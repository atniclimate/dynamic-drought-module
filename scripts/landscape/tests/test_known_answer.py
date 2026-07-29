"""Known-answer tests for the T-M0-2 corrected methods (WORKPLAN L1b).

Each corrected method is gated against inputs whose right answer is known
in closed form, independent of the legacy baseline:
  - Horn slope on synthetic planes (exact analytic slope, tolerance 1e-6
    deg; a plane cannot distinguish stencils, so a hand-computed 3x3
    matrix additionally pins the Horn 1-2-1 weights and denominator)
  - aspect on planes dipping toward each of the 8 compass directions; the
    explicit-null contract for flat cells, flat polygons, AND polygons
    whose opposing slopes cancel numerically (both sides of the
    cancellation epsilon are pinned); exact cardinal-boundary azimuths
  - polygon-weighted valid coverage on polygons with exact known valid
    fractions over the fixture DEM's nodata notch (tolerance 0.1 pct),
    including a half-cell-offset polygon exercising partial-pixel weights
  - categorical MODE materialization on a synthetic fine-grid classed
    raster with a known per-cell majority (values must come from the class
    set, never a bilinear blend), cache-identity separation from the
    continuous path, and rejection of a raster mispaired with its sidecar

The plane/aspect tests call horn_slope_aspect directly on arrays; the
coverage tests run the full aggregate path over the committed synthetic
fixtures; the categorical tests generate their fine-grid source in a
temporary directory (deterministic by construction, nothing to commit).
"""
from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import rasterio
from rasterio.transform import from_origin

from scripts.landscape import core
from scripts.landscape.adapters import terrain

SYNTH = Path(__file__).resolve().parent / "fixtures" / "synthetic"
RES = float(core.GRID_RES_M)

# The fixture DEM's frame (make_fixtures.py): 80x80 cells at 30 m, EPSG:5070,
# north-up from (X0, Y0), nodata notch rows 10..20, cols 50..60.
X0, Y0 = -1_900_005.0, 2_900_055.0
NOTCH_MINX, NOTCH_MAXX = X0 + 50 * RES, X0 + 60 * RES
NOTCH_MINY, NOTCH_MAXY = Y0 - 20 * RES, Y0 - 10 * RES


def plane(shape: tuple[int, int], dz_east_per_cell: float,
          dz_north_per_cell: float, base: float = 1000.0) -> np.ndarray:
    """A north-up elevation plane with the given per-CELL elevation change
    toward east and toward north (row 0 is the northernmost row)."""
    rows, cols = np.mgrid[0:shape[0], 0:shape[1]]
    z = base + dz_east_per_cell * cols - dz_north_per_cell * rows
    return z.astype("float32")


