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

/*
 * Shared selection-bbox seams (0.8.0 T-M0-4). Everything below operates on
 * MapLibre-order `[west, south, east, north]` boxes and is deliberately
 * ANTIMERIDIAN-NAIVE: plain arithmetic on raw numbers, no wrapping. These
 * used to live inline at their call sites (src/impact/sources.ts,
 * src/state/deep-link.ts, src/ui/search-controller.ts,
 * src/ui/island/place-studio.tsx, src/state/watershed-geometry.ts); they
 * were extracted so tests/antimeridian.spec.ts can pin the CURRENT naive
 * behavior on a crossing bbox through the very functions production calls
 * (several of those modules import src/config/urls.ts, which evaluates
 * Vite-only state at module scope and cannot be imported by a Node spec).
 * N2 (the Alaska/Aleutian widening) changes the behavior; the pins make
 * that a visible diff, not a surprise.
 */

/**
 * Midpoint of a bbox by plain averaging. For a naive min/max walked box of
 * an antimeridian-crossing geometry this lands on the WRONG side of the
 * world (near longitude 0); that known-poor framing is pinned behavior
 * until N2.
 */
export function bboxCenter(
  bbox: readonly [number, number, number, number]
): { lng: number; lat: number } {
  return {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2
  };
}

/**
 * Union bboxes by min/max on raw numbers; null for an empty list. For
 * parts on either side of the antimeridian the union smears toward a
 * world-spanning box (pinned behavior until N2).
 */
export function unionBboxes(
  boxes: ReadonlyArray<readonly [number, number, number, number]>
): [number, number, number, number] | null {
  let union: [number, number, number, number] | null = null;
  for (const b of boxes) {
    union = union
      ? [
          Math.min(union[0], b[0]),
          Math.min(union[1], b[1]),
          Math.max(union[2], b[2]),
          Math.max(union[3], b[3])
        ]
      : [b[0], b[1], b[2], b[3]];
  }
  return union;
}

/** Axis-aligned overlap test on raw numbers; no longitude wrapping. */
export function bboxIntersects(
  first: readonly [number, number, number, number],
  second: readonly [number, number, number, number]
): boolean {
  return !(
    first[2] < second[0] ||
    first[0] > second[2] ||
    first[3] < second[1] ||
    first[1] > second[3]
  );
}

/** Axis-aligned intersection on raw numbers, or null when disjoint. */
export function bboxIntersection(
  first: readonly [number, number, number, number],
  second: readonly [number, number, number, number]
): readonly [number, number, number, number] | null {
  if (!bboxIntersects(first, second)) return null;
  return [
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
    Math.min(first[2], second[2]),
    Math.min(first[3], second[3])
  ];
}

/**
 * The selection envelope string for the NIFC perimeter query
 * (src/impact/sources.ts): the selection bbox when one exists, else a
 * halo around the click point; members rounded to 4 decimals and joined.
 * A crossing selection still yields ONE naive world-spanning envelope
 * (pinned behavior until N2).
 */
export function selectionEnvelope(
  bbox: readonly [number, number, number, number] | undefined,
  lngLat: { readonly lng: number; readonly lat: number },
  haloDegrees = 0.5
): string {
  const box =
    bbox ??
    ([
      lngLat.lng - haloDegrees,
      lngLat.lat - haloDegrees,
      lngLat.lng + haloDegrees,
      lngLat.lat + haloDegrees
    ] as const);
  return box.map((n) => Math.round(n * 10000) / 10000).join(',');
}

/**
 * The `geometry` parameter value for an ArcGIS envelope query
 * (place-studio and watershed-geometry): the raw joined tuple. A crossing
 * bbox is sent as-is, one naive envelope (pinned behavior until N2).
 */
export function arcGisEnvelopeValue(
  bbox: readonly [number, number, number, number]
): string {
  return bbox.join(',');
}
