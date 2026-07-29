"""Land cover + fuels family adapter (T-S1-3): Landscape Fire and
Resource Management Planning Tools (LANDFIRE) Scott and Burgan 40 Fire
Behavior Fuel Models (FBFM40) and Existing Vegetation Type (EVT), Annual
National Land Cover Database (NLCD) land cover, and United States Forest
Service (USFS) Wildfire Hazard Potential (WHP).

The analysis grid is 30 m cells in European Petroleum Survey Group
(EPSG) registry code 5070 (NAD83 / Conus Albers), anchored at
core.GRID_ANCHOR_X/Y. NLCD is published by the Multi-Resolution Land
Characteristics consortium (MRLC).

This module implements the frozen land-cover and fuels contract: a
checked acquisition function
(acquire, contract 4.3) and a fetch-free aggregation function (aggregate,
contract 4.4), plus the lane's own RequestBudget copy (contract 4.5; the
per-lane duplication is accepted and recorded in contract 1.1).

Congruence rules this module enforces:
  - The three native 30 m sources (FBFM40, EVT, NLCD) must be
    anchor-congruent per contract 2.2, asserted in acquire() before
    materialization and revalidated in aggregate() before any read.
    Exact transforms are an on-grid identity. A service-returned
    transform may carry only revision 10's recorded sub-centimeter
    serialization deviations; MODE still selects the majority-overlap
    cell under the contract 2.2 boundary-sliver argument.
  - The 270 m WHP source is governed by the contract 5.3 checked
    precondition (congruence-or-stop): MODE materialization proceeds
    ONLY when the source CRS is EPSG:5070, the transform is unrotated
    and unsheared, both absolute pixel sizes equal 270 m within 1e-6 m,
    and both origin axes are anchor-congruent (edge offsets integral
    multiples of 30 within 1e-6 m). Any failure is a loud stop for the
    WHP sub-path (check_whp_precondition raises; acquire records the
    artifact error and never materializes); no silent fallback exists.

Definitions this lane documents (within the contract's frozen shapes):
  - whp.cellCount is the exactextract effective (partial-pixel) 270 m
    cell count, computed on the materialized 30 m analysis grid as the
    valid 30 m partial-pixel count divided by 81 (a 270 m cell is
    exactly 81 congruent 30 m cells; the identity holds only under the
    verified 5.3 precondition, which is what admits the raster here at
    all).
  - coarse uses the UNROUNDED effective cell count (coarse is true
    exactly when the unrounded count is < 30), matching the soil
    block's stated "unrounded values decide" convention for its
    sibling flag (contract 5.1.2); cellCount serializes at 1 decimal.
  - A polygon with ZERO valid pixels for a sub-source (the required
    artifact is fine but every intersected cell is nodata) yields that
    sub-block as the unavailable shape with reason
    "no valid <artifact-key> pixels in polygon"; this is the terrain
    adapter's "no valid DEM pixels" precedent applied per sub-block,
    distinct from the valid-but-all-non-burnable and
    valid-but-class-6/7-only STATS cases the contract freezes.
  - Modal (dominant) class ties break by the section 5 sort
    convention: fraction descending, then class code ascending.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import zipfile
from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
import requests
from exactextract import exact_extract
from rasterio.crs import CRS
from rasterio.transform import from_origin

from scripts.landscape import core

# --------------------------------------------------------------------------
# Frozen artifact keys (contract 4.6) and per-artifact routing
# --------------------------------------------------------------------------

ARTIFACT_KEYS = (
    "fuels-fbfm40",
    "fuels-evt",
    "fuels-evt-attributes",
    "landcover-nlcd",
    "hazard-whp",
)

ARTIFACT_KINDS = {
    "fuels-fbfm40": "raster",
    "fuels-evt": "raster",
    "fuels-evt-attributes": "attributes",
    "landcover-nlcd": "raster",
    "hazard-whp": "raster",
}

# Endpoint keys per artifact (contract 6.3 capture budget / section 8 build
# budget). Every HTTP attempt for an artifact spends its key first.
ENDPOINT_KEYS = {
    "fuels-fbfm40": "lfps-exportimage",
    "fuels-evt": "lfps-exportimage",
    "fuels-evt-attributes": "metadata",
    "landcover-nlcd": "mrlc-wcs",
    "hazard-whp": "rds-whp-zip",
}

# run_info stems per prepared RASTER artifact (contract 4.6).
RUN_INFO_STEMS = {
    "fuels-fbfm40": "fuelsFbfm40",
    "fuels-evt": "fuelsEvt",
    "landcover-nlcd": "landcoverNlcd",
    "hazard-whp": "hazardWhp",
}

# --------------------------------------------------------------------------
# Sources and vintage pins (contract 3 / 5.3)
# --------------------------------------------------------------------------

LFPS_EXPORTIMAGE = {
    "fuels-fbfm40": (
        "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
        "LF2023_FBFM40_CONUS/ImageServer/exportImage"
    ),
    "fuels-evt": (
        "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
        "LF2023_EVT_CONUS/ImageServer/exportImage"
    ),
}
LFPS_IMAGE_SERVICES = {
    key: url.removesuffix("/exportImage")
    for key, url in LFPS_EXPORTIMAGE.items()
}
EVT_ATTRIBUTE_TABLE_URL = (
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_EVT_CONUS/ImageServer/rasterAttributeTable"
)
MRLC_WCS_URL = (
    "https://dmsdata.cr.usgs.gov/geoserver/"
    "mrlc_Land-Cover-Native_conus_year_data/wcs"
)
# The WCS 1.0.0 coverage identifier for the Annual NLCD land-cover mosaic.
# Verified against GetCapabilities at capture (2026-07-22); the capture
# script fails loudly, listing the served names, if this ever drifts.
NLCD_COVERAGE = (
    "mrlc_Land-Cover-Native_conus_year_data:Land-Cover-Native_conus_year_data"
)
NLCD_TIME = "2024-01-01"
NLCD_COLLECTION = "Annual NLCD Collection 1.1"
WHP_ZIP_URL = (
    "https://www.fs.usda.gov/rds/archive/products/RDS-2015-0047-4/"
    "RDS-2015-0047-4_Data.zip"
)
WHP_DOI = "10.2737/RDS-2015-0047-4"

# Raw source downloads land here (gitignored; contract 4.3). Materialized
# analysis rasters go to the cache_dir the caller passes to acquire().
DOWNLOAD_CACHE = core.REPO_ROOT / "scripts" / ".cache" / "landcover-fuels"

# Tile caps for the full-extent tiled download path (section 8 estimate
# bases: ~10000 px exportImage requests, 5000 px WCS requests). The fixture
# window (100 cells) is a single request on each path.
LFPS_TILE_CELLS = 10000
MRLC_TILE_CELLS = 5000

# STOPGAP TRANSPORT (2026-07-25, maintainer-sanctioned build-2 amendment;
# docs/design/MAINTAINER_SOURCE_NOTES_2026-07-24.md thread 1): the lfps
# direct-stream path (f=image) has returned HTTP 500 on full-size
# FBFM40/EVT exports since 2026-07-23, while the identical request with
# f=json renders a valid GeoTIFF server-side. With DDM_LFPS_TWO_STEP=1
# each lfps tile is fetched in TWO requests (f=json for the rendered
# file's href, then the href itself); both spend the lfps-exportimage
# budget before sending, and the href is fetched immediately because the
# service's output retention can be minutes. Default off: the frozen
# contract transport stays f=image, and the durable replacement (the
# LFPS job API, lfps.usgs.gov/docs/api) is its own reviewed unit.
LFPS_TWO_STEP_ENV = "DDM_LFPS_TWO_STEP"


def _lfps_two_step_enabled() -> bool:
    return os.environ.get(LFPS_TWO_STEP_ENV, "") == "1"

# The WHP bulk download's per-invocation streaming time budget in seconds.
# A longer pull stops cleanly, persists the partial file, and resumes
# with an HTTP Range request on the next invocation (each resume attempt
# spends the budget again; the ceiling stays binding).
WHP_DOWNLOAD_TIME_BUDGET_S = 480.0
MATERIALIZATION_PAD_M = 120.0

# --------------------------------------------------------------------------
# Method history (contract 4.1)
# --------------------------------------------------------------------------

# The immutable method-version history for this family; entries are never
# edited or removed. The terrain module's bump rule applies verbatim: any
# change to a version's numerics or semantics, or to the serialized output
# of a published version (including its canonical serialization forms), is
# a new entry completed in the unit that introduces it.
METHOD_VERSIONS: dict[int, str] = {
    1: (
        "categorical MODE materialization onto the 30 m EPSG:5070 anchored "
        "analysis grid (verified native 30 m sources follow contract 2.2, "
        "including revision 10's recorded service-transform deviation and "
        "majority-overlap boundary; the 270 m WHP source proceeds only under "
        "the checked contract 5.3 congruence precondition); per-polygon "
        "class fractions via exactextract partial-pixel weights over each "
        "sub-source's valid (non-nodata) covered area; FBFM40 dominant "
        "burnable class with non-burnable codes 91, 92, 93, 98, 99 summed "
        "separately and a fraction >= 0.01 class list; EVT modal class with "
        "attribute-table name resolution; NLCD forest (41+42+43), cropland "
        "(81+82), wetland (90+95), and open water (11) disjoint subset "
        "fractions; WHP ordinal class mean over classes 1 to 5 with a "
        "seven-class fraction partition, an effective 270 m cell count "
        "(valid 30 m partial-pixel count / 81), and a coarse flag below 30 "
        "unrounded effective cells; coveragePct is the polygon-weighted "
        "valid fraction per sub-source"
    ),
}

# No serialized form in this family needs canonicalization (fractions,
# ordinal means, and integer class codes round plainly; there is no
# wrap-around quantity like the terrain azimuth). The constant is present,
# and empty, so review can see the question was answered (contract 4.1).
CANONICAL_SERIALIZATION: dict[int, str] = {}

# Static provenance, one block per sub-source (contract 4.1; the runtime
# provenance fields are merged in by core.build_snapshot at T-S1-4).
SOURCE_FBFM40 = {
    "source": (
        "LANDFIRE LF2023 Scott and Burgan 40 Fire Behavior Fuel Models "
        "(FBFM40), CONUS"
    ),
    "sourceUrl": (
        "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
        "LF2023_FBFM40_CONUS/ImageServer"
    ),
    "vintage": "LANDFIRE release code 240 (LF2023)",
    "resolutionMeters": 30,
    "method": METHOD_VERSIONS[1],
    "methodVersion": 1,
}
SOURCE_EVT = {
    "source": "LANDFIRE LF2023 Existing Vegetation Type (EVT), CONUS",
    "sourceUrl": (
        "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
        "LF2023_EVT_CONUS/ImageServer"
    ),
    "vintage": "LANDFIRE release code 240 (LF2023)",
    "resolutionMeters": 30,
    "method": METHOD_VERSIONS[1],
    "methodVersion": 1,
}
SOURCE_NLCD = {
    "source": (
        "Multi-Resolution Land Characteristics (MRLC) Annual National "
        "Land Cover Database (NLCD) land cover, CONUS"
    ),
    "sourceUrl": MRLC_WCS_URL,
    "vintage": f"TIME={NLCD_TIME} ({NLCD_COLLECTION})",
    "resolutionMeters": 30,
    "method": METHOD_VERSIONS[1],
    "methodVersion": 1,
}
SOURCE_WHP = {
    "source": (
        "United States Forest Service (USFS) Wildfire Hazard Potential "
        "(WHP) 2023 classified, edition 4"
    ),
    "sourceUrl": WHP_ZIP_URL,
    "vintage": f"edition 4 (2023 classified), DOI {WHP_DOI}",
    "resolutionMeters": 270,
    "method": METHOD_VERSIONS[1],
    "methodVersion": 1,
}

# --------------------------------------------------------------------------
# Class sets and published domains (contract 5.3 / 4.3)
# --------------------------------------------------------------------------

FBFM40_NONBURNABLE_CODES = frozenset({91, 92, 93, 98, 99})
FBFM40_CLASS_LIST_MIN_FRACTION = 0.01

NLCD_FOREST_CODES = frozenset({41, 42, 43})
NLCD_CROPLAND_CODES = frozenset({81, 82})
NLCD_WETLAND_CODES = frozenset({90, 95})
NLCD_OPEN_WATER_CODES = frozenset({11})

WHP_ORDINAL_CLASSES = (1, 2, 3, 4, 5)
WHP_ALL_CLASSES = (1, 2, 3, 4, 5, 6, 7)
WHP_COARSE_CELL_THRESHOLD = 30.0
WHP_CELLS_PER_SOURCE_CELL = 81.0  # (270 / 30) squared

# Published categorical domains for the float32 exactness assertion
# (contract 4.3): FBFM40, NLCD, and WHP by their published code domains;
# EVT's observed domain is frozen by contract 4.3. Observed maxima are
# recorded at capture; no claim is made beyond the asserted data.
CLASS_DOMAINS: dict[str, tuple[int, int]] = {
    "fuels-fbfm40": (91, 204),
    "fuels-evt": (7008, 9994),
    "landcover-nlcd": (0, 95),
    "hazard-whp": (1, 7),
}

GRID_METADATA_TOL_M = 1e-6
GRID_RETURNED_PIXEL_TOL_M = 1e-4
GRID_RETURNED_ORIGIN_TOL_M = 0.02
WHP_RES_M = 270.0

_EPSG_5070 = CRS.from_epsg(5070)


# --------------------------------------------------------------------------
# RequestBudget (contract 4.5; this lane's identical small copy)
# --------------------------------------------------------------------------

class BudgetExceededError(RuntimeError):
    """Raised when a spend would exceed an endpoint ceiling; the build or
    capture stops rather than shaving the ceiling quietly (contract 4.5/8)."""


class RequestBudget:
    """Count-before-send request ceilings per endpoint key. spend() is
    called BEFORE every HTTP attempt, including every retry attempt."""

    def __init__(self, ceilings: dict[str, int]) -> None:
        self.ceilings = dict(ceilings)
        self.counts: dict[str, int] = {k: 0 for k in self.ceilings}

    def spend(self, endpoint_key: str) -> None:
        ceiling = self.ceilings.get(endpoint_key, 0)
        used = self.counts.get(endpoint_key, 0)
        if used + 1 > ceiling:
            raise BudgetExceededError(
                f"request budget exceeded for endpoint key "
                f"'{endpoint_key}': ceiling {ceiling}, already spent {used} "
                f"(S1_LANE_CONTRACT.md sections 4.5 and 8; capture budgets "
                f"in 6.3). The run stops here; ceilings are hard bounds."
            )
        self.counts[endpoint_key] = used + 1


# --------------------------------------------------------------------------
# Grid congruence (contract 2.2) and the WHP precondition (contract 5.3)
# --------------------------------------------------------------------------

class GridCongruenceError(RuntimeError):
    """A native 30 m source (or a prepared analysis raster) failed the
    contract 2.2 anchor-congruence assertion."""


class WhpPreconditionError(RuntimeError):
    """The WHP source failed the contract 5.3 congruence-or-stop
    precondition; MODE materialization must not proceed."""


class WhpDownloadIncomplete(RuntimeError):
    """The WHP bulk download hit its per-invocation time budget; the
    partial file is persisted and the capture must be re-invoked to
    resume (the resume attempt spends the budget again)."""


def _lattice_distance(value: float, anchor: float, step: float = 30.0) -> float:
    """Distance from value to the nearest anchor + k * step lattice line."""
    r = (value - anchor) % step
    return min(r, step - r)


def _crs_is_5070(crs) -> bool:
    if crs is None:
        return False
    try:
        if crs.to_epsg() == 5070:
            return True
    except Exception:  # noqa: BLE001 - fall through to direct comparison
        pass
    return crs == _EPSG_5070


def grid_deviation_facts_30m(crs, transform) -> dict:
    """Observed transform deviations for the contract 2.2 receipt."""
    try:
        epsg = crs.to_epsg() if crs is not None else None
    except Exception:  # noqa: BLE001 - facts must remain recordable
        epsg = None
    return {
        "crsEpsg": epsg,
        "rotationShearBD": [transform.b, transform.d],
        "pixelSizesAE": [transform.a, transform.e],
        "pixelSizeDeviationsM": [
            abs(abs(transform.a) - core.GRID_RES_M),
            abs(abs(transform.e) - core.GRID_RES_M),
        ],
        "originEdgeOffsetsFromAnchor": [
            transform.c - core.GRID_ANCHOR_X,
            transform.f - core.GRID_ANCHOR_Y,
        ],
        "originLatticeDistances30m": [
            _lattice_distance(transform.c, core.GRID_ANCHOR_X),
            _lattice_distance(transform.f, core.GRID_ANCHOR_Y),
        ],
    }


def assert_anchor_congruent_30m(
    crs,
    transform,
    context: str,
    *,
    service_returned: bool = False,
) -> None:
    """The contract 2.2 assertion for native 30 m EPSG:5070 sources and for
    prepared analysis rasters: CRS EPSG:5070; unrotated and unsheared;
    30 m cells; edge offsets integral multiples of 30 from the anchor
    within the applicable tolerance. Metadata and exact prepared rasters
    use 1e-6 m. Service-returned rasters use the revision 10 split of
    1e-4 m for pixel size and 0.02 m for origin lattice distance. Raises
    GridCongruenceError naming the contract section."""
    pixel_tol = (
        GRID_RETURNED_PIXEL_TOL_M
        if service_returned else GRID_METADATA_TOL_M
    )
    origin_tol = (
        GRID_RETURNED_ORIGIN_TOL_M
        if service_returned else GRID_METADATA_TOL_M
    )
    failures: list[str] = []
    if not _crs_is_5070(crs):
        failures.append(f"CRS is {crs}, not EPSG:5070")
    if transform.b != 0.0 or transform.d != 0.0:
        failures.append(
            f"transform has rotation/shear terms b={transform.b!r}, "
            f"d={transform.d!r} (must be exactly 0)"
        )
    if abs(abs(transform.a) - core.GRID_RES_M) > pixel_tol or \
            abs(abs(transform.e) - core.GRID_RES_M) > pixel_tol:
        failures.append(
            f"pixel sizes ({transform.a!r}, {transform.e!r}) are not "
            f"{core.GRID_RES_M} m within {pixel_tol} m"
        )
    dx = _lattice_distance(transform.c, core.GRID_ANCHOR_X)
    dy = _lattice_distance(transform.f, core.GRID_ANCHOR_Y)
    if dx > origin_tol or dy > origin_tol:
        failures.append(
            f"origin edge offsets ({transform.c - core.GRID_ANCHOR_X!r}, "
            f"{transform.f - core.GRID_ANCHOR_Y!r}) are not integral "
            f"multiples of 30 within {origin_tol} m (lattice distances "
            f"{dx!r}, {dy!r})"
        )
    if failures:
        raise GridCongruenceError(
            f"{context}: source grid is not anchor-congruent per "
            f"S1_LANE_CONTRACT.md section 2.2: " + "; ".join(failures)
        )


def whp_geometry_facts(crs, transform) -> dict:
    """The four checked geometric facts of the contract 5.3 WHP
    precondition, as observed values (recorded in SOURCES.md and the lane
    report whichever way the check goes)."""
    try:
        epsg = crs.to_epsg() if crs is not None else None
    except Exception:  # noqa: BLE001 - facts must be recordable regardless
        epsg = None
    return {
        "crs": str(crs),
        "crsEpsg": epsg,
        "rotationShearBD": [transform.b, transform.d],
        "pixelSizesAE": [transform.a, transform.e],
        "originEdgeOffsetsFromAnchor": [
            transform.c - core.GRID_ANCHOR_X,
            transform.f - core.GRID_ANCHOR_Y,
        ],
        "originLatticeDistances30m": [
            _lattice_distance(transform.c, core.GRID_ANCHOR_X),
            _lattice_distance(transform.f, core.GRID_ANCHOR_Y),
        ],
    }


def check_whp_precondition(crs, transform) -> None:
    """The contract 5.3 congruence-or-stop precondition, all four facts:
    (1) CRS is EPSG:5070; (2) rotation and shear exactly 0; (3) both
    absolute pixel sizes equal 270 m within 1e-6 m; (4) both origin axes
    anchor-congruent (edge offsets integral multiples of 30 within
    1e-6 m). Raises WhpPreconditionError naming every failing condition;
    on failure the WHP sub-path STOPS (no silent fallback exists)."""
    failures: list[str] = []
    if not _crs_is_5070(crs):
        failures.append(f"condition 1 (CRS): {crs} is not EPSG:5070")
    if transform.b != 0.0 or transform.d != 0.0:
        failures.append(
            f"condition 2 (rotation/shear): b={transform.b!r}, "
            f"d={transform.d!r} are not exactly 0"
        )
    if abs(abs(transform.a) - WHP_RES_M) > GRID_METADATA_TOL_M or \
            abs(abs(transform.e) - WHP_RES_M) > GRID_METADATA_TOL_M:
        failures.append(
            f"condition 3 (pixel size): ({transform.a!r}, {transform.e!r}) "
            f"are not 270 m within {GRID_METADATA_TOL_M} m"
        )
    dx = _lattice_distance(transform.c, core.GRID_ANCHOR_X)
    dy = _lattice_distance(transform.f, core.GRID_ANCHOR_Y)
    if dx > GRID_METADATA_TOL_M or dy > GRID_METADATA_TOL_M:
        failures.append(
            f"condition 4 (origin congruence): edge offsets "
            f"({transform.c - core.GRID_ANCHOR_X!r}, "
            f"{transform.f - core.GRID_ANCHOR_Y!r}) are not integral "
            f"multiples of 30 within {GRID_METADATA_TOL_M} m (lattice distances "
            f"{dx!r}, {dy!r})"
        )
    if failures:
        facts = whp_geometry_facts(crs, transform)
        raise WhpPreconditionError(
            "WHP resampling precondition FAILED (S1_LANE_CONTRACT.md "
            "section 5.3; congruence-or-stop; MODE materialization must "
            "not proceed and no fallback may be taken silently): "
            + "; ".join(failures)
            + f"; all observed facts: {json.dumps(facts, sort_keys=True)}"
        )


def whp_window_bounds(
    src_transform, bounds_30m: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """The minimal 270 m-grid-aligned window of the WHP SOURCE grid that
    covers a 30 m window (contract 6.3; deterministic given the source
    transform). Alignment is to the source grid's own origin."""
    ox, oy = src_transform.c, src_transform.f
    minx, miny, maxx, maxy = bounds_30m
    left = ox + math.floor((minx - ox) / WHP_RES_M) * WHP_RES_M
    right = ox + math.ceil((maxx - ox) / WHP_RES_M) * WHP_RES_M
    top = oy - math.floor((oy - maxy) / WHP_RES_M) * WHP_RES_M
    bottom = oy - math.ceil((oy - miny) / WHP_RES_M) * WHP_RES_M
    return (left, bottom, right, top)


