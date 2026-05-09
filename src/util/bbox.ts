/**
 * Quantize a bounding box to a fixed grid step, padded outward by one step
 * on every side. Used by the hydrography layer to coalesce nearby viewport
 * states into a stable cache key (so panning a few pixels does not refetch).
 *
 * Bbox is in Leaflet's `[south, west, north, east]` order, matching the
 * vanilla baseline's `quantizeBbox` (`app.js` v0.1.x). The hydrography
 * cache lookup keys the Leaflet shape directly; converting to MapLibre's
 * `[west, south, east, north]` order before quantizing would invalidate
 * the cache layout. Conversion to MapLibre order happens at the call site
 * via `leafletBoundsToMapLibre` when needed.
 */
export function quantizeBbox(
  bbox: [number, number, number, number],
  step: number
): [number, number, number, number] {
  // bbox = [s, w, n, e]
  const q = (v: number): number => Math.round(v / step) * step;
  // Pad outward so the cached bbox is always at least the size of the
  // viewport.
  return [
    q(bbox[0] - step),
    q(bbox[1] - step),
    q(bbox[2] + step),
    q(bbox[3] + step)
  ];
}

/**
 * Convert Leaflet-shaped bounds (`[[south, west], [north, east]]`) to the
 * MapLibre GL JavaScript order (`[west, south, east, north]`) that
 * `Map.fitBounds()` and `LngLatBounds` accept.
 *
 * The `readonly` typing matches the immutable shape used by `Region` so
 * config tables can pass through without a type assertion.
 */
export function leafletBoundsToMapLibre(
  bounds: readonly [readonly [number, number], readonly [number, number]]
): [number, number, number, number] {
  const [[south, west], [north, east]] = bounds;
  return [west, south, east, north];
}
