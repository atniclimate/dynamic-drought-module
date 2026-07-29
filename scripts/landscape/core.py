"""Shared core of the landscape-signature build pipeline (T-M0-1 extraction).

Extracted from the monolithic scripts/build_landscape_signature.py with
behavior pinned by the parity fixtures in tests/fixtures/legacy/ (byte
comparisons under an injected retrieval date; see tests/test_parity.py for
the one deliberate exception, the corrected slope-method provenance
string). The one structural change this extraction carries, per the
WORKPLAN, is the per-polygon digital elevation model (DEM) read fix: each
analysis raster is materialized ONCE per family onto an EXPLICIT
GRID_RES_M analysis grid (see materialize_raster: the legacy warp's
`resolution` request was silently ignored by WarpedVRT, which is what made
single features take minutes and try to allocate tens of gigabytes), and
per-polygon windows are plain sub-window reads of that local raster. On a
source already on the analysis grid (the parity fixtures) values are
unchanged; on the real DEM the warp now genuinely lands on a true 30 m
grid instead of the Geospatial Data Abstraction Library (GDAL) suggested
~2 m grid, anchored to the ratified origin of the National Land Cover
Database (NLCD) and the Landscape Fire and Resource Management Planning
Tools (LANDFIRE) grids (GRID_ANCHOR_X/Y below; its source-metadata
verification is owed when the first native 30 m source lands).

T-M0-2 (L1b) fixed the known defects the extraction had preserved: slope is
now a true Horn 3x3 kernel with an aspect output (adapters/terrain.py),
coveragePct is the polygon-weighted valid-elevation fraction, and
materialize_raster has a categorical MODE resampling path (opt-in via
categorical=True; MODE never blends class codes, but callers must select
it for classed sources; the first real categorical adapter lands at
T-S1-3). Every intentional output change is enumerated in
tests/fixtures/delta-manifest.json and pinned by tests/fixtures/corrected/;
any diff vs the immutable legacy/ baseline outside that manifest fails the
parity suite. ONE legacy defect remains deliberately preserved (its fix is
a later unit's scope per the WORKPLAN, and the parity test pins it):
  - duplicate zonal codes are last-write-wins per feature row (no dissolve)

This package is BUILD-TIME ONLY. It never ships to the browser; the client
consumes only the compact snapshot it writes. See
docs/adr/P9-001-analysis-crs-resampling-toolchain.md and
docs/adr/P9-002-soil-product.md for the ratified decisions it implements.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from rasterio.windows import from_bounds as window_from_bounds

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# 1.1.0 (T-M0-2): additive aspect fields (aspectMeanDeg, aspectCardinal) and
# a semantic correction of coveragePct (polygon-weighted valid fraction, not
# the rectangular read-window fraction); see tests/fixtures/delta-manifest.json.
# 1.2.0 (T-M0-3): additive per-source provenance (acquired,
# materializedRasterSha256, methodVersion); the normative shape contract is
# schema/landscape-signature.schema.json, enforced by
# scripts/validate-landscape-artifact.mjs.
# 1.3.0 (T-S1-4): soil and landcoverFuels families, terrain methodVersion 3,
# per-layer vintage/resolution provenance, and the unavailable ledger.
SCHEMA_VERSION = "1.3.0"

# Pacific Northwest analysis extent, [minLon, minLat, maxLon, maxLat] in WGS 84.
PNW_BBOX = (-125.0, 41.5, -110.5, 49.5)

ANALYSIS_CRS = "EPSG:5070"            # NAD83 / Conus Albers, equal-area
GRID_RES_M = 30                       # common analysis grid resolution

# The analysis-grid anchor. The Architecture Decision Record (ADR) P9-001
# ratifies a 30 m grid "snapped to the NLCD and LANDFIRE grid origin in
# EPSG:5070". These values are the published NLCD/LANDFIRE CONUS grid
# upper-left corner; NLCD/LANDFIRE grid lines sit at 15 (mod 30) in
# EPSG:5070, NOT at absolute multiples of 30.
# VERIFICATION OWED: when the first native 30 m source (NLCD, FBFM40, EVT)
# lands at T-S1-0 (T-M0-2 brought only synthetic categorical fixtures, so
# the obligation did not discharge there), its transform must be checked
# against this anchor and the build must fail loudly on mismatch; until
# then this is the documented corner, not a value proven from downloaded
# source metadata.
GRID_ANCHOR_X = -2_493_045.0
GRID_ANCHOR_Y = 3_310_005.0

# Bump when materialization semantics change (resampling, nodata policy,
# grid anchoring, writer profile): the version is part of the cache key and
# the sidecar, so semantic changes can never silently reuse old pixels.
# v2 (T-M0-2): the sidecar and cache key now record the resampling method
# (the categorical MODE path landed); v1 sidecars predate that field, so
# the bump rematerializes rather than trusting an identity record that
# never said how the pixels were resampled.
MATERIALIZATION_FORMAT_VERSION = 2

# Strictly-increasing counter for temporary-file names (uniqueness across
# same-process materializations; the pid prefix covers cross-process).
_TMP_COUNTER = itertools.count()

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "scripts" / ".cache"
DATA_DIR = REPO_ROOT / "public" / "data"
OUT_PATH = DATA_DIR / "landscape-signature-pnw.json"

# EPA Region 10 pre-clipped Omernik shapefiles (same bulk source P8 used for the
# display bundle). Albers Equal Area Conic NAD83; reprojected to EPSG:5070 here.
EPA_S3_ROOT = "https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/reg10/"
ECO_L3_ZIP = "reg10_eco_l3.zip"
ECO_L4_ZIP = "reg10_eco_l4.zip"

USER_AGENT = "ddm-landscape-build/0.2 (+https://github.com/atniclimate/dynamic-drought-module)"

# The injected-retrieval-date environment variable: when set, the snapshot's
# "retrieved" stamp uses it verbatim, making outputs byte-stable for parity
# and reproducibility tests. The --retrieved CLI flag takes precedence.
RETRIEVED_ENV = "DDM_RETRIEVED_DATE"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _acquisition_stamp() -> str:
    """Today, as the acquisition date recorded in a fresh materialization's
    sidecar. A module-level seam so the fixture capture and the parity suite
    can pin it (the REAL sidecar-to-snapshot acquisition flow then runs
    deterministically); production always uses the current date. This is
    deliberately separate from retrieved_date(): the reproducibility pin
    (--retrieved / DDM_RETRIEVED_DATE) governs the artifact's top-level
    stamp and must never rewrite when the source data was acquired."""
    return time.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# Build-time asset download cache
# --------------------------------------------------------------------------

def download(url: str, dest: Path) -> Path:
    """Fetch a build-time asset to the cache once; reuse on subsequent runs."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"  downloading {url}")
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


