"""Terrain family adapter: 3D Elevation Program (3DEP) elevation, slope,
and aspect per ecoregion.

Structure follows the T-M0-1 extraction: the digital elevation model (DEM)
window for the whole zonal set is materialized ONCE (core.materialize_raster)
and each polygon reads a sub-window of that local raster. A materialization
failure is reported as explicit per-polygon unavailability for the whole
family, never a silent abort.

T-M0-2 (L1b) replaced the extraction's preserved defects with the corrected
methods, each pinned by known-answer tests (tests/test_known_answer.py) and
enumerated in tests/fixtures/delta-manifest.json:
  - slope is a true Horn 3x3 kernel (was numpy.gradient magnitude); cells
    without a full 3x3 neighborhood (array edges, nodata-adjacent cells)
    are excluded as NaN rather than estimated one-sidedly
  - aspect is emitted (downslope azimuth, 0 = north, clockwise; flat cells
    are explicit nulls; the per-polygon value is the area-weighted circular
    MEAN plus its 8-direction cardinal, null when opposing slopes cancel
    the mean below a documented numerical epsilon; no dominance claim)
  - coveragePct is the polygon-weighted valid-elevation fraction via
    exactextract partial-pixel weights (was the valid fraction of the
    rectangular read window)
One legacy defect remains deliberately preserved (a later unit's scope):
duplicate zonal codes are last-write-wins per feature row (no dissolve).

T-S1-2 (S1 terrain extension, lane contract rev 8 section 5.2) staged the
extended output behind aggregate(..., extended=True). T-S1-4 flips the
default to methodVersion 3; callers may still request extended=False only
as a historical fixture seam for methodVersion 2. The zero-polygon-weight
edge takes the explicit-unavailability record under both settings (S1 lane
contract rev 11; the prior stats shape could not pass schema validation).
The parity suite pins the current output over the committed fixtures:
  - elevBands: TEN fractions of valid-elevation area (below 0, the eight
    half-open [edge, next) intervals of ELEV_BAND_EDGES_M, and 4000-plus),
    area-weighted via exactextract partial-pixel weights
  - aspectDistribution: the 8 cardinals plus flat (exactly-zero-gradient
    cells) plus excluded (cells with no defined aspect for NEIGHBORHOOD
    reasons: array edge or nodata-adjacent Horn exclusion); the ten fields
    are a partition of valid-elevation area
  - NEAR-FLAT RESOLUTION (the question T-M0-2 left open): on the extended
    path the circular-mean aspect is GRADIENT-MAGNITUDE (resultant)
    WEIGHTED: each cell's aspect unit vector is scaled by its gradient
    magnitude, which is algebraically identical to averaging the raw
    downslope gradient vectors (-p, -q) themselves. Chosen over full
    unit-vector weighting because aspectMeanDeg claims a mean terrain
    orientation, and under full weighting a large near-flat area whose
    tiny gradients are numerically meaningless (float32 elevation
    quantization noise) can swing the emitted direction away from the
    terrain that actually has orientation. Gradient weighting makes each
    cell's influence proportional to the directional signal it actually
    carries, needs no arbitrary near-flat threshold (flat stays frozen as
    the exactly-zero-gradient case), and reduces to the same answer on
    uniform slopes. In the pinned disagreement case (a 3-to-1 area ratio
    of near-flat-east, gradient 1/960, over steep-south, gradient 1) the
    REJECTED full-weight rule emits 108.4 deg (E) while the ADOPTED rule
    emits 179.8 deg (S); both sides are hand-worked in
    tests/fixtures/terrain-extension/known-answer-cases.json and asserted
    in tests/test_terrain_extension.py.
"""
from __future__ import annotations

import math
import time
from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
from exactextract import exact_extract

from scripts.landscape import core

# 3D Elevation Program (3DEP) 1/3 arc-second seamless VRT on the public
# prd-tnm Simple Storage Service bucket. EPSG:4269 (NAD83 geographic), ~10 m;
# warped to the EPSG:5070 30 m analysis grid at materialization.
DEM_VRT = (
    "/vsicurl/https://prd-tnm.s3.amazonaws.com/StagedProducts/"
    "Elevation/13/TIFF/USGS_Seamless_DEM_13.vrt"
)

