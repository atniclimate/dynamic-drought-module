"""Offline tests for the T-S1-3 land-cover + fuels Contract B adapter.

CaptureSnapshotTests are regression pins over captured upstream bytes.
HandWorkedKnownAnswerTests are correctness proofs from synthetic class
arrays and transforms whose answers are computed independently here.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import geopandas as gpd
import numpy as np
import rasterio
from rasterio import Affine
from rasterio.crs import CRS
from rasterio.transform import from_origin
from shapely.geometry import box

from scripts.landscape import core
from scripts.landscape.adapters import landcover_fuels as lf


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "landcover-fuels"
WINDOW_BOUNDS = (-1856175.0, 3041265.0, -1853175.0, 3044265.0)
WHP_WINDOW_BOUNDS = (
    -1856385.000000001,
    3041144.999999998,
    -1853145.000000001,
    3044384.999999998,
)

FIXTURE_SHA256 = {
    "capture.py":
        "37e9d88c69bf302f62bb9fc4d80554a6dbcd5bf2627e6bd34f514a90e289884d",
    "fbfm40-window.tif":
        "d476adb915524ffd4e3071c154a9485d7de859836ab68b5735fb95d0494f7ef4",
    "evt-window.tif":
        "efba073629a6b7650a08ea9f7da63943b881ef48a893e6db99987e185f1ad48c",
    "evt-attributes.json":
        "e3566b3a06430868d71e9287dfd6c6c520a3da027aabea01951d407ee131dc2f",
    "nlcd-window.tif":
        "29f93d74353537b6b38c8c3db2a4fd761a4eb0642b361ee5cc401673571b5483",
    "whp-window.tif":
        "ccaeb01fe589d889f1a794da199501ee789531cfa5cf00e44ea39980882938df",
    "expected-landcoverfuels-block.json":
        "e6dd32ed3f98ca401edd52f1fee08795e56699734c9b0d10aacb69fb741431d1",
}

REQUEST_URLS = (
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_FBFM40_CONUS/ImageServer/exportImage?bbox=-1856295.0,"
    "3041145.0,-1853055.0,3044385.0&bboxSR=5070&imageSR=5070&"
    "size=108,108&format=tiff&pixelType=S16&"
    "interpolation=RSP_NearestNeighbor&f=image",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_EVT_CONUS/ImageServer/exportImage?bbox=-1856295.0,"
    "3041145.0,-1853055.0,3044385.0&bboxSR=5070&imageSR=5070&"
    "size=108,108&format=tiff&pixelType=S16&"
    "interpolation=RSP_NearestNeighbor&f=image",
    "https://dmsdata.cr.usgs.gov/geoserver/"
    "mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version="
    "1.0.0&request=GetCoverage&coverage=mrlc_Land-Cover-Native_"
    "conus_year_data:Land-Cover-Native_conus_year_data&crs=EPSG:5070&"
    "response_crs=EPSG:5070&bbox=-1856295.0,3041145.0,-1853055.0,"
    "3044385.0&time=2024-01-01&width=108&height=108&format=GeoTIFF",
    "https://www.fs.usda.gov/rds/archive/products/RDS-2015-0047-4/"
    "RDS-2015-0047-4_Data.zip",
)

CUMULATIVE_REQUEST_URLS = REQUEST_URLS + (
    "https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/"
    "Ecoregions/reg10/reg10_eco_l3.zip",
    "https://dmsdata.cr.usgs.gov/geoserver/"
    "mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version="
    "1.0.0&request=GetCapabilities",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_FBFM40_CONUS/ImageServer?f=json",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_EVT_CONUS/ImageServer?f=json",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_FBFM40_CONUS/ImageServer/exportImage?bbox=-1856175.0,"
    "3041265.0,-1853175.0,3044265.0&bboxSR=5070&imageSR=5070&"
    "size=100,100&format=tiff&pixelType=S16&"
    "interpolation=RSP_NearestNeighbor&f=image",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_EVT_CONUS/ImageServer/exportImage?bbox=-1856175.0,"
    "3041265.0,-1853175.0,3044265.0&bboxSR=5070&imageSR=5070&"
    "size=100,100&format=tiff&pixelType=S16&"
    "interpolation=RSP_NearestNeighbor&f=image",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_EVT_CONUS/ImageServer/rasterAttributeTable?f=json",
    "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023/"
    "LF2023_EVT_CONUS/ImageServer/rasterAttributeTable?f=pjson",
    "https://dmsdata.cr.usgs.gov/geoserver/"
    "mrlc_Land-Cover-Native_conus_year_data/wcs?service=WCS&version="
    "1.0.0&request=GetCoverage&coverage=mrlc_Land-Cover-Native_"
    "conus_year_data:Land-Cover-Native_conus_year_data&crs=EPSG:5070&"
    "response_crs=EPSG:5070&bbox=-1856175.0,3041265.0,-1853175.0,"
    "3044265.0&time=2024-01-01&width=100&height=100&format=GeoTIFF",
)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _cache_tempdir() -> tempfile.TemporaryDirectory:
    lf.DOWNLOAD_CACHE.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=lf.DOWNLOAD_CACHE)


def _write_raster(
    path: Path,
    values: np.ndarray,
    transform,
    *,
    nodata,
) -> Path:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=values.shape[1],
        height=values.shape[0],
        count=1,
        dtype=str(values.dtype),
        crs=core.ANALYSIS_CRS,
        transform=transform,
        nodata=nodata,
    ) as out:
        out.write(values, 1)
    return path


def _prepared_entry(path: Path, kind: str = "raster") -> dict:
    return {
        "kind": kind,
        "path": path,
        "error": None,
        "acquired": "2026-07-22",
        "sha256": _sha256(path),
    }


def _strict_local_fixture_sources(root: Path) -> dict[str, str]:
    """Copy captured 30 m service bytes onto an exact local transform.

    The committed NLCD fixture intentionally preserves its observed
    service-returned millimetre deviations. A local path is not entitled to
    that tolerance, so the offline acquire seam uses byte-identical class
    arrays with exact local metadata rather than misclassifying the path.
    """
    exact = from_origin(
        WINDOW_BOUNDS[0], WINDOW_BOUNDS[3],
        core.GRID_RES_M, core.GRID_RES_M)
    sources: dict[str, str] = {}
    for key, name in (
        ("fuels-fbfm40", "fbfm40-window.tif"),
        ("fuels-evt", "evt-window.tif"),
        ("landcover-nlcd", "nlcd-window.tif"),
    ):
        source = FIXTURES / name
        dest = root / f"strict-{name}"
        with rasterio.open(source) as src:
            values = src.read(1)
            profile = src.profile.copy()
            profile.update(transform=exact)
        with rasterio.open(dest, "w", **profile) as out:
            out.write(values, 1)
        sources[key] = str(dest)
    sources["fuels-evt-attributes"] = str(
        FIXTURES / "evt-attributes.json")
    sources["hazard-whp"] = str(FIXTURES / "whp-window.tif")
    return sources


def _aggregate_hand_built_arrays(
    root: Path,
    *,
    fbfm40: np.ndarray,
    nlcd: np.ndarray | None = None,
    whp: np.ndarray | None = None,
    evt: np.ndarray | None = None,
    geometry=None,
) -> tuple[dict, tuple[float, float, float, float]]:
    """Run literal class arrays through aggregate's real raster path."""
    fbfm40 = np.asarray(fbfm40, dtype="float32")
    height, width = fbfm40.shape
    arrays = {
        "fuels-fbfm40": fbfm40,
        "fuels-evt": np.asarray(
            evt if evt is not None else np.full((height, width), 7008),
            dtype="float32"),
        "landcover-nlcd": np.asarray(
            nlcd if nlcd is not None else np.full((height, width), 21),
            dtype="float32"),
        "hazard-whp": np.asarray(
            whp if whp is not None else np.full((height, width), 1),
            dtype="float32"),
    }
    if any(values.shape != (height, width) for values in arrays.values()):
        raise ValueError("all hand-built arrays must have the same shape")

    # Two nodata border cells supply core.read_window's 60 m pad. The
    # polygon covers only the literal inner class array.
    pad = 2
    left, top = core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y
    transform = from_origin(left, top, 30.0, 30.0)
    paths = {}
    for key, values in arrays.items():
        padded = np.full(
            (height + 2 * pad, width + 2 * pad), np.nan, dtype="float32")
        padded[pad:pad + height, pad:pad + width] = values
        paths[key] = _write_raster(
            root / f"{key}.tif", padded, transform, nodata=np.nan)

    attrs = root / "attrs.json"
    attrs.write_text('{"7008": "Known EVT"}\n', encoding="utf-8")
    prepared = {key: _prepared_entry(path) for key, path in paths.items()}
    prepared["fuels-evt-attributes"] = _prepared_entry(
        attrs, "attributes")
    inner_bounds = (
        left + pad * 30.0,
        top - (pad + height) * 30.0,
        left + (pad + width) * 30.0,
        top - pad * 30.0,
    )
    polygon = geometry if geometry is not None else box(*inner_bounds)
    gdf = gpd.GeoDataFrame(
        [{"CODE": "hand", "geometry": polygon}],
        crs=core.ANALYSIS_CRS,
    )
    return lf.aggregate(gdf, "CODE", prepared=prepared)["hand"], inner_bounds


