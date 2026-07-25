/**
 * Antimeridian contract utilities (0.8.0 T-M0-4, the N4a substrate for N2).
 *
 * The module defines, tests, and documents how this codebase talks about
 * longitude wrapping BEFORE any behavior changes. Nothing in the shipped
 * application changes behavior on these functions yet; the N2 unit (widening
 * the Alaska frame across the Aleutians) is the first behavioral consumer.
 *
 * TWO bbox representations exist and must never be conflated:
 *
 * 1. The NAIVE min/max walk (`geometryBbox` in `src/impact/context.ts`): for
 *    an antimeridian-crossing geometry whose coordinates sit in [-180, 180],
 *    the walk smears into a near-world-spanning box (west near -180, east
 *    near +180, span > 180). The true longitudinal extent is NOT recoverable
 *    from that box alone; crossing-aware envelopes must be re-derived from
 *    the geometry (N2's work). `naiveBboxSuggestsAntimeridianCrossing` and
 *    `geometryLikelyCrossesAntimeridian` speak about this representation.
 * 2. The ENCODED crossing form (west numerically greater than east after
 *    normalization), the form service envelopes will use once N2 produces
 *    them. No shipped producer emits this form today.
 *    `bboxCrossesAntimeridian` and `splitBboxAtAntimeridian` speak about
 *    this representation; feeding them a naive walked box classifies it as
 *    non-crossing, which is correct for the representation and useless for
 *    recovering the true extent (see 1).
 *
 * Bbox order is MapLibre's `[west, south, east, north]` throughout.
 *
 * Validation policy (no caller exists yet, so failing loudly is free):
 * every bbox-taking function throws a RangeError on non-finite members,
 * south > north, |latitude| > 90, or |east - west| > 360. Scalar
 * `normalizeLongitude` stays total (NaN in, NaN out).
 *
 * N2 residual inventory (antimeridian-naive paths OUTSIDE the selection-bbox
 * scope of T-M0-4, recorded here so the census stays honest; N2 owns them):
 * the Region bounds to `regionToMapLibreBounds` to `fitBounds` path
 * (src/config/regions.ts, src/ui/sidebar.ts), the viewport-to-service
 * envelopes in src/layers/aiannh.ts, src/layers/bia-reservations.ts, and
 * src/layers/hydrography.ts, the ray-cast in src/util/point-in-polygon.ts
 * (its header documents the limitation), and the search FLAG-PROVENANCE
 * mismatch: src/ui/search-controller.ts unions EVERY returned feature's
 * box for its camera but builds the selection context (and therefore the
 * `bboxCrossesAntimeridian` evidence) from the PRIMARY feature's geometry
 * only, so separate features jointly straddling the antimeridian smear
 * the camera without setting the flag (pinned in
 * tests/antimeridian.spec.ts; a future flag consumer must not trust the
 * flag as evidence about the AGGREGATE subject until N2 resolves this).
 */

import type { Geometry, Position } from 'geojson';

/** A `[west, south, east, north]` bounding box in WGS 84. */
export type LngLatBbox = readonly [number, number, number, number];

/**
 * Normalize a longitude into [-180, 180], congruent modulo 360,
 * sign-preserving at the edges: 190 -> -170, -190 -> 170, 540 -> 180,
 * -540 -> -180, and both 180 and -180 pass through unchanged (the same
 * meridian keeps two representations; bbox classification canonicalizes
 * them where it matters). Non-finite input returns NaN.
 */
export function normalizeLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return NaN;
  const r = lng % 360;
  if (r > 180) return r - 360;
  if (r < -180) return r + 360;
  return r;
}

/** Shared bbox validation; see the module header for the policy. */
function assertValidBbox(bbox: LngLatBbox, caller: string): void {
  const [west, south, east, north] = bbox;
  for (const v of bbox) {
    if (!Number.isFinite(v)) {
      throw new RangeError(`${caller}: bbox members must be finite, got [${bbox.join(', ')}]`);
    }
  }
  if (south > north) {
    throw new RangeError(`${caller}: south ${south} exceeds north ${north}`);
  }
  if (Math.abs(south) > 90 || Math.abs(north) > 90) {
    throw new RangeError(`${caller}: latitude outside [-90, 90] in [${bbox.join(', ')}]`);
  }
  if (Math.abs(east - west) > 360) {
    throw new RangeError(`${caller}: longitude span exceeds one wrap in [${bbox.join(', ')}]`);
  }
}

/**
 * Canonical longitude for endpoint-equality checks only: -180 and 180 are
 * the same meridian, so equality must not depend on which sign a producer
 * chose. Never used to rewrite stored values.
 */
function canonicalMeridian(lng: number): number {
  return lng === -180 ? 180 : lng;
}

/**
 * Whether a bbox is in the ENCODED crossing form: normalized west strictly
 * greater than normalized east, with real longitudinal interior.
 *
 * Deliberate classifications (pinned in tests/antimeridian.spec.ts):
 * - A raw span of exactly 360 (for example `[-180, s, 180, n]`) is the
 *   full-world box: NOT crossing.
 * - Endpoints equal after normalization with any other raw span (for
 *   example `[180, s, -180, n]`) have zero longitudinal interior: NOT
 *   crossing.
 * - A NAIVE min/max walked box (west <= east) is never classified as
 *   crossing by this predicate; that representation's crossing question is
 *   `naiveBboxSuggestsAntimeridianCrossing`.
 */
