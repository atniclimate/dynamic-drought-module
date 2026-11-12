/**
 * Street names inside Tribal areas. The base map is mesoscale everywhere
 * (src/map/style.ts); inside Census-defined Tribal areas it carries more
 * granularity (owner direction, 2026-11-12): from zoom 12 the Census TIGERweb
 * Local Roads layer is read live for the view and drawn, with street names,
 * only within the American Indian, Alaska Native and Native Hawaiian Areas
 * that the Tribal Lands layer (src/layers/aiannh.ts) already holds for the
 * view (MapLibre `within`).
 *
 * Tribal boundaries and roads are public data at T0 (CLAUDE.md). Both are
 * read live from the Census and never stored: nothing here is written to the
 * repository or to disk. Tribal Lands starts and stops this module and hands
 * it the areas each time it applies data, so it runs exactly while that
 * layer is on. A failed or cancelled read leaves the streets off; the
 * mesoscale base map stays.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';

import { ROAD_CLASS_COLORS } from '../config/palette';
import { PLACE_LABEL_COLOR, PLACE_LABEL_HALO } from '../config/interface-tokens';
import { URLS } from '../config/urls';
import { BOTTOM_STACK_IDS, TOP_LABEL_IDS, firstLayerIdAbove } from '../map/layer-order';
import { fetchBufferedWithBudget } from '../util/fetch';

const SOURCE_ID = 'tribal-streets';
const LINE_ID = 'tribal-streets-line';
const LABEL_ID = 'tribal-streets-label';
/** Street zoom: a zoom 12 view of a Tribal town reads about 1,500 streets (360 KB, measured 2026-11-12). */
export const TRIBAL_STREETS_MIN_ZOOM = 12;
const FETCH_TIMEOUT_MS = 15_000;
/** The read is refused past this many decoded bytes rather than parsed. */
const MAX_DECODED_BYTES = 4_000_000;
const DEBOUNCE_MS = 400;
const RECORD_LIMIT = 4000;

type Box = readonly [number, number, number, number];

let activeMap: maplibregl.Map | null = null;
let areas: { readonly feature: Feature; readonly box: Box }[] = [];
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let shownKey = '';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function boxOf(feature: Feature): Box {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    } else for (const child of c as unknown[]) visit(child);
  };
  const g = feature.geometry;
  if (g && 'coordinates' in g) visit(g.coordinates);
  return [w, s, e, n];
}

/** The query envelope: the view cut to the bounds of the Tribal areas it touches, or null. */
export function streetsEnvelope(view: Box, areaBoxes: readonly Box[]): Box | null {
  let w = 180, s = 90, e = -180, n = -90;
  for (const b of areaBoxes) {
    if (b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
    w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]);
  }
  if (w > e) return null;
  return [Math.max(w, view[0]), Math.max(s, view[1]), Math.min(e, view[2]), Math.min(n, view[3])];
}

function clear(map: maplibregl.Map): void {
  shownKey = '';
  (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
}

function ensureLayers(map: maplibregl.Map): void {
  if (map.getSource(SOURCE_ID)) return;
  map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROAD_CLASS_COLORS[3], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 14, 1.4] }
    },
    firstLayerIdAbove(map, BOTTOM_STACK_IDS.slice(0, BOTTOM_STACK_IDS.indexOf(LINE_ID)))
  );
  // Under the place names, in its TOP_LABEL_IDS seat (the read lands after the controller re-seated the labels).
  const labelBefore = TOP_LABEL_IDS.slice(TOP_LABEL_IDS.indexOf(LABEL_ID) + 1).find((id) => map.getLayer(id));
  map.addLayer({
    id: LABEL_ID,
    type: 'symbol',
    source: SOURCE_ID,
    filter: ['has', 'NAME'],
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'NAME'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'symbol-spacing': 300 },
    paint: { 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': PLACE_LABEL_HALO, 'text-halo-width': 1.2 }
  }, labelBefore);
}

async function refresh(): Promise<void> {
  const map = activeMap;
  if (!map) return;
  const b = map.getBounds();
  const envelope = map.getZoom() >= TRIBAL_STREETS_MIN_ZOOM
    ? streetsEnvelope([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], areas.map((a) => a.box))
    : null;
  if (!envelope) {
    controller?.abort();
    clear(map);
    return;
  }
  const key = envelope.map((v) => v.toFixed(3)).join(',');
  if (key === shownKey) return;
  controller?.abort();
  const own = new AbortController();
  controller = own;
  const params = new URLSearchParams({
    where: '1=1',
    geometry: envelope.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'NAME,MTFCC',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: '0.00004',
    resultRecordCount: String(RECORD_LIMIT),
    f: 'geojson'
  });
  try {
    const res = await fetchBufferedWithBudget(`${URLS.tigerwebTransportation}/8/query?${params}`, null, own.signal, FETCH_TIMEOUT_MS, MAX_DECODED_BYTES);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FeatureCollection;
    if (own.signal.aborted || activeMap !== map) return;
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('not a FeatureCollection');
    ensureLayers(map);
    const inside: FeatureCollection = { type: 'FeatureCollection', features: areas.map((a) => a.feature) };
    map.setFilter(LINE_ID, ['within', inside]);
    map.setFilter(LABEL_ID, ['all', ['has', 'NAME'], ['within', inside]]);
    (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource).setData(data);
    shownKey = key;
  } catch (err) {
    if (own.signal.aborted) return;
    console.warn('[tribal-streets] Census local roads read failed; the streets stay off.', err);
    clear(map);
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

/** Start reading streets for the view (Tribal Lands' activate). Idempotent. */
export function startTribalStreets(map: maplibregl.Map): void {
  if (activeMap === map) return;
  activeMap = map;
  map.on('moveend', schedule);
}

/** The Tribal areas Tribal Lands now holds; polygons only. */
export function setTribalStreetAreas(collection: FeatureCollection): void {
  areas = collection.features
    .filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
    .map((feature) => ({ feature, box: boxOf(feature) }));
  shownKey = '';
  schedule();
}

/** Abort a street read in flight without touching the map (Tribal Lands' cancelActivation). */
export function cancelTribalStreets(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
}

/** Stop and remove the streets (Tribal Lands' deactivate). */
export function stopTribalStreets(map: maplibregl.Map): void {
  cancelTribalStreets();
  map.off('moveend', schedule);
  activeMap = null;
  areas = [];
  shownKey = '';
  for (const id of [LABEL_ID, LINE_ID]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
