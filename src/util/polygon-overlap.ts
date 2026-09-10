/**
 * Areal overlap test for two GeoJSON Polygon or MultiPolygon geometries.
 *
 * The spatial predicate the place-conditions card needs (Codex adversarial
 * review 2026-09-10, finding 3). `src/ui/popup-conditions.ts` retrieves NWS
 * alert and NIFC perimeter candidates with the clicked boundary's screen-space
 * bounding BOX, because both of those layers outrank every boundary kind in
 * `src/config/interaction-ranks.ts` and a bare point query would make their
 * rows unreachable from a boundary popup at all. A rectangle is the right
 * RETRIEVAL shape and the wrong ATTRIBUTION shape: a concavity, a hole, or the
 * gap between two components of a MultiPolygon all admit another place's
 * warning into the rectangle, and the card then reported it as this place's.
 * This test is what turns the retrieved candidates back into the ones that
 * actually touch the place.
 *
 * Pure and dependency-free (no MapLibre), a deliberate sibling of
 * `src/util/point-in-polygon.ts`, whose even-odd `pointInPolygonGeometry` this
 * composes rather than reimplements. That keeps the hole semantics identical
 * across both tests and keeps this unit-testable in Node (the `verify:pure`
 * lane) without a browser or a map.
 *
 * Two areas overlap when any of three things is true, and all three are
 * needed: a vertex of one lies inside the other (the ordinary containment
 * case, in both directions because either may be the smaller), or an edge of
 * one crosses an edge of the other (the plus-sign case, where two rectangles
 * overlap with no vertex of either inside the other and the vertex tests alone
 * would answer false).
 *
 * Coordinates are WGS 84 `[lng, lat]`, and this is antimeridian-naive in the
 * same way and for the same reason `point-in-polygon.ts` and `geometryBbox` in
 * `src/impact/context.ts` are.
 *
 * COST. Bounding-box rejection runs first at whole-geometry level and again
 * per ring pair, so the common answers (clearly apart, clearly overlapping)
 * are cheap. The worst case, two ring pairs whose boxes overlap while the
 * rings themselves do not touch, is the product of their vertex counts. That
 * bound is acceptable HERE because every geometry this sees comes from
 * `queryRenderedFeatures`, which returns one tile-clipped slice per tile
 * (`GeoJSONFeature.geometry` in maplibre-gl reprojects `loadGeometry()` at the
 * feature's own z/x/y), so vertex counts are bounded by a tile rather than by
 * the size of a state. Do not reach for this on unclipped source geometry
 * without measuring it first.
 */

import type { Geometry, Position } from 'geojson';

import { pointInPolygonGeometry } from './point-in-polygon';

