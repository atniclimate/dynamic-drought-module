# Fixture source note: terrain extension (T-S1-2)

Lane: T-S1-2, the S1 terrain-extension lane, built against
`harness/phases/0.8.0/S1_LANE_CONTRACT.md` revision 8 (FROZEN),
sections 4.2, 5.2, 6.1, 6.3, and 7. Date: 2026-07-22.

## What this fixture set is

Per contract 6.1, this directory contains EXACTLY two files:
`known-answer-cases.json` (this lane's hand-worked known-answer table)
and this `SOURCES.md`. There is NO capture script and there are NO
captured bytes: every case is a SYNTHETIC array built at test time from
the constructive parameters in the JavaScript Object Notation (JSON)
(region formulas of the form z = base + perCol * col + perRow * row,
explicit nodata cells, and polygon boxes in cell units). Nothing in
this set derives from any downloaded raster.

## Network record (contract 6.3)

- Requests made by this lane: ZERO. No fetch of any kind was performed;
  the tests run with the network cable pulled.
- The `metadata` contingency (ceiling 5, reason-recorded) was NOT used.
- No `RequestBudget` was instantiated: the terrain module is Contract A
  (contract 4.2), which has no acquisition seam, and this lane adds no
  fetch surface. `RequestBudget.counts` record: not applicable
  (no budget object exists; zero requests).

## Source and vintage posture

The upstream source of the terrain family is UNCHANGED by this lane:
the United States Geological Survey (USGS) 3D Elevation Program (3DEP)
1/3 arc-second seamless digital elevation model (DEM), exactly as
recorded in the adapter `SOURCE` block. This lane performed no new
acquisition, so there is no new vintage, checksum, or citation entry to
record; the existing acquisition-sidecar machinery (T-M0-1/T-M0-3) is
the vintage record and is untouched. T-S1-4 activates
`SOURCE.methodVersion` 3. The `METHOD_VERSIONS[3]` and
`CANONICAL_SERIALIZATION[3]` entries were completed by T-S1-2, the unit
that introduced the version.

## The near-flat aspect weighting resolution (contract 5.2 / 9.1)

Candidate rules (decision procedure step 1):

- (a) REJECTED: keep full unit-vector weighting; every aspect-defined
  cell contributes a full-magnitude unit vector to the circular mean
  regardless of how small its gradient is.
- (b) ADOPTED: gradient-magnitude (resultant) weighting; each cell's
  aspect unit vector is scaled by its gradient magnitude, which is
  algebraically identical to averaging the raw downslope gradient
  vectors (-p, -q). The cancellation epsilon applies to the
  weight-normalized resultant (weighted mean vector magnitude divided
  by mean gradient magnitude, dimensionless in [0, 1] exactly like the
  unweighted resultant it replaces).

Rationale (step 3): `aspectMeanDeg` claims a mean terrain orientation.
Under full weighting, a large near-flat area whose tiny gradients are
numerically meaningless (float32 elevation quantization noise) can
swing the emitted direction away from the terrain that actually has
orientation; in the disagreement case below the rejected rule reports
east for a landscape whose only real orientation is south. Gradient
weighting makes each cell's influence proportional to the directional
signal it actually carries, requires no arbitrary near-flat threshold
(`flat` stays frozen as the EXACTLY-zero-gradient case, so no
thresholding semantic is introduced), and reduces to the same answer as
full weighting on uniform slopes (the agreement control). The change to
the existing `aspectMeanDeg`/`aspectCardinal` values lives EXCLUSIVELY
on the `extended=True` path (staging rule, contract 5.2); the default
path keeps rule (a) byte-identically until the T-S1-4 flip.

What the rejected rule would have done to the disagreement case: with a
3-to-1 area ratio of near-flat-east (gradient 1/960) over steep-south
(gradient 1), rule (a) emits 108.4 degrees (cardinal E), the direction
of the numerically meaningless majority; rule (b) emits 179.8 degrees
(cardinal S). Both values are hand-worked below and asserted against
real emissions in `test_terrain_extension.py` (the rejected rule is the
shipped default-path behavior, so both sides run live).

## Hand-worked provenance, case by case

All cases sit on the grid x0 = -1900005.0, y0 = 2900055.0, 30 m cells,
European Petroleum Survey Group (EPSG):5070 (the same synthetic frame
the existing known-answer tests use). Fractions serialize at 3
decimals; azimuths at 0.1 degree.

1. `elev-bands-basic`: ten constant columns under a grid-aligned
   10 x 10-cell polygon; one column nodata. Valid-elevation area
   90 cells; each valid column is 10/90 = 1/9 = 0.111 serialized
   (two columns land in band [0, 500), giving 2/9 = 0.222). Band
   membership worked by the frozen half-open rule; the values -100, 0,
   499.5, 500, 2999.5, and 4000 pin the below-0 band, both sides of the
   0 and 500 edges, the interval interiors, and the 4000-plus edge.
   coveragePct = 100 * 90/100 = 90.0.
2. `elev-bands-partial-pixel`: the same array; polygon offset half a
   cell on both x sides (columns 4.5 to 6.5). Areas: half of column 4,
   all of column 5, half of column 6 = 0.25 / 0.5 / 0.25 of the
   polygon, all valid. Only exact partial-pixel weights produce this.
3. `aspect-excluded`: uniform plane falling east (z = 700 - 30 * col:
   Horn p = -1, q = 0, azimuth 90) with one interior nodata cell. The
   polygon holds 100 cells; the nodata cell leaves the denominator
   (99 valid); its 8 neighbors lose their full Horn neighborhood:
   excluded = 8/99 = 0.081, E = 91/99 = 0.919, serialized sum 1.000.
   Weighted and unweighted means over cells that all point east are
   both exactly 90.0 (E).
4. `flat-vs-south-split`: left half constant (exactly zero gradient),
   right half z = 2000 - 30 * row (falls south, azimuth 180). Two equal
   384-cell boxes clear of the junction: flat = 0.5, S = 0.5,
   excluded = 0. Flat cells carry no aspect under either rule (excluded
   from the unweighted mean; zero weight under gradient weighting), so
   both rules emit 180.0 (S).
5. `near-flat-control` (the AGREEMENT control, step 2): both halves
   fall west (azimuth 270) at gradient magnitudes 0.5 and 1.0, equal
   areas. Rule (a): mean of two identical unit vectors (-1, 0) gives
   azimuth 270.0. Rule (b): mean gradient vector
   (0.5 * (-0.5) + 0.5 * (-1.0), 0) = (-0.75, 0), the same direction,
   azimuth 270.0. Both rules: 270.0 (W).
6. `near-flat-disagreement` (the DISAGREEMENT case, step 2): near-flat
   plane falling east at 0.03125 m per cell (exactly representable in
   float32; p = -0.03125/30 = -1/960) over 384 cells, steep plane
   falling south at 30 m per cell (magnitude 1) over 128 cells; 3-to-1.
   Rule (a): mean unit vector (3 * (1, 0) + 1 * (0, -1)) / 4
   = (0.75, -0.25); azimuth = 180 - atan(3) = 108.43494882292201
   degrees, serialized 108.4, cardinal E. Rule (b): mean gradient
   vector (3 * (1/960) * (1, 0) + 1 * (0, -1)) / 4 = (1/1280, -0.25);
   azimuth = 180 - atan((1/1280) / (1/4)) = 180 - atan(0.003125)
   = 180 - 0.17904873 = 179.82095127 degrees, serialized 179.8,
   cardinal S. Normalized resultant under rule (b):
   |(1/1280, -0.25)| / ((3/960 + 1) / 4) = 0.99689, far above the 1e-4
   epsilon. The emitted values genuinely disagree (108.4 vs 179.8;
   E vs S).
7. `opposing-cancellation-extended`: equal 384-cell areas of azimuth 90
   and azimuth 270 at equal magnitude 0.5. Weighted mean gradient
   vector (0.5 * 0.5 - 0.5 * 0.5, 0) = (0, 0); normalized resultant 0,
   below the epsilon: the mean and cardinal are null, while the
   distribution reports E = 0.5, W = 0.5.
8. `zero-valid-all-nodata-window`: a grid-aligned 4 x 4-cell polygon
   plus the reader's 60 m, two-cell pad spans the full 8 x 8 raster.
   All 64 cells are nodata, so polygon-weighted valid-elevation area is
   zero. The availability gate returns exactly `{ "unavailable": true, "reason":
   "no valid DEM pixels" }` under both flag settings, with no fraction
   keys.
9. `zero-valid-polygon-finite-window`: the same central 4 x 4 polygon
   covers 16 nodata cells, while all 48 cells outside it in the padded
   8 x 8 window are finite at 100 m. Exact polygon weighting assigns the
   exterior pixels zero area, so polygon-weighted valid-elevation area is
   zero. The availability gate returns exactly `{ "unavailable": true,
   "reason": "no valid DEM pixels" }` under both flag settings, with no
   stats or fraction keys. The raster stores nodata as -9999; neither that
   sentinel nor NaN survives serialization.

Partition invariants: every positive-valid-area case's ten
elevation-band fractions and ten aspect-distribution fields each sum
to 1 within 1e-9 unrounded and within 10 * 0.0005 + 1e-9 serialized
(the section 5 convention); the test file checks both on every such
case. The two zero-valid-area cases instead pin the same ruled no-data
shape above.
