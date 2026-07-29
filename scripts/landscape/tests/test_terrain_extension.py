"""T-S1-2 terrain-extension tests (S1 lane contract rev 8, section 5.2).

Two VISIBLY SEPARATE kinds, per the contract 6.1 oracle rule:

  - HandWorkedKnownAnswers (CORRECTNESS): every asserted value comes from
    the hand-worked table in fixtures/terrain-extension/
    known-answer-cases.json, computed independently of the implementation
    on synthetic arrays and derived case by case in that file and in the
    fixture directory's SOURCES.md. This class carries the near-flat
    decision procedure's cases on BOTH SIDES of the adopted rule: the
    disagreement case asserts the ADOPTED gradient-magnitude-weighted
    value on the current path AND the REJECTED full-unit-vector value on
    the explicit historical methodVersion 2 path, so both hand values are
    asserted against real emissions,
    plus the agreement control where both rules emit the same value.

  - RegressionPins (PINS, NOT PROOFS): the current default path emits the
    shipped corrected-fixture bytes, the explicit historical path differs
    only by the ruled fields and aspect labels, and the method-version flip
    leaves
    METHOD_VERSIONS[1], METHOD_VERSIONS[2], and the existing
    CANONICAL_SERIALIZATION entries untouched while SOURCE.methodVersion
    is 3.

Everything here runs offline: synthetic arrays plus the committed
synthetic fixtures; no test performs network work.
"""
from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import geopandas as gpd
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box
from shapely.ops import unary_union

from scripts.landscape import core
from scripts.landscape.adapters import terrain

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SYNTH = FIXTURES / "synthetic"
CORRECTED = FIXTURES / "corrected"
EXTDIR = FIXTURES / "terrain-extension"

CASES = json.loads((EXTDIR / "known-answer-cases.json").read_text(encoding="utf-8"))
GRID = CASES["grid"]
X0, Y0, RES = float(GRID["x0"]), float(GRID["y0"]), float(GRID["resM"])
# Synthetic coordinates use the European Petroleum Survey Group (EPSG):5070
# analysis frame.

# Serialized partition tolerance, section 5 convention: n = 10 summed
# serialized fields in both partitions this lane emits.
SERIALIZED_TOL = 10 * 0.0005 + 1e-9


def _case(name: str) -> dict:
    return next(c for c in CASES["cases"] if c["name"] == name)


def _build_elev(case: dict) -> np.ndarray:
    """Materialize a case's synthetic elevation array from its constructive
    parameters (the fixture JavaScript Object Notation (JSON) is the single
    source of truth; nothing here knows the expected answers)."""
    rows, cols = case["shape"]
    z = np.full((rows, cols), float(case.get("fill", 0.0)), dtype="float64")
    rr, cc = np.mgrid[0:rows, 0:cols]
    for reg in case.get("regions", []):
        c0, c1 = reg["cols"]
        sel = (cc >= c0) & (cc < c1)
        if reg.get("base") is None:
            z[sel] = np.nan
        else:
            vals = (float(reg["base"])
                    + float(reg.get("perCol", 0.0)) * cc
                    + float(reg.get("perRow", 0.0)) * rr)
            z[sel] = vals[sel]
    for r, c in case.get("nodataCells", []):
        z[r, c] = np.nan
    return z.astype("float32")


def _build_gdf(case: dict) -> gpd.GeoDataFrame:
    boxes = [
        box(X0 + b[0] * RES, Y0 - b[3] * RES, X0 + b[2] * RES, Y0 - b[1] * RES)
        for b in case["polygonBoxes"]
    ]
    return gpd.GeoDataFrame([{"geometry": unary_union(boxes)}],
                            crs=core.ANALYSIS_CRS)


def _transform():
    return from_origin(X0, Y0, RES, RES)


def _stats(name: str, extended: bool) -> dict:
    case = _case(name)
    return terrain._polygon_stats(_build_elev(case), _transform(),
                                  _build_gdf(case), extended=extended)


