/**
 * Point-in-polygon test for GeoJSON Polygon and MultiPolygon geometries.
 *
 * Used by the location-identity stack (`src/state/location-identity.ts`) to
 * resolve which bundled state contains a clicked point when the state layer is
 * not the click target (a click while only a thematic surface is shown). Pure
 * and dependency-free (no MapLibre), so the geometry math is unit-testable in
 * Node without a browser.
 *
 * Even-odd (ray-casting) rule. A ray is cast east from the test point; each
 * ring edge it crosses toggles inside/outside. Toggling across ALL rings of a
 * polygon (outer plus holes) yields the correct even-odd result: a point inside
 * the outer ring but inside a hole toggles twice and reads as outside. For a
 * MultiPolygon the point is inside if it is inside any component polygon.
 *
 * Coordinates are WGS 84 `[lng, lat]`. This is antimeridian-naive (it does not
 * wrap longitudes across +/-180); the bundled Pacific Northwest and contiguous
 * framings do not cross it, matching the same limitation documented for
 * `geometryBbox` in `src/impact/context.ts`.
 */

import type { Geometry, Position } from 'geojson';

/** Ray-cast test for a single ring. */
function pointInRing(lng: number, lat: number, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const xi = pi[0];
    const yi = pi[1];
    const xj = pj[0];
    const yj = pj[1];
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;
    const straddles = yi > lat !== yj > lat;
    if (straddles && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Even-odd test across a polygon's rings (outer ring plus any holes). */
function pointInPolygon(lng: number, lat: number, rings: readonly Position[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(lng, lat, ring)) inside = !inside;
  }
  return inside;
}

/**
 * Whether `[lng, lat]` lies inside a Polygon or MultiPolygon geometry. Any
 * other geometry type (Point, LineString, GeometryCollection, null) returns
 * false: those are not areal boundaries and cannot contain a point.
 */
export function pointInPolygonGeometry(
  lng: number,
  lat: number,
  geometry: Geometry | null | undefined
): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygon(lng, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(lng, lat, polygon));
  }
  return false;
}
