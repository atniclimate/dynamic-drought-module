"""Offline regression snapshots and hand-worked proofs for the soil adapter."""
from __future__ import annotations

import hashlib
import json
import math
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from scripts.landscape import core
from scripts.landscape.adapters import soil
from scripts.landscape.tests.fixtures.soil import capture as soil_capture


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "soil"
EXPECTED_FIXTURE_SHA256 = {
    "mukey-window.tif": "539f4d619c198181666a89606394dabd7ad8ab811de350867cc002eb85514b16",
    "sda-rows.json": "c6ff4b1a0c9b5b165a51b90f436cc3af495621b178336ddc0ca4f3ced6cd2d3e",
    "expected-soil-block.json": "6c3ad1775938c32d6bdb65d18160e551c8bb847030f102fe2a88076c2d0d1eb5",
    "capture.py": "49f8d6086477cd2538f8e0fcb12a546ad31d00be930c39ca59e9acae65ecbb1e",
    "SOURCES.md": "500733e787b08ab22dbeab47bd58736be543624e58f3fd819767ecd3d11c6e22",
}
EXPECTED_PROJECTED_BOUNDS = (
    -2365675.3568129563,
    2146441.4190688874,
    -1061758.9160277545,
    3265827.6540713627,
)
EXPECTED_SNAPPED_BOUNDS = (-2365695.0, 2146425.0, -1061745.0, 3265845.0)
EXPECTED_FIXTURE_CORNER = (-2112975.0, 2726205.0)


def _write_raster(
    path: Path,
    values: np.ndarray,
    *,
    transform=None,
    nodata: float = -9999.0,
) -> Path:
    transform = transform or from_origin(core.GRID_ANCHOR_X, core.GRID_ANCHOR_Y, 30, 30)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=values.shape[0],
        width=values.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:5070",
        transform=transform,
        nodata=nodata,
    ) as output:
        output.write(values.astype("float32"), 1)
    return path


def _base_rows() -> dict[str, list[dict]]:
    return {
        "sacatalog": [
            {"areasymbol": "US", "saverest": "2025-09-30"},
            {"areasymbol": "WA001", "saverest": "2025-10-02"},
        ],
        "muaggatt": [
            {"mukey": "1", "aws0150wta": "1", "drclassdcd": "Well drained"},
            {"mukey": "2", "aws0150wta": "3", "drclassdcd": "Somewhat poorly drained"},
        ],
        "component": [
            {"mukey": "1", "cokey": "101", "comppct_r": "100", "majcompflag": "Yes"},
            {"mukey": "2", "cokey": "201", "comppct_r": "100", "majcompflag": "Yes"},
        ],
        "chorizon": [
            {"cokey": "101", "chkey": "1001", "hzdept_r": "0", "hzdepb_r": "200", "awc_r": "0.006666666666666667"},
            {"cokey": "201", "chkey": "2001", "hzdept_r": "0", "hzdepb_r": "90", "awc_r": "0.033333333333333333"},
        ],
        "chtexturegrp": [
            {"chkey": "1001", "chtgkey": "1101", "texture": "Loam group", "rvindicator": "Yes"},
            {"chkey": "2001", "chtgkey": "2101", "texture": "Sand group", "rvindicator": "Yes"},
        ],
        "chtexture": [
            {"chtgkey": "1101", "chtkey": "1111", "texcl": "Loam"},
            {"chtgkey": "2101", "chtkey": "2111", "texcl": "Sand"},
        ],
        "corestrictions": [
            {"cokey": "101", "resdept_r": "180"},
        ],
        "mapunit": [
            {"mukey": "1", "lkey": "11"},
            {"mukey": "2", "lkey": "22"},
        ],
        "legend": [
            {"lkey": "11", "areasymbol": "WA001"},
            {"lkey": "22", "areasymbol": "US"},
        ],
    }


def _histogram(entries: list[tuple[int, float]], total: float | None = None) -> dict:
    valid = sum(area for _, area in entries)
    total = valid if total is None else total
    return {
        "totalAreaM2": total,
        "validAreaM2": valid,
        "nodataAreaM2": total - valid,
        "effectiveCellCount": valid / 900.0,
        "entries": [
            {"mukey": mukey, "areaM2": area, "fraction": area / valid}
            for mukey, area in sorted(entries)
        ] if valid else [],
    }


def _prepared(raster: Path, table: Path) -> dict:
    return {
        "soil-mukey": {
            "kind": "raster",
            "path": raster,
            "error": None,
            "acquired": "2026-07-22",
            "sha256": hashlib.sha256(raster.read_bytes()).hexdigest(),
        },
        "soil-sda": {
            "kind": "table",
            "path": table,
            "error": None,
            "acquired": "2026-07-22",
            "sha256": hashlib.sha256(table.read_bytes()).hexdigest(),
        },
    }