# --------------------------------------------------------------------------
# Structural validation of the EVT attribute table (contract 4.7)
# --------------------------------------------------------------------------

_EVT_CODE_KEY_RE = re.compile(r"-?[0-9]+")


def validate_evt_attributes(obj) -> None:
    """Contract 4.7: a JSON object mapping EVT code strings (decimal
    integer strings, unique by construction of a JSON object) to
    non-empty name strings. Raises ValueError on any
    violation."""
    if not isinstance(obj, dict):
        raise ValueError(
            f"fuels-evt-attributes must be a JSON object, got "
            f"{type(obj).__name__} (S1_LANE_CONTRACT.md 4.7)"
        )
    for key, value in obj.items():
        if not isinstance(key, str) or _EVT_CODE_KEY_RE.fullmatch(key) is None:
            raise ValueError(
                f"fuels-evt-attributes key {key!r} is not a decimal "
                f"integer string (S1_LANE_CONTRACT.md 4.7)"
            )
        if not isinstance(value, str) or value == "":
            raise ValueError(
                f"fuels-evt-attributes value for code {key} is not a "
                f"non-empty string (S1_LANE_CONTRACT.md 4.7)"
            )


# --------------------------------------------------------------------------
# Small shared helpers
# --------------------------------------------------------------------------

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _entry(kind: str, *, path: Path | None = None, error: str | None = None,
           acquired: str | None = None, sha256: str | None = None) -> dict:
    """A prepared-artifact entry (contract 4.3): exactly one of
    path/error non-None."""
    if (path is None) == (error is None):
        raise ValueError("exactly one of path/error must be non-None")
    return {"kind": kind, "path": path, "error": error,
            "acquired": acquired, "sha256": sha256}