class HornSlopeExact(unittest.TestCase):
    def test_slope_on_tilted_planes_is_exact(self) -> None:
        """On a plane the Horn kernel is exact: slope = atan(|grad|).
        Per-cell steps chosen exactly representable in float32."""
        cases = [
            (15.0, 0.0),     # p = 0.5 east
            (0.0, 7.5),      # q = 0.25 north
            (7.5, 7.5),      # diagonal
            (-30.0, 15.0),   # descending east, rising north
        ]
        for dz_e, dz_n in cases:
            with self.subTest(dz_e=dz_e, dz_n=dz_n):
                slope, _ = terrain.horn_slope_aspect(plane((9, 9), dz_e, dz_n), RES)
                want = math.degrees(math.atan(math.hypot(dz_e / RES, dz_n / RES)))
                interior = slope[1:-1, 1:-1].astype("float64")
                self.assertTrue(np.all(np.isfinite(interior)))
                self.assertLess(float(np.max(np.abs(interior - want))), 1e-6)

    def test_flat_plane_slope_is_exactly_zero(self) -> None:
        slope, _ = terrain.horn_slope_aspect(plane((9, 9), 0.0, 0.0), RES)
        self.assertTrue(np.all(slope[1:-1, 1:-1] == 0.0))

    def test_edges_and_nodata_neighbors_are_nan(self) -> None:
        """No one-sided estimates: the outer ring and every cell adjacent
        to a NaN cell carry NaN in both outputs."""
        z = plane((9, 9), 15.0, 0.0)
        z[4, 4] = np.nan
        slope, aspect = terrain.horn_slope_aspect(z, RES)
        for arr in (slope, aspect):
            self.assertTrue(np.all(np.isnan(arr[0, :])))
            self.assertTrue(np.all(np.isnan(arr[-1, :])))
            self.assertTrue(np.all(np.isnan(arr[:, 0])))
            self.assertTrue(np.all(np.isnan(arr[:, -1])))
            self.assertTrue(np.all(np.isnan(arr[3:6, 3:6])))
        # Beyond the contaminated 3x3 block the plane's slope is intact.
        self.assertLess(abs(float(slope[1, 1]) -
                            math.degrees(math.atan(0.5))), 1e-6)

    def test_horn_stencil_weights_pinned_by_hand_computed_matrices(self) -> None:
        """Planes cannot distinguish Horn from central difference or
        Prewitt (all are exact on a plane), so the defining 1-2-1 weights
        and the 8*res denominator are pinned on hand-worked 3x3 matrices.

        Matrix 1: all zeros except SE corner 90 (res 30).
          p = ((NE + 2E + SE) - (NW + 2W + SW)) / 240 = 90/240 = 0.375
          q = ((NW + 2N + NE) - (SW + 2S + SE)) / 240 = -90/240 = -0.375
          slope = atan(hypot(0.375, 0.375)) = 27.93835272960235 deg
          aspect = atan2(-0.375, 0.375) = 315 deg (NW)
        (Central difference would give p = 0 here; Prewitt 90/180.)

        Matrix 2: distinct values so the 2x edge weights matter.
          [[10, 25,  5], [40, 0, 55], [20, 35, 65]]
          p = ((5 + 110 + 65) - (10 + 80 + 20)) / 240 = 70/240
          q = ((10 + 50 + 5) - (20 + 70 + 65)) / 240 = -90/240
          slope = 25.411135016332118 deg; aspect = 322.1250163489018 deg
        (Central difference p = (55-40)/60 = 0.25 != 70/240.)"""
        z1 = np.zeros((3, 3), dtype="float32")
        z1[2, 2] = 90.0
        slope1, aspect1 = terrain.horn_slope_aspect(z1, RES)
        self.assertAlmostEqual(float(slope1[1, 1]), 27.93835272960235, delta=1e-4)
        self.assertAlmostEqual(float(aspect1[1, 1]), 315.0, delta=1e-4)
        z2 = np.array([[10.0, 25.0, 5.0],
                       [40.0, 0.0, 55.0],
                       [20.0, 35.0, 65.0]], dtype="float32")
        slope2, aspect2 = terrain.horn_slope_aspect(z2, RES)
        self.assertAlmostEqual(float(slope2[1, 1]), 25.411135016332118, delta=1e-4)
        self.assertAlmostEqual(float(aspect2[1, 1]), 322.1250163489018, delta=1e-4)

    def test_gradient_magnitude_differs_from_horn_where_curvature_exists(self) -> None:
        """The defect being fixed is real: on a curved surface the legacy
        numpy.gradient magnitude and the Horn kernel disagree."""
        rows, cols = np.mgrid[0:9, 0:9]
        z = (100.0 * np.sin(cols / 2.0) * np.cos(rows / 3.0)).astype("float32")
        horn, _ = terrain.horn_slope_aspect(z, RES)
        dzdy, dzdx = np.gradient(z.astype("float64"), RES, RES)
        legacy = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
        diff = np.abs(horn[1:-1, 1:-1].astype("float64") - legacy[1:-1, 1:-1])
        self.assertGreater(float(np.max(diff)), 0.1)


