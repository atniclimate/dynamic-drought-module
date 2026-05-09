/**
 * Region: a named PNW (or future-regional) framing for the map.
 *
 * The `bounds` field is intentionally in Leaflet's `[[south, west], [north, east]]`
 * order even though MapLibre uses `[west, south, east, north]`. This keeps the
 * config blocks ports cleanly from the vanilla baseline; conversion happens
 * at the boundary in `regionToMapLibreBounds()` (see src/config/regions.ts).
 *
 * `padding` is in degrees and is applied symmetrically when fitting the bounds.
 */
export interface Region {
  readonly label: string;
  readonly short: string;
  readonly bounds: readonly [readonly [number, number], readonly [number, number]];
  readonly padding: number;
  readonly description: string;
}

export type RegionKey = string;
