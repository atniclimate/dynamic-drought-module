"""Unit tests for the shared core helpers (T-M0-1; behavior-preserving)
plus the T-M0-3 provenance linkage (real sha/acquisition mechanisms; the
fixture byte-pins deliberately carry seam-injected values instead)."""
from __future__ import annotations

import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import rasterio

from scripts.landscape import core
from scripts.landscape.adapters import terrain

SYNTH = Path(__file__).resolve().parent / "fixtures" / "synthetic"


class RoundOrNone(unittest.TestCase):
    def test_regular_values(self) -> None:
        self.assertEqual(core.round_or_none(1.2345, 2), 1.23)
        self.assertEqual(core.round_or_none(100, 1), 100.0)

    def test_none_and_unparseable(self) -> None:
        self.assertIsNone(core.round_or_none(None, 1))
        self.assertIsNone(core.round_or_none("not a number", 1))

    def test_nonfinite(self) -> None:
        self.assertIsNone(core.round_or_none(math.nan, 1))
        self.assertIsNone(core.round_or_none(math.inf, 1))


class RetrievedDate(unittest.TestCase):
    def test_override_wins_over_env(self) -> None:
        with mock.patch.dict("os.environ", {core.RETRIEVED_ENV: "2025-12-31"}):
            self.assertEqual(core.retrieved_date("2026-01-01"), "2026-01-01")

    def test_env_used_when_no_override(self) -> None:
        with mock.patch.dict("os.environ", {core.RETRIEVED_ENV: "2025-12-31"}):
            self.assertEqual(core.retrieved_date(None), "2025-12-31")

    def test_falls_back_to_today_format(self) -> None:
        with mock.patch.dict("os.environ", clear=False) as env:
            env.pop(core.RETRIEVED_ENV, None)
            got = core.retrieved_date(None)
        self.assertRegex(got, r"^\d{4}-\d{2}-\d{2}$")