class AspectExact(unittest.TestCase):
    # (per-cell dz east, per-cell dz north) -> downslope azimuth in degrees.
    COMPASS = [
        ((0.0, 15.0), 180.0, "S"),    # rises north -> falls south
        ((-15.0, 15.0), 135.0, "SE"),
        ((-15.0, 0.0), 90.0, "E"),    # rises west -> falls east
        ((-15.0, -15.0), 45.0, "NE"),
        ((0.0, -15.0), 0.0, "N"),     # rises south -> falls north
        ((15.0, -15.0), 315.0, "NW"),
        ((15.0, 0.0), 270.0, "W"),    # rises east -> falls west
        ((15.0, 15.0), 225.0, "SW"),
    ]

    def test_aspect_on_planes_hits_all_eight_directions(self) -> None:
        for (dz_e, dz_n), want_deg, want_card in self.COMPASS:
            with self.subTest(direction=want_card):
                _, aspect = terrain.horn_slope_aspect(plane((9, 9), dz_e, dz_n), RES)
                interior = aspect[1:-1, 1:-1].astype("float64")
                self.assertTrue(np.all(np.isfinite(interior)))
                # Compare on the circle (0 == 360).
                delta = np.abs((interior - want_deg + 180.0) % 360.0 - 180.0)
                self.assertLess(float(np.max(delta)), 1e-4)
                self.assertEqual(terrain.aspect_cardinal(want_deg), want_card)

    def test_flat_cells_have_null_aspect(self) -> None:
        _, aspect = terrain.horn_slope_aspect(plane((9, 9), 0.0, 0.0), RES)
        self.assertTrue(np.all(np.isnan(aspect[1:-1, 1:-1])))

    def test_cardinal_bucket_boundaries(self) -> None:
        self.assertEqual(terrain.aspect_cardinal(0.0), "N")
        self.assertEqual(terrain.aspect_cardinal(22.4), "N")
        self.assertEqual(terrain.aspect_cardinal(22.6), "NE")
        self.assertEqual(terrain.aspect_cardinal(337.6), "N")
        self.assertEqual(terrain.aspect_cardinal(337.4), "NW")

    def test_every_exact_boundary_belongs_to_the_clockwise_bucket(self) -> None:
        """All eight EXACT half-bucket boundaries, pinned one by one: the
        boundary azimuth belongs to the clockwise (next) bucket, with no
        ties-to-even alternation."""
        expectations = [
            (22.5, "NE"), (67.5, "E"), (112.5, "SE"), (157.5, "S"),
            (202.5, "SW"), (247.5, "W"), (292.5, "NW"), (337.5, "N"),
        ]
        for azimuth, want in expectations:
            with self.subTest(azimuth=azimuth):
                self.assertEqual(terrain.aspect_cardinal(azimuth), want)


