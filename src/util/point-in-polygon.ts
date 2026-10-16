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

import type { LngLatBbox } from './antimeridian';
import { bboxCenter } from './bbox';

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

const SCAN_LINES = 9;

/**
 * A point inside the geometry to read point sources at when there is no click:
 * the box centre when it is inside, otherwise the middle of the widest inside
 * stretch along a few horizontal lines across each part, else the box centre.
 * shortcut: antimeridian-naive like pointInPolygonGeometry; a crossing
 * shape whose centre misses falls back to the box centre.
 */
export function representativePoint(
  geometry: Geometry | null | undefined,
  bbox: LngLatBbox
): { lng: number; lat: number } {
  const centre = bboxCenter(bbox);
  if (pointInPolygonGeometry(centre.lng, centre.lat, geometry)) return centre;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  let best = centre;
  let widest = 0;
  for (const rings of polygons) {
    // Lines across each part's own latitude span, so small scattered parts are not missed.
    const outer = rings[0] ?? [];
    const south = outer.reduce((min, p) => Math.min(min, p[1] ?? min), Infinity);
    const north = outer.reduce((max, p) => Math.max(max, p[1] ?? max), -Infinity);
    for (let line = 1; line <= SCAN_LINES; line += 1) {
      const lat = south + ((north - south) * line) / (SCAN_LINES + 1);
      // Even-odd crossings of this polygon's rings; consecutive pairs bound inside stretches.
      const xs: number[] = [];
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i] ?? [];
          const [xj, yj] = ring[j] ?? [];
          if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;
          if (yi > lat !== yj > lat) xs.push(xi + ((xj - xi) * (lat - yi)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const west = xs[k] ?? 0;
        const east = xs[k + 1] ?? 0;
        if (east - west > widest) {
          widest = east - west;
          best = { lng: (west + east) / 2, lat };
        }
      }
    }
  }
  return best;
}