class DownloadCache(unittest.TestCase):
    def test_existing_file_short_circuits_network(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "asset.zip"
            dest.write_bytes(b"cached")
            # An unroutable URL: any network attempt would raise.
            got = core.download("http://invalid.invalid/asset.zip", dest)
            self.assertEqual(got, dest)
            self.assertEqual(dest.read_bytes(), b"cached")


class Materialize(unittest.TestCase):
    BOUNDS = (-1_899_700.0, 2_898_700.0, -1_898_500.0, 2_899_700.0)

    def test_grid_is_anchored_to_the_nlcd_landfire_origin(self) -> None:
        """The output transform's origin must sit on the anchored grid
        (offset from GRID_ANCHOR an exact multiple of GRID_RES_M), which is
        NOT the absolute-multiples-of-30 grid."""
        with tempfile.TemporaryDirectory() as tmp:
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            with rasterio.open(dest) as ds:
                t = ds.transform
        self.assertEqual(t.a, core.GRID_RES_M)
        self.assertEqual(-t.e, core.GRID_RES_M)
        self.assertEqual((t.c - core.GRID_ANCHOR_X) % core.GRID_RES_M, 0.0)
        self.assertEqual((t.f - core.GRID_ANCHOR_Y) % core.GRID_RES_M, 0.0)
        # The anchor itself is offset 15 m from absolute multiples.
        self.assertEqual(t.c % core.GRID_RES_M, 15.0)

    def test_second_call_reuses_the_materialized_raster(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            first = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            stamp = first.stat().st_mtime_ns
            second = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            self.assertEqual(first, second)
            self.assertEqual(second.stat().st_mtime_ns, stamp)

    def test_corrupt_cache_is_rematerialized(self) -> None:
        """A truncated or unreadable cached raster must not be trusted."""
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            first = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            first.write_bytes(b"not a geotiff")
            second = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            with rasterio.open(second) as ds:
                self.assertEqual(str(ds.crs), core.ANALYSIS_CRS)

    def test_missing_sidecar_is_rematerialized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            first = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            first.with_suffix(".meta.json").unlink()
            stamp = first.stat().st_mtime_ns
            second = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            self.assertNotEqual(second.stat().st_mtime_ns, stamp)
            self.assertTrue(second.with_suffix(".meta.json").exists())

    def test_acquisition_date_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            got = core.acquisition_date(dest)
        self.assertRegex(got or "", r"^\d{4}-\d{2}-\d{2}$")

    def test_read_window_at_the_materialized_edges(self) -> None:
        """Reading the padded window of the extreme bounds used for the
        materialization stays inside the raster (the 120 m materialize pad
        versus 60 m read pad containment contract)."""
        with tempfile.TemporaryDirectory() as tmp:
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            with rasterio.open(dest) as ds:
                arr, transform = core.read_window(ds, self.BOUNDS)
                self.assertGreater(arr.shape[0], 0)
                self.assertGreater(arr.shape[1], 0)
                # All FOUR edges of the read window sit inside the raster.
                win_minx = transform.c
                win_maxy = transform.f
                win_maxx = transform.c + transform.a * arr.shape[1]
                win_miny = transform.f + transform.e * arr.shape[0]
                ds_minx = ds.transform.c
                ds_maxy = ds.transform.f
                ds_maxx = ds.transform.c + ds.transform.a * ds.width
                ds_miny = ds.transform.f + ds.transform.e * ds.height
                self.assertGreaterEqual(win_minx, ds_minx)
                self.assertLessEqual(win_maxy, ds_maxy)
                self.assertLessEqual(win_maxx, ds_maxx)
                self.assertGreaterEqual(win_miny, ds_miny)


class TerrainContractB(unittest.TestCase):
    def test_acquire_prepares_checked_local_raster_without_http_spend(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            budget = terrain.RequestBudget({"metadata": 0})
            prepared = terrain.acquire(
                Materialize.BOUNDS,
                Path(tmp),
                budget,
                sources={"terrain": str(SYNTH / "dem.tif")},
            )
            entry = prepared["terrain"]
            self.assertIsNone(entry["error"])
            self.assertTrue(Path(entry["path"]).is_file())
            self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(budget.counts, {"metadata": 0})

    def test_acquire_failure_is_explicit_unavailability(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prepared = terrain.acquire(
                Materialize.BOUNDS,
                Path(tmp),
                terrain.RequestBudget({}),
                sources={"terrain": str(Path(tmp) / "missing.tif")},
            )
        self.assertIsNone(prepared["terrain"]["path"])
        self.assertIn("terrain acquisition failed", prepared["terrain"]["error"])

    def test_request_budget_stops_before_an_unlisted_attempt(self) -> None:
        budget = terrain.RequestBudget({"metadata": 0})
        with self.assertRaises(terrain.BudgetExceededError):
            budget.spend("metadata")
        self.assertEqual(budget.counts, {"metadata": 0})


if __name__ == "__main__":
    unittest.main()


class ProvenanceLinkage(unittest.TestCase):
    """The REAL provenance mechanism (T-M0-3), tested against a temporary
    synthetic materialization. The byte-pinned fixtures deliberately carry a
    sentinel sha and a pinned clock (fixtures/seams.py), so THESE tests, not
    the fixture byte-pins, own the linkage claims: the emitted value is the
    sidecar's, the sidecar's matches the file bytes, unknown is None, and a
    byte change breaks the pairing."""

    BOUNDS = Materialize.BOUNDS

    def test_sha_reader_matches_sidecar_and_file_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            got = core.materialized_sha256(dest)
            sidecar = json.loads(
                dest.with_suffix(".meta.json").read_text(encoding="utf-8"))
            recomputed = hashlib.sha256(dest.read_bytes()).hexdigest()
        self.assertIsNotNone(got)
        self.assertRegex(got or "", r"^[0-9a-f]{64}$")
        self.assertEqual(got, sidecar["rasterSha256"])
        self.assertEqual(got, recomputed)

    def test_missing_or_corrupt_sidecar_is_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            meta_path = dest.with_suffix(".meta.json")
            meta_path.unlink()
            self.assertIsNone(core.materialized_sha256(dest))
            meta_path.write_text("not json", encoding="utf-8")
            self.assertIsNone(core.materialized_sha256(dest))

    def test_changed_raster_bytes_break_the_pairing(self) -> None:
        """The sidecar sha identifies EXACT raster bytes: after the raster
        changes, the recorded sha no longer matches the file, and the cache
        validator refuses the pairing (rematerializes)."""
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            recorded = core.materialized_sha256(dest)
            with open(dest, "ab") as fh:
                fh.write(b"\x00")
            recomputed = hashlib.sha256(dest.read_bytes()).hexdigest()
            self.assertNotEqual(recorded, recomputed)
            stamp = dest.stat().st_mtime_ns
            again = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            self.assertNotEqual(again.stat().st_mtime_ns, stamp)

    def test_acquisition_stamp_seam_reaches_the_sidecar(self) -> None:
        """The sidecar's acquired date comes from the module clock seam
        (what the fixture capture pins), not from any other clock."""
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "_acquisition_stamp",
                               lambda: "2031-12-31"):
            dest = core.materialize_raster(
                str(SYNTH / "dem.tif"), self.BOUNDS, Path(tmp), "terrain")
            self.assertEqual(core.acquisition_date(dest), "2031-12-31")


class BuildSnapshotProvenance(unittest.TestCase):
    """build_snapshot merges runtime provenance over the static SOURCE
    block; the keys are ALWAYS present and None is the explicit unknown."""

    def _snapshot(self, provenance) -> dict:
        import geopandas as gpd
        from shapely.geometry import box
        gdf = gpd.GeoDataFrame(
            {"US_L3CODE": ["9"], "US_L3NAME": ["Test"],
             "geometry": [box(0, 0, 1, 1)]},
            crs=core.ANALYSIS_CRS)
        return core.build_snapshot(
            levels=[3], only=["terrain"],
            sources={"terrain": terrain.SOURCE},
            family_results={3: {"terrain": {"9": {"unavailable": True,
                                                  "reason": "test"}}}},
            gdfs={3: gdf}, retrieved="2026-01-01",
            provenance=provenance)

    def test_runtime_fields_merge_over_the_static_block(self) -> None:
        sha = "ab" * 32
        snap = self._snapshot(
            {"terrain": {"acquired": "2026-01-02",
                         "materializedRasterSha256": sha}})
        src = snap["sources"]["terrain"]
        self.assertEqual(src["acquired"], "2026-01-02")
        self.assertEqual(src["materializedRasterSha256"], sha)
        self.assertEqual(src["methodVersion"], 3)
        self.assertEqual(src["method"], terrain.SOURCE["method"])
        self.assertEqual(snap["bundles"]["9"]["unavailable"], ["terrain"])

    def test_absent_provenance_is_explicit_none_not_omission(self) -> None:
        for provenance in (None, {}, {"terrain": {}}):
            with self.subTest(provenance=provenance):
                src = self._snapshot(provenance)["sources"]["terrain"]
                self.assertIn("acquired", src)
                self.assertIn("materializedRasterSha256", src)
                self.assertIsNone(src["acquired"])
                self.assertIsNone(src["materializedRasterSha256"])

    def test_static_source_block_is_not_mutated(self) -> None:
        before = dict(terrain.SOURCE)
        self._snapshot({"terrain": {"acquired": "2026-01-02",
                                    "materializedRasterSha256": "cd" * 32}})
        self.assertEqual(terrain.SOURCE, before)
        self.assertNotIn("acquired", terrain.SOURCE)

    def test_ledger_combines_family_subblock_and_unresolved_mukeys(self) -> None:
        import geopandas as gpd
        from shapely.geometry import box
        gdf = gpd.GeoDataFrame(
            {"US_L3CODE": ["9"], "US_L3NAME": ["Test"],
             "geometry": [box(0, 0, 1, 1)]},
            crs=core.ANALYSIS_CRS)
        snapshot = core.build_snapshot(
            levels=[3],
            only=["terrain", "soil", "landcoverFuels"],
            sources={"terrain": terrain.SOURCE},
            family_results={
                3: {
                    "terrain": {
                        "9": {"unavailable": True, "reason": "test terrain"}
                    },
                    "soil": {"9": {"soil": {"coveragePct": 100}}},
                    "landcoverFuels": {
                        "9": {
                            "landcoverFuels": {
                                "fbfm40": {
                                    "unavailable": True,
                                    "reason": "test fuels",
                                },
                                "evt": {"coveragePct": 100},
                                "landcover": {"coveragePct": 100},
                                "whp": {"coveragePct": 100},
                            }
                        }
                    },
                }
            },
            gdfs={3: gdf},
            retrieved="2026-01-01",
            diagnostics={
                "soilUnresolvedByCode": {
                    3: {"9": {"mukeys": [2, "1", 2]}}
                }
            },
        )
        self.assertEqual(
            snapshot["bundles"]["9"]["unavailable"],
            [
                "landcoverFuels.fbfm40",
                "soil.mukey.1",
                "soil.mukey.2",
                "terrain",
            ],
        )


class MethodVersionAnchor(unittest.TestCase):
    """The (family, methodVersion, method prose) tuple is pinned against
    an INDEPENDENT literal copy in this test source, so editing the
    adapter's METHOD_VERSIONS prose without bumping the version cannot
    stay green (a comparison of production back to itself would); the
    schema additionally pins the current version as a const. A legitimate
    method change therefore edits the adapter, this pin, and the schema
    const in one reviewed motion."""

    FAMILY = "terrain"
    EXPECTED_CANONICAL_SERIALIZATION = {
        2: (
            "aspectMeanDeg is serialized in canonical [0, 360): the "
            "round-to-0.1 label 360.0 becomes the equivalent 0.0"
        ),
        # Version 3 was staged by T-S1-2 and activated by T-S1-4.
        3: (
            "aspectMeanDeg is serialized in canonical [0, 360): the "
            "round-to-0.1 label 360.0 becomes the equivalent 0.0; elevBands and "
            "aspectDistribution fractions serialize at 3 decimals (round-half-"
            "even via core.round_or_none); a polygon with zero polygon-weighted "
            "valid-elevation area takes the explicit-unavailability shape under both "
            "extended settings, never a null-fraction stats record, never NaN, and "
            "never a nodata sentinel; the stats shape is emitted only for positive "
            "valid-elevation weight and therefore carries numeric elevation fields "
            "and computable fractions"
        ),
    }
    EXPECTED_METHOD_VERSIONS = {
        1: (
            "legacy monolith method (pre-T-M0-2): numpy.gradient slope "
            "magnitude, no aspect output, coveragePct as the valid "
            "fraction of the rectangular read window"
        ),
        2: (
            "area-weighted mean elevation (exactextract) on a 30m "
            "EPSG:5070 grid; Horn 3x3 slope and aspect (cells without a "
            "full neighborhood excluded; flat cells carry no aspect); "
            "aspect summarized as the area-weighted circular mean; "
            "coveragePct is the polygon-weighted valid-elevation fraction"
        ),
        # Version 3 was staged by T-S1-2 and activated by T-S1-4.
        3: (
            "area-weighted mean elevation (exactextract) on a 30m EPSG:5070 grid; "
            "Horn 3x3 slope and aspect (cells without a full neighborhood excluded; "
            "flat cells carry no aspect); aspect summarized as the area-weighted, "
            "gradient-magnitude-weighted (resultant) circular mean, so near-flat "
            "cells contribute in proportion to the directional signal they carry; "
            "coveragePct is the polygon-weighted valid-elevation fraction; adds "
            "elevBands (ten fractions of valid-elevation area over the "
            "ELEV_BAND_EDGES_M bands: below 0, eight half-open [edge, next) "
            "intervals, 4000-plus) and aspectDistribution (eight cardinals plus "
            "flat, the exactly-zero-gradient cells, plus excluded, the "
            "neighborhood-exclusion cells; a partition of valid-elevation area)"
        ),
    }
    EXPECTED_CURRENT_VERSION = 3

    def test_terrain_method_tuple_pinned_independently(self) -> None:
        self.assertEqual(terrain.METHOD_VERSIONS,
                         self.EXPECTED_METHOD_VERSIONS)
        self.assertEqual(terrain.CANONICAL_SERIALIZATION,
                         self.EXPECTED_CANONICAL_SERIALIZATION)
        self.assertEqual(terrain.SOURCE["methodVersion"],
                         self.EXPECTED_CURRENT_VERSION)
        self.assertEqual(
            terrain.SOURCE["method"],
            self.EXPECTED_METHOD_VERSIONS[self.EXPECTED_CURRENT_VERSION])
        self.assertIn(self.FAMILY, terrain.__name__)

    def test_schema_version_is_current(self) -> None:
        self.assertEqual(core.SCHEMA_VERSION, "1.3.0")