def _is_url(source) -> bool:
    return isinstance(source, str) and "://" in source


def _snap_bounds_30(bounds: tuple[float, float, float, float]
                    ) -> tuple[float, float, float, float]:
    """Snap bounds outward onto the anchored 30 m lattice (the same snap
    core.materialize_raster applies, without its pad)."""
    minx, miny, maxx, maxy = bounds
    ax, ay, res = core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y, core.GRID_RES_M

    def down(v: float, anchor: float) -> float:
        return anchor + math.floor((v - anchor) / res) * res

    def up(v: float, anchor: float) -> float:
        return anchor + math.ceil((v - anchor) / res) * res

    return (down(minx, ax), down(miny, ay), up(maxx, ax), up(maxy, ay))


def observed_class_range(path: Path) -> tuple[float, float]:
    """Observed (min, max) over the finite values of a raster, blockwise
    (recorded in SOURCES.md as the observed categorical maxima)."""
    omin, omax = math.inf, -math.inf
    with rasterio.open(path) as ds:
        for _, win in ds.block_windows(1):
            arr = ds.read(1, window=win, masked=True)
            data = np.asarray(arr.compressed(), dtype="float64")
            finite = data[np.isfinite(data)]
            if finite.size:
                omin = min(omin, float(finite.min()))
                omax = max(omax, float(finite.max()))
    return omin, omax


def _assert_integral_in_domain(path: Path, key: str) -> tuple[float, float]:
    """The contract 4.3 float32 exactness assertion over a materialized
    window: every finite value is integral and inside the published
    domain. Returns the observed (min, max). Raises ValueError on any
    violation (fail closed)."""
    lo, hi = CLASS_DOMAINS[key]
    omin, omax = math.inf, -math.inf
    with rasterio.open(path) as ds:
        for _, win in ds.block_windows(1):
            arr = ds.read(1, window=win, masked=True)
            finite = np.asarray(arr.compressed(), dtype="float64")
            finite = finite[np.isfinite(finite)]
            if finite.size == 0:
                continue
            if not np.all(finite == np.round(finite)):
                bad = finite[finite != np.round(finite)][:5]
                raise ValueError(
                    f"{key}: non-integral class values observed "
                    f"{bad.tolist()} (S1_LANE_CONTRACT.md 4.3 float32 "
                    f"exactness assertion)"
                )
            fmin, fmax = float(finite.min()), float(finite.max())
            if fmin < lo or fmax > hi:
                raise ValueError(
                    f"{key}: observed class values outside the published "
                    f"domain [{lo}, {hi}]: min {fmin}, max {fmax} "
                    f"(S1_LANE_CONTRACT.md 4.3)"
                )
            omin, omax = min(omin, fmin), max(omax, fmax)
    return omin, omax


# --------------------------------------------------------------------------
# Downloaders (acquire-only; every HTTP attempt spends the budget first)
# --------------------------------------------------------------------------

_USER_AGENT = core.USER_AGENT
_TIFF_MAGICS = (b"II*\x00", b"MM\x00*")


def _bounds_tag(bounds: tuple[float, float, float, float]) -> str:
    return hashlib.sha256(
        ",".join(f"{v:.3f}" for v in bounds).encode()
    ).hexdigest()[:12]


def _canonical_request_identity(
    url: str,
    *,
    query: dict | None = None,
    selectors: dict | None = None,
) -> dict:
    """Canonical, JSON-safe identity of the resolved upstream request.

    The URL identifies overrides as well as adopted endpoints. Query
    values and explicit product/vintage selectors prevent same-key,
    same-bounds cache reuse across a changed release, TIME, or coverage.
    """
    identity = {"url": str(url)}
    if query:
        identity["query"] = {
            str(key): str(value)
            for key, value in sorted(query.items())
        }
    if selectors:
        identity["selectors"] = {
            str(key): str(value)
            for key, value in sorted(selectors.items())
        }
    return identity


def _download_complete(
    dest: Path,
    sidecar: Path,
    request_identity: dict | None = None,
) -> bool:
    """A digest-and-request-identity cache skip.

    Downloaded bytes are reused only when their digest matches and, when
    supplied, the sidecar is bound to the same resolved request. The
    retained WHP ZIP's pre-revision-13 sidecar is accepted only for a
    URL-only identity because that record already carries its exact URL.
    """
    if not (dest.exists() and dest.stat().st_size > 0 and sidecar.exists()):
        return False
    try:
        recorded = json.loads(sidecar.read_text(encoding="utf-8"))
        if recorded.get("sha256") != _sha256_file(dest):
            return False
        if request_identity is None:
            return True
        recorded_identity = recorded.get("requestIdentity")
        if recorded_identity is None:
            # Legacy compatibility is intentionally narrow. Only the WHP
            # URL-only identity can be proven from the old retained record.
            return (
                set(request_identity) == {"url"}
                and recorded.get("url") == request_identity["url"]
            )
        return recorded_identity == request_identity
    except Exception:  # noqa: BLE001 - unreadable record means no skip
        return False


def _cache_identity_mismatch(
    dest: Path,
    sidecar: Path,
    request_identity: dict,
) -> bool:
    """True only for valid cached bytes bound to another request."""
    if not (dest.exists() and dest.stat().st_size > 0 and sidecar.exists()):
        return False
    try:
        recorded = json.loads(sidecar.read_text(encoding="utf-8"))
        if recorded.get("sha256") != _sha256_file(dest):
            return False
        return not _download_complete(dest, sidecar, request_identity)
    except Exception:  # noqa: BLE001 - an unreadable record is a cache miss
        return False


def _require_identity_refetch_budget(
    budget: RequestBudget,
    endpoint: str,
    context: str,
    attempts: int = 1,
) -> None:
    """Turn an unrefetchable identity mismatch into an artifact error.

    No HTTP attempt is made, so this is not BudgetExceededError's
    count-before-send path. acquire() records the RuntimeError against the
    artifact while siblings remain available.
    """
    used = budget.counts.get(endpoint, 0)
    ceiling = budget.ceilings.get(endpoint, 0)
    if used + attempts > ceiling:
        raise RuntimeError(
            f"{context}: cached request identity mismatch, and refetching "
            f"would require {attempts} request(s) beyond endpoint key "
            f"'{endpoint}' ceiling {ceiling} with {used} already spent "
            f"(S1_LANE_CONTRACT.md sections 4.3, 4.5, and 8)"
        )


def _record_download(
    dest: Path,
    sidecar: Path,
    extra: dict | None = None,
    *,
    request_identity: dict | None = None,
) -> None:
    record = {"sha256": _sha256_file(dest),
              "recorded": time.strftime("%Y-%m-%d")}
    if extra:
        record.update(extra)
    if request_identity is not None:
        record["requestIdentity"] = request_identity
    sidecar.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def _fetch_tiff(url: str, params: dict, timeout: float = 300.0) -> bytes:
    resp = requests.get(url, params=params,
                        headers={"User-Agent": _USER_AGENT}, timeout=timeout)
    resp.raise_for_status()
    body = resp.content
    if not body[:4] in _TIFF_MAGICS:
        excerpt = body[:300].decode("utf-8", errors="replace")
        raise RuntimeError(
            f"expected a TIFF from {url} but got non-TIFF content: {excerpt}"
        )
    return body