def _unrounded(name: str) -> dict:
    case = _case(name)
    return terrain._extended_fractions(_build_elev(case), _transform(),
                                       _build_gdf(case))


def _aggregate_case(name: str, *, extended: bool) -> dict:
    """Run one constructive case through the public raster-window path."""
    case = _case(name)
    elev = _build_elev(case)
    nodata = float(case["rasterNodata"])
    stored = np.where(np.isfinite(elev), elev, nodata).astype("float32")
    gdf = _build_gdf(case)
    gdf["caseCode"] = case["code"]
    with tempfile.TemporaryDirectory() as tmp:
        raster_path = Path(tmp) / "case.tif"
        with rasterio.open(
            raster_path,
            "w",
            driver="GTiff",
            height=stored.shape[0],
            width=stored.shape[1],
            count=1,
            dtype="float32",
            crs=core.ANALYSIS_CRS,
            transform=_transform(),
            nodata=nodata,
        ) as dst:
            dst.write(stored, 1)
        with mock.patch.object(core, "log", lambda msg: None):
            result = terrain.aggregate(
                gdf,
                "caseCode",
                prepared_raster=raster_path,
                extended=extended,
            )
    return result[case["code"]]


def _load_fixture_gdf() -> gpd.GeoDataFrame:
    return gpd.read_file(SYNTH / "ecoregions_l3.gpkg", layer="ecoregions")