# --------------------------------------------------------------------------
# Ecoregion zonal units
# --------------------------------------------------------------------------

def load_ecoregions(level: int) -> gpd.GeoDataFrame:
    """Load the unsimplified EPA Region 10 ecoregion polygons for a level,
    reprojected to the analysis CRS. level is 3 or 4."""
    zip_name = ECO_L3_ZIP if level == 3 else ECO_L4_ZIP
    zip_path = download(EPA_S3_ROOT + zip_name, CACHE_DIR / zip_name)
    # geopandas reads a single-shapefile zip directly via the zip:// scheme.
    gdf = gpd.read_file(f"zip://{zip_path}")
    if gdf.crs is None:
        raise RuntimeError(f"{zip_name} has no CRS; cannot reproject safely.")
    gdf = gdf.to_crs(ANALYSIS_CRS)
    code_field = "US_L3CODE" if level == 3 else "US_L4CODE"
    name_field = "US_L3NAME" if level == 3 else "US_L4NAME"
    if code_field not in gdf.columns or name_field not in gdf.columns:
        raise RuntimeError(
            f"expected {code_field}/{name_field} in {zip_name}; got {list(gdf.columns)}"
        )
    return gdf


# --------------------------------------------------------------------------
# Materialize-once raster access (the T-M0-1 structural change)
# --------------------------------------------------------------------------