# Transient transport drops (connection broken mid-body, incomplete
# reads, timeouts). Server-side failures are deliberately excluded:
# an HTTP status error (the outage's 500 signature), a missing href,
# or a non-TIFF body must keep failing fast, never retry.
_TRANSIENT_FETCH_ERRORS = (
    requests.exceptions.ConnectionError,
    requests.exceptions.ChunkedEncodingError,
    requests.exceptions.Timeout,
)


def _fetch_tiff_two_step(
    url: str,
    params: dict,
    budget: RequestBudget,
    endpoint: str,
    timeout: float = 300.0,
    attempts: int = 3,
) -> bytes:
    """The DDM_LFPS_TWO_STEP stopgap transport: ask the ImageServer to
    render the export server-side (f=json), then fetch the rendered file
    from the returned href. The caller's budget spend covers the first
    f=json request; every other HTTP request here (the href fetch, and
    both requests of any retry) spends the same endpoint key itself
    BEFORE sending, so count-before-send holds per HTTP attempt. A
    transient transport drop (_TRANSIENT_FETCH_ERRORS) retries up to
    `attempts` total tries because one broken connection otherwise
    wastes a whole multi-hour cold build; server-side failures never
    retry. The href is fetched immediately: lfps output retention can
    be as short as minutes."""
    last_transient: Exception | None = None
    for attempt in range(attempts):
        if attempt > 0:
            budget.spend(endpoint)
        try:
            json_params = dict(params)
            json_params["f"] = "json"
            resp = requests.get(url, params=json_params,
                                headers={"User-Agent": _USER_AGENT},
                                timeout=timeout)
            resp.raise_for_status()
            payload = resp.json()
            href = payload.get("href") if isinstance(payload, dict) else None
            if not href or payload.get("error") is not None:
                raise RuntimeError(
                    f"f=json export from {url} returned no usable href: "
                    f"{str(payload)[:300]}"
                )
            budget.spend(endpoint)
            file_resp = requests.get(
                href, headers={"User-Agent": _USER_AGENT}, timeout=timeout)
            file_resp.raise_for_status()
            body = file_resp.content
            if not body[:4] in _TIFF_MAGICS:
                excerpt = body[:300].decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"expected a TIFF from {href} but got non-TIFF "
                    f"content: {excerpt}"
                )
            return body
        except _TRANSIENT_FETCH_ERRORS as err:
            last_transient = err
            core.log(
                f"  {endpoint} transient transport failure, attempt "
                f"{attempt + 1} of {attempts}: {err}"
            )
    assert last_transient is not None
    raise last_transient


def _fetch_tiff_with_transient_retry(
    url: str,
    params: dict,
    budget: RequestBudget,
    endpoint: str,
    timeout: float = 300.0,
    attempts: int = 3,
) -> bytes:
    """A single-request tile GET with the same bounded transient-drop
    retry contract as the two-step transport: the caller's spend covers
    the first attempt, every retry spends `endpoint` before re-sending,
    and server-side failures (HTTP status errors, non-TIFF bodies)
    propagate immediately without retry."""
    last_transient: Exception | None = None
    for attempt in range(attempts):
        if attempt > 0:
            budget.spend(endpoint)
        try:
            return _fetch_tiff(url, params, timeout)
        except _TRANSIENT_FETCH_ERRORS as err:
            last_transient = err
            core.log(
                f"  {endpoint} transient transport failure, attempt "
                f"{attempt + 1} of {attempts}: {err}"
            )
    assert last_transient is not None
    raise last_transient


def _fetch_cached_json(
    url: str,
    cache_name: str,
    budget: RequestBudget,
    *,
    params: dict | None = None,
) -> dict:
    """Fetch one metadata JSON document with digest-backed cache reuse."""
    DOWNLOAD_CACHE.mkdir(parents=True, exist_ok=True)
    dest = DOWNLOAD_CACHE / cache_name
    sidecar = Path(str(dest) + ".sha256.json")
    resolved_params = params or {"f": "json"}
    request_identity = _canonical_request_identity(
        url, query=resolved_params)
    if _download_complete(dest, sidecar, request_identity):
        return json.loads(dest.read_text(encoding="utf-8"))
    if _cache_identity_mismatch(dest, sidecar, request_identity):
        _require_identity_refetch_budget(
            budget, "metadata", f"metadata cache {cache_name}")
    budget.spend("metadata")
    resp = requests.get(
        url,
        params=resolved_params,
        headers={"User-Agent": _USER_AGENT},
        timeout=300,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict) or payload.get("error") is not None:
        raise RuntimeError(
            f"metadata response from {url} is not a usable JSON object: "
            f"{payload!r}"
        )
    dest.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    _record_download(
        dest,
        sidecar,
        {"url": url},
        request_identity=request_identity,
    )
    return payload


def lfps_nodata_record(key: str, budget: RequestBudget) -> dict:
    """Return the revision 10 nodata/padding mask receipt for a LANDFIRE
    ImageServer. The service metadata is cached under the metadata budget."""
    if key not in LFPS_IMAGE_SERVICES:
        raise ValueError(f"no LANDFIRE ImageServer metadata route for {key}")
    payload = _fetch_cached_json(
        LFPS_IMAGE_SERVICES[key],
        f"{key}-service-info.json",
        budget,
    )
    spatial_ref = payload.get("spatialReference") or {}
    wkid = spatial_ref.get("latestWkid", spatial_ref.get("wkid"))
    pixel_x = payload.get("pixelSizeX")
    pixel_y = payload.get("pixelSizeY")
    extent = payload.get("extent") or {}
    xmin = extent.get("xmin")
    ymax = extent.get("ymax")
    metadata_failures = []
    if wkid != 5070:
        metadata_failures.append(f"metadata WKID is {wkid!r}, not 5070")
    if (not isinstance(pixel_x, (int, float))
            or not isinstance(pixel_y, (int, float))
            or abs(abs(float(pixel_x)) - 30.0) > GRID_METADATA_TOL_M
            or abs(abs(float(pixel_y)) - 30.0) > GRID_METADATA_TOL_M):
        metadata_failures.append(
            f"metadata pixel sizes are ({pixel_x!r}, {pixel_y!r}), not "
            f"30 m within {GRID_METADATA_TOL_M} m"
        )
    if not isinstance(xmin, (int, float)) or not isinstance(ymax, (int, float)):
        metadata_failures.append(
            f"metadata extent lacks numeric xmin/ymax: {extent!r}")
        metadata_dx = metadata_dy = None
    else:
        metadata_dx = _lattice_distance(float(xmin), core.GRID_ANCHOR_X)
        metadata_dy = _lattice_distance(float(ymax), core.GRID_ANCHOR_Y)
        if (metadata_dx > GRID_METADATA_TOL_M
                or metadata_dy > GRID_METADATA_TOL_M):
            metadata_failures.append(
                f"metadata origin lattice distances are "
                f"({metadata_dx!r}, {metadata_dy!r}), beyond "
                f"{GRID_METADATA_TOL_M} m"
            )
    if metadata_failures:
        raise GridCongruenceError(
            f"{key} service metadata failed S1_LANE_CONTRACT.md section "
            f"2.2: " + "; ".join(metadata_failures)
        )
    candidates = [
        ("noDataValue", payload.get("noDataValue")),
        ("rasterInfo.noDataValue", (payload.get("rasterInfo") or {}).get(
            "noDataValue")),
    ]
    declared_field = None
    declared_value = None
    for field, value in candidates:
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            declared_field = field
            declared_value = int(value) if float(value).is_integer() else float(value)
            break
    mask_values: list[int | float] = []
    if declared_value is not None:
        mask_values.append(declared_value)
    # ArcGIS exportImage may use 0 for out-of-extent padding even when the
    # returned GeoTIFF omits a nodata tag. Revision 10 explicitly permits
    # masking that service behavior before the valid-cell domain assertion.
    if 0 not in mask_values:
        mask_values.append(0)
    return {
        "serviceUrl": LFPS_IMAGE_SERVICES[key],
        "declaredField": declared_field,
        "declaredValue": declared_value,
        "maskValues": mask_values,
        "stagingNodata": 0,
        "zeroPaddingRule": (
            "ArcGIS exportImage out-of-extent padding value allowed by "
            "S1_LANE_CONTRACT.md 4.3 revision 10"
        ),
        "metadataGridFacts": {
            "wkid": wkid,
            "pixelSizesXY": [pixel_x, pixel_y],
            "originEdgesXY": [xmin, ymax],
            "originLatticeDistances30m": [metadata_dx, metadata_dy],
            "toleranceM": GRID_METADATA_TOL_M,
            "result": "PASS",
        },
    }


def _stage_service_nodata(path: Path, key: str, record: dict) -> Path:
    """Declare and mask service nodata/padding without changing valid
    categorical values. The staged copy remains in the local cache."""
    mask_values = tuple(record["maskValues"])
    staging_nodata = record["stagingNodata"]
    with rasterio.open(path) as src:
        if src.nodata == staging_nodata and all(
                value == staging_nodata for value in mask_values):
            return path
        profile = src.profile.copy()
        source_dtype = src.dtypes[0]
    dest = DOWNLOAD_CACHE / f"{path.stem}.masked-{key}.tif"
    sidecar = Path(str(dest) + ".sha256.json")
    source_sha = _sha256_file(path)
    if _download_complete(dest, sidecar):
        try:
            saved = json.loads(sidecar.read_text(encoding="utf-8"))
            if (saved.get("sourceSha256") == source_sha
                    and saved.get("maskValues") == list(mask_values)
                    and saved.get("stagingNodata") == staging_nodata):
                return dest
        except Exception:  # noqa: BLE001 - restage on an invalid receipt
            pass
    profile.update(nodata=staging_nodata)
    tmp = Path(str(dest) + ".part")
    with rasterio.open(path) as src, rasterio.open(tmp, "w", **profile) as out:
        for _, window in src.block_windows(1):
            arr = src.read(1, window=window, masked=False)
            staged = arr.copy()
            for value in mask_values:
                staged[arr == value] = staging_nodata
            out.write(staged.astype(source_dtype, copy=False), 1, window=window)
    tmp.replace(dest)
    _record_download(dest, sidecar, {
        "sourceSha256": source_sha,
        "maskValues": list(mask_values),
        "stagingNodata": staging_nodata,
        "declaredField": record.get("declaredField"),
        "declaredValue": record.get("declaredValue"),
    })
    return dest


def _tile_ranges(total_cells: int, tile_cells: int) -> list[tuple[int, int]]:
    """Row-major-compatible 1-D tiling: (offset, size) pairs covering
    total_cells in chunks of at most tile_cells."""
    out = []
    off = 0
    while off < total_cells:
        size = min(tile_cells, total_cells - off)
        out.append((off, size))
        off += size
    return out