/** A closed ring plus the box that contains it, computed once per ring. */
interface BoxedRing {
  readonly ring: readonly Position[];
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** West, south, east, north. Infinities when there is nothing to bound. */
interface Box {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * Every ring of a Polygon or MultiPolygon, outer rings and holes alike, each
 * carrying its own box. Any other geometry type (Point, LineString,
 * GeometryCollection, null) yields nothing: those are not areal and cannot
 * overlap an area, which is the same rule `flattenLngLat` applies in
 * `popup-conditions.ts` before it builds a box at all.
 */
function boxedRings(geometry: Geometry | null | undefined): BoxedRing[] {
  if (!geometry) return [];
  const rings: Position[][] = [];
  if (geometry.type === 'Polygon') {
    rings.push(...geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) rings.push(...polygon);
  } else {
    return [];
  }

  const boxed: BoxedRing[] = [];
  for (const ring of rings) {
    if (ring.length < 2) continue;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const position of ring) {
      const lng = position[0];
      const lat = position[1];
      if (lng === undefined || lat === undefined) continue;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    if (![west, south, east, north].every(Number.isFinite)) continue;
    boxed.push({ ring, west, south, east, north });
  }
  return boxed;
}

/** The box containing every ring given, or null when there are none. */
function unionBox(rings: readonly BoxedRing[]): Box | null {
  if (rings.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const r of rings) {
    if (r.west < west) west = r.west;
    if (r.east > east) east = r.east;
    if (r.south < south) south = r.south;
    if (r.north > north) north = r.north;
  }
  return { west, south, east, north };
}

/** Whether two boxes share any area, edges and corners counting as shared. */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
}

/** Whether a point lies within a box, edges counting as within. */
function pointInBox(lng: number, lat: number, box: Box): boolean {
  return lng >= box.west && lng <= box.east && lat >= box.south && lat <= box.north;
}

/**
 * The sign of the cross product of `ab` and `ac`: positive when `c` is left of
 * the directed line `ab`, negative when right, zero when collinear. The
 * standard orientation predicate, in floating point, which is exact enough for
 * screen-derived tile coordinates and is only ever used here to decide whether
 * two segments straddle each other.
 */
function orientation(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): number {
  const value = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/** Whether collinear point `c` lies within the segment `ab`'s box. */
function collinearPointOnSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  return (
    cx >= Math.min(ax, bx) &&
    cx <= Math.max(ax, bx) &&
    cy >= Math.min(ay, by) &&
    cy <= Math.max(ay, by)
  );
}

/**
 * Whether segments `p1p2` and `p3p4` touch. The general case is the mutual
 * straddle (each segment separates the other's endpoints); the collinear cases
 * are handled explicitly so that a shared edge, which is exactly what two
 * boundaries digitised from the same source produce, counts as touching rather
 * than falling through the strict-inequality test.
 */
function segmentsIntersect(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  p4x: number,
  p4y: number
): boolean {
  const d1 = orientation(p3x, p3y, p4x, p4y, p1x, p1y);
  const d2 = orientation(p3x, p3y, p4x, p4y, p2x, p2y);
  const d3 = orientation(p1x, p1y, p2x, p2y, p3x, p3y);
  const d4 = orientation(p1x, p1y, p2x, p2y, p4x, p4y);

  if (d1 !== d2 && d3 !== d4) return true;

  if (d1 === 0 && collinearPointOnSegment(p3x, p3y, p4x, p4y, p1x, p1y)) return true;
  if (d2 === 0 && collinearPointOnSegment(p3x, p3y, p4x, p4y, p2x, p2y)) return true;
  if (d3 === 0 && collinearPointOnSegment(p1x, p1y, p2x, p2y, p3x, p3y)) return true;
  if (d4 === 0 && collinearPointOnSegment(p1x, p1y, p2x, p2y, p4x, p4y)) return true;

  return false;
}

/** Whether any edge of ring `a` touches any edge of ring `b`. */
function ringsCross(a: BoxedRing, b: BoxedRing): boolean {
  if (!boxesOverlap(a, b)) return false;
  const ra = a.ring;
  const rb = b.ring;
  for (let i = 0, j = ra.length - 1; i < ra.length; j = i++) {
    const a1 = ra[j];
    const a2 = ra[i];
    if (!a1 || !a2) continue;
    const a1x = a1[0];
    const a1y = a1[1];
    const a2x = a2[0];
    const a2y = a2[1];
    if (a1x === undefined || a1y === undefined || a2x === undefined || a2y === undefined) {
      continue;
    }
    // A per-EDGE box rejection as well as the per-ring one above: a long ring
    // whose box overlaps typically has only a handful of edges that could.
    const eWest = Math.min(a1x, a2x);
    const eEast = Math.max(a1x, a2x);
    const eSouth = Math.min(a1y, a2y);
    const eNorth = Math.max(a1y, a2y);
    if (eWest > b.east || eEast < b.west || eSouth > b.north || eNorth < b.south) continue;

    for (let m = 0, n = rb.length - 1; m < rb.length; n = m++) {
      const b1 = rb[n];
      const b2 = rb[m];
      if (!b1 || !b2) continue;
      const b1x = b1[0];
      const b1y = b1[1];
      const b2x = b2[0];
      const b2y = b2[1];
      if (b1x === undefined || b1y === undefined || b2x === undefined || b2y === undefined) {
        continue;
      }
      if (segmentsIntersect(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y)) return true;
    }
  }
  return false;
}

/**
 * Whether any vertex of `rings` lies inside `geometry`. The box is the caller's
 * union box for `geometry`, used to reject vertices before paying for a
 * ray cast against every ring.
 */
function anyVertexInside(
  rings: readonly BoxedRing[],
  box: Box,
  geometry: Geometry
): boolean {
  for (const r of rings) {
    if (!boxesOverlap(r, box)) continue;
    for (const position of r.ring) {
      const lng = position[0];
      const lat = position[1];
      if (lng === undefined || lat === undefined) continue;
      if (!pointInBox(lng, lat, box)) continue;
      if (pointInPolygonGeometry(lng, lat, geometry)) return true;
    }
  }
  return false;
}

/**
 * Whether two areal geometries share any ground.
 *
 * False whenever either side is missing or is not a Polygon or MultiPolygon,
 * which is the conservative answer: a card that cannot establish overlap must
 * not assert it. The caller decides what a false means (`popup-conditions.ts`
 * keeps its bare-point read in that case rather than dropping the row).
 */
export function geometriesOverlap(
  a: Geometry | null | undefined,
  b: Geometry | null | undefined
): boolean {
  if (!a || !b) return false;
  const ringsA = boxedRings(a);
  const ringsB = boxedRings(b);
  if (ringsA.length === 0 || ringsB.length === 0) return false;

  const boxA = unionBox(ringsA);
  const boxB = unionBox(ringsB);
  if (boxA === null || boxB === null) return false;
  if (!boxesOverlap(boxA, boxB)) return false;

  // Containment, both directions: either area may be the one wholly inside.
  if (anyVertexInside(ringsB, boxA, a)) return true;
  if (anyVertexInside(ringsA, boxB, b)) return true;

  // Crossing with no vertex of either inside the other: two rectangles laid in
  // a plus sign overlap while every corner of each is outside the other.
  for (const ra of ringsA) {
    for (const rb of ringsB) {
      if (ringsCross(ra, rb)) return true;
    }
  }
  return false;
}
