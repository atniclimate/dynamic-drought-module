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
 * The view-envelope rule shared by the live viewport-scoped layers (AIANNH,
 * BIA reservations, NIFC fires): how far past the view a layer queries, and
 * when a cached answer still covers the view.
 */

/** `[west, south, east, north]`, EPSG:4326. */
export type ViewEnvelope = readonly [number, number, number, number];

/** The part of MapLibre's `LngLatBounds` the rule reads. */
interface ViewBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

/**
 * Overscan margin, as a fraction of the view's width and height on each
 * side, so small pans render correctly at their edges and are more likely to
 * hit a layer's response cache.
 */
const OVERSCAN_FACTOR = 0.25;

/**
 * Inverse of the five-decimal precision the query URLs serialize envelope
 * coordinates at. The envelope is quantized OUTWARD to this grid (floor the
 * west/south edges, ceil the east/north edges) so the cached envelope and
 * the envelope actually sent to the service are the same numbers: a
 * coverage hit then proves the service was really asked for the whole
 * visible view, with no sliver between the raw and serialized edges (Codex
 * Unit B re-verify, finding 3 residual, 2026-07-15).
 */
const ENVELOPE_QUANTUM = 1e5;

/** The overscanned query envelope for a view. */
export function buildQueryEnvelope(view: ViewBounds): [number, number, number, number] {
  const west = view.getWest();
  const south = view.getSouth();
  const east = view.getEast();
  const north = view.getNorth();
  const marginX = (east - west) * OVERSCAN_FACTOR;
  const marginY = (north - south) * OVERSCAN_FACTOR;
  return [
    Math.floor((west - marginX) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM,
    Math.floor((south - marginY) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM,
    Math.ceil((east + marginX) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM,
    Math.ceil((north + marginY) * ENVELOPE_QUANTUM) / ENVELOPE_QUANTUM
  ];
}

/** Whether a cached coverage envelope fully contains the visible view. */
export function envelopeCovers(envelope: ViewEnvelope, view: ViewBounds): boolean {
  return (
    envelope[0] <= view.getWest() &&
    envelope[1] <= view.getSouth() &&
    envelope[2] >= view.getEast() &&
    envelope[3] >= view.getNorth()
  );
}

/**
 * `envelopeCovers` for a plain bbox (a place's or framing's request box)
 * rather than a live map's bounds. A `null` envelope is a layer's unscoped
 * national fallback and covers every bbox.
 */
export function bboxCoveredByEnvelope(
  envelope: ViewEnvelope | null,
  bbox: ViewEnvelope
): boolean {
  if (envelope === null) return true;
  return (
    envelope[0] <= bbox[0] &&
    envelope[1] <= bbox[1] &&
    envelope[2] >= bbox[2] &&
    envelope[3] >= bbox[3]
  );
}

/**
 * Shrink a query envelope inward by one grid quantum to form the COVERAGE
 * envelope stored with a cached response. The binary64 value `k / 1e5` can
 * sit a sub-ULP outside the exact decimal the URL carried, so comparing
 * against the query envelope itself left an equality-edge false-positive
 * path (Codex Unit B second re-verify, LOW, 2026-07-15). One quantum
 * (about one meter) of lost cache reuse is an acceptable false negative; a
 * passing coverage check now can never claim area outside the service
 * request.
 */
export function toCoverageEnvelope(envelope: ViewEnvelope): [number, number, number, number] {
  const q = 1 / ENVELOPE_QUANTUM;
  return [envelope[0] + q, envelope[1] + q, envelope[2] - q, envelope[3] - q];
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