class HandWorkedKnownAnswers(unittest.TestCase):
    """CORRECTNESS: hand-worked known answers, computed independently of
    the implementation (derivations in known-answer-cases.json and
    SOURCES.md)."""

    def test_elev_bands_basic_with_boundary_edges_and_nodata(self) -> None:
        """Ten constant columns, one nodata: 1/9 per valid column of the
        90-cell valid area; the half-open edge rule pinned at 0, 500, and
        4000 exactly (each belongs to the band ABOVE the edge)."""
        case = _case("elev-bands-basic")
        stats = _stats("elev-bands-basic", extended=True)
        self.assertEqual(stats["elevBands"], case["expected"]["elevBands"])
        self.assertEqual(stats["coveragePct"], case["expected"]["coveragePct"])

    def test_elev_bands_partial_pixel_weights(self) -> None:
        """A polygon offset by half a cell on both sides: the 0.25/0.5/0.25
        split exists only under exact partial-pixel weights."""
        case = _case("elev-bands-partial-pixel")
        stats = _stats("elev-bands-partial-pixel", extended=True)
        self.assertEqual(stats["elevBands"], case["expected"]["elevBands"])
        self.assertEqual(stats["coveragePct"], case["expected"]["coveragePct"])

    def test_aspect_distribution_excluded_cells(self) -> None:
        """One interior nodata cell: its 8 Horn-excluded neighbors are
        'excluded' (8/99), the nodata cell itself leaves the denominator,
        and every other cell is E (91/99); serialized sum exactly 1.000."""
        case = _case("aspect-excluded")
        stats = _stats("aspect-excluded", extended=True)
        self.assertEqual(stats["aspectDistribution"],
                         case["expected"]["aspectDistribution"])
        self.assertEqual(stats["aspectMeanDeg"], case["expected"]["aspectMeanDeg"])
        self.assertEqual(stats["aspectCardinal"], case["expected"]["aspectCardinal"])

    def test_aspect_distribution_flat_half(self) -> None:
        """Half flat (exactly-zero gradient), half falling south: flat 0.5,
        S 0.5, nothing excluded; both weighting rules emit 180.0 (S)."""
        case = _case("flat-vs-south-split")
        ext = _stats("flat-vs-south-split", extended=True)
        self.assertEqual(ext["aspectDistribution"],
                         case["expected"]["aspectDistribution"])
        self.assertEqual(ext["aspectMeanDeg"], case["bothRules"]["adopted"])
        self.assertEqual(ext["aspectCardinal"], case["expected"]["aspectCardinal"])
        default = _stats("flat-vs-south-split", extended=False)
        self.assertEqual(default["aspectMeanDeg"], case["bothRules"]["rejected"])

    def test_near_flat_control_both_rules_agree(self) -> None:
        """THE AGREEMENT CONTROL (decision procedure step 2): two areas of
        the same downslope direction at different gradient magnitudes.
        Hand values: full unit-vector weighting averages two identical
        unit vectors; gradient weighting averages (-0.25, 0) and
        (-0.5, 0); both point at azimuth 270.0 (W). The historical
        rejected path and current adopted path must both emit it."""
        case = _case("near-flat-control")
        default = _stats("near-flat-control", extended=False)
        ext = _stats("near-flat-control", extended=True)
        self.assertEqual(default["aspectMeanDeg"], case["bothRules"]["rejected"])
        self.assertEqual(ext["aspectMeanDeg"], case["bothRules"]["adopted"])
        self.assertEqual(default["aspectCardinal"], "W")
        self.assertEqual(ext["aspectCardinal"], "W")

    def test_near_flat_disagreement_adopted_vs_rejected(self) -> None:
        """THE DISAGREEMENT CASE (decision procedure step 2), hand-worked
        on both sides; a 3-to-1 area ratio of near-flat-east (gradient
        1/960, azimuth 90) over steep-south (gradient 1, azimuth 180).

        REJECTED rule (full unit-vector weighting, the historical
        methodVersion 2 path):
        mean unit vector = (3*(1,0) + 1*(0,-1))/4 = (0.75, -0.25);
        azimuth = 180 - atan(3) deg = 108.43494882292201 -> 108.4 (E).
        The numerically meaningless near-flat direction dominates.

        ADOPTED rule (gradient-magnitude weighting, the current path):
        mean gradient vector = (3*(1/960)*(1,0) + 1*(0,-1))/4
        = (1/1280, -0.25); azimuth = 180 - atan(0.003125) deg
        = 179.82095127 -> 179.8 (S). The steep terrain carries the value.

        Both hand values are asserted against real emissions; their
        inequality proves the rules GENUINELY disagree in the emitted
        value on this input."""
        case = _case("near-flat-disagreement")
        rejected = _stats("near-flat-disagreement", extended=False)
        adopted = _stats("near-flat-disagreement", extended=True)
        self.assertEqual(rejected["aspectMeanDeg"],
                         case["rejectedRule"]["aspectMeanDeg"])
        self.assertEqual(rejected["aspectCardinal"],
                         case["rejectedRule"]["aspectCardinal"])
        self.assertEqual(adopted["aspectMeanDeg"],
                         case["expected"]["aspectMeanDeg"])
        self.assertEqual(adopted["aspectCardinal"],
                         case["expected"]["aspectCardinal"])
        self.assertNotEqual(adopted["aspectMeanDeg"], rejected["aspectMeanDeg"])
        self.assertNotEqual(adopted["aspectCardinal"], rejected["aspectCardinal"])
        # The unrounded adopted value against its closed-form hand
        # derivation (180 - atan(1/320) in degrees).
        unrounded = _unrounded("near-flat-disagreement")["aspectMeanDeg"]
        self.assertAlmostEqual(
            unrounded, case["bothRulesUnrounded"]["adopted"], delta=1e-6)

    def test_extended_cancellation_stays_null(self) -> None:
        """The cancellation-epsilon contract on the extended path: equal
        opposing areas at equal gradient magnitude cancel the weighted
        resultant below the epsilon; the mean is null, never a
        rounding-noise direction, while the distribution reports the
        honest E/W split."""
        case = _case("opposing-cancellation-extended")
        stats = _stats("opposing-cancellation-extended", extended=True)
        self.assertIsNone(stats["aspectMeanDeg"])
        self.assertIsNone(stats["aspectCardinal"])
        self.assertEqual(stats["aspectDistribution"],
                         case["expected"]["aspectDistribution"])

    def test_zero_valid_area_all_nodata_window_is_unavailable(self) -> None:
        """A 4 x 4 polygon plus its two-cell pad reads the full 8 x 8
        all-nodata raster. The pre-stats branch emits only explicit
        unavailability under either flag, with no fraction keys."""
        case = _case("zero-valid-all-nodata-window")
        default = _aggregate_case(case["name"], extended=False)
        extended = _aggregate_case(case["name"], extended=True)
        self.assertEqual(default, case["expected"])
        self.assertEqual(extended, case["expected"])
        self.assertNotIn("elevBands", extended)
        self.assertNotIn("aspectDistribution", extended)
        serialized = json.dumps(extended, allow_nan=False)
        self.assertNotIn("NaN", serialized)
        self.assertNotIn(str(case["rasterNodata"]), serialized)

    def test_zero_valid_area_finite_window_is_unavailable(self) -> None:
        """The same polygon covers 16 nodata cells, but its padded window
        also holds 48 finite cells. The exterior cells have zero polygon
        weight, so both flags emit only explicit unavailability."""
        case = _case("zero-valid-polygon-finite-window")
        default = _aggregate_case(case["name"], extended=False)
        extended = _aggregate_case(case["name"], extended=True)
        self.assertEqual(default, case["expected"])
        self.assertEqual(extended, case["expected"])
        self.assertNotIn("elevBands", extended)
        self.assertNotIn("aspectDistribution", extended)
        for result in (default, extended):
            serialized = json.dumps(result, allow_nan=False)
            self.assertNotIn("NaN", serialized)
            self.assertNotIn(str(case["rasterNodata"]), serialized)

    def test_unrounded_hand_values_match_exactly(self) -> None:
        """Where the table pins unrounded hand fractions, the UNROUNDED
        pipeline values match within 1e-9 (integer-cell arithmetic in
        float64 leaves no room for more)."""
        for case in CASES["cases"]:
            pins = case.get("expectedUnrounded")
            if not pins:
                continue
            with self.subTest(case=case["name"]):
                un = _unrounded(case["name"])
                if "elevBands" in pins:
                    for i, want in enumerate(pins["elevBands"]):
                        self.assertAlmostEqual(un["elevBands"][i], want,
                                               delta=1e-9)
                if "aspectDistribution" in pins:
                    for k, want in pins["aspectDistribution"].items():
                        self.assertAlmostEqual(un["aspectDistribution"][k],
                                               want, delta=1e-9)

    def test_partition_invariants_unrounded_and_serialized(self) -> None:
        """The section 5 convention on every positive-valid-area case:
        both partitions sum to 1 within 1e-9 UNROUNDED, and within
        n * 0.0005 + 1e-9 (n = 10) serialized."""
        for case in CASES["cases"]:
            if case.get("zeroValidArea"):
                continue
            with self.subTest(case=case["name"]):
                un = _unrounded(case["name"])
                self.assertEqual(len(un["elevBands"]), 10)
                self.assertEqual(len(un["aspectDistribution"]), 10)
                self.assertLessEqual(abs(math.fsum(un["elevBands"]) - 1.0), 1e-9)
                self.assertLessEqual(
                    abs(math.fsum(un["aspectDistribution"].values()) - 1.0), 1e-9)
                stats = _stats(case["name"], extended=True)
                self.assertLessEqual(
                    abs(math.fsum(stats["elevBands"]) - 1.0), SERIALIZED_TOL)
                self.assertLessEqual(
                    abs(math.fsum(stats["aspectDistribution"].values()) - 1.0),
                    SERIALIZED_TOL)

    def test_band_edges_are_the_frozen_contract_list(self) -> None:
        """The module constant is exactly the contract 5.2 list."""
        self.assertEqual(terrain.ELEV_BAND_EDGES_M,
                         [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000])