export function bboxCrossesAntimeridian(bbox: LngLatBbox): boolean {
  assertValidBbox(bbox, 'bboxCrossesAntimeridian');
  const [west, , east] = bbox;
  if (east - west === 360) return false;
  const nw = canonicalMeridian(normalizeLongitude(west));
  const ne = canonicalMeridian(normalizeLongitude(east));
  if (nw === ne) return false;
  return nw > ne;
}

/**
 * Heuristic for NAIVE min/max walked boxes (`geometryBbox` output): a
 * longitude span strictly greater than 180 degrees suggests the walked
 * geometry crossed the antimeridian and smeared. Strictly greater is
 * deliberate: a hemisphere-wide (exactly 180 degree) box is legitimately
 * representable and is not flagged.
 *
 * ADMITTED RESIDUAL: a geometry that genuinely spans more than 180 degrees
 * of longitude without crossing would flag falsely. Prefer
 * `geometryLikelyCrossesAntimeridian` when the geometry is at hand; this
 * predicate exists for stored boxes whose geometry is gone.
 */
export function naiveBboxSuggestsAntimeridianCrossing(bbox: LngLatBbox): boolean {
  assertValidBbox(bbox, 'naiveBboxSuggestsAntimeridianCrossing');
  return bbox[2] - bbox[0] > 180;
}

/**
 * Antimeridian-crossing evidence read from a GeoJSON geometry itself:
 *
 * - any segment whose endpoints differ by more than 180 degrees of
 *   longitude (the RFC 7946 wrap signature for coordinates kept in
 *   [-180, 180]), OR
 * - a naive min/max longitude span greater than 180 degrees (catches
 *   multipart geometries whose lobes sit on either side with no
 *   connecting segment, for example the Aleutian island groups).
 *
 * ADMITTED RESIDUALS, stated plainly: this is evidence, not proof. A
 * geometry genuinely wider than 180 degrees of longitude flags falsely on
 * the span arm; a crossing encoded with coordinates already normalized
 * onto one side (longitudes beyond +-180) may not show the wrap
 * signature. Both are acceptable for T-M0-4 because NO consumer changes
 * behavior on the result yet; N2 must revisit the evidence quality when
 * behavior starts depending on it.
 *
 * `GeometryCollection` and empty geometries return false, matching
 * `geometryBbox` returning null for them.
 */
export function geometryLikelyCrossesAntimeridian(
  geometry: Geometry | undefined | null
): boolean {
  if (!geometry || geometry.type === 'GeometryCollection') return false;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let wrapSegment = false;

  const isPosition = (node: unknown): node is Position =>
    Array.isArray(node) && typeof node[0] === 'number' && typeof node[1] === 'number';

  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (isPosition(node)) {
      const lng = node[0] as number;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      return;
    }
    // An array of positions is a ring or line: check consecutive pairs for
    // the wrap signature while still visiting each position for min/max.
    if (node.length > 1 && isPosition(node[0])) {
      for (let i = 1; i < node.length; i++) {
        const prev = node[i - 1];
        const curr = node[i];
        if (isPosition(prev) && isPosition(curr)) {
          if (Math.abs((curr[0] as number) - (prev[0] as number)) > 180) {
            wrapSegment = true;
          }
        }
      }
    }
    for (const child of node) visit(child);
  };

  visit((geometry as { coordinates?: unknown }).coordinates);

  if (wrapSegment) return true;
  if (!Number.isFinite(minLng)) return false;
  return maxLng - minLng > 180;
}

/**
 * Split an ENCODED crossing bbox (see `bboxCrossesAntimeridian`) into its
 * two hemisphere halves: `[[west, s, 180, n], [-180, s, east, n]]`, both
 * longitude-normalized. Zero-width halves are possible at exact +-180
 * inputs and are returned, not dropped (no caller exists yet; callers
 * that cannot use a zero-width envelope filter at their boundary).
 *
 * Non-crossing boxes return a single box in one CANONICAL normalized
 * form:
 * - a full-world box (raw span exactly +360, whatever its endpoints,
 *   for example `[0, s, 360, n]`) returns `[-180, s, 180, n]`;
 * - endpoints on the same meridian after normalization (zero
 *   longitudinal interior, including the 180/-180 duality and raw span
 *   -360) return `[w, s, w, n]` on the normalized west;
 * - every other box returns its endpoints normalized.
 *
 * This function is NOT a repair path for naive walked boxes: a naive box
 * classifies as non-crossing and passes through in one piece. The true
 * extent of a crossing geometry is only recoverable from the geometry.
 */
export function splitBboxAtAntimeridian(
  bbox: LngLatBbox
): readonly [LngLatBbox] | readonly [LngLatBbox, LngLatBbox] {
  assertValidBbox(bbox, 'splitBboxAtAntimeridian');
  const [west, south, east, north] = bbox;
  if (east - west === 360) {
    // Full world, in canonical form (a pass-through could leak an
    // unnormalized endpoint, for example [0, s, 360, n]).
    return [[-180, south, 180, north] as const] as const;
  }
  const nw = normalizeLongitude(west);
  const ne = normalizeLongitude(east);
  if (canonicalMeridian(nw) === canonicalMeridian(ne)) {
    // Zero longitudinal interior: one canonical representation, so the
    // 180/-180 duality cannot yield a west-greater-than-east "normalized"
    // result.
    return [[nw, south, nw, north] as const] as const;
  }
  if (!bboxCrossesAntimeridian(bbox)) {
    return [[nw, south, ne, north] as const] as const;
  }
  return [
    [nw, south, 180, north] as const,
    [-180, south, ne, north] as const
  ] as const;
}