class CaptureSnapshotTests(unittest.TestCase):
    """CAPTURE SNAPSHOTS: regression and upstream-drift pins only."""

    def test_exact_fixture_inventory_and_captured_hashes(self) -> None:
        expected_inventory = {
            "fbfm40-window.tif",
            "evt-window.tif",
            "evt-attributes.json",
            "nlcd-window.tif",
            "whp-window.tif",
            "expected-landcoverfuels-block.json",
            "capture.py",
            "SOURCES.md",
        }
        self.assertEqual(
            {path.name for path in FIXTURES.iterdir()}, expected_inventory)
        for name, expected in FIXTURE_SHA256.items():
            with self.subTest(name=name):
                self.assertEqual(_sha256(FIXTURES / name), expected)

    def test_pinned_window_profiles(self) -> None:
        for name in ("fbfm40-window.tif", "evt-window.tif",
                     "nlcd-window.tif"):
            with self.subTest(name=name), rasterio.open(FIXTURES / name) as ds:
                self.assertEqual((ds.width, ds.height), (100, 100))
                self.assertEqual(ds.crs.to_epsg(), 5070)
                lf.assert_anchor_congruent_30m(
                    ds.crs,
                    ds.transform,
                    context=name,
                    service_returned=True,
                )
        with rasterio.open(FIXTURES / "whp-window.tif") as ds:
            self.assertEqual((ds.width, ds.height), (12, 12))
            self.assertEqual(tuple(ds.bounds), WHP_WINDOW_BOUNDS)
            lf.check_whp_precondition(ds.crs, ds.transform)

    def test_pinned_corners_urls_vintages_and_digests_in_sources(self) -> None:
        text = (FIXTURES / "SOURCES.md").read_text(encoding="utf-8")
        self.assertIn(str(list(WINDOW_BOUNDS)), text)
        self.assertIn(str(list(WHP_WINDOW_BOUNDS)), text)
        for url in CUMULATIVE_REQUEST_URLS:
            with self.subTest(url=url):
                self.assertIn(url, text)
        self.assertIn("GetCapabilities, 2 attempts", text)
        self.assertIn("LANDFIRE release code 240 (LF2023)", text)
        self.assertIn("TIME=2024-01-01", text)
        self.assertIn("Annual NLCD Collection 1.1", text)
        self.assertIn("10.2737/RDS-2015-0047-4", text)
        self.assertGreaterEqual(
            text.count("Content-Length and Last-Modified were not retained"),
            2,
        )
        self.assertIn("Revision 13 explicitly excludes SOURCES.md", text)
        for digest in FIXTURE_SHA256.values():
            self.assertIn(digest, text)

    def test_capture_snapshot_through_offline_contract_b_path(self) -> None:
        expected = json.loads(
            (FIXTURES / "expected-landcoverfuels-block.json").read_text(
                encoding="utf-8"))
        budget = lf.RequestBudget({
            "lfps-exportimage": 0,
            "mrlc-wcs": 0,
            "rds-whp-zip": 0,
            "metadata": 0,
            "epa-s3": 0,
        })
        with _cache_tempdir() as tmp, patch.object(
                lf.requests, "get", side_effect=AssertionError(
                    "offline tests must never fetch")):
            sources = _strict_local_fixture_sources(Path(tmp))
            prepared = lf.acquire(
                WINDOW_BOUNDS,
                Path(tmp),
                budget,
                sources=sources,
            )
            self.assertTrue(all(entry["error"] is None
                                for entry in prepared.values()))
            gdf = gpd.GeoDataFrame(
                [{"CODE": "north-cascades-window",
                  "geometry": box(*WINDOW_BOUNDS)}],
                crs=core.ANALYSIS_CRS,
            )
            run_info: dict = {}
            actual = lf.aggregate(
                gdf, "CODE", prepared=prepared, run_info=run_info)
        self.assertEqual(actual, expected)
        self.assertTrue(all(value == 0 for value in budget.counts.values()))
        self.assertEqual(
            set(run_info),
            {
                "fuelsFbfm40Acquired", "fuelsFbfm40RasterSha256",
                "fuelsEvtAcquired", "fuelsEvtRasterSha256",
                "landcoverNlcdAcquired", "landcoverNlcdRasterSha256",
                "hazardWhpAcquired", "hazardWhpRasterSha256",
            },
        )


