import {
  bboxCrossesAntimeridian,
  crossingAwareBbox,
  normalizeLongitude,
  splitBboxAtAntimeridian,
  type LngLatBbox
} from './antimeridian';

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
 * Shared selection-bbox seams (N2-A). Everything below operates on
 * MapLibre-order `[west, south, east, north]` boxes and accepts both encoded
 * crossings (`west > east`) and naive geometry walks (`east - west > 180`).
 * Geometry-owning callers should still prefer the exact geometry walk in
 * `geometryBboxAcrossAntimeridian`.
 */

type LongitudeInterval = readonly [number, number];

/** Split either bbox representation into normalized, non-crossing pieces. */
export function serviceBboxPieces(
  bbox: LngLatBbox
): readonly [LngLatBbox] | readonly [LngLatBbox, LngLatBbox] {
  return splitBboxAtAntimeridian(crossingAwareBbox(bbox));
}

/** Longitude-only pieces used by union and intersection. */
function longitudeIntervals(bbox: LngLatBbox): LongitudeInterval[] {
  return serviceBboxPieces(bbox).map(
    (piece) => [piece[0], piece[2]] as const
  );
}

/**
 * Convert a crossing bbox to one continuous MapLibre fit. The east edge may
 * exceed 180 so the camera follows the compact antimeridian extent.
 */
export function bboxToContinuousBounds(
  bbox: LngLatBbox,
  referenceLongitude?: number
): [number, number, number, number] {
  const aware = crossingAwareBbox(bbox);
  let west = aware[0];
  let east = aware[2];
  if (bboxCrossesAntimeridian(aware)) east += 360;

  if (referenceLongitude !== undefined && Number.isFinite(referenceLongitude)) {
    const center = (west + east) / 2;
    const shift = Math.round((referenceLongitude - center) / 360) * 360;
    west += shift;
    east += shift;
  }
  return [west, aware[1], east, aware[3]];
}

/** Midpoint of either bbox representation on its continuous longitude arc. */
export function bboxCenter(
  bbox: LngLatBbox,
  referenceLongitude?: number
): { lng: number; lat: number } {
  const continuous = bboxToContinuousBounds(bbox, referenceLongitude);
  return {
    lng: normalizeLongitude((continuous[0] + continuous[2]) / 2),
    lat: (continuous[1] + continuous[3]) / 2
  };
}

/**
 * Union bboxes on a circle; null for an empty list. The result uses encoded
 * crossing form when the smallest covering longitude arc crosses 180.
 */