class PolygonStatsAspect(unittest.TestCase):
    """The per-polygon aspect summary through the real exactextract path."""

    def _stats_for_plane(self, dz_e: float, dz_n: float) -> dict:
        import geopandas as gpd
        from shapely.geometry import box
        size = 20
        z = plane((size, size), dz_e, dz_n)
        transform = from_origin(X0, Y0, RES, RES)
        one = gpd.GeoDataFrame(
            [{"geometry": box(X0 + 3 * RES, Y0 - 17 * RES,
                              X0 + 17 * RES, Y0 - 3 * RES)}],
            crs=core.ANALYSIS_CRS)
        return terrain._polygon_stats(z, transform, one)

    def test_uniform_plane_polygon_carries_the_plane_aspect(self) -> None:
        stats = self._stats_for_plane(15.0, 0.0)  # falls west
        self.assertEqual(stats["aspectCardinal"], "W")
        self.assertAlmostEqual(stats["aspectMeanDeg"], 270.0, delta=1e-3)
        self.assertAlmostEqual(
            stats["slopeMeanDeg"], math.degrees(math.atan(0.5)), delta=1e-2)
        self.assertEqual(stats["coveragePct"], 100.0)

    def test_flat_polygon_has_null_aspect_and_zero_slope(self) -> None:
        stats = self._stats_for_plane(0.0, 0.0)
        self.assertIsNone(stats["aspectMeanDeg"])
        self.assertIsNone(stats["aspectCardinal"])
        self.assertEqual(stats["slopeMeanDeg"], 0.0)

    def _stats_for_azimuth(self, azimuth_deg: float) -> dict:
        """A uniform plane whose downslope azimuth is exactly the given
        compass angle (gradient magnitude 0.5), through the real
        exactextract path."""
        theta = math.radians(azimuth_deg)
        g = 0.5
        return self._stats_for_plane(-g * math.sin(theta) * RES,
                                     -g * math.cos(theta) * RES)

    def test_rounded_360_label_is_canonicalized_to_zero(self) -> None:
        """CANONICAL_SERIALIZATION[2] (T-M0-3): an azimuth of 359.97 deg
        rounds to the 0.1-degree label 360.0, which denotes the same
        direction as 0.0; the emitted pair is the canonical (0.0, 'N'),
        matching the schema's exclusive [0, 360) bound."""
        stats = self._stats_for_azimuth(359.97)
        self.assertEqual(stats["aspectMeanDeg"], 0.0)
        self.assertEqual(stats["aspectCardinal"], "N")

    def test_azimuth_below_the_rounding_edge_is_not_canonicalized(self) -> None:
        """The neighboring azimuth 359.9 sits below the rounding edge and
        is emitted unchanged (the canonicalization touches only the
        360.0 label)."""
        stats = self._stats_for_azimuth(359.9)
        self.assertEqual(stats["aspectMeanDeg"], 359.9)
        self.assertEqual(stats["aspectCardinal"], "N")

    def _two_plane_stats(self, azimuth_deg: float, left_cols: tuple[int, int],
                         right_cols: tuple[int, int]) -> dict:
        """Two planes with EXACTLY opposite downslope directions (azimuth
        and azimuth+180) in the left and right halves of one array, sampled
        by a MultiPolygon of one grid-aligned box per half. The boxes stay
        two columns clear of the junction so no kernel mixes the planes."""
        import geopandas as gpd
        from shapely.geometry import box
        from shapely.ops import unary_union
        size = 40
        rows, cols = np.mgrid[0:size, 0:size]
        az = math.radians(azimuth_deg)
        # Downslope azimuth az means elevation FALLS along (sin az, cos az)
        # in (east, north): z = -(x*sin + y*cos)*s with x = col*RES,
        # y = -row*RES (north-up).
        s = 0.4
        x = cols * RES
        y = -rows * RES
        z = (-(x * math.sin(az) + y * math.cos(az)) * s)
        zz = np.empty((size, size), dtype="float64")
        half = size // 2
        zz[:, :half] = z[:, :half]
        # Right half: the opposite gradient (aspect azimuth + 180), offset
        # by a constant so magnitudes stay small; the constant changes no
        # gradient.
        zz[:, half:] = -z[:, half:] + 2.0 * float(z[:, half - 1].mean())
        elev = zz.astype("float32")
        transform = from_origin(X0, Y0, RES, RES)

        def cell_box(c0: int, c1: int, r0: int = 4, r1: int = 36):
            return box(X0 + c0 * RES, Y0 - r1 * RES, X0 + c1 * RES, Y0 - r0 * RES)

        geom = unary_union([cell_box(*left_cols), cell_box(*right_cols)])
        one = gpd.GeoDataFrame([{"geometry": geom}], crs=core.ANALYSIS_CRS)
        return terrain._polygon_stats(elev, transform, one)

    def test_exactly_opposing_equal_areas_cancel_to_null(self) -> None:
        """The cancellation-epsilon contract at an oblique azimuth: equal
        areas of aspect 100.1 and 280.1 degrees cancel to a numerically
        unresolvable mean and must yield NULL, not an arbitrary
        rounding-noise direction (the float32 pipeline leaves a residual
        near 1e-7, which the epsilon must exceed)."""
        stats = self._two_plane_stats(100.1, (4, 16), (24, 36))
        self.assertIsNone(stats["aspectMeanDeg"])
        self.assertIsNone(stats["aspectCardinal"])
        self.assertGreater(stats["slopeMeanDeg"], 0.0)

    def test_axis_aligned_opposing_equal_areas_cancel_to_null(self) -> None:
        stats = self._two_plane_stats(90.0, (4, 16), (24, 36))
        self.assertIsNone(stats["aspectMeanDeg"])
        self.assertIsNone(stats["aspectCardinal"])

    def test_unequal_opposing_areas_keep_the_majority_direction(self) -> None:
        """A 3-to-1 area majority of one direction is numerically
        resolvable: the resultant is ~0.5 of the unit vector and the mean
        points at the majority azimuth."""
        stats = self._two_plane_stats(100.1, (4, 16), (28, 32))
        self.assertIsNotNone(stats["aspectMeanDeg"])
        self.assertAlmostEqual(stats["aspectMeanDeg"], 100.1, delta=0.1)
        self.assertEqual(stats["aspectCardinal"], "E")


