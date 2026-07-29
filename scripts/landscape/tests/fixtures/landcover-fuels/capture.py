"""Fixture capture for the T-S1-3 land-cover + fuels lane (contract 6.3).

Captures, under the frozen capture budget, the 100 x 100-cell North
Cascades window fixtures for LANDFIRE FBFM40 and EVT (Existing
Vegetation Type), the Annual National Land Cover Database (NLCD)
window, the EVT attribute table, and the minimal 270 m-aligned Wildfire
Hazard Potential (WHP) covering window, then generates the
expected-landcoverfuels-block.json capture snapshot by running the REAL
acquire + aggregate path over the captured fixture files, and writes
SOURCES.md.

Deterministic window (contract 6.3): the North Cascades Level III
ecoregion's largest part by the frozen total ordering (area descending,
part bounding-box minx ascending, miny ascending, original part index
ascending), shapely representative_point() of that part, then
  ulx = GRID_ANCHOR_X + floor((rp.x - 1500 - GRID_ANCHOR_X) / 30) * 30
  uly = GRID_ANCHOR_Y + ceil((rp.y + 1500 - GRID_ANCHOR_Y) / 30) * 30
and the window is (ulx, uly - 3000, ulx + 3000, uly).

Resumable by design (the conductor's long-run operating rule): every
download skips when its recorded digest already matches, and the
RequestBudget counts persist CUMULATIVELY across invocations in a JSON
sidecar in the cache directory; recorded counts are true cumulative
totals and the 6.3 ceilings bind them. Re-invoke until the capture
completes. The WHP congruence-or-stop precondition (contract 5.3) is
checked inside acquire(); on failure this script STOPS, prints the four
observed facts, and exits nonzero. It is NOT invoked by any test.

Run (from the repository root, foreground):
  .venv/Scripts/python.exe scripts/landscape/tests/fixtures/landcover-fuels/capture.py
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
sys.path.insert(0, str(REPO))

import numpy as np  # noqa: E402
import geopandas as gpd  # noqa: E402
import rasterio  # noqa: E402
import requests  # noqa: E402
from rasterio.transform import from_origin  # noqa: E402
from rasterio.windows import Window  # noqa: E402
from shapely.geometry import box  # noqa: E402

from scripts.landscape import core  # noqa: E402
from scripts.landscape.adapters import landcover_fuels as lf  # noqa: E402

# The frozen capture budget (contract 6.3, T-S1-3 row).
CAPTURE_BUDGET = {
    "lfps-exportimage": 12,
    "mrlc-wcs": 6,
    "rds-whp-zip": 2,
    "epa-s3": 4,
    "metadata": 8,
}

TARGET_L3_NAME = "North Cascades"
WINDOW_CELLS = 100
WINDOW_M = WINDOW_CELLS * core.GRID_RES_M  # 3000 m

STATE_PATH = lf.DOWNLOAD_CACHE / "capture-state.json"
SNAPSHOT_CODE = "north-cascades-window"

FIXTURE_FILES = {
    "fuels-fbfm40": HERE / "fbfm40-window.tif",
    "fuels-evt": HERE / "evt-window.tif",
    "fuels-evt-attributes": HERE / "evt-attributes.json",
    "landcover-nlcd": HERE / "nlcd-window.tif",
    "hazard-whp": HERE / "whp-window.tif",
}
EXPECTED_PATH = HERE / "expected-landcoverfuels-block.json"
SOURCES_PATH = HERE / "SOURCES.md"


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"counts": {k: 0 for k in CAPTURE_BUDGET}}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n",
                          encoding="utf-8")


class PersistentBudget(lf.RequestBudget):
    """The lane RequestBudget with cumulative cross-invocation counts:
    counts are seeded from the state sidecar and persisted after every
    spend, so the recorded totals are true cumulative totals."""

    def __init__(self, ceilings: dict[str, int], state: dict) -> None:
        super().__init__(ceilings)
        self._state = state
        for k, v in state.get("counts", {}).items():
            if k in self.counts:
                self.counts[k] = int(v)

    def spend(self, endpoint_key: str) -> None:
        super().spend(endpoint_key)
        self._state["counts"] = dict(self.counts)
        save_state(self._state)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def derive_window_corner(state: dict, budget: lf.RequestBudget) -> None:
    """Step 1: EPA polygons (budgeted under epa-s3 when not cached) and
    the frozen corner derivation."""
    if "window" in state:
        return
    l3_zip = core.CACHE_DIR / core.ECO_L3_ZIP
    if not (l3_zip.exists() and l3_zip.stat().st_size > 0):
        budget.spend("epa-s3")
    gdf = core.load_ecoregions(3)
    target = gdf[gdf["US_L3NAME"] == TARGET_L3_NAME]
    if target.empty:
        raise RuntimeError(
            f"{TARGET_L3_NAME} not found; names: "
            f"{sorted(gdf['US_L3NAME'].unique())}"
        )
    # The frozen total ordering over parts (contract 6.3): area
    # descending, part bbox minx ascending, miny ascending, ORIGINAL
    # PART INDEX ascending. Parts enumerate across the target's rows in
    # GeoDataFrame order, then within each (multi)polygon in geoms order.
    parts = []
    idx = 0
    for _, row in target.iterrows():
        geom = row.geometry
        geoms = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        for part in geoms:
            b = part.bounds
            parts.append((-part.area, b[0], b[1], idx, part))
            idx += 1
    parts.sort(key=lambda t: t[:4])
    largest = parts[0][4]
    rp = largest.representative_point()
    ax, ay, res = core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y, core.GRID_RES_M
    import math
    ulx = ax + math.floor((rp.x - 1500 - ax) / res) * res
    uly = ay + math.ceil((rp.y + 1500 - ay) / res) * res
    state["window"] = {
        "targetL3Name": TARGET_L3_NAME,
        "partCount": idx,
        "largestPartAreaM2": float(largest.area),
        "representativePoint": [float(rp.x), float(rp.y)],
        "ulx": ulx,
        "uly": uly,
        "bounds5070": [ulx, uly - WINDOW_M, ulx + WINDOW_M, uly],
    }
    save_state(state)
    print(f"window corner: ulx={ulx}, uly={uly} "
          f"(rp=({rp.x:.3f}, {rp.y:.3f}), {idx} parts)")


def verify_nlcd_coverage_name(state: dict, budget: lf.RequestBudget) -> None:
    """Step 2: verify the module's pinned WCS coverage identifier against
    GetCapabilities (one metadata request; fail loudly on drift)."""
    if state.get("nlcdCoverageVerified"):
        return
    budget.spend("metadata")
    resp = requests.get(
        lf.MRLC_WCS_URL,
        params={"service": "WCS", "version": "1.0.0",
                "request": "GetCapabilities"},
        headers={"User-Agent": core.USER_AGENT}, timeout=120)
    resp.raise_for_status()
    names = re.findall(r"<(?:\w+:)?name>([^<]+)</(?:\w+:)?name>", resp.text)
    if lf.NLCD_COVERAGE not in names:
        raise RuntimeError(
            f"pinned NLCD_COVERAGE {lf.NLCD_COVERAGE!r} not among served "
            f"coverages; update the adapter constant. Served names: {names}"
        )
    state["nlcdCoverageVerified"] = True
    state["nlcdCoverageNames"] = names
    save_state(state)
    print(f"NLCD coverage name verified: {lf.NLCD_COVERAGE}")


def acquire_real_sources(state: dict, budget: lf.RequestBudget) -> None:
    """Step 3: the real network acquisition for the window through the
    adapter's own acquire() (spend()-governed; the WHP precondition is
    checked inside). Also records the WHP source geometry facts and the
    ZIP retention record."""
    if state.get("acquired"):
        state["serviceNodata"] = {
            key: lf.lfps_nodata_record(key, budget)
            for key in ("fuels-fbfm40", "fuels-evt")
        }
        save_state(state)
        return
    bounds = tuple(state["window"]["bounds5070"])
    mat_dir = lf.DOWNLOAD_CACHE / "materialized-capture"
    prepared = lf.acquire(bounds, mat_dir, budget)
    errors = {k: v["error"] for k, v in prepared.items()
              if v["error"] is not None}
    whp_error = errors.get("hazard-whp")
    if whp_error is not None and "5.3" in whp_error:
        # The congruence-or-stop verdict must surface as itself, with
        # the four observed facts, not as a generic failure.
        raise lf.WhpPreconditionError(whp_error)
    raster_errors = {
        key: reason for key, reason in errors.items()
        if key != "fuels-evt-attributes"
    }
    if raster_errors:
        raise RuntimeError(
            f"acquisition failed for {sorted(raster_errors)}: "
            f"{raster_errors} "
            f"(stop-and-surface; no silent fallback)"
        )
    # Resolve the cached adopted sources again. Every path is digest-backed,
    # so these calls spend zero requests and give the exact staged files the
    # successful acquire used without widening Contract B's artifact shape.
    raw = {
        key: str(lf._resolve_local_source(key, bounds, budget, None)[0])
        for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd")
    }
    attr_error = errors.get("fuels-evt-attributes")
    if attr_error is None:
        raw["fuels-evt-attributes"] = str(
            prepared["fuels-evt-attributes"]["path"])
        state["evtAttributesUnavailableReason"] = None
    else:
        # Contract 4.6 sanctioned form: the EVT stats remain available and
        # dominantName is null. The reason lives here, SOURCES.md, and logs,
        # never in the serialized block. The exact inventory still carries
        # a structurally valid attribute JSON fixture.
        fallback = lf.DOWNLOAD_CACHE / "evt-attributes-unavailable.json"
        fallback.write_text("{}\n", encoding="utf-8")
        raw["fuels-evt-attributes"] = str(fallback)
        state["evtAttributesUnavailableReason"] = attr_error
    zip_path = lf.DOWNLOAD_CACHE / "RDS-2015-0047-4_Data.zip"
    whp_tif = lf.extract_whp_classified_tif(zip_path)
    raw["hazard-whp-conus"] = str(whp_tif)
    with rasterio.open(whp_tif) as src:
        state["whpGeometryFacts"] = lf.whp_geometry_facts(
            src.crs, src.transform)
        state["whpSourceProfile"] = {
            "dtype": src.dtypes[0], "nodata": src.nodata,
            "width": src.width, "height": src.height,
        }
    _, whp_stage = lf.stage_whp_for_materialization(whp_tif)
    state["whpDtypeStaging"] = whp_stage
    state["categoricalDtypeStaging"] = {
        key: lf.stage_categorical_for_materialization(Path(raw[key]), key)[1]
        for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd")
    }
    state["serviceNodata"] = {
        key: lf.lfps_nodata_record(key, budget)
        for key in ("fuels-fbfm40", "fuels-evt")
    }
    zip_record = json.loads(
        Path(str(zip_path) + ".sha256.json").read_text(encoding="utf-8"))
    state["whpZipRetention"] = zip_record
    state["rawSources"] = raw
    state["acquired"] = True
    save_state(state)
    print("acquisition complete; WHP precondition PASSED")


def cut_whp_window(state: dict) -> None:
    """Step 4: the minimal 270 m-aligned covering window of the WHP
    source grid (contract 6.3), cut from the retained CONUS raster."""
    if state.get("whpWindow"):
        return
    bounds30 = tuple(state["window"]["bounds5070"])
    src_path = state["rawSources"]["hazard-whp-conus"]
    with rasterio.open(src_path) as src:
        wb = lf.whp_window_bounds(src.transform, bounds30)
        left, bottom, right, top = wb
        col0 = round((left - src.transform.c) / lf.WHP_RES_M)
        row0 = round((src.transform.f - top) / lf.WHP_RES_M)
        width = round((right - left) / lf.WHP_RES_M)
        height = round((top - bottom) / lf.WHP_RES_M)
        arr = src.read(1, window=Window(col_off=col0, row_off=row0,
                                        width=width, height=height))
        profile = {
            "driver": "GTiff", "height": height, "width": width,
            "count": 1, "dtype": src.dtypes[0], "crs": src.crs,
            "transform": from_origin(left, top, lf.WHP_RES_M, lf.WHP_RES_M),
            "nodata": src.nodata,
        }
    with rasterio.open(FIXTURE_FILES["hazard-whp"], "w", **profile) as out:
        out.write(arr, 1)
    state["whpWindow"] = {"bounds5070": list(wb),
                          "widthCells": width, "heightCells": height,
                          "colOff": col0, "rowOff": row0}
    save_state(state)
    print(f"whp-window.tif: {width}x{height} cells at 270 m, bounds {wb}")


def copy_fixtures(state: dict) -> None:
    """Step 5: cut the exact 100 x 100 returned-raster windows and copy
    the attribute fixture. Acquisition downloads include core's 120 m
    materialization pad; the committed fixture inventory does not."""
    minx, miny, maxx, maxy = state["window"]["bounds5070"]
    for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd"):
        src_path = Path(state["rawSources"][key])
        with rasterio.open(src_path) as src:
            col0 = round((minx - src.transform.c) / src.transform.a)
            row0 = round((src.transform.f - maxy) / abs(src.transform.e))
            window = Window(
                col_off=col0,
                row_off=row0,
                width=WINDOW_CELLS,
                height=WINDOW_CELLS,
            )
            arr = src.read(1, window=window, masked=False)
            if arr.shape != (WINDOW_CELLS, WINDOW_CELLS):
                raise RuntimeError(
                    f"{key}: exact fixture cut produced {arr.shape}, "
                    f"expected {(WINDOW_CELLS, WINDOW_CELLS)}"
                )
            profile = src.profile.copy()
            profile.update(
                height=WINDOW_CELLS,
                width=WINDOW_CELLS,
                transform=src.window_transform(window),
            )
        with rasterio.open(FIXTURE_FILES[key], "w", **profile) as out:
            out.write(arr, 1)
    shutil.copyfile(
        state["rawSources"]["fuels-evt-attributes"],
        FIXTURE_FILES["fuels-evt-attributes"],
    )
    print("fixture files copied")


def build_expected_block(state: dict) -> dict:
    """Step 6: snapshot through strict local acquire plus aggregate.

    Captured service rasters preserve their returned transforms, including
    the recorded NLCD millimetre deviations. Local paths do not qualify for
    the service tolerance, so byte-identical class arrays are copied onto an
    exact local transform before the zero-network acquire replay.
    """
    bounds = tuple(state["window"]["bounds5070"])
    offline_budget = lf.RequestBudget({k: 0 for k in CAPTURE_BUDGET})
    with tempfile.TemporaryDirectory(dir=lf.DOWNLOAD_CACHE) as tmp:
        tmp_path = Path(tmp)
        strict_sources = {
            "fuels-evt-attributes": str(
                FIXTURE_FILES["fuels-evt-attributes"]),
            "hazard-whp": str(FIXTURE_FILES["hazard-whp"]),
        }
        exact = from_origin(
            bounds[0], bounds[3], core.GRID_RES_M, core.GRID_RES_M)
        for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd"):
            source = FIXTURE_FILES[key]
            dest = tmp_path / f"strict-{source.name}"
            with rasterio.open(source) as src:
                values = src.read(1)
                profile = src.profile.copy()
                profile.update(transform=exact)
            with rasterio.open(dest, "w", **profile) as out:
                out.write(values, 1)
            strict_sources[key] = str(dest)
        prepared = lf.acquire(
            bounds, tmp_path, offline_budget, sources=strict_sources)
        errors = {k: v["error"] for k, v in prepared.items()
                  if v["error"] is not None}
        if errors:
            raise RuntimeError(f"fixture-driven acquire failed: {errors}")
        assert all(v == 0 for v in offline_budget.counts.values()), \
            "the fixture-driven path must not spend any budget"
        minx, miny, maxx, maxy = bounds
        gdf = gpd.GeoDataFrame(
            [{"CODE": SNAPSHOT_CODE,
              "geometry": box(minx, miny, maxx, maxy)}],
            crs=core.ANALYSIS_CRS)
        run_info: dict = {}
        result = lf.aggregate(gdf, "CODE", prepared=prepared,
                              run_info=run_info)
    EXPECTED_PATH.write_bytes(
        (json.dumps(result, indent=2) + "\n").encode("utf-8"))
    print(f"wrote {EXPECTED_PATH.name}")
    return result


def observed_ranges(state: dict) -> dict:
    out = {}
    for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd",
                "hazard-whp"):
        out[key] = list(lf.observed_class_range(FIXTURE_FILES[key]))
    state["observedClassRanges"] = out
    save_state(state)
    return out


def congruence_record(state: dict) -> dict:
    """The 2.2 congruence facts for the three 30 m fixture windows."""
    out = {}
    for key in ("fuels-fbfm40", "fuels-evt", "landcover-nlcd"):
        with rasterio.open(FIXTURE_FILES[key]) as ds:
            lf.assert_anchor_congruent_30m(
                ds.crs,
                ds.transform,
                context=f"{key} fixture",
                service_returned=True,
            )
            out[key] = lf.grid_deviation_facts_30m(ds.crs, ds.transform)
            out[key]["result"] = (
                "PASS (service-returned transform asserted per contract "
                "2.2 revision 10)"
            )
    state["congruence30m"] = out
    save_state(state)
    return out


def write_sources_md(state: dict, fixture_hashes: dict) -> None:
    w = state["window"]
    wz = state["whpZipRetention"]
    facts = state["whpGeometryFacts"]
    ranges = state["observedClassRanges"]
    cong = state["congruence30m"]
    counts = state["counts"]
    attr_reason = state.get("evtAttributesUnavailableReason")
    minx, miny, maxx, maxy = w["bounds5070"]
    request_bounds = lf._snap_bounds_30(
        lf._bounds_with_materialization_pad(tuple(w["bounds5070"])))
    req_minx, req_miny, req_maxx, req_maxy = request_bounds
    req_width = round((req_maxx - req_minx) / core.GRID_RES_M)
    req_height = round((req_maxy - req_miny) / core.GRID_RES_M)
    wwb = state["whpWindow"]["bounds5070"]
    lines = []
    a = lines.append
    a("# SOURCES: land-cover + fuels lane fixtures (T-S1-3)")
    a("")
    a(f"Captured {time.strftime('%Y-%m-%d')} by capture.py in this "
      f"directory, under the frozen capture budget of "
      f"S1_LANE_CONTRACT.md revision 13 section 6.3. All requests were "
      f"foreground and "
      f"spend()-governed; the counts below are TRUE CUMULATIVE totals "
      f"across capture invocations (persisted in the cache sidecar).")
    a("")
    a("## Window (contract 6.3, frozen derivation)")
    a("")
    a(f"- Target polygon: the {w['targetL3Name']} Level III ecoregion "
      f"(Environmental Protection Agency (EPA) Region 10 unsimplified "
      f"source, loaded via "
      f"core.load_ecoregions(3) at capture time; {w['partCount']} parts).")
    a(f"- Largest part area: {w['largestPartAreaM2']:.1f} m2; "
      f"representative point: ({w['representativePoint'][0]:.6f}, "
      f"{w['representativePoint'][1]:.6f}) European Petroleum Survey "
      f"Group (EPSG) registry code 5070.")
    a(f"- Computed corner: ulx = {w['ulx']}, uly = {w['uly']} "
      f"(the frozen floor/ceil formulas).")
    a(f"- 30 m window bounds (EPSG:5070): [{minx}, {miny}, {maxx}, "
      f"{maxy}] = 100 x 100 analysis cells.")
    a(f"- Wildfire Hazard Potential (WHP) covering window (minimal 270 "
      f"m-aligned on the SOURCE "
      f"grid): {wwb} = {state['whpWindow']['widthCells']} x "
      f"{state['whpWindow']['heightCells']} cells at 270 m.")
    a("")
    a("## Sources, pinned vintages, licenses")
    a("")
    a("### LANDFIRE LF2023 Scott and Burgan 40 Fire Behavior Fuel Models "
      "(FBFM40) and Existing Vegetation Type (EVT) (fuels-fbfm40, "
      "fuels-evt, fuels-evt-attributes)")
    a("")
    a(f"- Vintage pin: LANDFIRE release code 240 (LF2023) (contract 3).")
    a(f"- exportImage requests (one per layer, EPSG:5070 in and out, "
      f"S16, nearest neighbor, materialization-padded size "
      f"{req_width},{req_height}):")
    a(f"  - {lf.LFPS_EXPORTIMAGE['fuels-fbfm40']}?bbox={req_minx},"
      f"{req_miny},{req_maxx},{req_maxy}&bboxSR=5070&imageSR=5070&"
      f"size={req_width},{req_height}&format=tiff"
      f"&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image")
    a(f"  - {lf.LFPS_EXPORTIMAGE['fuels-evt']}?bbox={req_minx},"
      f"{req_miny},{req_maxx},{req_maxy}&bboxSR=5070&imageSR=5070&"
      f"size={req_width},{req_height}&format=tiff"
      f"&pixelType=S16&interpolation=RSP_NearestNeighbor&f=image")
    if attr_reason is None:
        a(f"- EVT attribute table: {lf.EVT_ATTRIBUTE_TABLE_URL}?f=pjson "
          f"(VALUE and EVT_NAME columns kept; names are VERBATIM upstream "
          f"strings and keep their original characters).")
    else:
        a(f"- EVT attribute table attempt: "
          f"{lf.EVT_ATTRIBUTE_TABLE_URL}?f=pjson. Service metadata "
          f"declared hasRasterAttributeTable=false and the response was "
          f"empty, so contract 4.6's dominantName-null path applies.")
    a("- License: LANDFIRE data are public domain (United States "
      "Geological Survey / United States Forest Service (USFS) / "
      "Department of the Interior product).")
    a("- Checksum posture: no server checksum published. Content-Length "
      "and Last-Modified were not retained for either exportImage "
      "response. Per revision 13, this absence is explicit; both fields "
      "will be captured at the next budgeted contact with this endpoint "
      "during the T-S1-4 full build. Each fixture's locally computed "
      "Secure Hash Algorithm 256-bit (SHA-256) remains recorded below.")
    for key in ("fuels-fbfm40", "fuels-evt"):
        rec = state["serviceNodata"][key]
        a(f"- {key} nodata/padding mask before the valid-cell domain "
          f"assertion: mask values {rec['maskValues']}; service metadata "
          f"field {rec['declaredField']!r} declared "
          f"{rec['declaredValue']!r}; staging nodata "
          f"{rec['stagingNodata']}. {rec['zeroPaddingRule']}.")
        meta = rec["metadataGridFacts"]
        a(f"- {key} exact metadata-grid assertion: well-known identifier "
          f"(WKID) {meta['wkid']}; "
          f"pixel sizes {meta['pixelSizesXY']}; origin edges "
          f"{meta['originEdgesXY']}; lattice distances "
          f"{meta['originLatticeDistances30m']} m within "
          f"{meta['toleranceM']} m: {meta['result']}.")
    a("")
    a("### Multi-Resolution Land Characteristics (MRLC) Annual National "
      "Land Cover Database (NLCD) (landcover-nlcd)")
    a("")
    a(f"- Vintage pin: TIME={lf.NLCD_TIME} plus collection "
      f"{lf.NLCD_COLLECTION!r} (contract 3).")
    a(f"- Coverage identifier (verified against GetCapabilities at "
      f"capture): {lf.NLCD_COVERAGE}")
    a(f"- GetCoverage request: {lf.MRLC_WCS_URL}?service=WCS&version="
      f"1.0.0&request=GetCoverage&coverage={lf.NLCD_COVERAGE}&crs="
      f"EPSG:5070&response_crs=EPSG:5070&bbox={req_minx},{req_miny},"
      f"{req_maxx},{req_maxy}&time={lf.NLCD_TIME}&width={req_width}&"
      f"height={req_height}&format=GeoTIFF")
    a("- License: public domain (United States Geological Survey).")
    a("- Checksum posture: no server checksum. Content-Length and "
      "Last-Modified were not retained for the GetCoverage response. Per "
      "revision 13, this absence is explicit; both fields will be captured "
      "at the next budgeted contact with this endpoint during the T-S1-4 "
      "full build. The fixture's locally computed SHA-256 is below.")
    a("")
    a("### United States Forest Service (USFS) Wildfire Hazard Potential "
      "(WHP) edition 4 (hazard-whp)")
    a("")
    a(f"- Vintage pin: edition 4 (2023 classified), Digital Object "
      f"Identifier (DOI) {lf.WHP_DOI} "
      f"(REQUIRED citation, contract 3).")
    a("- Citation: Dillon, Gregory K.; Gilbertson-Day, Julie W. 2023. "
      "Wildfire Hazard Potential for the United States (270-m), version "
      f"2023. 4th Edition. Fort Collins, CO: Forest Service Research "
      f"Data Archive. https://doi.org/{lf.WHP_DOI}")
    a(f"- Bulk download (one ZIP, cached and RETAINED per contract 3.1 "
      f"insurance): {lf.WHP_ZIP_URL}")
    a(f"- Retention record: Content-Length {wz.get('contentLength')}, "
      f"Last-Modified {wz.get('lastModified')!r}, locally computed "
      f"SHA-256 {wz.get('sha256')} (ZIP retained at "
      f"scripts/.cache/landcover-fuels/RDS-2015-0047-4_Data.zip).")
    a("- License: United States public domain (USFS Research Data "
      "Archive).")
    stage = state["whpDtypeStaging"]
    a(f"- Revision 10 lossless dtype staging: {stage['sourceDtype']} to "
      f"{stage['widenedDtype']} with integer nodata "
      f"{stage['widenedNodata']}, then an exact float32 materialization "
      f"view with nodata Not a Number (NaN) for core's masked read. "
      f"Valid-value identity: "
      f"{stage['valueIdentityCheck']}; nodata-mask identity: "
      f"{stage['nodataMaskIdentityCheck']}. Core was not edited.")
    a("")
    a("### Revision 10 lossless staging for 30 m categorical sources")
    a("")
    a("Declaring nodata exposes core's integer masked-array NaN fill "
      "limitation for all three service rasters. Each cache-only float32 "
      "view preserves every valid integer exactly, maps only declared "
      "nodata to NaN, and is the source passed to core.materialize_raster. "
      "Core was not edited.")
    for key, rec in state["categoricalDtypeStaging"].items():
        a(f"- {key}: {rec['sourceDtype']} with nodata "
          f"{rec['sourceNodata']} to {rec['materializationDtype']} with "
          f"nodata {rec['materializationNodata']}; valid-value identity "
          f"{rec['valueIdentityCheck']}; mask identity "
          f"{rec['nodataMaskIdentityCheck']}.")
    a("")
    a("## Congruence results")
    a("")
    a("### Contract 2.2 (native 30 m sources, asserted in acquire())")
    a("")
    for key, rec in cong.items():
        a(f"- {key}: Coordinate Reference System (CRS) EPSG:"
          f"{rec['crsEpsg']}; pixel sizes "
          f"{rec['pixelSizesAE']}; observed absolute pixel-size "
          f"deviations {rec['pixelSizeDeviationsM']} m (limit 0.0001 m); "
          f"origin edge offsets from the anchor "
          f"{rec['originEdgeOffsetsFromAnchor']}; observed lattice "
          f"distances {rec['originLatticeDistances30m']} m "
          f"(limit 0.02 m): {rec['result']}")
    a("")
    a("### Contract 5.3 WHP precondition (congruence-or-stop): PASSED")
    a("")
    a("All four geometric facts were checked at capture on the "
      "extracted CONUS raster; MODE materialization is therefore "
      "equivalent to the doctrine's nearest-neighbor rule for THIS "
      "checked case (every 30 m target cell lies inside exactly one "
      "270 m source cell). No equivalence is claimed beyond it.")
    a("")
    a(f"1. CRS: {facts['crs']} (EPSG {facts['crsEpsg']}); required "
      f"EPSG:5070.")
    a(f"2. Rotation/shear terms (b, d): {facts['rotationShearBD']} "
      f"(required exactly 0).")
    a(f"3. Pixel sizes (a, e): {facts['pixelSizesAE']} (required "
      f"abs 270 within 1e-6 m).")
    a(f"4. Origin edge offsets from the anchor: "
      f"{facts['originEdgeOffsetsFromAnchor']}; lattice distances to "
      f"the nearest 30 m multiple: {facts['originLatticeDistances30m']} "
      f"(required <= 1e-6 m).")
    a("")
    a("## Observed categorical ranges (contract 4.3 record)")
    a("")
    for key, (lo, hi) in ranges.items():
        dom = lf.CLASS_DOMAINS[key]
        a(f"- {key}: observed [{lo:.0f}, {hi:.0f}] within the asserted "
          f"domain [{dom[0]}, {dom[1]}] (windowed observation only; no "
          f"claim beyond the asserted data).")
    a("")
    a("## Cumulative request URL ledger")
    a("")
    a("Every unique URL attempted in this capture decision is listed. "
      "The first 100 x 100 service windows and first JSON attribute "
      "attempt belong to the stopped revision 8 draft; their counts remain "
      "binding even though the revision 10 padded requests produced the "
      "committed fixtures.")
    a("")
    a(f"- Environmental Protection Agency ecoregion archive, 1 attempt: "
      f"{core.EPA_S3_ROOT}{core.ECO_L3_ZIP}")
    a(f"- National Land Cover Database GetCapabilities, 2 attempts: "
      f"{lf.MRLC_WCS_URL}?service=WCS&version=1.0.0&request="
      f"GetCapabilities")
    for key in ("fuels-fbfm40", "fuels-evt"):
        a(f"- {key} service metadata, 1 attempt: "
          f"{lf.LFPS_IMAGE_SERVICES[key]}?f=json")
        a(f"- {key} original 100 x 100 exportImage, 1 attempt: "
          f"{lf.LFPS_EXPORTIMAGE[key]}?bbox={minx},{miny},{maxx},{maxy}&"
          f"bboxSR=5070&imageSR=5070&size=100,100&format=tiff&"
          f"pixelType=S16&interpolation=RSP_NearestNeighbor&f=image")
        a(f"- {key} revision 10 padded exportImage, 1 attempt: "
          f"{lf.LFPS_EXPORTIMAGE[key]}?bbox={req_minx},{req_miny},"
          f"{req_maxx},{req_maxy}&bboxSR=5070&imageSR=5070&size="
          f"{req_width},{req_height}&format=tiff&pixelType=S16&"
          f"interpolation=RSP_NearestNeighbor&f=image")
    a(f"- Existing Vegetation Type attribute operation, 1 original "
      f"attempt: {lf.EVT_ATTRIBUTE_TABLE_URL}?f=json")
    a(f"- Existing Vegetation Type attribute operation, 1 corrected "
      f"attempt: {lf.EVT_ATTRIBUTE_TABLE_URL}?f=pjson")
    a(f"- National Land Cover Database original 100 x 100 GetCoverage, "
      f"1 attempt: {lf.MRLC_WCS_URL}?service=WCS&version=1.0.0&request="
      f"GetCoverage&coverage={lf.NLCD_COVERAGE}&crs=EPSG:5070&"
      f"response_crs=EPSG:5070&bbox={minx},{miny},{maxx},{maxy}&time="
      f"{lf.NLCD_TIME}&width=100&height=100&format=GeoTIFF")
    a(f"- National Land Cover Database revision 10 padded GetCoverage, "
      f"1 attempt: {lf.MRLC_WCS_URL}?service=WCS&version=1.0.0&request="
      f"GetCoverage&coverage={lf.NLCD_COVERAGE}&crs=EPSG:5070&"
      f"response_crs=EPSG:5070&bbox={req_minx},{req_miny},{req_maxx},"
      f"{req_maxy}&time={lf.NLCD_TIME}&width={req_width}&height="
      f"{req_height}&format=GeoTIFF")
    a(f"- Wildfire Hazard Potential edition-4 archive, 1 attempt: "
      f"{lf.WHP_ZIP_URL}")
    a("")
    a("## Fixture provenance and digests")
    a("")
    a("Requests to files: the two exportImage requests produced "
      "fbfm40-window.tif and evt-window.tif; the GetCoverage request "
      "produced nlcd-window.tif; whp-window.tif was cut locally from the "
      "retained edition-4 continental United States (CONUS) raster (no "
      "extra request). The unavailable rasterAttributeTable response "
      "produced no usable rows, so capture.py wrote the structurally valid "
      "empty evt-attributes.json that drives contract 4.6's honest null. "
      "expected-landcoverfuels-block.json was generated offline from "
      "byte-identical class-array copies of the fixture files on strict "
      "exact local transforms through the real acquire + aggregate path "
      "(zero spends, asserted).")
    a("")
    a("SHA-256 of every fixture file except SOURCES.md is pinned here and "
      "in test_landcover_fuels.py. Revision 13 explicitly excludes "
      "SOURCES.md from its own hash table because self-hashing has no "
      "stable fixpoint; capture.py is included.")
    a("")
    for name, digest in sorted(fixture_hashes.items()):
        a(f"- `{name}`: `{digest}`")
    a("")
    a("## Cumulative request counts (RequestBudget.counts vs 6.3 "
      "ceilings)")
    a("")
    for key in sorted(CAPTURE_BUDGET):
        a(f"- {key}: {counts.get(key, 0)} of {CAPTURE_BUDGET[key]}")
    a("")
    a("## dominantName null reasons (contract 4.6 recording home)")
    a("")
    if attr_reason is None:
        a("None: the snapshot window's dominant EVT code resolved against "
          "the captured attribute table.")
    else:
        clean_reason = attr_reason.rstrip(".")
        a(f"The corrected single rasterAttributeTable retry remained "
          f"unavailable: {clean_reason}. Contract 4.6 therefore keeps the "
          f"EVT sub-block available with dominantName null. This reason "
          f"is not serialized.")
    a("")
    SOURCES_PATH.write_bytes(("\n".join(lines)).encode("utf-8"))
    print(f"wrote {SOURCES_PATH.name}")


def main() -> int:
    state = load_state()
    budget = PersistentBudget(CAPTURE_BUDGET, state)
    try:
        derive_window_corner(state, budget)
        verify_nlcd_coverage_name(state, budget)
        acquire_real_sources(state, budget)
        cut_whp_window(state)
        copy_fixtures(state)
        build_expected_block(state)
        ranges = observed_ranges(state)
        congruence_record(state)
        fixture_hashes = {
            p.name: sha256_of(p)
            for p in (
                list(FIXTURE_FILES.values())
                + [EXPECTED_PATH, HERE / "capture.py"]
            )
        }
        state["fixtureHashes"] = fixture_hashes
        save_state(state)
        write_sources_md(state, fixture_hashes)
    except lf.WhpDownloadIncomplete as exc:
        print(f"INCOMPLETE (re-invoke to resume): {exc}", file=sys.stderr)
        return 4
    except lf.WhpPreconditionError as exc:
        print(f"WHP PRECONDITION FAILED (STOP-AND-SURFACE): {exc}",
              file=sys.stderr)
        return 3
    except lf.BudgetExceededError as exc:
        print(f"BUDGET EXCEEDED (STOP-AND-SURFACE): {exc}", file=sys.stderr)
        return 5
    print("\n=== capture summary ===")
    print(json.dumps({
        "window": state["window"],
        "whpWindow": state["whpWindow"],
        "counts": state["counts"],
        "observedClassRanges": state["observedClassRanges"],
        "whpGeometryFacts": state["whpGeometryFacts"],
        "whpZipRetention": state["whpZipRetention"],
        "fixtureHashes": state["fixtureHashes"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