class HandWorkedKnownAnswerTests(unittest.TestCase):
    """HAND-WORKED KNOWN ANSWERS: independent correctness proofs."""

    def test_whp_precondition_pass_and_one_failure_per_condition(self) -> None:
        good = Affine(
            270.0, 0.0, core.GRID_ANCHOR_X,
            0.0, -270.0, core.GRID_ANCHOR_Y,
        )
        failures = {
            "condition 1": (
                CRS.from_epsg(4326), good, "condition 1 (CRS)"),
            "condition 2": (
                CRS.from_epsg(5070),
                Affine(270.0, 1.0, core.GRID_ANCHOR_X,
                       0.0, -270.0, core.GRID_ANCHOR_Y),
                "condition 2 (rotation/shear)",
            ),
            "condition 3": (
                CRS.from_epsg(5070),
                Affine(269.9, 0.0, core.GRID_ANCHOR_X,
                       0.0, -270.0, core.GRID_ANCHOR_Y),
                "condition 3 (pixel size)",
            ),
            "condition 4": (
                CRS.from_epsg(5070),
                Affine(270.0, 0.0, core.GRID_ANCHOR_X + 0.1,
                       0.0, -270.0, core.GRID_ANCHOR_Y),
                "condition 4 (origin congruence)",
            ),
        }
        for label, (crs, transform, message) in failures.items():
            with self.subTest(label=label):
                lf.check_whp_precondition(CRS.from_epsg(5070), good)
                with self.assertRaises(lf.WhpPreconditionError) as raised:
                    lf.check_whp_precondition(crs, transform)
                self.assertIn(message, str(raised.exception))

    def test_returned_raster_tolerance_and_metadata_strictness(self) -> None:
        returned = Affine(
            30.0 + 0.0000012,
            0.0,
            core.GRID_ANCHOR_X + 0.0024,
            0.0,
            -30.0,
            core.GRID_ANCHOR_Y + 0.0088,
        )
        lf.assert_anchor_congruent_30m(
            CRS.from_epsg(5070), returned, "returned",
            service_returned=True)
        with self.assertRaises(lf.GridCongruenceError):
            lf.assert_anchor_congruent_30m(
                CRS.from_epsg(5070), returned, "metadata")

    def test_fbfm40_hand_worked_partition_and_threshold(self) -> None:
        # 1,250 polygon cells: 250 nodata, then 1,000 valid cells split
        # 200/500/290/9/1. Coverage = 1000/1250 = 80%; valid-area
        # fractions are .2/.5/.29/.009/.001. Only fractions >= .01 list.
        values = np.concatenate([
            np.full(250, np.nan),
            np.full(200, 91),
            np.full(500, 101),
            np.full(290, 102),
            np.full(9, 103),
            np.full(1, 104),
        ]).reshape(25, 50)
        with _cache_tempdir() as tmp_name:
            result, _ = _aggregate_hand_built_arrays(
                Path(tmp_name), fbfm40=values)
        block = result["fbfm40"]
        self.assertEqual(block, {
            "dominantCode": 101,
            "dominantFraction": 0.5,
            "nonburnableFraction": 0.2,
            "classes": [
                {"code": 101, "fraction": 0.5},
                {"code": 102, "fraction": 0.29},
            ],
            "otherBurnableFraction": 0.01,
            "coveragePct": 80.0,
        })
        partition = (
            block["nonburnableFraction"]
            + sum(item["fraction"] for item in block["classes"])
            + block["otherBurnableFraction"]
        )
        self.assertAlmostEqual(partition, 1.0)

    def test_all_nonburnable_is_stats_with_null_dominance(self) -> None:
        # 100 valid cells: 60 code 91 and 40 code 99. Both are
        # non-burnable, so dominance is honestly null while coverage is 100%.
        values = np.concatenate([
            np.full(60, 91), np.full(40, 99)]).reshape(10, 10)
        with _cache_tempdir() as tmp_name:
            result, _ = _aggregate_hand_built_arrays(
                Path(tmp_name), fbfm40=values)
        block = result["fbfm40"]
        self.assertIsNone(block["dominantCode"])
        self.assertIsNone(block["dominantFraction"])
        self.assertEqual(block["nonburnableFraction"], 1.0)
        self.assertEqual(block["classes"], [])
        self.assertEqual(block["otherBurnableFraction"], 0.0)
        self.assertEqual(block["coveragePct"], 100.0)

    def test_whp_hand_worked_partition_and_ordinal_mean(self) -> None:
        # 100 valid 30 m cells with class counts 10/20/20/20/10/10/10.
        # Ordinal numerator = 10 + 40 + 60 + 80 + 50 = 240 over 80
        # class-1-to-5 cells, hence mean 3.0. Effective WHP cells are
        # 100/81 = 1.234567..., serialized 1.2 and coarse.
        whp = np.concatenate([
            np.full(10, 1), np.full(20, 2), np.full(20, 3),
            np.full(20, 4), np.full(10, 5), np.full(10, 6),
            np.full(10, 7),
        ]).reshape(10, 10)
        with _cache_tempdir() as tmp_name:
            result, _ = _aggregate_hand_built_arrays(
                Path(tmp_name), fbfm40=np.full((10, 10), 101), whp=whp)
        block = result["whp"]
        self.assertEqual(block["classMean"], 3.0)
        self.assertEqual(block["classFractions"], {
            "1": 0.1, "2": 0.2, "3": 0.2, "4": 0.2,
            "5": 0.1, "6": 0.1, "7": 0.1,
        })
        self.assertAlmostEqual(sum(block["classFractions"].values()), 1.0)
        self.assertEqual(block["cellCount"], 1.2)
        self.assertTrue(block["coarse"])
        self.assertEqual(block["coveragePct"], 100.0)

    def test_class_6_7_only_whp_has_real_fractions_and_null_mean(self) -> None:
        # 25 class-6 and 75 class-7 cells are valid labels but contribute
        # no ordinal hazard classes, so classMean is null and count is 100/81.
        whp = np.concatenate([
            np.full(25, 6), np.full(75, 7)]).reshape(10, 10)
        with _cache_tempdir() as tmp_name:
            result, _ = _aggregate_hand_built_arrays(
                Path(tmp_name), fbfm40=np.full((10, 10), 101), whp=whp)
        block = result["whp"]
        self.assertIsNone(block["classMean"])
        self.assertEqual(block["classFractions"], {
            "1": 0.0, "2": 0.0, "3": 0.0, "4": 0.0,
            "5": 0.0, "6": 0.25, "7": 0.75,
        })
        self.assertEqual(block["cellCount"], 1.2)
        self.assertEqual(block["coveragePct"], 100.0)

    def test_landcover_disjoint_subset_sum_bound(self) -> None:
        # 25 cells in each disjoint subset: forest 41, cropland 81,
        # wetland 90, and open water 11. Each fraction is 25/100.
        nlcd = np.concatenate([
            np.full(25, 41), np.full(25, 81),
            np.full(25, 90), np.full(25, 11),
        ]).reshape(10, 10)
        with _cache_tempdir() as tmp_name:
            result, _ = _aggregate_hand_built_arrays(
                Path(tmp_name), fbfm40=np.full((10, 10), 101), nlcd=nlcd)
        block = result["landcover"]
        fields = (
            block["forestFraction"], block["croplandFraction"],
            block["wetlandFraction"], block["openWaterFraction"],
        )
        self.assertEqual(fields, (0.25, 0.25, 0.25, 0.25))
        self.assertLessEqual(sum(fields), 1.0 + 4 * 0.0005)
        self.assertEqual(block["coveragePct"], 100.0)

    def test_coarse_threshold_uses_unrounded_30_cell_boundary(self) -> None:
        # 45 x 54 = 2,430 valid 30 m cells = exactly 30 WHP cells.
        # Removing a 0.045 m horizontal strip removes
        # 54 * (0.045/30) = 0.081 cell, yielding 2,429.919/81 = 29.999.
        shape = (45, 54)
        arrays = np.ones(shape, dtype="float32")
        with _cache_tempdir() as tmp_name:
            root = Path(tmp_name)
            at_result, bounds = _aggregate_hand_built_arrays(
                root, fbfm40=np.full(shape, 101), whp=arrays)
            left, bottom, right, top = bounds
            below_result, _ = _aggregate_hand_built_arrays(
                root,
                fbfm40=np.full(shape, 101),
                whp=arrays,
                geometry=box(left, bottom, right, top - 0.045),
            )
        below = below_result["whp"]
        at = at_result["whp"]
        self.assertTrue(below["coarse"])
        self.assertFalse(at["coarse"])
        self.assertEqual(below["cellCount"], 30.0)
        self.assertEqual(at["cellCount"], 30.0)
        self.assertEqual(below["coveragePct"], 100.0)
        self.assertEqual(at["coveragePct"], 100.0)

    def test_attributes_validation_pass_and_fail(self) -> None:
        lf.validate_evt_attributes({"7008": "Douglas-fir forest"})
        lf.validate_evt_attributes({})
        for invalid in ({"not-a-code": "name"}, {"7008": ""}, []):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                lf.validate_evt_attributes(invalid)

    def test_budget_exceeded_path(self) -> None:
        budget = lf.RequestBudget({"metadata": 1})
        budget.spend("metadata")
        with self.assertRaisesRegex(
                lf.BudgetExceededError,
                "metadata.*ceiling 1.*sections 4.5 and 8"):
            budget.spend("metadata")
        self.assertEqual(budget.counts, {"metadata": 1})

    def test_download_cache_request_identity_mismatch_is_a_miss(self) -> None:
        bounds = (
            core.GRID_ANCHOR_X,
            core.GRID_ANCHOR_Y - 30.0,
            core.GRID_ANCHOR_X + 30.0,
            core.GRID_ANCHOR_Y,
        )

        def body(value: int) -> bytes:
            with rasterio.io.MemoryFile() as mem:
                with mem.open(
                    driver="GTiff", width=1, height=1, count=1,
                    dtype="int16", crs=core.ANALYSIS_CRS,
                    transform=from_origin(
                        core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y,
                        30.0, 30.0), nodata=0,
                ) as out:
                    out.write(np.array([[value]], dtype="int16"), 1)
                return mem.read()

        identity_240 = lf._canonical_request_identity(
            "https://example.invalid/exportImage",
            query={"f": "image"},
            selectors={"product": "fuels-fbfm40", "releaseCode": "240"},
        )
        identity_250 = lf._canonical_request_identity(
            "https://example.invalid/exportImage",
            query={"f": "image"},
            selectors={"product": "fuels-fbfm40", "releaseCode": "250"},
        )
        with _cache_tempdir() as tmp_name, patch.object(
                lf, "DOWNLOAD_CACHE", Path(tmp_name)):
            first_budget = lf.RequestBudget({"lfps-exportimage": 1})
            cached = lf._download_tiled_window(
                "fuels-fbfm40", bounds, first_budget, 1,
                lambda *_: body(101), identity_240)
            self.assertEqual(first_budget.counts["lfps-exportimage"], 1)

            calls = []

            def changed_request(*_args) -> bytes:
                calls.append(True)
                return body(102)

            second_budget = lf.RequestBudget({"lfps-exportimage": 1})
            refreshed = lf._download_tiled_window(
                "fuels-fbfm40", bounds, second_budget, 1,
                changed_request, identity_250)
            self.assertEqual(refreshed, cached)
            self.assertEqual(len(calls), 1)
            self.assertEqual(second_budget.counts["lfps-exportimage"], 1)
            with rasterio.open(refreshed) as ds:
                self.assertEqual(ds.read(1).tolist(), [[102]])
            record = json.loads(
                Path(str(refreshed) + ".sha256.json").read_text(
                    encoding="utf-8"))
            self.assertEqual(
                record["requestIdentity"]["selectors"]["releaseCode"],
                "250",
            )

            identity_260 = lf._canonical_request_identity(
                "https://example.invalid/exportImage",
                query={"f": "image"},
                selectors={
                    "product": "fuels-fbfm40", "releaseCode": "260"},
            )
            forbidden_calls = []
            no_budget = lf.RequestBudget({"lfps-exportimage": 0})
            with self.assertRaisesRegex(
                    RuntimeError, "cached request identity mismatch"):
                lf._download_tiled_window(
                    "fuels-fbfm40", bounds, no_budget, 1,
                    lambda *_: forbidden_calls.append(True), identity_260)
            self.assertEqual(forbidden_calls, [])
            self.assertEqual(no_budget.counts["lfps-exportimage"], 0)

    def test_legacy_whp_sidecar_accepts_exact_url_only_identity(self) -> None:
        """The retained edition-4 ZIP predates requestIdentity. Its recorded
        URL plus digest is the deliberately narrow compatibility proof."""
        with _cache_tempdir() as tmp_name:
            root = Path(tmp_name)
            archive = root / "RDS-2015-0047-4_Data.zip"
            archive.write_bytes(b"pinned WHP fixture bytes")
            sidecar = Path(str(archive) + ".sha256.json")
            sidecar.write_text(
                json.dumps({
                    "sha256": lf._sha256_file(archive),
                    "url": lf.WHP_ZIP_URL,
                }) + "\n",
                encoding="utf-8",
            )
            identity = lf._canonical_request_identity(lf.WHP_ZIP_URL)
            self.assertEqual(identity, {"url": lf.WHP_ZIP_URL})
            self.assertTrue(lf._download_complete(
                archive, sidecar, identity))
            self.assertFalse(lf._download_complete(
                archive,
                sidecar,
                lf._canonical_request_identity(
                    lf.WHP_ZIP_URL, query={"edition": "5"}),
            ))

    def test_source_acquire_congruence_pass_and_shifted_failure(self) -> None:
        with _cache_tempdir() as tmp_name, patch.object(
                lf.requests, "get", side_effect=AssertionError(
                    "local source acquire must not fetch")):
            tmp = Path(tmp_name)
            left, top = core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y
            exact = from_origin(left, top, 30.0, 30.0)
            # A 0.01 m shift passes the service-returned 0.02 m rule but
            # MUST fail for this local path under the strict 1e-6 m rule.
            shifted = from_origin(left + 0.01, top, 30.0, 30.0)
            whp_transform = from_origin(left, top, 270.0, 270.0)
            attrs = tmp / "attrs.json"
            attrs.write_text('{"7008": "Known EVT"}\n', encoding="utf-8")

            def source_set(fbfm_transform) -> dict[str, str]:
                return {
                    "fuels-fbfm40": str(_write_raster(
                        tmp / ("fbfm-shift.tif" if fbfm_transform == shifted
                               else "fbfm.tif"),
                        np.full((20, 20), 101, dtype="int16"),
                        fbfm_transform, nodata=0)),
                    "fuels-evt": str(_write_raster(
                        tmp / "evt.tif",
                        np.full((20, 20), 7008, dtype="int16"),
                        exact, nodata=0)),
                    "fuels-evt-attributes": str(attrs),
                    "landcover-nlcd": str(_write_raster(
                        tmp / "nlcd.tif",
                        np.full((20, 20), 41, dtype="uint8"),
                        exact, nodata=250)),
                    "hazard-whp": str(_write_raster(
                        tmp / "whp.tif",
                        np.full((3, 3), 2, dtype="uint8"),
                        whp_transform, nodata=255)),
                }

            bounds = (left + 150, top - 450, left + 450, top - 150)
            pass_prepared = lf.acquire(
                bounds, tmp / "mat-pass", lf.RequestBudget({}),
                sources=source_set(exact))
            self.assertTrue(all(entry["error"] is None
                                for entry in pass_prepared.values()))
            fail_prepared = lf.acquire(
                bounds, tmp / "mat-fail", lf.RequestBudget({}),
                sources=source_set(shifted))
            self.assertIn(
                "section 2.2", fail_prepared["fuels-fbfm40"]["error"])

    def test_aggregate_revalidation_pass_and_shifted_failure(self) -> None:
        with _cache_tempdir() as tmp_name:
            tmp = Path(tmp_name)
            left, top = core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y
            exact = from_origin(left, top, 30.0, 30.0)
            shifted = from_origin(left + 1.0, top, 30.0, 30.0)
            paths = {
                "fuels-fbfm40": _write_raster(
                    tmp / "fbfm.tif",
                    np.full((12, 12), 101, dtype="float32"),
                    exact, nodata=np.nan),
                "fuels-evt": _write_raster(
                    tmp / "evt.tif",
                    np.full((12, 12), 7008, dtype="float32"),
                    exact, nodata=np.nan),
                "landcover-nlcd": _write_raster(
                    tmp / "nlcd.tif",
                    np.full((12, 12), 41, dtype="float32"),
                    exact, nodata=np.nan),
                "hazard-whp": _write_raster(
                    tmp / "whp.tif",
                    np.full((12, 12), 2, dtype="float32"),
                    exact, nodata=np.nan),
            }
            attrs = tmp / "attrs.json"
            attrs.write_text('{"7008": "Known EVT"}\n', encoding="utf-8")
            prepared = {key: _prepared_entry(path)
                        for key, path in paths.items()}
            prepared["fuels-evt-attributes"] = _prepared_entry(
                attrs, "attributes")
            gdf = gpd.GeoDataFrame(
                [{"CODE": "known",
                  "geometry": box(left + 90, top - 180,
                                  left + 180, top - 90)}],
                crs=core.ANALYSIS_CRS,
            )
            passed = lf.aggregate(gdf, "CODE", prepared=prepared)
            self.assertTrue(all("unavailable" not in value
                                for value in passed["known"].values()))

            shifted_path = _write_raster(
                tmp / "fbfm-shifted.tif",
                np.full((12, 12), 101, dtype="float32"),
                shifted, nodata=np.nan)
            shifted_prepared = dict(prepared)
            shifted_prepared["fuels-fbfm40"] = _prepared_entry(shifted_path)
            failed = lf.aggregate(
                gdf, "CODE", prepared=shifted_prepared)["known"]
            self.assertTrue(failed["fbfm40"]["unavailable"])
            self.assertIn("section 2.2", failed["fbfm40"]["reason"])
            self.assertNotIn("unavailable", failed["evt"])

    def test_attribute_error_keeps_evt_stats_with_null_name(self) -> None:
        fracs = {7008: 1.0}
        block = lf._evt_block(fracs, 100.0, None, "known")
        self.assertEqual(block, {
            "dominantCode": 7008,
            "dominantName": None,
            "dominantFraction": 1.0,
            "coveragePct": 100.0,
        })
        self.assertNotIn("reason", block)

    def test_lossless_padding_mask_and_whp_dtype_staging(self) -> None:
        with _cache_tempdir() as tmp_name:
            tmp = Path(tmp_name)
            transform = from_origin(
                core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y, 30.0, 30.0)
            service = _write_raster(
                tmp / "service.tif",
                np.array([[-9999, 0, 101]], dtype="int16"),
                transform,
                nodata=None,
            )
            staged = lf._stage_service_nodata(service, "fuels-fbfm40", {
                "maskValues": [-9999, 0],
                "stagingNodata": 0,
                "declaredField": "noDataValue",
                "declaredValue": -9999,
            })
            with rasterio.open(staged) as ds:
                self.assertEqual(ds.nodata, 0)
                self.assertEqual(ds.read(1, masked=True).compressed().tolist(),
                                 [101])

            whp = _write_raster(
                tmp / "whp-uint8.tif",
                np.array([[1, 7, 255]], dtype="uint8"),
                from_origin(
                    core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y, 270.0, 270.0),
                nodata=255,
            )
            materialization_path, receipt = lf.stage_whp_for_materialization(
                whp)
            self.assertEqual(receipt["widenedDtype"], "int16")
            self.assertEqual(receipt["valueIdentityCheck"],
                             "PASS for every valid pixel")
            with rasterio.open(materialization_path) as ds:
                values = ds.read(1, masked=True)
                self.assertEqual(values.compressed().tolist(), [1.0, 7.0])