class CoverageExact(unittest.TestCase):
    """coveragePct against polygons whose valid fraction over the fixture
    DEM's nodata notch is known exactly."""

    def _record(self, geom) -> dict:
        import geopandas as gpd
        gdf = gpd.GeoDataFrame(
            [{"US_L3CODE": "t", "US_L3NAME": "t", "geometry": geom}],
            crs=core.ANALYSIS_CRS)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            result = terrain.aggregate(
                gdf, "US_L3CODE",
                dem_path=str(SYNTH / "dem.tif"), cache_dir=Path(tmp))
        return result["t"]

    def _coverage(self, geom) -> float:
        return self._record(geom)["coveragePct"]

    def test_fully_valid_polygon_is_100(self) -> None:
        from shapely.geometry import box
        self.assertAlmostEqual(
            self._coverage(box(X0 + 300.0, Y0 - 900.0, X0 + 900.0, Y0 - 300.0)),
            100.0, delta=0.1)

    def test_half_over_the_notch_is_50(self) -> None:
        """Grid-aligned box spanning 600 m of x, the west 300 m inside the
        notch: exactly half the polygon is over nodata."""
        from shapely.geometry import box
        got = self._coverage(box(NOTCH_MINX, NOTCH_MINY, NOTCH_MAXX + 300.0, NOTCH_MAXY))
        self.assertAlmostEqual(got, 50.0, delta=0.1)

    def test_partial_pixel_weights_at_half_cell_offset(self) -> None:
        """A box overhanging the 300 m notch by half a cell on BOTH sides:
        the valid area is the two 15 m strips, 30 of 330 m of x-span (each a
        half-covered valid cell, so the answer needs exact partial-pixel
        weights; no rectangular-window ratio produces it)."""
        from shapely.geometry import box
        got = self._coverage(
            box(NOTCH_MINX - 15.0, NOTCH_MINY, NOTCH_MAXX + 15.0, NOTCH_MAXY))
        self.assertAlmostEqual(got, 100.0 * 30.0 / 330.0, delta=0.1)

    def test_polygon_entirely_over_the_notch_is_unavailable(self) -> None:
        """A polygon with zero polygon-weighted valid-elevation area takes
        the explicit-unavailability shape (S1 lane contract rev 11; the
        schema's no-data branch), not a zero-coverage stats record. The
        pre-rev-11 pin (coveragePct 0.0 in a stats shape) described an
        output the schema validator would reject."""
        from shapely.geometry import box
        got = self._record(
            box(NOTCH_MINX + 30.0, NOTCH_MINY + 30.0,
                NOTCH_MAXX - 30.0, NOTCH_MAXY - 30.0))
        self.assertEqual(
            got, {"unavailable": True, "reason": "no valid DEM pixels"})