# Pinned copies of the PRE-EXISTING method-history entries; editing the
# module strings must force a visible edit here (the same pin-in-test-
# source pattern the parity suite uses).
PINNED_METHOD_1 = (
    "legacy monolith method (pre-T-M0-2): numpy.gradient slope magnitude, "
    "no aspect output, coveragePct as the valid fraction of the "
    "rectangular read window"
)
PINNED_METHOD_2 = (
    "area-weighted mean elevation (exactextract) on a 30m EPSG:5070 grid; "
    "Horn 3x3 slope and aspect (cells without a full neighborhood excluded; "
    "flat cells carry no aspect); aspect summarized as the area-weighted "
    "circular mean; coveragePct is the polygon-weighted valid-elevation "
    "fraction"
)
PINNED_CANONICAL_2 = (
    "aspectMeanDeg is serialized in canonical [0, 360): the "
    "round-to-0.1 label 360.0 becomes the equivalent 0.0"
)


class RegressionPins(unittest.TestCase):
    """PINS, NOT PROOFS: byte identity of the current default path, the
    exact method delta, and the method-version activation rules."""

    def test_default_matches_shipped_corrected_bytes(self) -> None:
        """The activated methodVersion 3 default reproduces the shipped
        corrected fixture byte for byte."""
        gdf = _load_fixture_gdf()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            result = terrain.aggregate(
                gdf, "US_L3CODE",
                dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp))
        got = (json.dumps(result, indent=2) + "\n").encode("utf-8")
        want = (CORRECTED / "terrain_l3.json").read_bytes()
        self.assertEqual(got, want)

    def test_extended_true_kwarg_equals_the_default_call(self) -> None:
        gdf = _load_fixture_gdf()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            unflagged = terrain.aggregate(
                gdf, "US_L3CODE",
                dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp))
            flagged = terrain.aggregate(
                gdf, "US_L3CODE",
                dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp),
                extended=True)
        self.assertEqual(json.dumps(unflagged, indent=2),
                         json.dumps(flagged, indent=2))

    def test_current_adds_exactly_the_two_fields_to_historical(self) -> None:
        """Version 3 adds elevBands and aspectDistribution to historical
        version 2 and may change only aspectMeanDeg/aspectCardinal."""
        gdf = _load_fixture_gdf()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            historical = terrain.aggregate(
                gdf, "US_L3CODE",
                dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp),
                extended=False)
            current = terrain.aggregate(
                gdf, "US_L3CODE",
                dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp))
        self.assertEqual(set(historical), set(current))
        for code, entry in historical.items():
            with self.subTest(code=code):
                if entry.get("unavailable"):
                    self.assertEqual(current[code], entry)
                    continue
                self.assertEqual(set(current[code]) - set(entry),
                                 {"elevBands", "aspectDistribution"})
                for key in entry:
                    if key in ("aspectMeanDeg", "aspectCardinal"):
                        continue
                    self.assertEqual(current[code][key], entry[key], key)

    def test_method_version_flip_and_existing_entries_untouched(self) -> None:
        """Historical method prose remains byte stable and version 3 is
        activated by T-S1-4."""
        self.assertEqual(terrain.METHOD_VERSIONS[1], PINNED_METHOD_1)
        self.assertEqual(terrain.METHOD_VERSIONS[2], PINNED_METHOD_2)
        self.assertEqual(terrain.CANONICAL_SERIALIZATION[2], PINNED_CANONICAL_2)
        self.assertEqual(set(terrain.METHOD_VERSIONS), {1, 2, 3})
        self.assertEqual(set(terrain.CANONICAL_SERIALIZATION), {2, 3})
        for needle in ("elevBands", "aspectDistribution",
                       "gradient-magnitude-weighted"):
            self.assertIn(needle, terrain.METHOD_VERSIONS[3])
        self.assertEqual(terrain.SOURCE["methodVersion"], 3)
        self.assertEqual(terrain.SOURCE["method"], terrain.METHOD_VERSIONS[3])


if __name__ == "__main__":
    unittest.main()