def _write_table(path: Path, rows: dict | None = None) -> Path:
    soil.write_json(path, rows or _base_rows())
    return path


def _packed_sda_response(rows: dict[str, list[dict]]) -> bytes:
    return json.dumps({
        "Table": [
            list(soil.SDA_TABLES),
            [json.dumps(rows[table]) for table in soil.SDA_TABLES],
        ]
    }).encode("utf-8")


def _manifest_for(directory: Path, hist3: dict, hist4: dict, rows: dict) -> dict:
    soil.write_json(directory / "histogram-l3.json", hist3)
    soil.write_json(directory / "histogram-l4.json", hist4)
    soil.write_json(directory / "sda-rows.json", rows)
    evidence = soil.vintage_evidence(rows["sacatalog"])
    manifest = {
        "manifestSchemaVersion": "1",
        **evidence,
        "rasterVintageAssumption": soil.RASTER_VINTAGE_ASSUMPTION,
        "tileGrid": {
            "projectedBounds5070": list(EXPECTED_PROJECTED_BOUNDS),
            "snappedBounds5070": list(EXPECTED_SNAPPED_BOUNDS),
            "tileSizeCells": 5000,
            "tilesX": 9,
            "tilesY": 8,
        },
        "tiles": [
            {"ix": ix, "iy": iy, "sha256": "0" * 64}
            for iy in range(8) for ix in range(9)
        ],
        "epaBoundaryZips": {
            "l3": {"filename": "l3.zip", "sha256": "1" * 64},
            "l4": {"filename": "l4.zip", "sha256": "2" * 64},
        },
        "sdaQueries": [{"query": "SELECT fixture", "responseSha256": "3" * 64}],
        "files": {
            name: soil.sha256_file(directory / name)
            for name in ("histogram-l3.json", "histogram-l4.json", "sda-rows.json")
        },
        "captureDates": {"wcsPull": "2026-07-22", "sdaPull": "2026-07-22"},
        "requestCounts": {
            "soilweb-wcs": 1,
            "sda-post": 1,
            "epa-s3": 2,
            "metadata": 0,
        },
    }
    soil.write_json(directory / "MANIFEST.json", manifest)
    return manifest


@unittest.skipUnless(
    all((FIXTURES / name).is_file() for name in EXPECTED_FIXTURE_SHA256),
    "capture fixtures not written yet",
)
class CaptureSnapshotRegression(unittest.TestCase):
    """Captured bytes are drift pins, not correctness oracles."""

    def test_fixture_inventory_is_exact(self) -> None:
        self.assertEqual(
            {path.name for path in FIXTURES.iterdir() if path.is_file()},
            set(EXPECTED_FIXTURE_SHA256),
        )

    def test_fixture_sha256_pins(self) -> None:
        for name, expected in EXPECTED_FIXTURE_SHA256.items():
            with self.subTest(file=name):
                self.assertEqual(
                    hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest(),
                    expected,
                )

    def test_fixture_window_corner_known_answer(self) -> None:
        with rasterio.open(FIXTURES / "mukey-window.tif") as dataset:
            self.assertEqual((dataset.transform.c, dataset.transform.f), EXPECTED_FIXTURE_CORNER)
            self.assertEqual((dataset.width, dataset.height), (100, 100))

    def test_source_note_request_mapping_and_header_owner(self) -> None:
        text = (FIXTURES / "SOURCES.md").read_text(encoding="utf-8")
        self.assertIn("tile(s) `[[1, 3]]`", text)
        self.assertIn("batch(es) `[0]`", text)
        self.assertIn("next vintage's annual full pull", text)
        self.assertIn("Hypertext Transfer Protocol", text)
        self.assertNotIn("next budgeted T-S1-4 contact", text)

    def test_captured_window_matches_snapshot(self) -> None:
        with rasterio.open(FIXTURES / "mukey-window.tif") as dataset:
            bounds = dataset.bounds
        gdf = gpd.GeoDataFrame(
            {"US_L3CODE": ["fixture"]},
            geometry=[box(*bounds)],
            crs="EPSG:5070",
        )
        result = soil.aggregate(
            gdf,
            "US_L3CODE",
            prepared=_prepared(
                FIXTURES / "mukey-window.tif", FIXTURES / "sda-rows.json"
            ),
        )
        expected = json.loads(
            (FIXTURES / "expected-soil-block.json").read_text(encoding="utf-8")
        )
        self.assertEqual(result["fixture"], expected)