class TwoStepTransportRetryTests(unittest.TestCase):
    """Pins the DDM_LFPS_TWO_STEP transport's retry contract: transient
    transport drops retry with every HTTP attempt spending the budget
    first; server-side failures never retry."""

    class _Resp:
        def __init__(self, *, json_value=None, content=b"", error=None):
            self._json = json_value
            self.content = content
            self._error = error

        def raise_for_status(self):
            if self._error is not None:
                raise self._error

        def json(self):
            return self._json

    def _run(self, responses):
        calls = []

        def fake_get(url, **kwargs):
            calls.append(url)
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        budget = lf.RequestBudget({"lfps-exportimage": 10})
        with patch.object(lf.requests, "get", side_effect=fake_get):
            result = lf._fetch_tiff_two_step(
                "https://example.invalid/exportImage",
                {"f": "json", "bbox": "0,0,1,1"},
                budget,
                "lfps-exportimage",
            )
        return result, budget, calls

    def test_transient_href_drop_retries_and_spends_per_attempt(self):
        tiff = b"II*\x00rest"
        ok_json = self._Resp(json_value={"href": "https://example.invalid/out.tif"})
        responses = [
            ok_json,
            lf.requests.exceptions.ChunkedEncodingError("broken mid-body"),
            self._Resp(json_value={"href": "https://example.invalid/out.tif"}),
            self._Resp(content=tiff),
        ]
        result, budget, calls = self._run(responses)
        self.assertEqual(result, tiff)
        # The caller's pre-spend covers the first f=json request; inside
        # the helper: first href spend, then the retry's json + href.
        self.assertEqual(budget.counts["lfps-exportimage"], 3)
        self.assertEqual(len(calls), 4)

    def test_server_side_http_error_never_retries(self):
        error = lf.requests.exceptions.HTTPError("500 Server Error")
        responses = [self._Resp(error=error), self._Resp(content=b"II*\x00")]
        budget = lf.RequestBudget({"lfps-exportimage": 10})
        calls = []

        def fake_get(url, **kwargs):
            calls.append(url)
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with patch.object(lf.requests, "get", side_effect=fake_get):
            with self.assertRaises(lf.requests.exceptions.HTTPError):
                lf._fetch_tiff_two_step(
                    "https://example.invalid/exportImage",
                    {"f": "json"},
                    budget,
                    "lfps-exportimage",
                )
        self.assertEqual(len(calls), 1)
        self.assertEqual(budget.counts["lfps-exportimage"], 0)

    def test_exhausted_transient_attempts_reraise_last_error(self):
        drop = lf.requests.exceptions.ChunkedEncodingError
        ok_json = {"href": "https://example.invalid/out.tif"}
        responses = [
            self._Resp(json_value=ok_json), drop("drop 1"),
            self._Resp(json_value=ok_json), drop("drop 2"),
            self._Resp(json_value=ok_json), drop("drop 3"),
        ]
        budget = lf.RequestBudget({"lfps-exportimage": 10})

        def fake_get(url, **kwargs):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with patch.object(lf.requests, "get", side_effect=fake_get):
            with self.assertRaisesRegex(
                    lf.requests.exceptions.ChunkedEncodingError, "drop 3"):
                lf._fetch_tiff_two_step(
                    "https://example.invalid/exportImage",
                    {"f": "json"},
                    budget,
                    "lfps-exportimage",
                )
        # Three href spends plus two retry json spends.
        self.assertEqual(budget.counts["lfps-exportimage"], 5)

    def test_single_request_retry_helper_spends_per_retry(self):
        tiff = b"II*\x00rest"
        responses = [
            lf.requests.exceptions.ConnectionError("broken mid-body"),
            self._Resp(content=tiff),
        ]
        budget = lf.RequestBudget({"mrlc-wcs": 10})

        def fake_get(url, **kwargs):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with patch.object(lf.requests, "get", side_effect=fake_get):
            result = lf._fetch_tiff_with_transient_retry(
                "https://example.invalid/wcs", {"bbox": "0,0,1,1"},
                budget, "mrlc-wcs")
        self.assertEqual(result, tiff)
        # The caller's pre-spend covers the first attempt; only the
        # retry spends here.
        self.assertEqual(budget.counts["mrlc-wcs"], 1)

    def test_whp_transient_drop_resumes_via_call_site_loop(self):
        drops = [lf.requests.exceptions.ChunkedEncodingError("dropped")]
        zip_marker = Path("fake-whp.zip")
        tif_marker = Path("fake-whp.tif")

        def fake_download(budget, url=lf.WHP_ZIP_URL):
            if drops:
                raise drops.pop(0)
            return zip_marker

        budget = lf.RequestBudget({"rds-whp-zip": 3})
        with patch.object(lf, "download_whp_zip", side_effect=fake_download), \
                patch.object(lf, "extract_whp_classified_tif",
                             return_value=tif_marker) as extract:
            path, service_returned = lf._resolve_local_source(
                "hazard-whp", (0.0, 0.0, 1.0, 1.0), budget, None)
        self.assertEqual(path, tif_marker)
        self.assertFalse(service_returned)
        extract.assert_called_once_with(zip_marker)


if __name__ == "__main__":
    unittest.main()
