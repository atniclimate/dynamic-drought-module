/**
 * The ArcGIS feature-service rules the Place studio, the watershed reads and
 * the Tribal land area search share, each written once so a fix reaches every
 * reader together. Import-free (types only). The two Tribal boundary layers
 * keep the lenient, labelled check in src/util/geojson-checks.ts, which
 * renders a partial answer as degraded instead of refusing it.
 */
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

export type ArealGeometry = Polygon | MultiPolygon;

/** A complete GeoJSON FeatureCollection; an ArcGIS error body or a partial (exceededTransferLimit) answer throws. */
export function assertCompleteFeatureCollection(raw: unknown): FeatureCollection {
  if (raw && typeof raw === 'object' && 'error' in raw) {
    throw new Error('ArcGIS returned an error response.');
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { type?: unknown }).type !== 'FeatureCollection' ||
    !Array.isArray((raw as { features?: unknown }).features)
  ) {
    throw new Error('Expected a GeoJSON FeatureCollection.');
  }
  if ((raw as { exceededTransferLimit?: unknown }).exceededTransferLimit === true) {
    throw new Error('ArcGIS returned a partial FeatureCollection.');
  }
  return raw as FeatureCollection;
}

export function isArealGeometry(geometry: Geometry | null | undefined): geometry is ArealGeometry {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
}

/** Every feature's polygons as one geometry: a Polygon for one part, a MultiPolygon for more, null for none. */
export function mergeArealGeometry(features: readonly Feature[]): ArealGeometry | null {
  const polygons: MultiPolygon['coordinates'] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates);
    if (geometry?.type === 'MultiPolygon') polygons.push(...geometry.coordinates);
  }
  if (polygons.length === 0) return null;
  if (polygons.length === 1) {
    return { type: 'Polygon', coordinates: polygons[0] ?? [] };
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}

/** A value inside an ArcGIS `where` string literal: a single quote doubles (Rocky Boy's). */
export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