def materialize_raster(
    src_path: str,
    bounds_5070: tuple[float, float, float, float],
    cache_dir: Path,
    family: str,
    pad_m: float = 120.0,
    categorical: bool = False,
) -> Path:
    """Warp the window of src_path covering bounds_5070 (plus pad) to the
    analysis grid ONCE and persist it as a local tiled, compressed float32
    GeoTIFF (NaN nodata) plus a .meta.json sidecar recording the acquisition
    date and grid. Returns the local path; a cached materialization is
    reused only after its sidecar and raster header validate.

    categorical=True selects MODE resampling for classed rasters (land
    cover, fuel models): the warp emits only values present in the source,
    never a bilinear blend of neighboring class codes. Continuous rasters
    (the default) stay bilinear; the flag is the caller's responsibility
    (nothing detects a classed source automatically). The resampling
    method is part of the cache key and the sidecar identity, and the
    sidecar binds to the exact raster bytes by sha256, so a cached raster
    is reused only as the resampling policy that actually produced it (a
    mispaired or hand-swapped raster fails validation and is
    rematerialized). The float32
    output profile is shared with the continuous path; integer class codes
    are exact in float32 up to 2^24, far beyond any classed product this
    pipeline consumes (the dtype policy for real categorical sources is
    revisited when the first one lands, T-S1-3).

    The target grid is EXPLICIT: GRID_RES_M cells in ANALYSIS_CRS, snapped
    outward onto the NLCD/LANDFIRE-anchored grid (GRID_ANCHOR_X/Y; see the
    anchor's verification note). This is the T-M0-1 fix for the legacy
    per-polygon read: the old WarpedVRT call passed a `resolution` keyword
    that WarpedVRT does not accept as a target-grid parameter, so the
    request was silently ignored and the warp ran on GDAL's suggested grid
    (~2 m cells near the Pacific Northwest); that is what made single
    features take minutes and polygon windows try to allocate tens of
    gigabytes. Slope's cell size (GRID_RES_M) is now actually true of the
    array it is applied to.

    The pad exceeds the per-polygon read pad (60 m) plus rounding slack, so
    every later polygon window stays inside the materialized extent. Written
    block-by-block so memory stays bounded on region-scale extents; the
    write goes to a unique temporary file that is removed on the exception
    path and atomically renamed on success (concurrent same-key runs are
    last-writer-wins on the rename; a hard process kill can strand a .part
    file, which nothing ever reads). Free disk space is preflighted against
    the raw array size before any network work starts.
    """
    minx, miny, maxx, maxy = bounds_5070
    minx, miny, maxx, maxy = minx - pad_m, miny - pad_m, maxx + pad_m, maxy + pad_m

    def snap_down(v: float, anchor: float) -> float:
        return anchor + math.floor((v - anchor) / GRID_RES_M) * GRID_RES_M

    def snap_up(v: float, anchor: float) -> float:
        return anchor + math.ceil((v - anchor) / GRID_RES_M) * GRID_RES_M

    minx = snap_down(minx, GRID_ANCHOR_X)
    miny = snap_down(miny, GRID_ANCHOR_Y)
    maxx = snap_up(maxx, GRID_ANCHOR_X)
    maxy = snap_up(maxy, GRID_ANCHOR_Y)
    width = round((maxx - minx) / GRID_RES_M)
    height = round((maxy - miny) / GRID_RES_M)
    transform = from_origin(minx, maxy, GRID_RES_M, GRID_RES_M)
    resampling = Resampling.mode if categorical else Resampling.bilinear
    key = hashlib.sha256(
        f"{src_path}|{family}|{minx:.3f},{miny:.3f},{maxx:.3f},{maxy:.3f}|"
        f"{GRID_RES_M}|{resampling.name}|v{MATERIALIZATION_FORMAT_VERSION}".encode()
    ).hexdigest()[:16]
    dest = cache_dir / f"analysis-{family}-{key}.tif"
    meta_path = dest.with_suffix(".meta.json")
    if _cache_valid(dest, meta_path, src_path, family, width, height, transform,
                    resampling.name):
        return dest
    cache_dir.mkdir(parents=True, exist_ok=True)
    _preflight_disk(cache_dir, width, height)
    # A stale or invalid sidecar must never survive next to a raster we are
    # about to replace: remove it up front so any crash below leaves a
    # sidecar-less destination, which _cache_valid refuses.
    meta_path.unlink(missing_ok=True)
    # Transport tuning for /vsicurl/ sources (the P9b scale fix): skip remote
    # directory listings and retry transient HTTP failures. Numerics unchanged.
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
    os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
    log(f"  materializing {family} analysis raster ({width}x{height} at "
        f"{GRID_RES_M}m) -> {dest.name}")
    t0 = time.time()
    # Temporary names carry pid + a strictly-increasing in-process counter:
    # distinct within a process lifetime and across live processes. A name
    # COLLISION with a file stranded by an earlier hard kill (pid reuse) is
    # harmless, not just unlikely: both writers truncate, and the explicit
    # unlinks below clear any stranded bytes before work starts. Exception
    # paths clean both temporaries; _cache_valid never reads .part files.
    stamp = f"{os.getpid()}-{next(_TMP_COUNTER)}"
    tmp = dest.with_name(f"{dest.stem}.{stamp}.part.tif")
    meta_tmp = meta_path.with_name(f"{meta_path.stem}.{stamp}.part.json")
    tmp.unlink(missing_ok=True)
    meta_tmp.unlink(missing_ok=True)
    try:
        with rasterio.open(src_path) as src:
            with WarpedVRT(
                src,
                crs=ANALYSIS_CRS,
                resampling=resampling,
                transform=transform,
                width=width,
                height=height,
            ) as vrt:
                profile = {
                    "driver": "GTiff",
                    "height": height,
                    "width": width,
                    "count": 1,
                    "dtype": "float32",
                    "crs": ANALYSIS_CRS,
                    "transform": transform,
                    "nodata": float("nan"),
                    "tiled": True,
                    "blockxsize": 512,
                    "blockysize": 512,
                    "compress": "deflate",
                    "predictor": 3,
                }
                with rasterio.open(tmp, "w", **profile) as out:
                    block = 2048
                    for r0 in range(0, height, block):
                        rh = min(block, height - r0)
                        for c0 in range(0, width, block):
                            cw = min(block, width - c0)
                            sub = Window(col_off=c0, row_off=r0, width=cw, height=rh)
                            data = vrt.read(1, window=sub, masked=True)
                            out.write(
                                np.asarray(data.filled(np.nan), dtype="float32"),
                                1,
                                window=sub,
                            )
        # Publication order (conservative pairing): the RASTER is replaced
        # first, the sidecar last through its own unique temporary. A crash
        # at any point leaves a destination without a fresh sidecar, which
        # _cache_valid refuses; old pixels can never sit beside a new
        # acquisition date.
        tmp.replace(dest)
        meta = {
            "formatVersion": MATERIALIZATION_FORMAT_VERSION,
            "acquired": _acquisition_stamp(),
            "source": src_path,
            "family": family,
            "crs": ANALYSIS_CRS,
            "gridResolutionMeters": GRID_RES_M,
            "resampling": resampling.name,
            "width": width,
            "height": height,
            "transform": list(transform)[:6],
            # Binds the sidecar's claims (resampling above all) to the exact
            # raster bytes: without this, any raster with a matching grid
            # header would validate under any sidecar.
            "rasterSha256": _sha256_file(dest),
        }
        meta_tmp.write_bytes((json.dumps(meta, indent=2) + "\n").encode("utf-8"))
        meta_tmp.replace(meta_path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        if meta_tmp.exists():
            meta_tmp.unlink(missing_ok=True)
    log(f"  materialized {family} ({time.time() - t0:.1f}s)")
    return dest


def _sha256_file(path: Path) -> str:
    """Streaming sha256 of a file (materialized rasters can be large)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _cache_valid(dest: Path, meta_path: Path, src_path: str, family: str,
                 width: int, height: int, transform, resampling_name: str) -> bool:
    """A cached materialization is reused only when its sidecar exists, its
    identity fields (source, family, format version, grid, resampling) all
    match the request, its acquisition date is well-formed, the raster
    header matches the expected grid, AND the raster bytes hash to the
    sidecar's recorded sha256 (the sidecar's resampling claim is only as
    good as its pairing with the pixels; the hash makes the pairing a
    checked fact instead of a filename convention). Anything else
    (truncated file, missing/mismatched/mispaired sidecar, grid change) is
    rematerialized. The hash costs one streaming read of the cached raster
    per reuse; if region-scale rasters ever make that cost bite, the
    binding mechanism can be revisited, but the check must not silently
    disappear.

    Deliberate refresh policy: a validated cache is reused indefinitely and
    the snapshot stamps the cache's recorded acquisition date, so staleness
    is visible in the artifact rather than silently refreshed. Refresh is
    manual (delete the cache file or scripts/.cache) or by bumping
    MATERIALIZATION_FORMAT_VERSION when materialization semantics change;
    no upstream version probe exists for the seamless 3DEP VRT."""
    if not (dest.exists() and dest.stat().st_size > 0 and meta_path.exists()):
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        acquired = meta.get("acquired")
        meta_ok = (
            meta.get("formatVersion") == MATERIALIZATION_FORMAT_VERSION
            and meta.get("source") == src_path
            and meta.get("family") == family
            and meta.get("crs") == ANALYSIS_CRS
            and meta.get("gridResolutionMeters") == GRID_RES_M
            and meta.get("resampling") == resampling_name
            and meta.get("width") == width
            and meta.get("height") == height
            and meta.get("transform") == list(transform)[:6]
            and isinstance(acquired, str)
            and re.fullmatch(r"\d{4}-\d{2}-\d{2}", acquired) is not None
        )
        with rasterio.open(dest) as ds:
            ok = (
                meta_ok
                and str(ds.crs) == ANALYSIS_CRS
                and ds.width == width
                and ds.height == height
                and list(ds.transform)[:6] == list(transform)[:6]
            )
        ok = ok and meta.get("rasterSha256") == _sha256_file(dest)
    except Exception:  # noqa: BLE001 - any unreadable cache is invalid
        return False
    if not ok:
        log(f"  cached {dest.name} does not match the expected grid/identity; "
            "rematerializing")
    return ok


def _preflight_disk(cache_dir: Path, width: int, height: int) -> None:
    """Fail self-explaining before network work if the destination volume
    cannot plausibly hold the materialization (budgeted at 0.75x the raw
    float32 size; deflate compression has been observed near 0.5x)."""
    raw_bytes = width * height * 4
    free = shutil.disk_usage(cache_dir).free
    if free < int(raw_bytes * 0.75):
        raise RuntimeError(
            f"not enough free disk space for the materialized raster: "
            f"{width}x{height} float32 is {raw_bytes / 1e9:.1f} GB raw "
            f"(deflate typically halves this) but only {free / 1e9:.1f} GB "
            f"is free at {cache_dir}. Free space or point the cache at a "
            f"larger volume."
        )


def acquisition_date(materialized: Path) -> str | None:
    """The acquisition date recorded when a materialized raster was fetched,
    from its .meta.json sidecar; None when unknown."""
    meta_path = materialized.with_suffix(".meta.json")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        value = meta.get("acquired")
        return value if isinstance(value, str) else None
    except Exception:  # noqa: BLE001 - a missing or corrupt sidecar is unknown
        return None


def materialized_sha256(materialized: Path) -> str | None:
    """The sha256 of the serialized local raster file bytes the statistics
    were computed from, as recorded in the .meta.json sidecar (rasterSha256,
    which _cache_valid verifies against the actual bytes on every reuse);
    None when unknown. This identifies the LOCAL MATERIALIZED analysis
    input; it is expressly not a hash of upstream content (the seamless
    3DEP VRT has no stable content identity) and not a canonical
    pixel-array hash. A module-level seam: the fixture capture and parity
    suite patch it to a fixture-only sentinel so byte-pinned fixtures do
    not depend on platform GeoTIFF encoder bytes; the real linkage is
    covered by dedicated unittests."""
    meta_path = materialized.with_suffix(".meta.json")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        value = meta.get("rasterSha256")
        return value if isinstance(value, str) else None
    except Exception:  # noqa: BLE001 - a missing or corrupt sidecar is unknown
        return None


def read_window(ds: rasterio.DatasetReader, bounds_5070, pad_m: float = 60.0):
    """Read a padded window covering bounds_5070 from a materialized analysis
    raster. Returns (float32 array with NaN nodata, transform); the same
    contract the legacy per-polygon warp read had."""
    minx, miny, maxx, maxy = bounds_5070
    minx, miny, maxx, maxy = minx - pad_m, miny - pad_m, maxx + pad_m, maxy + pad_m
    win = window_from_bounds(minx, miny, maxx, maxy, transform=ds.transform)
    win = win.round_offsets().round_lengths()
    data = ds.read(1, window=win, masked=True)
    transform = ds.window_transform(win)
    arr = np.asarray(data.filled(np.nan), dtype="float32")
    return arr, transform


def memdataset(arr: np.ndarray, transform, dtype: str = "float32") -> MemoryFile:
    """Wrap a single-band float array (NaN nodata) as an in-memory rasterio
    dataset for exactextract. Caller uses mf.open() and closes the MemoryFile.
    dtype="float64" exists for numerically delicate intermediates (the aspect
    circular-mean sin/cos rasters), where a float32 write would round the
    values the downstream cancellation test depends on."""
    profile = {
        "driver": "GTiff",
        "height": arr.shape[0],
        "width": arr.shape[1],
        "count": 1,
        "dtype": dtype,
        "crs": ANALYSIS_CRS,
        "transform": transform,
        "nodata": float("nan"),
    }
    mf = MemoryFile()
    with mf.open(**profile) as ds:
        ds.write(arr.astype(dtype), 1)
    return mf


# --------------------------------------------------------------------------
# Shared numeric / stamping helpers
# --------------------------------------------------------------------------

def round_or_none(value, ndigits):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    return round(f, ndigits)


def retrieved_date(override: str | None = None) -> str:
    """The snapshot's retrieval stamp: the --retrieved flag wins, then the
    DDM_RETRIEVED_DATE environment variable, then today. The injection seam
    exists so parity and reproducibility tests are byte-stable."""
    if override:
        return override
    env = os.environ.get(RETRIEVED_ENV)
    if env:
        return env
    return time.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# Snapshot assembly and artifact writer
# --------------------------------------------------------------------------

def build_snapshot(
    levels: list[int],
    only: list[str],
    sources: dict,
    family_results: dict[int, dict[str, dict]],
    gdfs: dict[int, gpd.GeoDataFrame],
    retrieved: str,
    provenance: dict[str, dict] | None = None,
    diagnostics: dict | None = None,
) -> dict:
    """Assemble the snapshot dict exactly as the legacy writer did (field
    order and structure are parity-pinned).

    provenance maps a source key to its RUNTIME provenance fields (1.3.0:
    acquired, materializedRasterSha256), merged over that family's static
    SOURCE block. Families absent from the mapping get both keys as None:
    the keys are always present, and None is the explicit honest unknown
    (materialization failed or sidecar unreadable), never an omission."""
    bundles: dict = {}
    diagnostic_state = diagnostics or {}
    for level in levels:
        gdf = gdfs[level]
        code_field = "US_L3CODE" if level == 3 else "US_L4CODE"
        level_results = family_results.get(level, {})
        for _, row in gdf.iterrows():
            code = row[code_field]
            entry = bundles.setdefault(
                code,
                {"level": level, "usL3Code": row.get("US_L3CODE"), "usL3Name": row.get("US_L3NAME")},
            )
            if level == 4:
                entry["usL4Code"] = row.get("US_L4CODE")
                entry["usL4Name"] = row.get("US_L4NAME")
                entry["parent"] = row.get("US_L3CODE")
            for family in only:
                values = level_results.get(family, {})
                if code in values:
                    value = values[code]
                    entry[family] = (
                        value[family]
                        if isinstance(value, dict) and family in value
                        else value
                    )
            entry["unavailable"] = _unavailable_ledger(
                level,
                code,
                entry,
                only,
                diagnostic_state,
            )
    runtime = provenance or {}
    merged_sources = {}
    for k, source in sources.items():
        fam_runtime = runtime.get(k, {})
        merged_sources[k] = {
            **source,
            "acquired": fam_runtime.get("acquired"),
            "materializedRasterSha256": fam_runtime.get("materializedRasterSha256"),
        }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "retrieved": retrieved,
        "analysisCrs": ANALYSIS_CRS,
        "gridResolutionMeters": GRID_RES_M,
        "aggregationUnit": "EPA Omernik ecoregion (unsimplified Region 10 Albers source)",
        "sources": merged_sources,
        "bundles": bundles,
    }


def _unavailable_ledger(
    level: int,
    code: str,
    bundle: dict,
    families: list[str],
    diagnostics: dict,
) -> list[str]:
    """Derive the per-bundle missing-data paths from the frozen handoffs."""
    ledger: list[str] = []
    for family in families:
        value = bundle.get(family)
        if isinstance(value, dict) and value.get("unavailable") is True:
            ledger.append(family)
        if family == "landcoverFuels" and isinstance(value, dict):
            for subfamily in ("fbfm40", "evt", "landcover", "whp"):
                subvalue = value.get(subfamily)
                if (
                    isinstance(subvalue, dict)
                    and subvalue.get("unavailable") is True
                ):
                    ledger.append(f"landcoverFuels.{subfamily}")
    unresolved_levels = diagnostics.get("soilUnresolvedByCode", {})
    unresolved_codes = unresolved_levels.get(
        level,
        unresolved_levels.get(str(level), {}),
    )
    unresolved = unresolved_codes.get(code, {}) if isinstance(
        unresolved_codes, dict
    ) else {}
    mukeys = unresolved.get("mukeys", []) if isinstance(unresolved, dict) else []
    ledger.extend(f"soil.mukey.{int(mukey)}" for mukey in mukeys)
    return sorted(set(ledger))


def write_snapshot(snapshot: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Explicit LF newline policy so the artifact bytes are platform-stable
    # (Windows text mode would otherwise write CRLF).
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(snapshot, indent=2) + "\n")
    log(f"wrote {out_path} ({len(snapshot.get('bundles', {}))} bundles)")
