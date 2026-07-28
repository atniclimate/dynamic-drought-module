/**
 * Map-center coverage ring derived offline from all 11,009 vertices of the
 * bundled 2023 United States Census Bureau 1:20,000,000 geometry for the 48
 * contiguous states and District of Columbia. Its monotone-chain convex hull
 * is expanded 0.5 percent around the interior point (-95.84, 36.94), then
 * rounded to 0.01 degrees. The committed geometry test proves that every
 * source vertex remains inside. False-inside border tolerance is intentional;
 * selected-frame request accounting catches tile failures.
 */
const CONUS_COVERAGE_RING: ReadonlyArray<readonly [number, number]> = [
  [-124.87,48.44], [-124.87,48.21], [-124.7,42.87], [-124.55,40.46],
  [-124.51,40.28], [-123.87,38.97], [-123.85,38.92], [-120.58,34.01],
  [-119.66,33.21], [-118.54,32.78], [-98.26,26.02], [-98.21,26],
  [-97.43,25.78], [-81.96,24.44], [-81.85,24.44], [-81.03,24.61],
  [-80.89,24.65], [-80.58,24.81], [-80.42,24.94], [-80.28,25.09],
  [-80.16,25.27], [-66.81,44.86], [-67.65,47.12], [-67.81,47.25],
  [-68.02,47.37], [-68.07,47.39], [-68.13,47.41], [-69.02,47.5],
  [-69.09,47.51], [-95.15,49.45], [-122.89,49.06],
];

export function pointHasHeatRiskCoverage(
  lng: number,
  lat: number
): boolean {
  let inside = false;
  for (
    let index = 0, previous = CONUS_COVERAGE_RING.length - 1;
    index < CONUS_COVERAGE_RING.length;
    previous = index, index += 1
  ) {
    const [x, y] = CONUS_COVERAGE_RING[index]!;
    const [previousX, previousY] = CONUS_COVERAGE_RING[previous]!;
    if (
      (y > lat) !== (previousY > lat) &&
      lng <
        ((previousX - x) * (lat - y)) / (previousY - y) + x
    ) {
      inside = !inside;
    }
  }
  return inside;
}
