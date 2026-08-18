/**
 * GeoJSON polygon to Esri `rings` conversion.
 *
 * ArcGIS REST spatial queries take polygon geometry as a `rings` array with
 * the OPPOSITE winding convention from GeoJSON: RFC 7946 exteriors are
 * counterclockwise with clockwise holes, while Esri exteriors are clockwise
 * with counterclockwise holes. This module walks EVERY ring of every polygon
 * (unlike the minimap's private single-outer-ring helper in
 * src/state/minimap-wildfire.ts, which predates it), fixes each ring's
 * winding individually by its own signed area so holes stay holes, and
 * rounds coordinates to a bounded precision so a dense coastline boundary
 * does not inflate the query payload.
 *
 * Pure and dependency-free so Node tests exercise it without a browser
 * (the same design goal as src/util/point-in-polygon.ts).
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';

/** Round to `precision` decimal places (4 decimals is roughly 11 m). */
function roundCoordinate(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Twice-signed shoelace area over an unclosed ring in x/y (lng/lat) order.
 * Positive means counterclockwise.
 */
function signedRingArea(ring: readonly (readonly number[])[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (!current || !next) continue;
    twiceArea += current[0]! * next[1]! - next[0]! * current[1]!;
  }
  return twiceArea / 2;
}

/**
 * One GeoJSON linear ring to one closed Esri ring: coordinates rounded,
 * winding fixed for its role (exterior clockwise, hole counterclockwise).
 * A ring that degenerates below three distinct positions is a malformed
 * boundary, not a queryable shape, so it throws (callers fail closed).
 */
function toEsriRing(
  ring: readonly Position[],
  precision: number,
  exterior: boolean
): number[][] {
  const rounded = ring.map((position) => [
    roundCoordinate(position[0], precision),
    roundCoordinate(position[1], precision)
  ]);
  const first = rounded[0];
  const last = rounded.at(-1);
  if (first && last && first[0] === last[0] && first[1] === last[1]) {
    rounded.pop();
  }
  const distinct = new Set(rounded.map(([x, y]) => `${x},${y}`));
  if (rounded.length < 3 || distinct.size < 3) {
    throw new Error(
      'esri-geometry: a boundary ring has fewer than three distinct positions.'
    );
  }
  const area = signedRingArea(rounded);
  // Esri exterior rings are clockwise (negative shoelace area in x/y);
  // holes are counterclockwise. A zero-area ring after rounding has no
  // recoverable orientation and is kept as-is.
  if (exterior ? area > 0 : area < 0) rounded.reverse();
  const close = rounded[0];
  if (!close) {
    throw new Error('esri-geometry: a boundary ring is empty.');
  }
  return [...rounded, [...close]];
}

/**
 * Convert a GeoJSON `Polygon` or `MultiPolygon` to an Esri `rings` array:
 * every ring of every polygon, each closed, each with its winding fixed for
 * its role, each coordinate rounded to `precision` decimals. Throws on a
 * geometry with no rings or a degenerate ring (callers fail closed rather
 * than querying a shape that does not represent the selection).
 */
export function geoJsonPolygonToEsriRings(
  geometry: Polygon | MultiPolygon,
  precision = 4
): number[][][] {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const rings: number[][][] = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      rings.push(toEsriRing(ring, precision, index === 0));
    });
  }
  if (rings.length === 0) {
    throw new Error('esri-geometry: the boundary geometry has no rings.');
  }
  return rings;
}
