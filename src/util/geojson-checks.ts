/**
 * Structural checks on GeoJSON answers, each written once so a change to what
 * counts as valid reaches every reader of that shape together.
 *
 * Import-free (types only), so a layer chunk that uses it pulls in nothing
 * else. `src/config/wildfire-presentation.ts` keeps its own, stricter copy
 * (it also requires closed rings).
 */
import type { FeatureCollection, Position } from 'geojson';

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function isRing(value: unknown): value is Position[] {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isPolygonCoordinates(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isRing);
}

/**
 * A Polygon or MultiPolygon whose rings each hold at least four finite
 * positions; nothing else. Ring closure is not checked. Read by the NADM
 * verdict, the minimap's NADM polygons and the NWS alert reader.
 */
export function hasPolygonCoordinates(geometry: Record<string, unknown>): boolean {
  const coordinates = geometry['coordinates'];
  if (geometry['type'] === 'Polygon') return isPolygonCoordinates(coordinates);
  return (
    geometry['type'] === 'MultiPolygon' &&
    Array.isArray(coordinates) &&
    coordinates.length > 0 &&
    coordinates.every(isPolygonCoordinates)
  );
}

/**
 * Validate that a parsed ArcGIS `f=geojson` answer is a genuine GeoJSON
 * FeatureCollection and not an ArcGIS error body or other malformed shape.
 * Throws on failure so the caller's catch block reports `'error'`. `label`
 * names the source in the error (the two Tribal boundary layers).
 */
export function assertFeatureCollection(raw: unknown, label: string): FeatureCollection {
  if (raw && typeof raw === 'object' && 'error' in raw) {
    const err = (raw as { error?: { code?: number; message?: string } }).error;
    throw new Error(
      `ArcGIS error ${err?.code ?? '(unknown code)'}: ${err?.message ?? 'unknown error'}`
    );
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { type?: string }).type !== 'FeatureCollection' ||
    !Array.isArray((raw as { features?: unknown }).features)
  ) {
    throw new Error(`${label} response was not a GeoJSON FeatureCollection.`);
  }
  return raw as FeatureCollection;
}

/**
 * Whether the service flagged this response as truncated
 * (`exceededTransferLimit`, at the top level or in the collection's
 * `properties`, both of which ArcGIS uses). A truncated body renders (partial
 * data beats none) but reports `degraded` ("live (partial)") and is NEVER
 * admitted to the coverage-envelope cache: a cached envelope asserts "the
 * service answered this whole envelope", which a truncated response cannot
 * claim (R2-trio, the 2026-07-15 planning true-up, D-0.7.0-037).
 */
export function isTruncated(raw: unknown): boolean {
  const body = raw as {
    exceededTransferLimit?: unknown;
    properties?: { exceededTransferLimit?: unknown } | null;
  } | null;
  return Boolean(body?.exceededTransferLimit || body?.properties?.exceededTransferLimit);
}