class CategoricalMode(unittest.TestCase):
    """The categorical MODE materialization path: classed rasters warp by
    majority, never by bilinear blending."""

    CLASSES = (11.0, 42.0, 81.0)

    def _write_fine_source(self, path: Path) -> np.ndarray:
        """A 10 m classed raster covering a 12x12-cell 30 m analysis frame;
        each 30 m cell holds 9 subcells with a deterministic 6-to-3 majority,
        so the MODE answer per coarse cell is known."""
        coarse = 12
        fine = coarse * 3
        want = np.empty((coarse, coarse), dtype="float32")
        data = np.empty((fine, fine), dtype="float32")
        for r in range(coarse):
            for c in range(coarse):
                majority = self.CLASSES[(r + c) % 3]
                minority = self.CLASSES[(r + c + 1) % 3]
                block = np.full((3, 3), majority, dtype="float32")
                block[0, 0] = minority
                block[1, 1] = minority
                block[2, 2] = minority
                data[r * 3:(r + 1) * 3, c * 3:(c + 1) * 3] = block
                want[r, c] = majority
        profile = {
            "driver": "GTiff", "height": fine, "width": fine, "count": 1,
            "dtype": "float32", "crs": core.ANALYSIS_CRS,
            "transform": from_origin(X0, Y0, RES / 3.0, RES / 3.0),
            "nodata": -9999.0,
        }
        with rasterio.open(path, "w", **profile) as ds:
            ds.write(data, 1)
        return want

    # Bounds whose 120 m materialization pad lands exactly on the
    # 12x12-cell source frame: everything materialized has source data
    # (no NaN border).
    BOUNDS = (X0 + 4 * RES, Y0 - 8 * RES, X0 + 8 * RES, Y0 - 4 * RES)

    def test_mode_resampling_matches_the_known_majority(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            src = Path(tmp) / "classes.tif"
            want = self._write_fine_source(src)
            dest = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=True)
            with rasterio.open(dest) as ds:
                got = ds.read(1)
                t = ds.transform
            # Map the materialized window back onto the source's coarse frame.
            col_off = round((t.c - X0) / RES)
            row_off = round((Y0 - t.f) / RES)
            sub_want = want[row_off:row_off + got.shape[0],
                            col_off:col_off + got.shape[1]]
            valid = np.isfinite(got)
            self.assertTrue(valid.all())
            np.testing.assert_array_equal(got, sub_want)

    def test_mode_output_never_blends_classes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            src = Path(tmp) / "classes.tif"
            self._write_fine_source(src)
            dest = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=True)
            with rasterio.open(dest) as ds:
                got = ds.read(1)
            self.assertTrue(np.isin(got[np.isfinite(got)],
                                    np.asarray(self.CLASSES, "float32")).all())

    def test_bilinear_on_the_same_source_would_blend(self) -> None:
        """The defect the MODE path prevents is real: the continuous path on
        the same classed source emits values outside the class set."""
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            src = Path(tmp) / "classes.tif"
            self._write_fine_source(src)
            dest = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=False)
            with rasterio.open(dest) as ds:
                got = ds.read(1)
            finite = got[np.isfinite(got)]
            self.assertFalse(np.isin(finite,
                                     np.asarray(self.CLASSES, "float32")).all())

    def test_mispaired_raster_and_sidecar_are_rejected(self) -> None:
        """The sidecar's resampling claim binds to the raster BYTES: a
        bilinear raster hand-placed at the mode destination (sidecar and
        grid header both otherwise matching) must be rematerialized, never
        trusted."""
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            src = Path(tmp) / "classes.tif"
            self._write_fine_source(src)
            mode_dest = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=True)
            bilinear_dest = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=False)
            true_mode_bytes = mode_dest.read_bytes()
            # The swap: bilinear pixels under the mode sidecar.
            mode_dest.write_bytes(bilinear_dest.read_bytes())
            again = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=True)
            self.assertEqual(again, mode_dest)
            self.assertEqual(again.read_bytes(), true_mode_bytes,
                             "the swapped-in bilinear raster was reused "
                             "instead of being rematerialized")

    def test_categorical_and_continuous_do_not_share_a_cache_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(core, "log", lambda msg: None):
            src = Path(tmp) / "classes.tif"
            self._write_fine_source(src)
            a = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=True)
            b = core.materialize_raster(
                str(src), self.BOUNDS, Path(tmp), "classes", categorical=False)
            self.assertNotEqual(a, b)
            import json
            meta_a = json.loads(a.with_suffix(".meta.json").read_text("utf-8"))
            meta_b = json.loads(b.with_suffix(".meta.json").read_text("utf-8"))
            self.assertEqual(meta_a["resampling"], "mode")
            self.assertEqual(meta_b["resampling"], "bilinear")


if __name__ == "__main__":
    unittest.main()