class HandWorkedKnownAnswers(unittest.TestCase):
    """Correctness proofs computed independently of captured snapshots."""

    def test_full_pull_grid_known_answer(self) -> None:
        from rasterio.warp import transform_bounds

        projected = transform_bounds(
            "EPSG:4326", "EPSG:5070", *core.PNW_BBOX, densify_pts=21
        )
        self.assertEqual(projected, EXPECTED_PROJECTED_BOUNDS)
        west = core.GRID_ANCHOR_X + math.floor(
            (projected[0] - core.GRID_ANCHOR_X) / 30
        ) * 30
        south = core.GRID_ANCHOR_Y + math.floor(
            (projected[1] - core.GRID_ANCHOR_Y) / 30
        ) * 30
        east = core.GRID_ANCHOR_X + math.ceil(
            (projected[2] - core.GRID_ANCHOR_X) / 30
        ) * 30
        north = core.GRID_ANCHOR_Y + math.ceil(
            (projected[3] - core.GRID_ANCHOR_Y) / 30
        ) * 30
        self.assertEqual((west, south, east, north), EXPECTED_SNAPPED_BOUNDS)
        width = round((east - west) / 30)
        height = round((north - south) / 30)
        self.assertEqual((width, height), (43465, 37314))
        self.assertEqual((math.ceil(width / 5000), math.ceil(height / 5000)), (9, 8))

    def test_weighted_percentile_is_step_function_not_linear(self) -> None:
        values = [(0.0, 1.0), (100.0, 9.0)]
        self.assertEqual(soil.weighted_percentile(values, 0.10), 0.0)
        linear_interpolation_rival = 10.0
        self.assertNotEqual(soil.weighted_percentile(values, 0.10), linear_interpolation_rival)

    def test_static_provenance_blocks_cover_both_subsources(self) -> None:
        expected_keys = {
            "source", "sourceUrl", "vintage", "resolutionMeters", "method",
            "methodVersion",
        }
        self.assertEqual(set(soil.SOURCE), expected_keys)
        self.assertEqual(set(soil.SOURCE_MUKEY), expected_keys)
        self.assertEqual(set(soil.SOURCE_SDA), expected_keys)
        self.assertEqual(soil.SOURCE, soil.SOURCE_MUKEY)
        self.assertEqual(soil.SOURCE_MUKEY["sourceUrl"], soil.SOILWEB_WCS_URL)
        self.assertEqual(soil.SOURCE_SDA["sourceUrl"], soil.SDA_URL)
        self.assertIsNone(soil.SOURCE_SDA["resolutionMeters"])
        self.assertEqual(soil.SOURCE_SDA["methodVersion"], 1)

    def test_capture_transport_is_executed_by_acquire(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "response.bin"
            request = soil.CaptureRequest(
                method="GET",
                url="https://example.invalid/capture",
                endpoint_key="metadata",
                destination=destination,
            )
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.iter_content.return_value = [b"adapter-only-fetch"]
            response.headers = {}
            response.raise_for_status.return_value = None
            budget = soil.RequestBudget({"metadata": 1})
            with mock.patch.object(soil.requests, "get", return_value=response) as get:
                prepared = soil.acquire(
                    (
                        core.GRID_ANCHOR_X,
                        core.GRID_ANCHOR_Y - 30,
                        core.GRID_ANCHOR_X + 30,
                        core.GRID_ANCHOR_Y,
                    ),
                    Path(tmp),
                    budget,
                    sources=request,
                )
            self.assertEqual(destination.read_bytes(), b"adapter-only-fetch")
            self.assertIsNone(request.error)
            self.assertEqual(budget.counts, {"metadata": 1})
            self.assertEqual(set(prepared), {"soil-mukey", "soil-sda"})
            get.assert_called_once()
        capture_source = Path(soil_capture.__file__).read_text(encoding="utf-8")
        self.assertNotIn("import requests", capture_source)
        self.assertNotRegex(capture_source, r"\brequests\.(get|post)\b")

    def test_hand_worked_soil_derivations(self) -> None:
        rows = _base_rows()
        hist = {"A": _histogram([(1, 2700.0), (2, 6300.0)])}
        result = soil.soil_blocks_from_histogram(hist, rows, level=3)["A"]["soil"]
        self.assertEqual(result["awsRootZoneMm"], 24.0)
        self.assertEqual(result["awsP10"], 10.0)
        self.assertEqual(result["awsP90"], 30.0)
        self.assertEqual(result["rootZoneDepthCm"], 117.0)
        self.assertEqual(result["dominantTexture"], "Sand")
        self.assertEqual(result["ssurgoFraction"], 0.3)
        self.assertEqual(result["statsgo2Fraction"], 0.7)
        self.assertTrue(result["generalized"])
        self.assertTrue(result["coarse"])

    def test_root_depth_is_not_capped_at_150(self) -> None:
        rows = _base_rows()
        index = soil._index_rows(rows)
        self.assertEqual(soil._mukey_root_depth("1", index), 180.0)

    def test_dominant_component_and_texture_tie_breaks(self) -> None:
        rows = _base_rows()
        rows["component"] = [
            {"mukey": "1", "cokey": "102", "comppct_r": "50", "majcompflag": "Yes"},
            {"mukey": "1", "cokey": "101", "comppct_r": "50", "majcompflag": "Yes"},
        ]
        rows["chorizon"] = [
            {"cokey": "101", "chkey": "1002", "hzdept_r": "0", "hzdepb_r": "20", "awc_r": "0.05"},
            {"cokey": "101", "chkey": "1001", "hzdept_r": "0", "hzdepb_r": "10", "awc_r": "0.05"},
        ]
        rows["chtexturegrp"] = [
            {"chkey": "1001", "chtgkey": "700", "texture": "Ignored non-RV", "rvindicator": "No"},
            {"chkey": "1001", "chtgkey": "900", "texture": "Later RV", "rvindicator": "Yes"},
            {"chkey": "1001", "chtgkey": "800", "texture": "First RV", "rvindicator": "Yes"},
            {"chkey": "1002", "chtgkey": "1000", "texture": "Deeper surface tie", "rvindicator": "Yes"},
        ]
        rows["chtexture"] = [
            {"chtgkey": "700", "chtkey": "1", "texcl": "Clay"},
            {"chtgkey": "800", "chtkey": "2", "texcl": "Silt loam"},
            {"chtgkey": "800", "chtkey": "1", "texcl": "Loam"},
            {"chtgkey": "900", "chtkey": "1", "texcl": "Sand"},
            {"chtgkey": "1000", "chtkey": "1", "texcl": "Silt loam"},
        ]
        index = soil._index_rows(rows)
        self.assertEqual(soil._dominant_component("1", index)["cokey"], "101")
        self.assertEqual(soil._mukey_texture("1", index), "Loam")

    def test_partial_nodata_histogram_effective_count_and_coarse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raster = _write_raster(
                root / "partial.tif",
                np.array([[1, 1], [2, -9999]], dtype="float32"),
            )
            table = _write_table(root / "rows.json")
            gdf = gpd.GeoDataFrame(
                {"US_L3CODE": ["A"]},
                geometry=[box(
                    core.GRID_ANCHOR_X,
                    core.GRID_ANCHOR_Y - 60,
                    core.GRID_ANCHOR_X + 60,
                    core.GRID_ANCHOR_Y,
                )],
                crs="EPSG:5070",
            )
            histogram = soil._histograms_from_prepared_raster(raster, gdf, "US_L3CODE")["A"]
            self.assertEqual(histogram["totalAreaM2"], 3600.0)
            self.assertEqual(histogram["validAreaM2"], 2700.0)
            self.assertEqual(histogram["nodataAreaM2"], 900.0)
            self.assertEqual(histogram["effectiveCellCount"], 3.0)
            result = soil.aggregate(gdf, "US_L3CODE", prepared=_prepared(raster, table))
            self.assertEqual(result["A"]["soil"]["cellCount"], 3.0)
            self.assertTrue(result["A"]["soil"]["coarse"])

    @unittest.skipUnless(
        (FIXTURES / "sda-rows.json").is_file(),
        "capture fixtures not written yet",
    )
    def test_captured_rows_pin_the_millimeter_conversion(self) -> None:
        rows = json.loads((FIXTURES / "sda-rows.json").read_text(encoding="utf-8"))
        receipt = soil.unit_cross_check(rows)
        self.assertEqual(receipt["verdict"], "PASS")
        self.assertGreaterEqual(receipt["selectedCount"], 8)
        self.assertGreaterEqual(receipt["passingCount"], 8)
        self.assertFalse(receipt["systematicNear10xOr0_1x"])
        positive = next(item for item in receipt["sample"] if item["aws0150wtaCm"] > 0)
        mukey = positive["mukey"]
        histogram = {"A": _histogram([(mukey, 900.0)])}
        block = soil.soil_blocks_from_histogram(histogram, rows, level=3)["A"]["soil"]
        expected_mm = round(positive["aws0150wtaCm"] * soil.AWS_CM_TO_MM, 1)
        self.assertEqual(block["awsRootZoneMm"], expected_mm)
        self.assertEqual(block["awsP10"], expected_mm)
        self.assertEqual(block["awsP90"], expected_mm)

    def test_source_and_prepared_congruence_assertions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows_path = _write_table(root / "rows.json")
            exact = _write_raster(root / "exact.tif", np.ones((2, 2)))
            shifted = _write_raster(
                root / "shifted.tif",
                np.ones((2, 2)),
                transform=from_origin(
                    core.GRID_ANCHOR_X + 0.03, core.GRID_ANCHOR_Y, 30, 30
                ),
            )
            budget = soil.RequestBudget({"soilweb-wcs": 0, "sda-post": 0})
            acquired = soil.acquire(
                (
                    core.GRID_ANCHOR_X,
                    core.GRID_ANCHOR_Y - 60,
                    core.GRID_ANCHOR_X + 60,
                    core.GRID_ANCHOR_Y,
                ),
                root / "cache",
                budget,
                sources={"soil-mukey": str(exact), "soil-sda": str(rows_path)},
            )
            self.assertIsNone(acquired["soil-mukey"]["error"])
            failed = soil.acquire(
                (
                    core.GRID_ANCHOR_X,
                    core.GRID_ANCHOR_Y - 60,
                    core.GRID_ANCHOR_X + 60,
                    core.GRID_ANCHOR_Y,
                ),
                root / "cache2",
                budget,
                sources={"soil-mukey": str(shifted), "soil-sda": str(rows_path)},
            )
            self.assertIn("section 2.2", failed["soil-mukey"]["error"])

            gdf = gpd.GeoDataFrame(
                {"US_L3CODE": ["A"]},
                geometry=[box(
                    core.GRID_ANCHOR_X,
                    core.GRID_ANCHOR_Y - 60,
                    core.GRID_ANCHOR_X + 60,
                    core.GRID_ANCHOR_Y,
                )],
                crs="EPSG:5070",
            )
            good = soil.aggregate(gdf, "US_L3CODE", prepared=_prepared(exact, rows_path))
            self.assertIn("soil", good["A"])
            bad = soil.aggregate(gdf, "US_L3CODE", prepared=_prepared(shifted, rows_path))
            self.assertTrue(bad["A"]["unavailable"])
            self.assertIn("section 2.2", bad["A"]["reason"])

    def test_request_budget_exceeded_path(self) -> None:
        budget = soil.RequestBudget({"soilweb-wcs": 1})
        budget.spend("soilweb-wcs")
        with self.assertRaisesRegex(
            soil.BudgetExceededError, "soilweb-wcs.*ceiling 1.*sections 4.5/8"
        ):
            budget.spend("soilweb-wcs")
        self.assertEqual(budget.counts["soilweb-wcs"], 1)

    def test_sda_structural_validation_pass_and_fail(self) -> None:
        soil.validate_sda_rows(_base_rows())
        broken = _base_rows()
        broken["muaggatt"][0].pop("drclassdcd")
        with self.assertRaisesRegex(soil.SoilValidationError, "4.7"):
            soil.validate_sda_rows(broken)
        unknown = _base_rows()
        unknown["extra"] = []
        with self.assertRaisesRegex(soil.SoilValidationError, "top-level"):
            soil.validate_sda_rows(unknown)

    def test_unresolved_by_code_survives_two_levels(self) -> None:
        rows = _base_rows()
        hist3 = {
            "A": _histogram([(1, 900.0), (999, 900.0)]),
            "B": _histogram([(2, 1800.0)]),
        }
        hist4 = {
            "C": _histogram([(2, 900.0), (888, 900.0)]),
        }
        run_info = {}
        level3 = soil.soil_blocks_from_histogram(hist3, rows, level=3, run_info=run_info)
        level4 = soil.soil_blocks_from_histogram(hist4, rows, level=4, run_info=run_info)
        self.assertIn("soil", level3["A"])
        self.assertIn("soil", level3["B"])
        self.assertIn("soil", level4["C"])
        self.assertEqual(
            run_info["soilUnresolvedByCode"],
            {
                3: {"A": {"count": 1, "mukeys": [999]}},
                4: {"C": {"count": 1, "mukeys": [888]}},
            },
        )

    def test_zero_join_is_unavailable(self) -> None:
        result = soil.soil_blocks_from_histogram(
            {"U": _histogram([(999, 900.0)])}, _base_rows(), level=3
        )
        self.assertEqual(
            result["U"], {"unavailable": True, "reason": "no usable soil join"}
        )

    def test_multiple_mapunit_rows_fail_closed(self) -> None:
        rows = _base_rows()
        rows["mapunit"].append({"mukey": "1", "lkey": "22"})
        with self.assertRaisesRegex(soil.SoilValidationError, "more than one mapunit"):
            soil.soil_blocks_from_histogram(
                {"A": _histogram([(1, 900.0)])}, rows, level=3
            )

    def test_identical_mapunit_rows_fail_before_batch_deduplication(self) -> None:
        rows = _base_rows()
        rows["mapunit"].append(dict(rows["mapunit"][0]))
        response = _packed_sda_response(rows)
        with self.assertRaisesRegex(soil.SoilValidationError, "more than one mapunit"):
            soil.build_sda_rows(
                [1, 2], lambda _query, _index: response, batch_size=3000
            )


class IntermediateContractProofs(unittest.TestCase):
    def _case(self, root: Path) -> tuple[dict, dict, dict]:
        rows = _base_rows()
        hist3 = {"A": _histogram([(1, 1800.0), (2, 1800.0)])}
        hist4 = {"B": _histogram([(1, 900.0), (2, 2700.0)])}
        manifest = _manifest_for(root, hist3, hist4, rows)
        return hist3, hist4, manifest

    def test_aggregate_and_intermediate_paths_have_identical_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = _base_rows()
            raster = _write_raster(root / "soil.tif", np.array([[1, 1], [2, 2]]))
            table = _write_table(root / "rows-source.json", rows)
            gdf = gpd.GeoDataFrame(
                {"US_L3CODE": ["A"]},
                geometry=[box(
                    core.GRID_ANCHOR_X,
                    core.GRID_ANCHOR_Y - 60,
                    core.GRID_ANCHOR_X + 60,
                    core.GRID_ANCHOR_Y,
                )],
                crs="EPSG:5070",
            )
            histogram = soil._histograms_from_prepared_raster(raster, gdf, "US_L3CODE")
            _manifest_for(root, histogram, {"B": _histogram([(1, 900.0)])}, rows)
            direct = soil.aggregate(gdf, "US_L3CODE", prepared=_prepared(raster, table))
            restored = soil.aggregate_from_intermediates(root, 3)
            self.assertEqual(direct, restored)

    def test_digest_success_and_run_info_forms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._case(root)
            result = soil.aggregate_from_intermediates(root, 3, run_info=None)
            self.assertIn("soil", result["A"])
            run_info = {"keep": True}
            soil.aggregate_from_intermediates(root, 3, run_info=run_info)
            self.assertEqual(run_info["soilMukeyAcquired"], "2026-07-22")
            self.assertIsNone(run_info["soilMukeyRasterSha256"])
            self.assertIn(3, run_info["soilUnresolvedByCode"])
            self.assertTrue(run_info["keep"])

    def test_guard_overflow_reuse_is_exactly_bound_and_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "committed" / "FY2026"
            root.mkdir(parents=True)
            _, _, manifest = self._case(root)
            cache_root = Path(tmp) / "cache"
            overflow = (
                cache_root
                / "soil"
                / "intermediates-overflow"
                / manifest["fyLabel"]
            )
            overflow.mkdir(parents=True)
            for name in soil.INTERMEDIATE_DATA_NAMES:
                (root / name).replace(overflow / name)
            soil.write_json(
                overflow / soil.OVERFLOW_BINDING_NAME,
                soil._overflow_binding_record(manifest),
            )
            with mock.patch.object(core, "CACHE_DIR", cache_root):
                result = soil.aggregate_from_intermediates(root, 3)
            self.assertIn("soil", result["A"])

    def test_guard_overflow_binding_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "committed" / "FY2026"
            root.mkdir(parents=True)
            _, _, manifest = self._case(root)
            cache_root = Path(tmp) / "cache"
            overflow = (
                cache_root
                / "soil"
                / "intermediates-overflow"
                / manifest["fyLabel"]
            )
            overflow.mkdir(parents=True)
            for name in soil.INTERMEDIATE_DATA_NAMES:
                (root / name).replace(overflow / name)
            binding = soil._overflow_binding_record(manifest)
            binding["methodVersion"] += 1
            soil.write_json(overflow / soil.OVERFLOW_BINDING_NAME, binding)
            with mock.patch.object(core, "CACHE_DIR", cache_root):
                with self.assertRaisesRegex(
                    soil.SoilValidationError,
                    "binding sidecar differs",
                ):
                    soil.aggregate_from_intermediates(root, 3)

    def test_one_digest_mismatch_per_data_file(self) -> None:
        for name in ("histogram-l3.json", "histogram-l4.json", "sda-rows.json"):
            with self.subTest(file=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                self._case(root)
                with open(root / name, "ab") as stream:
                    stream.write(b" ")
                with self.assertRaisesRegex(soil.SoilValidationError, f"{re.escape(name)} sha256 mismatch"):
                    soil.aggregate_from_intermediates(root, 3)

    def test_manifest_structural_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, _, manifest = self._case(root)
            manifest.pop("tiles")
            soil.write_json(root / "MANIFEST.json", manifest)
            with self.assertRaisesRegex(soil.SoilValidationError, "MANIFEST structural failure"):
                soil.aggregate_from_intermediates(root, 3)

    def test_histogram_structural_validation(self) -> None:
        valid = {"A": _histogram([(1, 900.0), (2, 900.0)], total=2700.0)}
        soil.validate_histogram(valid)
        broken = json.loads(json.dumps(valid))
        broken["A"]["effectiveCellCount"] = 9
        with self.assertRaisesRegex(soil.SoilValidationError, "effective cell count"):
            soil.validate_histogram(broken)

    def test_manifest_unknown_request_key_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, _, manifest = self._case(root)
            manifest["requestCounts"]["unknown"] = 0
            with self.assertRaisesRegex(soil.SoilValidationError, "requestCounts keys"):
                soil.validate_manifest(manifest)

    def test_manifest_tile_grid_value_semantics_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _, _, baseline = self._case(Path(tmp))
        cases = {
            "projected transform": (
                lambda value: value["tileGrid"]["projectedBounds5070"].__setitem__(0, value["tileGrid"]["projectedBounds5070"][0] - 1),
                "projectedBounds5070",
            ),
            "nonintegral cells": (
                lambda value: value["tileGrid"]["snappedBounds5070"].__setitem__(2, value["tileGrid"]["snappedBounds5070"][2] + 15),
                "cell counts are non-integral",
            ),
            "anchor edge": (
                lambda value: (
                    value["tileGrid"]["snappedBounds5070"].__setitem__(0, value["tileGrid"]["snappedBounds5070"][0] + 1),
                    value["tileGrid"]["snappedBounds5070"].__setitem__(2, value["tileGrid"]["snappedBounds5070"][2] + 1),
                ),
                "anchor-congruent",
            ),
            "outward snap": (
                lambda value: (
                    value["tileGrid"]["snappedBounds5070"].__setitem__(0, value["tileGrid"]["snappedBounds5070"][0] + 30),
                    value["tileGrid"]["snappedBounds5070"].__setitem__(2, value["tileGrid"]["snappedBounds5070"][2] + 30),
                ),
                "outward snap",
            ),
            "tile size type": (
                lambda value: value["tileGrid"].__setitem__("tileSizeCells", 5000.0),
                "tileSizeCells",
            ),
            "tile count type": (
                lambda value: value["tileGrid"].__setitem__("tilesX", 9.0),
                "must be integers",
            ),
            "tile count value": (
                lambda value: value["tileGrid"].__setitem__("tilesY", 7),
                "tile counts differ",
            ),
            "row-major completeness": (
                lambda value: value["tiles"].__setitem__(1, dict(value["tiles"][0])),
                "unique row-major",
            ),
        }
        for label, (mutate, message) in cases.items():
            with self.subTest(rule=label):
                manifest = json.loads(json.dumps(baseline))
                mutate(manifest)
                with self.assertRaisesRegex(soil.SoilValidationError, message):
                    soil.validate_manifest(manifest)

    def test_overflow_reuse_is_bound_to_manifest_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            durable = root / "durable"
            overflow = root / "overflow"
            durable.mkdir()
            overflow.mkdir()
            hist3, hist4, manifest = self._case(durable)
            for name in soil_capture.DATA_NAMES:
                (durable / name).replace(overflow / name)
            identity = soil_capture._manifest_input_identity(manifest)
            binding_path = overflow / soil_capture.OVERFLOW_BINDING_NAME
            with self.assertRaisesRegex(
                soil.SoilValidationError, "binding sidecar is missing"
            ):
                soil_capture._load_bound_overflow(overflow, durable, identity)
            self.assertFalse(binding_path.exists())
            soil.write_json(
                binding_path, soil_capture._overflow_binding_record(manifest)
            )
            loaded_manifest, loaded_l3, loaded_l4, loaded_rows = (
                soil_capture._load_bound_overflow(overflow, durable, identity)
            )
            self.assertEqual(loaded_manifest, manifest)
            self.assertEqual(loaded_l3, hist3)
            self.assertEqual(loaded_l4, hist4)
            self.assertEqual(loaded_rows, _base_rows())
            self.assertTrue(binding_path.is_file())

            mutations = {
                "tile": lambda value: value["tiles"][0].__setitem__("sha256", "f" * 64),
                "boundary": lambda value: value["epaBoundaryZips"]["l3"].__setitem__("sha256", "f" * 64),
                "SDA response": lambda value: value["sdaQueries"][0].__setitem__("responseSha256", "f" * 64),
            }
            for family, mutate in mutations.items():
                with self.subTest(input_family=family):
                    stale = json.loads(json.dumps(identity))
                    mutate(stale)
                    with self.assertRaisesRegex(
                        soil.SoilValidationError, "input identity differs"
                    ):
                        soil_capture._load_bound_overflow(
                            overflow, durable, stale
                        )

            binding = json.loads(binding_path.read_text(encoding="utf-8"))
            binding["captureSchemaVersion"] = "stale"
            soil.write_json(binding_path, binding)
            with self.assertRaisesRegex(
                soil.SoilValidationError, "binding sidecar differs"
            ):
                soil_capture._load_bound_overflow(
                    overflow, durable, identity
                )

    def test_deleted_stale_binding_cannot_bypass_version_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            durable = root / "durable"
            overflow = root / "overflow"
            durable.mkdir()
            overflow.mkdir()
            _, _, manifest = self._case(durable)
            for name in soil_capture.DATA_NAMES:
                (durable / name).replace(overflow / name)
            identity = soil_capture._manifest_input_identity(manifest)
            binding_path = overflow / soil_capture.OVERFLOW_BINDING_NAME
            stale = soil_capture._overflow_binding_record(manifest)
            stale["captureSchemaVersion"] = "stale"
            soil.write_json(binding_path, stale)
            with self.assertRaisesRegex(
                soil.SoilValidationError, "binding sidecar differs"
            ):
                soil_capture._load_bound_overflow(
                    overflow, durable, identity
                )
            binding_path.unlink()
            with self.assertRaisesRegex(
                soil.SoilValidationError, "binding sidecar is missing"
            ):
                soil_capture._load_bound_overflow(
                    overflow, durable, identity
                )
            self.assertFalse(binding_path.exists())

    def test_overflow_reuse_validates_sda_structure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            durable = root / "durable"
            overflow = root / "overflow"
            durable.mkdir()
            overflow.mkdir()
            _, _, manifest = self._case(durable)
            for name in soil_capture.DATA_NAMES:
                (durable / name).replace(overflow / name)
            soil.write_json(overflow / "sda-rows.json", {"not-sda": []})
            manifest["files"]["sda-rows.json"] = soil.sha256_file(
                overflow / "sda-rows.json"
            )
            soil.write_json(durable / "MANIFEST.json", manifest)
            soil.write_json(
                overflow / soil_capture.OVERFLOW_BINDING_NAME,
                soil_capture._overflow_binding_record(manifest),
            )
            with self.assertRaisesRegex(soil.SoilValidationError, "top-level tables"):
                soil_capture._load_bound_overflow(
                    overflow,
                    durable,
                    soil_capture._manifest_input_identity(manifest),
                )

    def test_drift_check_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._case(root)
            content = json.dumps({
                "Table": [
                    ["areasymbol", "saverest"],
                    ["US", "2025-09-30"],
                    ["WA001", "2025-10-02"],
                ]
            }).encode("utf-8")
            response = mock.Mock(content=content)
            response.raise_for_status.return_value = None
            budget = soil.RequestBudget({"sda-post": 1})
            with mock.patch.object(soil.requests, "post", return_value=response) as post:
                result = soil.drift_check(root, budget)
            self.assertFalse(result["drift"])
            self.assertEqual(result["recorded"], result["current"])
            self.assertEqual(budget.counts, {"sda-post": 1})
            post.assert_called_once()

    def test_drift_check_inconsistent_manifest_stops_before_network(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, _, manifest = self._case(root)
            manifest["saverestMax"] = "2025-10-03"
            soil.write_json(root / "MANIFEST.json", manifest)
            budget = soil.RequestBudget({"sda-post": 1})
            with mock.patch.object(soil.requests, "post") as post:
                with self.assertRaisesRegex(soil.SoilValidationError, "vintage tuple"):
                    soil.drift_check(root, budget)
            post.assert_not_called()
            self.assertEqual(budget.counts, {"sda-post": 0})


if __name__ == "__main__":
    unittest.main()