# The immutable method-version history for this family. methodVersion in
# SOURCE below must name a key here, and the schema pins its current value
# (const in schema/landscape-signature.schema.json), so the counter cannot
# drift from the method it claims to version.
#
# Bump rule, precisely: (a) any change to a version's method NUMERICS or
# SEMANTICS (kernels, weighting, exclusions, coverage definition) adds a
# new entry here, updates SOURCE, and updates the schema const in the
# same unit; (b) any change to the SERIALIZED OUTPUT of a PUBLISHED
# version, including its canonical serialization forms below, is likewise
# a bump. A version's canonical serialization forms
# (CANONICAL_SERIALIZATION) are part of that version's DEFINITION; they
# may be completed only in the unit that INTRODUCES the version, before
# any released artifact carries it, and are immutable afterward. Entries
# in both mappings are never edited or removed.
METHOD_VERSIONS: dict[int, str] = {
    1: (
        "legacy monolith method (pre-T-M0-2): numpy.gradient slope magnitude, "
        "no aspect output, coveragePct as the valid fraction of the "
        "rectangular read window"
    ),
    2: (
        "area-weighted mean elevation (exactextract) on a 30m EPSG:5070 grid; "
        "Horn 3x3 slope and aspect (cells without a full neighborhood excluded; "
        "flat cells carry no aspect); aspect summarized as the area-weighted "
        "circular mean; coveragePct is the polygon-weighted valid-elevation "
        "fraction"
    ),
    # Version 3 was staged by T-S1-2 and atomically activated by T-S1-4
    # together with the schema const and ruled fixture regeneration.
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

# Canonical serialization forms included in each method version's
# DEFINITION (see the bump rule above; pinned independently in test
# source alongside the prose). Version 2's form was declared in T-M0-3,
# the unit that introduced methodVersion itself, before any released
# artifact carried terrain method 2.
CANONICAL_SERIALIZATION: dict[int, str] = {
    2: (
        "aspectMeanDeg is serialized in canonical [0, 360): the "
        "round-to-0.1 label 360.0 becomes the equivalent 0.0"
    ),
    # Completed in T-S1-2, the unit that INTRODUCES version 3 (the bump
    # rule's canonical-serialization clause); immutable afterward.
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

# Per-family source resolution and provenance, baked into the snapshot for
# honesty. The RUNTIME provenance fields (acquired, materializedRasterSha256)
# are merged in by core.build_snapshot; this block is the static half.
SOURCE = {
    "source": "USGS 3D Elevation Program (3DEP) 1/3 arc-second seamless DEM",
    "sourceUrl": "https://www.usgs.gov/3d-elevation-program",
    "vintage": "continuously updated (seamless VRT)",
    "resolutionMeters": 10,
    "method": METHOD_VERSIONS[3],
    "methodVersion": 3,
}


class BudgetExceededError(RuntimeError):
    """Raised before a budgeted terrain HTTP attempt would exceed its cap."""


class RequestBudget:
    """Count-before-send ceilings for terrain's explicit request surface.

    The adopted 3DEP path is a GDAL /vsicurl/ read whose internal HTTP
    requests cannot be intercepted by spend(). It is measured separately as
    the contract section 8 receipt bound. The class still freezes the
    Contract B acquisition interface and governs any future explicit metadata
    or fallback request.
    """

    def __init__(self, ceilings: dict[str, int]) -> None:
        if any(
            not isinstance(key, str)
            or isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for key, value in ceilings.items()
        ):
            raise ValueError("request ceilings must be nonnegative integers")
        self.ceilings = dict(ceilings)
        self.counts = {key: 0 for key in ceilings}

    def spend(self, endpoint_key: str) -> None:
        ceiling = self.ceilings.get(endpoint_key, 0)
        used = self.counts.get(endpoint_key, 0)
        if used + 1 > ceiling:
            raise BudgetExceededError(
                f"request budget exceeded for {endpoint_key}: ceiling "
                f"{ceiling}; frozen S1 lane contract sections 4.5/8 require "
                "a hard stop"
            )
        self.counts[endpoint_key] = used + 1

# The 8-direction compass buckets for the aspect cardinal: half-open
# 45-degree intervals centered on the compass points, so N owns
# [337.5, 22.5) and each boundary azimuth belongs to the CLOCKWISE bucket
# (22.5 is NE, 337.5 is N). Enforced by an explicit floor rule, not
# banker's rounding, so exact boundaries are consistent.
ASPECT_CARDINALS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")

# A NUMERICAL CANCELLATION EPSILON, not a dominance test: below this
# mean-resultant magnitude (fraction of the unit vector) the circular mean
# direction is numerically unresolvable and the polygon carries null
# instead of an arbitrary rounding-artifact angle. The output above the
# epsilon is exactly what its field name says, the area-weighted MEAN
# direction; a resultant of 0.0002 (a 50.01/49.99 split of opposing
# slopes) yields a real mean, and no claim of terrain-aspect DOMINANCE is
# made at any resultant (a domain dominance threshold, if a consumer ever
# needs one, is that consumer's ruling to seek). Sizing: in this
# pipeline's own cancellation tests, exactly opposing float32-elevation
# planes cancel to residuals near 1e-7 (a bound specific to those cases;
# gradient differencing is input-dependent and aspect grows
# ill-conditioned as the gradient nears zero, so no general per-cell
# error claim is made). 1e-4 sits orders above those observed residuals;
# the known-answer tests pin both sides of it. On the DEFAULT
# (methodVersion 2) path, near-flat cells with a tiny nonzero gradient
# still contribute full-weight unit vectors to the mean (only
# exactly-zero gradients are excluded as flat); T-S1-2 resolved that
# question in favor of gradient-magnitude (resultant) weighting on the
# extended=True path (see the module docstring and METHOD_VERSIONS[3]),
# where this same epsilon applies to the WEIGHT-NORMALIZED resultant
# (the weighted mean vector's magnitude divided by the mean gradient
# magnitude, a dimensionless value in [0, 1] exactly like the unweighted
# resultant it replaces).
ASPECT_CANCELLATION_EPSILON = 1e-4

# The frozen elevation-band edges (lane contract 5.2): the extended
# output's elevBands is TEN fractions of valid-elevation area: below 0,
# the eight half-open [edge, next) intervals, and 4000-plus.
ELEV_BAND_EDGES_M = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]


def _horn_pq(z: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """The Horn 3x3 gradient components on a float64 north-up elevation
    grid: p = dz/dx (+x east), q = dz/dy (+y north). Cells without a full
    3x3 neighborhood are NaN. Extracted verbatim from horn_slope_aspect
    (T-S1-2) so the extended path can reuse the exact same arithmetic;
    numerics are unchanged."""
    p = np.full(z.shape, np.nan)  # dz/dx, +x = east
    q = np.full(z.shape, np.nan)  # dz/dy, +y = north
    if z.shape[0] >= 3 and z.shape[1] >= 3:
        nw, n_, ne = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
        w_, e_ = z[1:-1, :-2], z[1:-1, 2:]
        sw, s_, se = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
        p[1:-1, 1:-1] = ((ne + 2.0 * e_ + se) - (nw + 2.0 * w_ + sw)) / (8.0 * res_m)
        # Row 0 is north: the "upper" kernel row is the NORTH row, so the
        # northward gradient is (north row - south row).
        q[1:-1, 1:-1] = ((nw + 2.0 * n_ + ne) - (sw + 2.0 * s_ + se)) / (8.0 * res_m)
    return p, q


def horn_slope_aspect(elev: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Slope (degrees) and aspect (downslope azimuth degrees, 0 = north,
    clockwise) from a north-up elevation grid by the Horn 3x3 kernel.

    Cells without a full 3x3 neighborhood (array edges and cells adjacent
    to NaN nodata) are NaN in BOTH outputs: no one-sided estimates. Flat
    cells (both gradient components exactly zero) have slope 0 and aspect
    NaN (an explicit no-direction, rendered as null downstream). The read
    pad (60 m = two cells beyond polygon bounds) means polygon interiors
    always have full neighborhoods except beside genuine source nodata.
    """
    z = elev.astype("float64")
    p, q = _horn_pq(z, res_m)
    slope = np.degrees(np.arctan(np.hypot(p, q)))
    # Downslope azimuth: the steepest-descent vector is (-p, -q) in
    # (east, north); atan2(east, north) is the compass convention.
    with np.errstate(invalid="ignore"):
        aspect = np.degrees(np.arctan2(-p, -q)) % 360.0
    aspect[(p == 0.0) & (q == 0.0)] = np.nan
    # The Horn kernel omits the center cell, so a nodata cell's neighbors
    # could otherwise hand it an estimate; a cell with no elevation has no
    # slope or aspect, full stop.
    center_nodata = ~np.isfinite(z)
    slope[center_nodata] = np.nan
    aspect[center_nodata] = np.nan
    return slope.astype("float32"), aspect.astype("float32")


def aspect_cardinal(azimuth_deg: float) -> str:
    """The 8-direction compass bucket for an azimuth in [0, 360): half-open
    45-degree intervals centered on the compass points; a boundary azimuth
    (22.5, 67.5, ...) belongs to the clockwise bucket."""
    return ASPECT_CARDINALS[math.floor((azimuth_deg + 22.5) / 45.0) % 8]


def _extended_fractions(elev: np.ndarray, transform, one_row: gpd.GeoDataFrame) -> dict:
    """UNROUNDED extended terrain statistics for one polygon (T-S1-2, lane
    contract 5.2): the ten elevation-band fractions, the ten-field aspect
    distribution partition, and the gradient-magnitude-weighted (resultant)
    circular-mean aspect. Every fraction is of VALID-ELEVATION area via
    exactextract partial-pixel weights. The caller gates this routine to
    polygons with positive valid-elevation weight, so every fraction is
    computable. Returned unrounded so the
    known-answer tests can check the partition invariants (each unrounded
    sum within 1e-9 of 1) upstream of serialization rounding."""
    z64 = elev.astype("float64")
    p, q = _horn_pq(z64, core.GRID_RES_M)
    del z64
    valid = np.isfinite(elev)
    # The three-way split of valid-elevation cells (a partition with the
    # eight cardinal buckets of the defined cells):
    #   defined:  a computable downslope direction (finite aspect)
    #   flat:     full neighborhood, both gradient components exactly zero
    #   excluded: no defined aspect for NEIGHBORHOOD reasons (array edge
    #             or nodata-adjacent Horn exclusion)
    finite_gradient = np.isfinite(p) & np.isfinite(q) & valid
    flat = finite_gradient & (p == 0.0) & (q == 0.0)
    defined = finite_gradient & ~flat
    excluded = valid & ~finite_gradient

    def indicator(mask: np.ndarray) -> np.ndarray:
        # 1.0/0.0 over valid-elevation cells, NaN (nodata, excluded by
        # exactextract) elsewhere: the weighted mean IS the fraction of
        # valid-elevation area.
        result = mask.astype("float32")
        result[~valid] = np.nan
        return result

    def extracted_mean(arr: np.ndarray, dtype: str) -> float:
        mf = core.memdataset(arr, transform, dtype=dtype)
        try:
            with mf.open() as ds:
                row = exact_extract(
                    ds,
                    one_row,
                    ["mean"],
                    output="pandas",
                ).iloc[0]
            return float(row["mean"])
        except (TypeError, ValueError):
            return float("nan")
        finally:
            mf.close()

    means: dict[str, float] = {}
    edges = ELEV_BAND_EDGES_M
    for i in range(len(edges) + 1):
        if i == 0:
            in_band = elev < edges[0]
        elif i == len(edges):
            in_band = elev >= edges[-1]
        else:
            in_band = (elev >= edges[i - 1]) & (elev < edges[i])
        arr = indicator(in_band & valid)
        means[f"band{i}"] = extracted_mean(arr, "float32")
        del arr, in_band

    with np.errstate(invalid="ignore"):
        aspect64 = np.degrees(np.arctan2(-p, -q)) % 360.0
    aspect64[~defined] = np.nan
    # The same half-open floor rule as aspect_cardinal, evaluated one
    # bucket at a time so a large polygon never retains eight full-window
    # indicator arrays.
    for k in range(8):
        lower = (k * 45.0 - 22.5) % 360.0
        upper = (k * 45.0 + 22.5) % 360.0
        if lower > upper:
            in_bucket = defined & (
                (aspect64 >= lower) | (aspect64 < upper)
            )
        else:
            in_bucket = defined & (
                (aspect64 >= lower) & (aspect64 < upper)
            )
        arr = indicator(in_bucket)
        means[f"card{k}"] = extracted_mean(arr, "float32")
        del arr, in_bucket
    del aspect64

    for name, mask in (("flat", flat), ("excluded", excluded)):
        arr = indicator(mask)
        means[name] = extracted_mean(arr, "float32")
        del arr
    # The downslope gradient vectors for the resultant-weighted mean: the
    # unit vector scaled by gradient magnitude is exactly (-p, -q), so the
    # weighted circular mean is the direction of the area-weighted mean
    # gradient vector. float64 end to end (see the sin/cos precision note
    # in _polygon_stats); restricted to aspect-DEFINED cells, which is
    # equivalent to including flat cells at their zero weight.
    for name, source in (("gx", p), ("gy", q)):
        arr = np.full(source.shape, np.nan, dtype="float64")
        arr[defined] = -source[defined]
        means[name] = extracted_mean(arr, "float64")
        del arr
    magnitude = np.hypot(p, q)
    magnitude[~defined] = np.nan
    means["gmag"] = extracted_mean(magnitude, "float64")
    del magnitude, p, q

    aspect_mean = None
    gx, gy, g = means["gx"], means["gy"], means["gmag"]
    # The cancellation epsilon applies to the WEIGHT-NORMALIZED resultant
    # (see the ASPECT_CANCELLATION_EPSILON note): |mean vector| / mean
    # magnitude is in [0, 1] exactly like the unweighted resultant. A
    # polygon with no aspect-defined cells has NaN means and stays null;
    # mean magnitude is strictly positive whenever any cell is defined.
    if (math.isfinite(gx) and math.isfinite(gy) and math.isfinite(g)
            and g > 0.0 and math.hypot(gx, gy) / g >= ASPECT_CANCELLATION_EPSILON):
        aspect_mean = math.degrees(math.atan2(gx, gy)) % 360.0

    return {
        "elevBands": [means[f"band{i}"] for i in range(len(edges) + 1)],
        "aspectDistribution": {
            **{ASPECT_CARDINALS[k]: means[f"card{k}"] for k in range(8)},
            "flat": means["flat"],
            "excluded": means["excluded"],
        },
        "aspectMeanDeg": aspect_mean,
    }


def _polygon_stats(elev: np.ndarray, transform, one_row: gpd.GeoDataFrame,
                   extended: bool = False) -> dict:
    """The corrected per-polygon terrain read: elevation stats, Horn slope
    mean, circular-mean aspect (plus cardinal), and polygon-weighted valid
    coverage, all through exactextract partial-pixel weights."""
    slope, aspect = horn_slope_aspect(elev, core.GRID_RES_M)
    # Validity carries 1.0/0.0 (never NaN) so exactextract weights every
    # intersected cell: the mean IS the polygon's valid-elevation fraction.
    validity = np.isfinite(elev).astype("float32")
    # sin/cos stay float64 end to end: a float32 write would round them by
    # ~1e-8, the same order as the cancellation residuals the epsilon must
    # sit above (see ASPECT_CANCELLATION_EPSILON).
    extracted: dict[str, object] = {}
    basic_rasters = {
        "elev": (elev, ["mean", "min", "max"], "float32"),
        "slope": (slope, ["mean"], "float32"),
        "validity": (validity, ["mean"], "float32"),
    }
    for name, (arr, ops, dtype) in basic_rasters.items():
        mf = core.memdataset(arr, transform, dtype=dtype)
        try:
            with mf.open() as ds:
                row = exact_extract(ds, one_row, ops, output="pandas").iloc[0]
            for op in ops:
                extracted[f"{name}_{op}"] = row[op]
        finally:
            mf.close()
    del basic_rasters, slope, validity

    aspect_rad = np.radians(aspect.astype("float64"))
    for name, operation in (
        ("aspect_sin", np.sin),
        ("aspect_cos", np.cos),
    ):
        arr = operation(aspect_rad)
        mf = core.memdataset(arr, transform, dtype="float64")
        try:
            with mf.open() as ds:
                row = exact_extract(
                    ds,
                    one_row,
                    ["mean"],
                    output="pandas",
                ).iloc[0]
            extracted[f"{name}_mean"] = row["mean"]
        finally:
            mf.close()
        del arr
    del aspect, aspect_rad

    sin_mean = extracted["aspect_sin_mean"]
    cos_mean = extracted["aspect_cos_mean"]
    aspect_mean = None
    cardinal = None
    try:
        s, c = float(sin_mean), float(cos_mean)  # type: ignore[arg-type]
        if math.isfinite(s) and math.isfinite(c) and math.hypot(s, c) >= ASPECT_CANCELLATION_EPSILON:
            aspect_mean = math.degrees(math.atan2(s, c)) % 360.0
            cardinal = aspect_cardinal(aspect_mean)
    except (TypeError, ValueError):
        pass

    # Canonical azimuth form, part of method version 2's DEFINITION
    # (CANONICAL_SERIALIZATION[2], declared in the unit that introduced
    # the version; see the bump rule above): rounding to 0.1 deg can lift
    # a mean in [359.95, 360) to the label 360.0, which denotes the SAME
    # direction as 0.0; the artifact carries the canonical 0.0 and the
    # schema enforces [0, 360) exclusive.
    aspect_rounded = core.round_or_none(aspect_mean, 1)
    if aspect_rounded == 360.0:
        aspect_rounded = 0.0

    result = {
        "elevMeanM": core.round_or_none(extracted["elev_mean"], 1),
        "elevMinM": core.round_or_none(extracted["elev_min"], 1),
        "elevMaxM": core.round_or_none(extracted["elev_max"], 1),
        "slopeMeanDeg": core.round_or_none(extracted["slope_mean"], 2),
        "aspectMeanDeg": aspect_rounded,
        "aspectCardinal": cardinal,
        "coveragePct": core.round_or_none(
            100.0 * float(extracted["validity_mean"]), 1  # type: ignore[arg-type]
        ),
    }
    if not extended:
        return result
    # MethodVersion 3. The near-flat resolution carries the gradient-
    # magnitude-weighted aspect mean and the two additive distributions.
    ext = _extended_fractions(elev, transform, one_row)
    weighted_mean = ext["aspectMeanDeg"]
    weighted_rounded = core.round_or_none(weighted_mean, 1)
    if weighted_rounded == 360.0:
        weighted_rounded = 0.0  # CANONICAL_SERIALIZATION[3], same azimuth rule
    result["aspectMeanDeg"] = weighted_rounded
    result["aspectCardinal"] = (
        aspect_cardinal(weighted_mean) if weighted_mean is not None else None
    )
    result["elevBands"] = [core.round_or_none(v, 3) for v in ext["elevBands"]]
    result["aspectDistribution"] = {
        k: core.round_or_none(v, 3) for k, v in ext["aspectDistribution"].items()
    }
    return result


def _has_polygon_valid_elevation(
    elev: np.ndarray, transform, one_row: gpd.GeoDataFrame
) -> bool:
    """Whether exact polygon weighting assigns positive area to valid DEM."""
    validity = np.isfinite(elev).astype("float32")
    mf = core.memdataset(validity, transform, dtype="float32")
    try:
        with mf.open() as ds:
            row = exact_extract(ds, one_row, ["mean"], output="pandas").iloc[0]
        valid_fraction = float(row["mean"])
        return math.isfinite(valid_fraction) and valid_fraction > 0.0
    except (TypeError, ValueError):
        return False
    finally:
        mf.close()


def _prepared_entry_error(entry: dict | None) -> str | None:
    """Contract B revalidation of the prepared 30 m analysis raster."""
    if not isinstance(entry, dict):
        return "terrain: artifact missing from prepared set"
    if entry.get("kind") != "raster":
        return "terrain: prepared artifact kind is not raster"
    if entry.get("error") is not None:
        return f"terrain: {entry['error']}"
    raw_path = entry.get("path")
    path = Path(raw_path) if isinstance(raw_path, (str, Path)) else None
    if path is None or not path.is_file():
        return f"terrain: prepared raster path {raw_path} does not exist"
    try:
        with rasterio.open(path) as ds:
            transform = ds.transform
            if str(ds.crs) != core.ANALYSIS_CRS:
                return (
                    "terrain prepared raster is not EPSG:5070 per "
                    "S1_LANE_CONTRACT.md section 2.2"
                )
            if (
                abs(transform.a - core.GRID_RES_M) > 1e-6
                or abs(transform.e + core.GRID_RES_M) > 1e-6
                or abs(transform.b) > 1e-12
                or abs(transform.d) > 1e-12
            ):
                return (
                    "terrain prepared raster is not an unrotated 30 m grid "
                    "per S1_LANE_CONTRACT.md section 2.2"
                )
            x_steps = (transform.c - core.GRID_ANCHOR_X) / core.GRID_RES_M
            y_steps = (transform.f - core.GRID_ANCHOR_Y) / core.GRID_RES_M
            if (
                abs(x_steps - round(x_steps)) * core.GRID_RES_M > 1e-6
                or abs(y_steps - round(y_steps)) * core.GRID_RES_M > 1e-6
            ):
                return (
                    "terrain prepared raster is not anchor-congruent per "
                    "S1_LANE_CONTRACT.md section 2.2"
                )
    except Exception as exc:  # noqa: BLE001 - unreadable is unavailable
        return f"terrain prepared raster is unreadable: {exc}"
    return None


def acquire(
    bounds_5070: tuple[float, float, float, float],
    cache_dir: Path,
    budget: RequestBudget,
    *,
    sources: dict[str, str] | None = None,
) -> dict[str, dict]:
    """Contract B checked acquisition for the terrain analysis raster.

    The adopted /vsicurl/ path is materialized through core. Its GDAL-issued
    request count is an instrumented receipt, not a spend() row. A local
    ``sources["terrain"]`` override is the offline fixture seam.
    """
    source = (sources or {}).get("terrain", DEM_VRT)
    try:
        materialized = core.materialize_raster(
            source,
            bounds_5070,
            cache_dir,
            "terrain",
        )
        entry = {
            "kind": "raster",
            "path": materialized,
            "error": None,
            "acquired": core.acquisition_date(materialized),
            "sha256": core.materialized_sha256(materialized),
        }
        error = _prepared_entry_error(entry)
        if error is not None:
            return {
                "terrain": {
                    "kind": "raster",
                    "path": None,
                    "error": error,
                    "acquired": None,
                    "sha256": None,
                }
            }
        return {"terrain": entry}
    except BudgetExceededError:
        raise
    except Exception as exc:  # noqa: BLE001 - explicit family unavailability
        return {
            "terrain": {
                "kind": "raster",
                "path": None,
                "error": f"terrain acquisition failed: {exc}",
                "acquired": None,
                "sha256": None,
            }
        }


def aggregate(
    gdf: gpd.GeoDataFrame,
    code_field: str,
    dem_path: str | None = None,
    cache_dir: Path | None = None,
    prepared_raster: Path | None = None,
    run_info: dict | None = None,
    materialization_error: str | None = None,
    *,
    prepared: dict[str, dict] | None = None,
    extended: bool | None = None,
) -> dict:
    """Per-polygon elevation (mean/min/max), Horn slope mean, circular-mean
    aspect, and polygon-weighted valid coverage, keyed by code_field.
    Materializes the DEM for the zonal set's extent once, then reads one
    sub-window per polygon so memory stays bounded.

    dem_path and cache_dir default to the module DEM_VRT and core.CACHE_DIR
    resolved at call time (an injection seam for the parity tests).
    prepared_raster, when given, is an already-materialized analysis raster
    covering every polygon (the once-per-FAMILY seam: the orchestrator
    materializes the union extent once and passes it to every level's
    aggregation). run_info, when given, receives 'terrainAcquired' (the
    materialization's recorded acquisition date) so the snapshot's retrieval
    stamp can reflect when the data was actually fetched.
    materialization_error, when given, is a failure the orchestrator already
    hit for this family: the adapter reports it as per-polygon
    unavailability WITHOUT attempting its own materialization (so one
    family-level failure is one attempt, never one per level).
    extended (KEYWORD-ONLY) emits elevBands and aspectDistribution per
    polygon and carries the gradient-magnitude-weighted aspect mean. When
    omitted, it follows SOURCE.methodVersion, so the activated version 3
    path is the default. Callers may pass False only for historical
    methodVersion 2 fixture checks. The zero-polygon-weight edge takes the
    explicit-unavailability record under both settings (S1 lane contract
    rev 11; the prior stats shape could not pass schema validation). The
    parity suite pins byte identity over the committed current fixtures."""
    if extended is None:
        extended = SOURCE["methodVersion"] >= 3
    if prepared is not None:
        entry = prepared.get("terrain")
        prepared_error = _prepared_entry_error(entry)
        if prepared_error is not None:
            materialization_error = prepared_error
            prepared_raster = None
        else:
            raw_path = entry.get("path") if entry is not None else None
            prepared_raster = Path(raw_path)
            if run_info is not None:
                run_info["terrainAcquired"] = entry.get("acquired")
                run_info["terrainRasterSha256"] = entry.get("sha256")
    dem_path = dem_path if dem_path is not None else DEM_VRT
    cache_dir = cache_dir if cache_dir is not None else core.CACHE_DIR
    out: dict = {}
    n = len(gdf)
    nonempty = gdf[~(gdf.geometry.is_empty | gdf.geometry.isna())]
    if nonempty.empty:
        for _, row in gdf.iterrows():
            out[row[code_field]] = {"unavailable": True, "reason": "empty geometry"}
        return out
    if materialization_error is not None:
        for _, row in gdf.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                out[row[code_field]] = {"unavailable": True, "reason": "empty geometry"}
            else:
                out[row[code_field]] = {
                    "unavailable": True,
                    "reason": f"dem materialization failed: {materialization_error}",
                }
        return out
    if prepared_raster is not None:
        local_dem = prepared_raster
    else:
        try:
            local_dem = core.materialize_raster(
                dem_path, tuple(nonempty.total_bounds), cache_dir, "terrain"
            )
        except Exception as exc:  # noqa: BLE001 - explicit family unavailability
            core.log(f"  terrain materialization failed: {exc}")
            for _, row in gdf.iterrows():
                geom = row.geometry
                if geom is None or geom.is_empty:
                    out[row[code_field]] = {"unavailable": True, "reason": "empty geometry"}
                else:
                    out[row[code_field]] = {
                        "unavailable": True,
                        "reason": f"dem materialization failed: {exc}",
                    }
            return out
    if run_info is not None:
        run_info["terrainAcquired"] = core.acquisition_date(local_dem)
        run_info["terrainRasterSha256"] = core.materialized_sha256(local_dem)
    with rasterio.open(local_dem) as dem_ds:
        for i, (_, row) in enumerate(gdf.iterrows(), start=1):
            code = row[code_field]
            geom = row.geometry
            if geom is None or geom.is_empty:
                out[code] = {"unavailable": True, "reason": "empty geometry"}
                continue
            bounds = geom.bounds
            t0 = time.time()
            try:
                elev, transform = core.read_window(dem_ds, bounds)
            except Exception as exc:  # noqa: BLE001 - record, do not abort the build
                core.log(f"  [{i}/{n}] {code}: DEM read failed: {exc}")
                out[code] = {"unavailable": True, "reason": f"dem read failed: {exc}"}
                continue
            one_row = gdf.iloc[[i - 1]]
            if not _has_polygon_valid_elevation(elev, transform, one_row):
                out[code] = {"unavailable": True, "reason": "no valid DEM pixels"}
                continue
            out[code] = _polygon_stats(elev, transform, one_row, extended=extended)
            core.log(
                f"  [{i}/{n}] {code} {row.get('US_L3NAME', '')}: "
                f"mean {out[code]['elevMeanM']} m, min {out[code]['elevMinM']}, "
                f"max {out[code]['elevMaxM']}, slope {out[code]['slopeMeanDeg']} deg, "
                f"aspect {out[code]['aspectCardinal']} "
                f"({time.time() - t0:.1f}s)"
            )
    return out