def _bounds_with_materialization_pad(
    bounds: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    minx, miny, maxx, maxy = bounds
    return (
        minx - MATERIALIZATION_PAD_M,
        miny - MATERIALIZATION_PAD_M,
        maxx + MATERIALIZATION_PAD_M,
        maxy + MATERIALIZATION_PAD_M,
    )


def _download_tiled_window(
    key: str,
    bounds_5070: tuple[float, float, float, float],
    budget: RequestBudget,
    tile_cells: int,
    request_fn,
    request_identity: dict,
) -> Path:
    """Download the snapped window for a 30 m source as one fixed,
    non-overlapping, anchor-congruent tile set (section 8 windowing rule),
    mosaicked to a single local GeoTIFF. request_fn(tile_bounds, width,
    height) -> bytes performs one HTTP request AFTER the budget spend
    (the DDM_LFPS_TWO_STEP stopgap transport performs two, spending the
    endpoint key itself before its second request)."""
    snapped = _snap_bounds_30(bounds_5070)
    minx, miny, maxx, maxy = snapped
    width = round((maxx - minx) / core.GRID_RES_M)
    height = round((maxy - miny) / core.GRID_RES_M)
    DOWNLOAD_CACHE.mkdir(parents=True, exist_ok=True)
    dest = DOWNLOAD_CACHE / f"{key}-{_bounds_tag(snapped)}.tif"
    sidecar = Path(str(dest) + ".sha256.json")
    resolved_identity = dict(request_identity)
    resolved_identity["snappedBounds5070"] = list(snapped)
    resolved_identity["tileCells"] = tile_cells
    if _download_complete(dest, sidecar, resolved_identity):
        return dest

    col_tiles = _tile_ranges(width, tile_cells)
    row_tiles = _tile_ranges(height, tile_cells)
    endpoint = ENDPOINT_KEYS[key]
    if _cache_identity_mismatch(dest, sidecar, resolved_identity):
        _require_identity_refetch_budget(
            budget,
            endpoint,
            f"{key} download cache",
            attempts=len(col_tiles) * len(row_tiles),
        )
    tile_paths: list[tuple[int, int, Path]] = []
    for row_off, tile_h in row_tiles:
        for col_off, tile_w in col_tiles:
            t_minx = minx + col_off * core.GRID_RES_M
            t_maxy = maxy - row_off * core.GRID_RES_M
            t_maxx = t_minx + tile_w * core.GRID_RES_M
            t_miny = t_maxy - tile_h * core.GRID_RES_M
            budget.spend(endpoint)
            body = request_fn((t_minx, t_miny, t_maxx, t_maxy), tile_w, tile_h)
            tpath = DOWNLOAD_CACHE / (
                f"{key}-{_bounds_tag(snapped)}-t{row_off}-{col_off}.part.tif"
            )
            tpath.write_bytes(body)
            tile_paths.append((row_off, col_off, tpath))
            with rasterio.open(tpath) as returned:
                assert_anchor_congruent_30m(
                    returned.crs,
                    returned.transform,
                    context=(
                        f"{key} service-returned tile at row {row_off}, "
                        f"column {col_off}"
                    ),
                    service_returned=True,
                )
                facts = grid_deviation_facts_30m(
                    returned.crs, returned.transform)
                core.log(
                    f"  {key} returned-tile grid deviations: "
                    f"{json.dumps(facts, sort_keys=True)}"
                )

    try:
        if len(tile_paths) == 1:
            tile_paths[0][2].replace(dest)
        else:
            _mosaic_tiles(dest, tile_paths, snapped, width, height)
    finally:
        for _, _, tpath in tile_paths:
            tpath.unlink(missing_ok=True)
    _record_download(
        dest, sidecar, request_identity=resolved_identity)
    return dest


def _mosaic_tiles(dest: Path, tile_paths, snapped, width, height) -> None:
    """Write congruent tiles into one GeoTIFF at integer cell offsets."""
    minx, _, _, maxy = snapped
    with rasterio.open(tile_paths[0][2]) as first:
        dtype = first.dtypes[0]
        nodata = first.nodata
        crs = first.crs
    profile = {
        "driver": "GTiff", "height": height, "width": width, "count": 1,
        "dtype": dtype, "crs": crs,
        "transform": from_origin(minx, maxy, core.GRID_RES_M, core.GRID_RES_M),
        "nodata": nodata, "tiled": True, "blockxsize": 512,
        "blockysize": 512, "compress": "deflate",
    }
    tmp = dest.with_name(dest.stem + ".part.tif")
    with rasterio.open(tmp, "w", **profile) as out:
        for row_off, col_off, tpath in tile_paths:
            with rasterio.open(tpath) as tds:
                arr = tds.read(1)
                out.write(arr, 1, window=rasterio.windows.Window(
                    col_off=col_off, row_off=row_off,
                    width=arr.shape[1], height=arr.shape[0]))
    tmp.replace(dest)


def _download_lfps(
    key: str,
    bounds_5070,
    budget: RequestBudget,
    url_override: str | None = None,
) -> Path:
    url = url_override or LFPS_EXPORTIMAGE[key]
    nodata_record = lfps_nodata_record(key, budget)
    two_step = _lfps_two_step_enabled()
    static_query = {
        "bboxSR": "5070",
        "imageSR": "5070",
        "format": "tiff",
        "pixelType": "S16",
        "interpolation": "RSP_NearestNeighbor",
        "f": "json" if two_step else "image",
    }
    selectors = {"product": key, "releaseCode": "240"}
    if two_step:
        selectors["transport"] = "f=json-two-step"
    request_identity = _canonical_request_identity(
        url,
        query=static_query,
        selectors=selectors,
    )
    endpoint = ENDPOINT_KEYS[key]

    def request_fn(tile_bounds, width, height) -> bytes:
        minx, miny, maxx, maxy = tile_bounds
        query = {
            "bbox": f"{minx},{miny},{maxx},{maxy}",
            **static_query,
            "size": f"{width},{height}",
        }
        if two_step:
            return _fetch_tiff_two_step(url, query, budget, endpoint)
        return _fetch_tiff(url, query)

    downloaded = _download_tiled_window(
        key,
        _bounds_with_materialization_pad(bounds_5070),
        budget,
        LFPS_TILE_CELLS,
        request_fn,
        request_identity,
    )
    return _stage_service_nodata(downloaded, key, nodata_record)


def _download_nlcd(
    bounds_5070,
    budget: RequestBudget,
    url_override: str | None = None,
) -> Path:
    url = url_override or MRLC_WCS_URL
    static_query = {
        "service": "WCS",
        "version": "1.0.0",
        "request": "GetCoverage",
        "coverage": NLCD_COVERAGE,
        "crs": "EPSG:5070",
        "response_crs": "EPSG:5070",
        "time": NLCD_TIME,
        "format": "GeoTIFF",
    }
    request_identity = _canonical_request_identity(
        url,
        query=static_query,
        selectors={"collection": NLCD_COLLECTION},
    )

    def request_fn(tile_bounds, width, height) -> bytes:
        minx, miny, maxx, maxy = tile_bounds
        return _fetch_tiff_with_transient_retry(url, {
            **static_query,
            "bbox": f"{minx},{miny},{maxx},{maxy}",
            "width": str(width),
            "height": str(height),
        }, budget, ENDPOINT_KEYS["landcover-nlcd"])

    return _download_tiled_window(
        "landcover-nlcd",
        _bounds_with_materialization_pad(bounds_5070),
        budget,
        MRLC_TILE_CELLS,
        request_fn,
        request_identity,
    )


def download_whp_zip(
    budget: RequestBudget,
    time_budget_s: float = WHP_DOWNLOAD_TIME_BUDGET_S,
    url: str = WHP_ZIP_URL,
) -> Path:
    """Fetch the WHP edition-4 ZIP once into the local cache (contract
    3.1 retention insurance: the ZIP is retained with recorded
    Content-Length, Last-Modified, and locally computed sha256).
    Re-invokable: a completed download with a matching recorded digest is
    reused without an HTTP attempt; a partial file resumes via an HTTP
    Range request (a fresh budget spend). Raises WhpDownloadIncomplete
    when the per-invocation time budget elapses mid-stream."""
    DOWNLOAD_CACHE.mkdir(parents=True, exist_ok=True)
    if url == WHP_ZIP_URL:
        name = "RDS-2015-0047-4_Data.zip"
    else:
        tag = hashlib.sha256(url.encode()).hexdigest()[:12]
        name = f"RDS-2015-0047-4_Data-{tag}.zip"
    dest = DOWNLOAD_CACHE / name
    sidecar = Path(str(dest) + ".sha256.json")
    request_identity = {"url": url}
    if _download_complete(dest, sidecar, request_identity):
        return dest
    if _cache_identity_mismatch(dest, sidecar, request_identity):
        _require_identity_refetch_budget(
            budget, "rds-whp-zip", "hazard-whp ZIP cache")
    part = Path(str(dest) + ".part")
    resume_at = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": _USER_AGENT}
    if resume_at:
        headers["Range"] = f"bytes={resume_at}-"
    budget.spend("rds-whp-zip")
    resp = requests.get(url, headers=headers, stream=True,
                        timeout=(30, 300))
    resp.raise_for_status()
    if resume_at and resp.status_code != 206:
        core.log("  WHP zip: server ignored the Range request; restarting")
        resume_at = 0
        part.unlink(missing_ok=True)
    content_length = resp.headers.get("Content-Length")
    last_modified = resp.headers.get("Last-Modified")
    total = (int(content_length) + resume_at) if content_length else None
    started = time.monotonic()
    mode = "ab" if resume_at else "wb"
    with open(part, mode) as fh:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            fh.write(chunk)
            if time.monotonic() - started > time_budget_s:
                resp.close()
                raise WhpDownloadIncomplete(
                    f"WHP zip download hit the per-invocation time budget "
                    f"({time_budget_s:.0f}s) at {part.stat().st_size} of "
                    f"{total if total is not None else 'unknown'} bytes; "
                    f"re-invoke the capture to resume (the resume spends "
                    f"rds-whp-zip again)"
                )
    if total is not None and part.stat().st_size != total:
        raise RuntimeError(
            f"WHP zip download ended short: {part.stat().st_size} of "
            f"{total} bytes (re-invoke to resume)"
        )
    part.replace(dest)
    _record_download(dest, sidecar, {
        "url": url,
        "contentLength": total,
        "lastModified": last_modified,
    }, request_identity=request_identity)
    return dest


def extract_whp_classified_tif(zip_path: Path) -> Path:
    """Extract the single classified CONUS GeoTIFF member from the WHP
    edition-4 ZIP into the download cache; loud failure listing members
    when the expected single match is not found."""
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [
            n for n in zf.namelist()
            if n.lower().endswith(".tif")
            and "cls" in Path(n).name.lower()
            and "conus" in Path(n).name.lower()
        ]
        if len(candidates) != 1:
            raise RuntimeError(
                f"expected exactly one classified CONUS .tif in "
                f"{zip_path.name}, found {len(candidates)}: {candidates}; "
                f"all members: {zf.namelist()}"
            )
        member = candidates[0]
        info = zf.getinfo(member)
        out = DOWNLOAD_CACHE / Path(member).name
        if out.exists() and out.stat().st_size == info.file_size:
            return out
        tmp = Path(str(out) + ".part")
        with zf.open(member) as src, open(tmp, "wb") as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
        tmp.replace(out)
        return out


def stage_categorical_for_materialization(
    source_path: Path, key: str,
) -> tuple[Path, dict]:
    """Create a lossless float32 categorical view when integer nodata
    would trigger core's masked-array NaN fill limitation."""
    source_sha = _sha256_file(source_path)
    tag = source_sha[:12]
    dest = DOWNLOAD_CACHE / f"{source_path.stem}-{tag}.float32.tif"
    receipt_path = DOWNLOAD_CACHE / f"{source_path.stem}-{tag}.dtype.json"
    with rasterio.open(source_path) as src:
        dtype = src.dtypes[0]
        nodata = src.nodata
        if dtype == "float32" and (
                nodata is None or math.isnan(float(nodata))):
            return source_path, {
                "sourceDtype": dtype,
                "materializationDtype": dtype,
                "sourceNodata": nodata,
                "valueIdentityCheck": "not required; already float32",
                "nodataMaskIdentityCheck": "not required; already float32",
            }
        if not np.issubdtype(np.dtype(dtype), np.integer):
            raise RuntimeError(
                f"{key}: unsupported categorical source dtype {dtype!r} "
                "for lossless staging"
            )
        if nodata is None or not float(nodata).is_integer():
            raise RuntimeError(
                f"{key}: integer categorical staging requires an integer "
                f"nodata declaration, got {nodata!r}"
            )
        nodata_int = int(nodata)
        profile = src.profile.copy()

    if not dest.exists():
        profile.update(dtype="float32", nodata=float("nan"),
                       compress="deflate", predictor=3)
        tmp = Path(str(dest) + ".part")
        with rasterio.open(source_path) as src, rasterio.open(
                tmp, "w", **profile) as out:
            for _, window in src.block_windows(1):
                original = src.read(1, window=window, masked=False)
                staged = original.astype("float32")
                staged[original == nodata_int] = np.nan
                valid = original != nodata_int
                if not np.array_equal(
                        original[valid].astype("int64"),
                        staged[valid].astype("int64")):
                    raise RuntimeError(
                        f"{key}: integer to float32 valid-value identity "
                        "check failed"
                    )
                out.write(staged, 1, window=window)
        tmp.replace(dest)

    with rasterio.open(source_path) as src, rasterio.open(dest) as staged_ds:
        if (staged_ds.dtypes[0] != "float32"
                or staged_ds.crs != src.crs
                or staged_ds.transform != src.transform
                or staged_ds.width != src.width
                or staged_ds.height != src.height):
            raise RuntimeError(
                f"{key}: cached float32 staging header failed identity "
                "validation"
            )
        for _, window in src.block_windows(1):
            original = src.read(1, window=window, masked=False)
            staged = staged_ds.read(1, window=window, masked=False)
            valid = original != nodata_int
            if (not np.array_equal(np.isnan(staged), ~valid)
                    or not np.array_equal(
                        original[valid].astype("int64"),
                        staged[valid].astype("int64"))):
                raise RuntimeError(
                    f"{key}: cached float32 staging failed the value/mask "
                    "identity check"
                )

    receipt = {
        "sourcePath": str(source_path),
        "sourceSha256": source_sha,
        "sourceDtype": dtype,
        "sourceNodata": nodata_int,
        "materializationPath": str(dest),
        "materializationDtype": "float32",
        "materializationNodata": "NaN",
        "valueIdentityCheck": "PASS for every valid pixel",
        "nodataMaskIdentityCheck": "PASS for every pixel",
    }
    receipt_path.write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return dest, receipt


def stage_whp_for_materialization(source_path: Path) -> tuple[Path, dict]:
    """Create and verify the revision 10 lossless WHP dtype staging.

    The downloaded uint8 values first widen bit-identically to int16 with
    the integer nodata declared. Core's current masked read also cannot fill
    an int16 masked array with NaN, so a second lossless float32 view maps
    only nodata to NaN and preserves every valid integer exactly. Core then
    materializes from that view. Both copies live in the local cache.
    """
    source_sha = _sha256_file(source_path)
    tag = source_sha[:12]
    int16_path = DOWNLOAD_CACHE / f"{source_path.stem}-{tag}.int16.tif"
    float_path = DOWNLOAD_CACHE / f"{source_path.stem}-{tag}.float32.tif"
    receipt_path = DOWNLOAD_CACHE / f"{source_path.stem}-{tag}.dtype.json"

    with rasterio.open(source_path) as src:
        source_dtype = src.dtypes[0]
        source_nodata = src.nodata
        if source_dtype not in ("uint8", "int8", "uint16"):
            if source_dtype == "float32" and (
                    source_nodata is None or math.isnan(source_nodata)):
                return source_path, {
                    "sourceDtype": source_dtype,
                    "materializationDtype": source_dtype,
                    "sourceNodata": source_nodata,
                    "valueIdentityCheck": "not required; already float32",
                }
            raise RuntimeError(
                f"hazard-whp: unsupported source dtype {source_dtype!r} for "
                "the revision 10 lossless staging path"
            )
        if source_nodata is None or not float(source_nodata).is_integer():
            raise RuntimeError(
                f"hazard-whp: lossless dtype staging requires an integer "
                f"source nodata value, got {source_nodata!r}"
            )
        nodata_int = int(source_nodata)
        profile = src.profile.copy()

    if not int16_path.exists():
        p16 = profile.copy()
        p16.update(dtype="int16", nodata=nodata_int, compress="deflate")
        tmp16 = Path(str(int16_path) + ".part")
        with rasterio.open(source_path) as src, rasterio.open(
                tmp16, "w", **p16) as out:
            for _, window in src.block_windows(1):
                original = src.read(1, window=window, masked=False)
                widened = original.astype("int16")
                if not np.array_equal(original.astype("int64"),
                                      widened.astype("int64")):
                    raise RuntimeError(
                        "hazard-whp: uint8 to int16 value-identity check "
                        "failed (S1_LANE_CONTRACT.md 4.3 revision 10)"
                    )
                out.write(widened, 1, window=window)
        tmp16.replace(int16_path)

    # Verify the retained int16 copy even when it was reused from cache.
    with rasterio.open(source_path) as src, rasterio.open(int16_path) as wide:
        if (wide.dtypes[0] != "int16" or wide.nodata != nodata_int
                or wide.crs != src.crs or wide.transform != src.transform
                or wide.width != src.width or wide.height != src.height):
            raise RuntimeError(
                "hazard-whp: cached int16 staging header failed identity "
                "validation (S1_LANE_CONTRACT.md 4.3 revision 10)"
            )
        for _, window in src.block_windows(1):
            original = src.read(1, window=window, masked=False)
            widened = wide.read(1, window=window, masked=False)
            if not np.array_equal(original.astype("int64"),
                                  widened.astype("int64")):
                raise RuntimeError(
                    "hazard-whp: cached int16 staging values are not "
                    "bit-identical to the uint8 source"
                )

    if not float_path.exists():
        pf = profile.copy()
        pf.update(dtype="float32", nodata=float("nan"), compress="deflate",
                  predictor=3)
        tmpf = Path(str(float_path) + ".part")
        with rasterio.open(int16_path) as src, rasterio.open(
                tmpf, "w", **pf) as out:
            for _, window in src.block_windows(1):
                widened = src.read(1, window=window, masked=False)
                staged = widened.astype("float32")
                staged[widened == nodata_int] = np.nan
                valid = widened != nodata_int
                if not np.array_equal(
                        widened[valid].astype("int64"),
                        staged[valid].astype("int64")):
                    raise RuntimeError(
                        "hazard-whp: int16 to float32 value-identity check "
                        "failed (S1_LANE_CONTRACT.md 4.3 revision 10)"
                    )
                out.write(staged, 1, window=window)
        tmpf.replace(float_path)

    with rasterio.open(int16_path) as wide, rasterio.open(float_path) as stage:
        if (stage.dtypes[0] != "float32" or stage.crs != wide.crs
                or stage.transform != wide.transform
                or stage.width != wide.width or stage.height != wide.height):
            raise RuntimeError(
                "hazard-whp: float32 materialization view failed header "
                "identity validation"
            )
        for _, window in wide.block_windows(1):
            widened = wide.read(1, window=window, masked=False)
            staged = stage.read(1, window=window, masked=False)
            valid = widened != nodata_int
            if (not np.array_equal(np.isnan(staged), ~valid)
                    or not np.array_equal(
                        widened[valid].astype("int64"),
                        staged[valid].astype("int64"))):
                raise RuntimeError(
                    "hazard-whp: float32 materialization view failed the "
                    "value/mask identity check"
                )

    receipt = {
        "sourcePath": str(source_path),
        "sourceSha256": source_sha,
        "sourceDtype": source_dtype,
        "sourceNodata": nodata_int,
        "widenedPath": str(int16_path),
        "widenedDtype": "int16",
        "widenedNodata": nodata_int,
        "materializationPath": str(float_path),
        "materializationDtype": "float32",
        "materializationNodata": "NaN",
        "valueIdentityCheck": "PASS for every valid pixel",
        "nodataMaskIdentityCheck": "PASS for every pixel",
    }
    receipt_path.write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return float_path, receipt


def _fetch_evt_attribute_table(
    budget: RequestBudget,
    url: str = EVT_ATTRIBUTE_TABLE_URL,
) -> Path:
    """Fetch the EVT raster attribute table (metadata budget) and write
    the frozen code-to-name JSON mapping into the download cache."""
    DOWNLOAD_CACHE.mkdir(parents=True, exist_ok=True)
    suffix = "" if url == EVT_ATTRIBUTE_TABLE_URL else (
        "-" + hashlib.sha256(url.encode()).hexdigest()[:12])
    dest = DOWNLOAD_CACHE / f"evt-attributes{suffix}.json"
    sidecar = Path(str(dest) + ".sha256.json")
    request_identity = _canonical_request_identity(
        url,
        query={"f": "pjson"},
        selectors={"valueField": "VALUE", "nameField": "EVT_NAME"},
    )
    if _download_complete(dest, sidecar, request_identity):
        return dest
    if _cache_identity_mismatch(dest, sidecar, request_identity):
        _require_identity_refetch_budget(
            budget, "metadata", "fuels-evt-attributes cache")
    # One corrected retry only. pjson is the ArcGIS REST operation's
    # explicit JSON representation; an empty/unavailable response takes
    # contract 4.6's dominantName-null path rather than burning metadata
    # budget on endpoint hunting.
    payload = _fetch_cached_json(
        url,
        f"evt-raster-attribute-table-response{suffix}.json",
        budget,
        params={"f": "pjson"},
    )
    fields = payload.get("fields") or payload.get(
        "rasterAttributeTable", {}).get("fields")
    features = payload.get("features") or payload.get(
        "rasterAttributeTable", {}).get("features")
    if not fields or not features:
        service_info = _fetch_cached_json(
            LFPS_IMAGE_SERVICES["fuels-evt"],
            "fuels-evt-service-info.json",
            budget,
        )
        raise RuntimeError(
            f"rasterAttributeTable response missing fields/features; "
            f"top-level keys: {list(payload.keys())}; service metadata "
            f"hasRasterAttributeTable="
            f"{service_info.get('hasRasterAttributeTable')!r}. The "
            f"contract 4.6 dominantName-null path is required."
        )
    names = [f.get("name", "") for f in fields]
    value_field = next((n for n in names if n.upper() == "VALUE"), None)
    name_field = next((n for n in names if n.upper() == "EVT_NAME"), None)
    if value_field is None or name_field is None:
        raise RuntimeError(
            f"rasterAttributeTable lacks VALUE/EVT_NAME fields; got {names}"
        )
    mapping: dict[str, str] = {}
    for feat in features:
        attrs = feat.get("attributes", {})
        code = attrs.get(value_field)
        name = attrs.get(name_field)
        if code is None or name is None:
            continue
        mapping[str(int(code))] = str(name)
    validate_evt_attributes(mapping)
    dest.write_text(
        json.dumps(mapping, indent=2, ensure_ascii=False, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    _record_download(
        dest,
        sidecar,
        {"url": url},
        request_identity=request_identity,
    )
    return dest


# --------------------------------------------------------------------------
# Contract B: acquire (contract 4.3)
# --------------------------------------------------------------------------

def acquire(
    bounds_5070: tuple[float, float, float, float],
    cache_dir: Path,
    budget: RequestBudget,
    *,
    sources: dict[str, str] | None = None,
) -> dict[str, dict]:
    """Checked acquisition for the land-cover + fuels family: one
    prepared-artifact entry per frozen key (contract 4.6). Per raster
    artifact, in order: download (or accept a local source override, the
    fixture and fallback seam), the congruence assertion (contract 2.2
    for the 30 m natives; the contract 5.3 checked precondition for WHP),
    then core.materialize_raster(..., categorical=True) as the single
    entry point onto the analysis grid, then the contract 4.3 float32
    exactness assertion. One attempt per artifact per call: a source
    failure is that artifact's error and the function continues;
    BudgetExceededError propagates."""
    overrides = dict(sources or {})
    prepared: dict[str, dict] = {}
    for key in ARTIFACT_KEYS:
        kind = ARTIFACT_KINDS[key]
        try:
            if kind == "attributes":
                prepared[key] = _acquire_attributes(key, budget,
                                                    overrides.get(key))
            else:
                prepared[key] = _acquire_raster(key, bounds_5070, cache_dir,
                                                budget, overrides.get(key))
        except BudgetExceededError:
            raise
        except WhpDownloadIncomplete:
            raise
        except Exception as exc:  # noqa: BLE001 - per-artifact error record
            core.log(f"  {key}: acquisition failed: {exc}")
            prepared[key] = _entry(kind, error=str(exc))
    return prepared


def _resolve_local_source(
    key: str,
    bounds_5070,
    budget: RequestBudget,
    override,
) -> tuple[Path, bool]:
    """Resolve source bytes and their acquisition provenance.

    The boolean is true only for the HTTP coverage-service acquisition
    route, including a digest-and-identity-validated cache entry produced
    by that route. A local path is always local and therefore receives the
    strict contract 2.2 tolerance, regardless of filename or URL syntax.
    """
    if override is not None and not _is_url(override):
        p = Path(override)
        if not p.exists():
            raise FileNotFoundError(f"{key}: local source {p} does not exist")
        return p, False
    url_override = str(override) if override is not None else None
    if key in ("fuels-fbfm40", "fuels-evt"):
        return _download_lfps(key, bounds_5070, budget, url_override), True
    if key == "landcover-nlcd":
        return _download_nlcd(bounds_5070, budget, url_override), True
    if key == "hazard-whp":
        last_transient: Exception | None = None
        zip_path: Path | None = None
        for attempt in range(3):
            try:
                zip_path = download_whp_zip(
                    budget, url=url_override or WHP_ZIP_URL)
                break
            except _TRANSIENT_FETCH_ERRORS as err:
                # The .part file persists across attempts, so the next
                # call Range-resumes from the received bytes.
                # download_whp_zip spends rds-whp-zip itself per attempt;
                # the section 8 ceiling stays the hard cap.
                last_transient = err
                core.log(
                    f"  hazard-whp transient transport failure, attempt "
                    f"{attempt + 1} of 3: {err}")
        if zip_path is None:
            assert last_transient is not None
            raise last_transient
        return extract_whp_classified_tif(zip_path), False
    raise ValueError(f"unknown raster artifact key {key}")


def _acquire_raster(key: str, bounds_5070, cache_dir: Path,
                    budget: RequestBudget, override) -> dict:
    local_src, service_returned = _resolve_local_source(
        key, bounds_5070, budget, override)
    with rasterio.open(local_src) as src:
        if key == "hazard-whp":
            facts = whp_geometry_facts(src.crs, src.transform)
            core.log(f"  hazard-whp source geometry facts: "
                     f"{json.dumps(facts)}")
            check_whp_precondition(src.crs, src.transform)
        else:
            assert_anchor_congruent_30m(
                src.crs, src.transform,
                context=f"{key} source {Path(str(local_src)).name}",
                service_returned=service_returned,
            )
    if key in LFPS_IMAGE_SERVICES:
        with rasterio.open(local_src) as src:
            existing_nodata = src.nodata
        local_record = {
            "declaredField": (
                "GeoTIFF nodata tag" if existing_nodata is not None else None
            ),
            "declaredValue": existing_nodata,
            "maskValues": list(dict.fromkeys(
                [value for value in (existing_nodata, 0)
                 if value is not None]
            )),
            "stagingNodata": 0,
        }
        local_src = _stage_service_nodata(local_src, key, local_record)
    _assert_integral_in_domain(local_src, key)
    materialization_src = local_src
    if key == "hazard-whp":
        materialization_src, staging = stage_whp_for_materialization(local_src)
    else:
        materialization_src, staging = stage_categorical_for_materialization(
            local_src, key)
    core.log(
        f"  {key} lossless dtype staging: "
        + json.dumps(staging, sort_keys=True)
    )
    materialized = core.materialize_raster(
        str(materialization_src), tuple(bounds_5070), cache_dir, key,
        categorical=True,
    )
    omin, omax = _assert_integral_in_domain(materialized, key)
    core.log(f"  {key}: observed class range [{omin}, {omax}]")
    return _entry(
        "raster",
        path=materialized,
        acquired=core.acquisition_date(materialized),
        sha256=core.materialized_sha256(materialized),
    )


def _acquire_attributes(key: str, budget: RequestBudget, override) -> dict:
    if override is not None and not _is_url(override):
        p = Path(override)
        if not p.exists():
            raise FileNotFoundError(f"{key}: local source {p} does not exist")
        obj = json.loads(p.read_text(encoding="utf-8"))
        validate_evt_attributes(obj)
        local = p
    else:
        local = _fetch_evt_attribute_table(
            budget,
            str(override) if override is not None else EVT_ATTRIBUTE_TABLE_URL,
        )
    return _entry(
        "attributes",
        path=local,
        acquired=time.strftime("%Y-%m-%d"),
        sha256=_sha256_file(local),
    )


# --------------------------------------------------------------------------
# Contract B: aggregate (contract 4.4)
# --------------------------------------------------------------------------

class _DomainError(RuntimeError):
    """Observed per-polygon class values violated the published domain."""


def _revalidate_raster(entry: dict, key: str) -> str | None:
    """Contract 4.4 revalidation of a prepared raster artifact (CRS
    EPSG:5070, congruent transform, 30 m cells; contract 2.2). Returns an
    error string, or None when usable."""
    if entry is None:
        return f"{key}: artifact missing from prepared set"
    if entry.get("kind") != "raster":
        return f"{key}: prepared artifact kind is not raster"
    if entry.get("error") is not None:
        return f"{key}: {entry['error']}"
    path = entry.get("path")
    if path is None or not Path(path).exists():
        return f"{key}: prepared raster path {path} does not exist"
    try:
        with rasterio.open(path) as ds:
            assert_anchor_congruent_30m(
                ds.crs, ds.transform, context=f"{key} prepared raster")
    except GridCongruenceError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001 - unreadable raster is an error
        return f"{key}: prepared raster unreadable: {exc}"
    return None


def _revalidate_attributes(entry: dict) -> tuple[dict | None, str | None]:
    """Contract 4.4 revalidation of fuels-evt-attributes: sha256 identity
    against the recorded digest PLUS the contract 4.7 structural
    validation. Returns (mapping, None) or (None, reason). The reason is
    for SOURCES.md and logs only; it is never serialized (contract 4.6)."""
    key = "fuels-evt-attributes"
    if entry is None:
        return None, f"{key}: artifact missing from prepared set"
    if entry.get("kind") != "attributes":
        return None, f"{key}: prepared artifact kind is not attributes"
    if entry.get("error") is not None:
        return None, f"{key}: {entry['error']}"
    path = entry.get("path")
    if path is None or not Path(path).exists():
        return None, f"{key}: file {path} does not exist"
    recorded = entry.get("sha256")
    actual = _sha256_file(Path(path))
    if recorded != actual:
        return None, (
            f"{key}: sha256 mismatch (recorded {recorded}, actual {actual})"
        )
    try:
        obj = json.loads(Path(path).read_text(encoding="utf-8"))
        validate_evt_attributes(obj)
    except Exception as exc:  # noqa: BLE001 - structural failure is an error
        return None, f"{key}: structural validation failed: {exc}"
    return obj, None


def _polygon_class_stats(ds, one_row: gpd.GeoDataFrame, geom, key: str):
    """Per-polygon categorical read: class fractions of the sub-source's
    VALID (non-nodata) covered area, the polygon-weighted valid coverage
    percent, and the effective (partial-pixel) valid 30 m cell count.
    Returns None when the polygon covers no valid cells."""
    arr, transform = core.read_window(ds, geom.bounds)
    validity = np.isfinite(arr).astype("float32")
    mf = core.memdataset(validity, transform)
    try:
        with mf.open() as vds:
            vrow = exact_extract(vds, one_row, ["mean"], output="pandas").iloc[0]
    finally:
        mf.close()
    coverage_frac = float(vrow["mean"]) if np.isfinite(vrow["mean"]) else 0.0

    mf2 = core.memdataset(arr, transform)
    try:
        with mf2.open() as cds:
            crow = exact_extract(cds, one_row, ["unique", "frac", "count"],
                                 output="pandas").iloc[0]
    finally:
        mf2.close()
    count = float(crow["count"]) if np.isfinite(crow["count"]) else 0.0
    if count <= 0.0:
        return None
    uniques = np.atleast_1d(np.asarray(crow["unique"], dtype="float64"))
    fracs_arr = np.atleast_1d(np.asarray(crow["frac"], dtype="float64"))
    lo, hi = CLASS_DOMAINS[key]
    if not np.all(uniques == np.round(uniques)):
        raise _DomainError(
            f"{key}: non-integral class values in polygon read "
            f"(S1_LANE_CONTRACT.md 4.3)"
        )
    if uniques.size and (float(uniques.min()) < lo or float(uniques.max()) > hi):
        raise _DomainError(
            f"{key}: class values outside the published domain [{lo}, {hi}] "
            f"in polygon read: min {float(uniques.min())}, "
            f"max {float(uniques.max())} (S1_LANE_CONTRACT.md 4.3)"
        )
    fracs = {int(round(v)): float(f) for v, f in zip(uniques, fracs_arr)}
    return fracs, 100.0 * coverage_frac, count


def _dominant(fracs: dict[int, float]) -> tuple[int, float]:
    """Modal class: largest fraction; ties break to the smaller code
    (the section 5 sort convention applied to the modal pick)."""
    code = min(fracs, key=lambda c: (-fracs[c], c))
    return code, fracs[code]


def _assert_partition(
    unrounded: list[float], serialized: list[float], context: str,
) -> None:
    if abs(sum(unrounded) - 1.0) > 1e-9:
        raise ValueError(
            f"{context}: unrounded fractions do not partition to 1 "
            f"within 1e-9 (sum {sum(unrounded)!r})"
        )
    tolerance = len(serialized) * 0.0005 + 1e-9
    if abs(sum(serialized) - 1.0) > tolerance:
        raise ValueError(
            f"{context}: serialized fractions do not partition to 1 "
            f"within {tolerance} (sum {sum(serialized)!r})"
        )


def _fbfm40_block(fracs: dict[int, float], coverage_pct: float) -> dict:
    nonburnable = sum(f for c, f in fracs.items()
                      if c in FBFM40_NONBURNABLE_CODES)
    burnable = {c: f for c, f in fracs.items()
                if c not in FBFM40_NONBURNABLE_CODES}
    if burnable:
        dom_code, dom_frac = _dominant(burnable)
        dominant_code = dom_code
        dominant_fraction = core.round_or_none(dom_frac, 3)
    else:
        dominant_code = None
        dominant_fraction = None
    listed = [(c, f) for c, f in burnable.items()
              if f >= FBFM40_CLASS_LIST_MIN_FRACTION]
    listed.sort(key=lambda cf: (-cf[1], cf[0]))
    other_burnable = sum(burnable.values()) - sum(f for _, f in listed)
    serialized_nonburnable = core.round_or_none(nonburnable, 3)
    serialized_listed = [core.round_or_none(f, 3) for _, f in listed]
    serialized_other = core.round_or_none(other_burnable, 3)
    _assert_partition(
        [nonburnable, *(f for _, f in listed), other_burnable],
        [serialized_nonburnable, *serialized_listed, serialized_other],
        "fbfm40",
    )
    return {
        "dominantCode": dominant_code,
        "dominantFraction": dominant_fraction,
        "nonburnableFraction": serialized_nonburnable,
        "classes": [
            {"code": c, "fraction": serialized}
            for (c, _), serialized in zip(listed, serialized_listed)
        ],
        "otherBurnableFraction": serialized_other,
        "coveragePct": core.round_or_none(coverage_pct, 1),
    }


def _evt_block(fracs: dict[int, float], coverage_pct: float,
               attr_map: dict | None, code: str) -> dict:
    dom_code, dom_frac = _dominant(fracs)
    dominant_name = None
    if attr_map is not None:
        dominant_name = attr_map.get(str(dom_code))
        if dominant_name is None:
            core.log(
                f"  evt {code}: dominant code {dom_code} not present in "
                f"the EVT attribute table; dominantName is null "
                f"(reason recorded here and in SOURCES.md only, never "
                f"serialized; S1_LANE_CONTRACT.md 4.6)"
            )
    return {
        "dominantCode": dom_code,
        "dominantName": dominant_name,
        "dominantFraction": core.round_or_none(dom_frac, 3),
        "coveragePct": core.round_or_none(coverage_pct, 1),
    }


def _landcover_block(fracs: dict[int, float], coverage_pct: float) -> dict:
    def subset(codes: frozenset[int]) -> float:
        return sum(f for c, f in fracs.items() if c in codes)

    values = [
        subset(NLCD_FOREST_CODES),
        subset(NLCD_CROPLAND_CODES),
        subset(NLCD_WETLAND_CODES),
        subset(NLCD_OPEN_WATER_CODES),
    ]
    serialized = [core.round_or_none(value, 3) for value in values]
    if sum(values) > 1.0 + 1e-9:
        raise ValueError(
            f"landcover disjoint-subset sum exceeds 1: {sum(values)!r}"
        )
    if sum(serialized) > 1.0 + 4 * 0.0005:
        raise ValueError(
            "landcover serialized disjoint-subset sum exceeds the "
            "contract 5.3 bound"
        )
    return {
        "forestFraction": serialized[0],
        "croplandFraction": serialized[1],
        "wetlandFraction": serialized[2],
        "openWaterFraction": serialized[3],
        "coveragePct": core.round_or_none(coverage_pct, 1),
    }


def _whp_block(fracs: dict[int, float], coverage_pct: float,
               count_30m: float) -> dict:
    ordinal_total = sum(fracs.get(c, 0.0) for c in WHP_ORDINAL_CLASSES)
    ordinal_present = any(c in fracs for c in WHP_ORDINAL_CLASSES)
    if ordinal_present and ordinal_total > 0.0:
        class_mean = sum(
            c * fracs.get(c, 0.0) for c in WHP_ORDINAL_CLASSES
        ) / ordinal_total
    else:
        class_mean = None
    effective_270 = count_30m / WHP_CELLS_PER_SOURCE_CELL
    unrounded_fractions = [fracs.get(c, 0.0) for c in WHP_ALL_CLASSES]
    serialized_fractions = [
        core.round_or_none(value, 3) for value in unrounded_fractions
    ]
    _assert_partition(
        unrounded_fractions, serialized_fractions, "whp classFractions")
    return {
        "classMean": core.round_or_none(class_mean, 2),
        "classFractions": {
            str(c): value
            for c, value in zip(WHP_ALL_CLASSES, serialized_fractions)
        },
        "cellCount": core.round_or_none(effective_270, 1),
        # coarse decides on the UNROUNDED effective cell count (see the
        # module docstring; the soil block's stated convention).
        "coarse": effective_270 < WHP_COARSE_CELL_THRESHOLD,
        "coveragePct": core.round_or_none(coverage_pct, 1),
    }


def aggregate(
    gdf: gpd.GeoDataFrame,
    code_field: str,
    *,
    prepared: dict[str, dict],
    run_info: dict | None = None,
) -> dict:
    """Per-polygon land-cover + fuels block (the contract 5.3 frozen
    shape's four sub-blocks, each independently stats-or-unavailable per
    its required artifacts). NEVER fetches and NEVER materializes;
    prepared is exactly the acquire() return shape (the orchestrator
    path and the fixture path go through the same validation). Returns a
    dict keyed by code_field values, one entry per input row."""
    if run_info is not None:
        for key, stem in RUN_INFO_STEMS.items():
            entry = prepared.get(key)
            if entry is not None:
                run_info[f"{stem}Acquired"] = entry.get("acquired")
                run_info[f"{stem}RasterSha256"] = entry.get("sha256")

    raster_errors: dict[str, str | None] = {
        key: _revalidate_raster(prepared.get(key), key)
        for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd",
                    "hazard-whp")
    }
    attr_map, attr_reason = _revalidate_attributes(
        prepared.get("fuels-evt-attributes"))
    if attr_reason is not None:
        core.log(f"  {attr_reason} (dominantName will serialize as null; "
                 f"the reason is recorded in logs and SOURCES.md only)")

    datasets: dict[str, rasterio.DatasetReader] = {}
    try:
        for key, err in raster_errors.items():
            if err is None:
                datasets[key] = rasterio.open(prepared[key]["path"])

        out: dict = {}
        n = len(gdf)
        for i, (_, row) in enumerate(gdf.iterrows(), start=1):
            code = row[code_field]
            geom = row.geometry
            if geom is None or geom.is_empty:
                out[code] = {"unavailable": True, "reason": "empty geometry"}
                continue
            one_row = gdf.iloc[[i - 1]]
            block: dict = {}
            for sub_name, key in (
                ("fbfm40", "fuels-fbfm40"),
                ("evt", "fuels-evt"),
                ("landcover", "landcover-nlcd"),
                ("whp", "hazard-whp"),
            ):
                err = raster_errors[key]
                if err is not None:
                    block[sub_name] = {"unavailable": True, "reason": err}
                    continue
                try:
                    stats = _polygon_class_stats(
                        datasets[key], one_row, geom, key)
                except _DomainError as exc:
                    block[sub_name] = {"unavailable": True,
                                       "reason": str(exc)}
                    continue
                except Exception as exc:  # noqa: BLE001 - record per polygon
                    core.log(f"  [{i}/{n}] {code} {sub_name}: read failed: "
                             f"{exc}")
                    block[sub_name] = {
                        "unavailable": True,
                        "reason": f"{key}: read failed: {exc}",
                    }
                    continue
                if stats is None:
                    block[sub_name] = {
                        "unavailable": True,
                        "reason": f"no valid {key} pixels in polygon",
                    }
                    continue
                fracs, coverage_pct, count = stats
                if sub_name == "fbfm40":
                    block[sub_name] = _fbfm40_block(fracs, coverage_pct)
                elif sub_name == "evt":
                    block[sub_name] = _evt_block(
                        fracs, coverage_pct, attr_map, str(code))
                elif sub_name == "landcover":
                    block[sub_name] = _landcover_block(fracs, coverage_pct)
                else:
                    block[sub_name] = _whp_block(fracs, coverage_pct, count)
            out[code] = block
    finally:
        for ds in datasets.values():
            try:
                ds.close()
            except Exception:  # noqa: BLE001 - close best-effort
                pass
    return out
