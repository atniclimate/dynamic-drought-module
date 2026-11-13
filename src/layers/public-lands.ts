/**
 * Public Lands layer: public and protected lands from the USGS Protected Areas
 * Database of the United States (PAD-US 4.1, manager type), read live for the
 * view from zoom 10 and drawn minimally (owner, 2026-11-12: public and
 * protected lands "minimalistically, in a heavily zoomed in view"): a faint
 * tint by manager (federal, state, local and other), a thin outline, the
 * unit's name from zoom 12. American Indian lands (manager type TRIB) are left
 * out: the Tribal layers draw them from their own publishing services.
 *
 * Public data at T0, read live and never stored. A read is abortable and
 * superseded by the next view; a failed read leaves the layer empty and its
 * status unavailable until the next view answers.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import { MAP_GROUND_COLOR } from '../config/interface-tokens';
import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import { fetchBufferedWithBudget } from '../util/fetch';

const LAYER_KEY = 'public-lands';
const SOURCE_ID = 'public-lands';
const FILL_ID = 'public-lands-fill';
const LINE_ID = 'public-lands-line';
const LABEL_ID = 'public-lands-label';
/** Heavily zoomed in: a zoom 10 view of the Wenatchee country reads about 140 areas, 1.3 MB (measured 2026-11-12). */
export const PUBLIC_LANDS_MIN_ZOOM = 10;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_DECODED_BYTES = 8_000_000;
const DEBOUNCE_MS = 400;
// scripts/check-upstream-drift.mjs probes this list by name.
const PUBLIC_LANDS_OUT_FIELDS = 'Mang_Type,Unit_Nm';

/** Manager groups and their faint tints. */
const TINT: maplibregl.ExpressionSpecification = ['match', ['get', 'Mang_Type'],
  'FED', '#d6b56a',
  'STAT', '#7fb38a',
  '#9aa3ad'];

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_ID, LINE_ID, LABEL_ID] as const;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

let activeMap: maplibregl.Map | null = null;
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let shownKey = '';

function setData(map: maplibregl.Map, data: FeatureCollection): void {
  (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(data);
}

async function refresh(): Promise<void> {
  const map = activeMap;
  if (!map) return;
  if (map.getZoom() < PUBLIC_LANDS_MIN_ZOOM) {
    controller?.abort();
    shownKey = '';
    setData(map, EMPTY);
    registry.setStatus(LAYER_KEY, 'ready');
    return;
  }
  const b = map.getBounds();
  const envelope = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const key = envelope.map((v) => v.toFixed(3)).join(',');
  if (key === shownKey) return;
  controller?.abort();
  const own = new AbortController();
  controller = own;
  registry.setStatus(LAYER_KEY, 'loading');
  const params = new URLSearchParams({
    where: "Mang_Type <> 'TRIB'",
    geometry: envelope.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: '0.0002',
    outFields: PUBLIC_LANDS_OUT_FIELDS,
    f: 'geojson'
  });
  try {
    const res = await fetchBufferedWithBudget(`${URLS.padusManagerType}/query?${params}`, null, own.signal, FETCH_TIMEOUT_MS, MAX_DECODED_BYTES);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FeatureCollection;
    if (own.signal.aborted || activeMap !== map) return;
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('not a FeatureCollection');
    setData(map, data);
    shownKey = key;
    registry.setStatus(LAYER_KEY, 'ready');
  } catch (err) {
    if (own.signal.aborted) return;
    console.warn('[public-lands] PAD-US read failed; the layer stays empty for this view.', err);
    setData(map, EMPTY);
    registry.setStatus(LAYER_KEY, 'error');
  } finally {
    if (controller === own) controller = null;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refresh();
  }, DEBOUNCE_MS);
}

export async function activate(map: maplibregl.Map): Promise<void> {
  if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });
  if (!map.getLayer(FILL_ID)) {
    map.addLayer({ id: FILL_ID, type: 'fill', source: SOURCE_ID, paint: { 'fill-color': TINT, 'fill-opacity': 0.09 } });
  }
  if (!map.getLayer(LINE_ID)) {
    // The tint carries the manager from zoom 10; the edges strengthen toward zoom 13, where names appear.
    map.addLayer({ id: LINE_ID, type: 'line', source: SOURCE_ID, paint: { 'line-color': TINT, 'line-width': 0.8, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.15, 13, 0.5] } });
  }
  if (!map.getLayer(LABEL_ID)) {
    map.addLayer({
      id: LABEL_ID,
      type: 'symbol',
      source: SOURCE_ID,
      minzoom: 12,
      filter: ['has', 'Unit_Nm'],
      layout: { 'text-field': ['get', 'Unit_Nm'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-max-width': 8, 'text-padding': 24 },
      paint: { 'text-color': TINT, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
    });
  }
  if (activeMap !== map) {
    activeMap = map;
    map.on('moveend', schedule);
  }
  shownKey = '';
  await refresh();
}

export function deactivate(map: maplibregl.Map): void {
  if (timer) clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
  map.off('moveend', schedule);
  activeMap = null;
  shownKey = '';
  for (const id of [LABEL_ID, LINE_ID, FILL_ID]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