export function unionBboxes(
  boxes: ReadonlyArray<LngLatBbox>
): [number, number, number, number] | null {
  if (boxes.length === 0) return null;

  let south = Infinity;
  let north = -Infinity;
  const intervals: Array<[number, number]> = [];
  for (const bbox of boxes) {
    south = Math.min(south, bbox[1]);
    north = Math.max(north, bbox[3]);
    for (const interval of longitudeIntervals(bbox)) {
      intervals.push([interval[0], interval[1]]);
    }
  }

  intervals.sort((first, second) => first[0] - second[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }

  if (
    merged.length === 1 &&
    merged[0]?.[0] === -180 &&
    merged[0]?.[1] === 180
  ) {
    return [-180, south, 180, north];
  }

  let largestGap = -1;
  let west = merged[0]?.[0] ?? -180;
  let east = merged[merged.length - 1]?.[1] ?? 180;
  for (let index = 0; index < merged.length; index++) {
    const current = merged[index] as [number, number];
    const next =
      index === merged.length - 1
        ? (merged[0] as [number, number])[0] + 360
        : (merged[index + 1] as [number, number])[0];
    const gap = next - current[1];
    if (gap > largestGap) {
      largestGap = gap;
      west = normalizeLongitude(next);
      east = normalizeLongitude(current[1]);
    }
  }

  if (largestGap <= 0) return [-180, south, 180, north];
  return [west, south, east, north];
}

/** Axis-aligned overlap test with circular longitude handling. */
export function bboxIntersects(
  first: LngLatBbox,
  second: LngLatBbox
): boolean {
  if (first[3] < second[1] || first[1] > second[3]) return false;
  return longitudeIntervals(first).some((firstInterval) =>
    longitudeIntervals(second).some(
      (secondInterval) =>
        firstInterval[1] >= secondInterval[0] &&
        firstInterval[0] <= secondInterval[1]
    )
  );
}

/**
 * Circular bbox intersection, or null when disjoint. An intersection that
 * spans both sides of 180 is returned in encoded crossing form.
 */
export function bboxIntersection(
  first: LngLatBbox,
  second: LngLatBbox
): LngLatBbox | null {
  const south = Math.max(first[1], second[1]);
  const north = Math.min(first[3], second[3]);
  if (south > north) return null;

  const intersections: LngLatBbox[] = [];
  for (const firstInterval of longitudeIntervals(first)) {
    for (const secondInterval of longitudeIntervals(second)) {
      const west = Math.max(firstInterval[0], secondInterval[0]);
      const east = Math.min(firstInterval[1], secondInterval[1]);
      if (west <= east) intersections.push([west, south, east, north]);
    }
  }
  return unionBboxes(intersections);
}

/**
 * Selection envelopes for NIFC and similar services. The selection bbox is
 * used when present; otherwise a click halo is constructed. Crossings always
 * return exactly two non-crossing strings.
 */
export function selectionEnvelopes(
  bbox: LngLatBbox | undefined,
  lngLat: { readonly lng: number; readonly lat: number },
  haloDegrees = 0.5
): readonly string[] {
  const box =
    bbox ??
    ([
      lngLat.lng - haloDegrees,
      lngLat.lat - haloDegrees,
      lngLat.lng + haloDegrees,
      lngLat.lat + haloDegrees
    ] as const);
  return serviceBboxPieces(box).map((piece) =>
    piece.map((n) => Math.round(n * 10000) / 10000).join(',')
  );
}

/** ArcGIS `geometry` parameter values under the shared split contract. */
export function arcGisEnvelopeValues(bbox: LngLatBbox): readonly string[] {
  return serviceBboxPieces(bbox).map((piece) => piece.join(','));
}

/**
 * Legacy singular ArcGIS value for callers whose product behavior belongs to
 * a later slice. N2-A consumers use `arcGisEnvelopeValues`.
 */
export function arcGisEnvelopeValue(bbox: LngLatBbox): string {
  return bbox.join(',');
}

/** Merge split response rows by a stable identifier, preserving first order. */
export function mergeByStableIdentifier<T>(
  groups: ReadonlyArray<readonly T[]>,
  identifier: (row: T) => string | number | null | undefined
): T[] {
  const merged: T[] = [];
  const seen = new Set<string | number>();
  for (const group of groups) {
    for (const row of group) {
      const id = identifier(row);
      if (id !== null && id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      merged.push(row);
    }
  }
  return merged;
}

/**
 * Run one request per non-crossing service piece. A parent abort or any
 * sibling failure aborts the shared child signal for every request.
 */
export async function loadServiceEnvelopePieces<T>(
  bbox: LngLatBbox,
  parentSignal: AbortSignal,
  load: (
    piece: LngLatBbox,
    siblingSignal: AbortSignal,
    index: number
  ) => Promise<T>
): Promise<T[]> {
  const siblingController = new AbortController();
  const abortSiblings = (): void => siblingController.abort();
  if (parentSignal.aborted) abortSiblings();
  else parentSignal.addEventListener('abort', abortSiblings, { once: true });

  try {
    const requests = serviceBboxPieces(bbox).map((piece, index) =>
      load(piece, siblingController.signal, index)
    );
    return await Promise.all(requests);
  } catch (error) {
    abortSiblings();
    throw error;
  } finally {
    parentSignal.removeEventListener('abort', abortSiblings);
  }
}
