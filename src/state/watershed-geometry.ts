import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  MultiPolygon,
  Polygon
} from 'geojson';

import type { PlaceCatalogEntry } from '../config/place-catalog';
import { URLS } from '../config/urls';
import { fetchJsonWithBudget } from '../util/fetch';

export type WatershedGeometry = Polygon | MultiPolygon;

export interface WatershedCandidateProperties extends Record<string, unknown> {
  readonly watershedLevel: 2 | 4;
  readonly watershedCode: string;
  readonly watershedLabel: string;
}

const WATERSHED_TIMEOUT_MS = 8_000;
const MAP_TILE_SIZE = 512;
const MIN_OFFSET_DEGREES = 0.0001;
const MAX_OFFSET_DEGREES = 0.05;

interface WatershedLayer {
  readonly level: 2 | 4;
  readonly layer: 1 | 2;
  readonly codeField: 'huc2' | 'huc4';
}

const WATERSHED_LAYERS: readonly WatershedLayer[] = [
  { level: 2, layer: 1, codeField: 'huc2' },
  { level: 4, layer: 2, codeField: 'huc4' }
];

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

function isArealGeometry(
  geometry: Geometry | null | undefined
): geometry is WatershedGeometry {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
}

function assertFeatureCollection(raw: unknown): FeatureCollection {
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

function propertyText(
  properties: GeoJsonProperties,
  field: string
): string | null {
  if (!properties) return null;
  const matchingKey = Object.keys(properties).find(
    (key) => key.toLocaleLowerCase() === field.toLocaleLowerCase()
  );
  if (!matchingKey) return null;
  const value = properties[matchingKey];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function layerForEntry(entry: PlaceCatalogEntry): WatershedLayer {
  if (entry.kind !== 'watershed') {
    throw new Error('Watershed geometry requires a watershed catalog entry.');
  }
  const level = entry.detail === 'HUC2' ? 2 : entry.detail === 'HUC4' ? 4 : null;
  const layer = WATERSHED_LAYERS.find((candidate) => candidate.level === level);
  if (!layer || !new RegExp(`^\\d{${layer.level}}$`).test(entry.id)) {
    throw new Error('Watershed catalog entry has an invalid HUC level or code.');
  }
  return layer;
}

/**
 * Generalize to approximately one 512-tile world pixel at the current zoom.
 * The clamps keep national views bounded and high zooms from becoming an
 * accidental full-resolution request.
 */
export function watershedMaxAllowableOffset(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? Math.max(0, zoom) : 0;
  const worldPixelDegrees = 360 / (MAP_TILE_SIZE * 2 ** safeZoom);
  const clamped = Math.min(
    MAX_OFFSET_DEGREES,
    Math.max(MIN_OFFSET_DEGREES, worldPixelDegrees)
  );
  return Number(clamped.toFixed(6));
}

function geometryParams(zoom: number, outFields: string): URLSearchParams {
  return new URLSearchParams({
    outFields,
    returnGeometry: 'true',
    returnZ: 'false',
    returnM: 'false',
    outSR: '4326',
    maxAllowableOffset: String(watershedMaxAllowableOffset(zoom)),
    geometryPrecision: '6',
    resultRecordCount: '2000',
    f: 'geojson'
  });
}

async function queryLayer(
  layer: WatershedLayer,
  params: URLSearchParams,
  signal: AbortSignal
): Promise<FeatureCollection> {
  abortIfNeeded(signal);
  const raw = await fetchJsonWithBudget(
    `${URLS.wbdMapServer}/${layer.layer}/query?${params.toString()}`,
    { cache: 'no-store' },
    signal,
    WATERSHED_TIMEOUT_MS
  );
  abortIfNeeded(signal);
  return assertFeatureCollection(raw);
}

/** Fetch one selected HUC2 or HUC4 boundary by its catalog code. */
export async function loadWatershedSelectionGeometry(
  entry: PlaceCatalogEntry,
  zoom: number,
  signal: AbortSignal
): Promise<Feature<WatershedGeometry, GeoJsonProperties> | null> {
  const layer = layerForEntry(entry);
  const params = geometryParams(
    zoom,
    `${layer.codeField},name,areasqkm,states`
  );
  params.set('where', `${layer.codeField}='${entry.id}'`);
  params.set('resultRecordCount', '1');
  const collection = await queryLayer(layer, params, signal);
  const feature = collection.features.find((candidate) => {
    const code = propertyText(candidate.properties, layer.codeField);
    return code?.padStart(layer.level, '0') === entry.id && isArealGeometry(candidate.geometry);
  });
  if (!feature || !isArealGeometry(feature.geometry)) return null;
  return {
    type: 'Feature',
    id: feature.id,
    properties: feature.properties,
    geometry: feature.geometry
  };
}

/**
 * Fetch generalized HUC2 and HUC4 overlap candidates for one selected bbox.
 * Both requests are spatially bounded even though these tiers fit one page.
 */
export async function loadWatershedCandidates(
  bbox: readonly [number, number, number, number],
  zoom: number,
  signal: AbortSignal
): Promise<
  FeatureCollection<WatershedGeometry, WatershedCandidateProperties>
> {
  const collections = await Promise.all(
    WATERSHED_LAYERS.map(async (layer) => {
      const params = geometryParams(
        zoom,
        `${layer.codeField},name,areasqkm,states`
      );
      params.set('where', '1=1');
      params.set('geometry', bbox.join(','));
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
      return { layer, collection: await queryLayer(layer, params, signal) };
    })
  );
  abortIfNeeded(signal);

  const features: Array<
    Feature<WatershedGeometry, WatershedCandidateProperties>
  > = [];
  for (const { layer, collection } of collections) {
    for (const feature of collection.features) {
      if (!isArealGeometry(feature.geometry)) continue;
      const rawCode = propertyText(feature.properties, layer.codeField);
      const name = propertyText(feature.properties, 'name');
      if (!rawCode || !name) continue;
      const code = rawCode.padStart(layer.level, '0');
      if (!new RegExp(`^\\d{${layer.level}}$`).test(code)) continue;
      features.push({
        type: 'Feature',
        id: `watershed:${layer.level}:${code}`,
        properties: {
          ...(feature.properties ?? {}),
          watershedLevel: layer.level,
          watershedCode: code,
          watershedLabel: `${name} (HUC ${code})`
        },
        geometry: feature.geometry
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
