/**
 * More granularity inside Tribal areas. The base map is mesoscale everywhere
 * (src/map/style.ts); inside Census-defined Tribal areas it carries more
 * (owner direction and decision 4, 2026-11-12): from zoom 12 four live reads
 * for the view, cut to the bounds of the American Indian, Alaska Native and
 * Native Hawaiian Areas that the Tribal Lands layer (src/layers/aiannh.ts)
 * already holds:
 *   - streets with their names (Census TIGERweb Local Roads), drawn only
 *     within the areas (MapLibre `within`, so a street crossing a boundary
 *     is left off);
 *   - named streams and lakes (USGS National Hydrography Dataset, large
 *     scale), drawn like the base map's water;
 *   - community names (Census Designated Places, at the Census internal
 *     point), drawn only within the areas.
 * Streams and lakes are drawn for the whole envelope, not only within the
 * areas: `within` keeps a line only when it lies wholly inside, so a river
 * crossing a boundary would vanish.
 *
 * Tribal boundaries, roads, water and place names are public data at T0
 * (CLAUDE.md). All are read live and the app keeps no copy: nothing here is
 * written to the repository. Tribal Lands starts and stops this module and
 * hands it the areas each time it applies data, so it runs exactly while that
 * layer is on. Each read fails on its own and leaves only its own detail off;
 * the mesoscale base map stays.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';

import { ROAD_CLASS_COLORS } from '../config/palette';
import { BASE_WATER_LABEL_COLOR, MAP_GROUND_COLOR, PLACE_LABEL_COLOR, PLACE_LABEL_HALO } from '../config/interface-tokens';
import { URLS } from '../config/urls';
import { BOTTOM_STACK_IDS, TOP_LABEL_IDS, firstLayerIdAbove } from '../map/layer-order';
import { fetchBufferedWithBudget } from '../util/fetch';
import { isTruncated } from '../util/geojson-checks';

/** Street zoom: a zoom 12 view of a Tribal town reads about 1,500 streets (360 KB, measured 2026-11-12). */
export const TRIBAL_STREETS_MIN_ZOOM = 12;
const FETCH_TIMEOUT_MS = 15_000;
/** A read is refused past this many decoded bytes rather than parsed. */
const MAX_DECODED_BYTES = 4_000_000;
const DEBOUNCE_MS = 400;
const RECORD_LIMIT = 4000;
const FONT = ['Noto Sans Regular'];

// The fields each read sends (scripts/check-upstream-drift.mjs probes each list by name).
const STREET_OUT_FIELDS = 'NAME,MTFCC';
// The NHD flowline layer names its fields in lower case, the waterbody layer in capitals.
const STREAM_OUT_FIELDS = 'gnis_name,lengthkm';
const WATERBODY_OUT_FIELDS = 'GNIS_NAME,AREASQKM';
const COMMUNITY_OUT_FIELDS = 'BASENAME,INTPTLAT,INTPTLON';

type Box = readonly [number, number, number, number];

interface DetailRead {
  readonly source: string;
  readonly url: () => string;
  readonly where: string;
  readonly outFields: string;
  /** Drawn only within the Tribal areas (`within`), or for the whole envelope. */
  readonly withinAreas: boolean;
  /** Census places come back without geometry (each becomes a point at its internal point). */
  readonly points?: true;
  /** Reshapes the answer before it is drawn. */
  readonly shape?: (data: FeatureCollection) => FeatureCollection;
  readonly layers: readonly maplibregl.LayerSpecification[];
}

const READS: readonly DetailRead[] = [
  {
    source: 'tribal-streets',
    url: () => `${URLS.tigerwebTransportation}/8/query`,
    where: '1=1',
    outFields: STREET_OUT_FIELDS,
    withinAreas: true,
    layers: [
      {
        id: 'tribal-streets-line',
        type: 'line',
        source: 'tribal-streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROAD_CLASS_COLORS[3], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 14, 1.4] }
      },
      {
        id: 'tribal-streets-label',
        type: 'symbol',
        source: 'tribal-streets',
        filter: ['has', 'NAME'],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'NAME'], 'text-font': FONT, 'text-size': 10.5, 'symbol-spacing': 500 },
        paint: { 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': PLACE_LABEL_HALO, 'text-halo-width': 1.2 }
      }
    ]
  },
  {
    source: 'tribal-waterbodies',
    url: () => `${URLS.usgsNhdMapServer}/12/query`,
    where: 'GNIS_NAME IS NOT NULL',
    outFields: WATERBODY_OUT_FIELDS,
    withinAreas: false,
    layers: [
      { id: 'tribal-waterbodies', type: 'fill', source: 'tribal-waterbodies', paint: { 'fill-color': MAP_GROUND_COLOR } },
      {
        id: 'tribal-waterbodies-label',
        type: 'symbol',
        source: 'tribal-waterbodies',
        // Ponds under 5 hectares keep their water but not a name.
        filter: ['>=', ['get', 'AREASQKM'], 0.05],
        layout: { 'text-field': ['get', 'GNIS_NAME'], 'text-font': FONT, 'text-size': 10.5, 'text-max-width': 7 },
        paint: { 'text-color': BASE_WATER_LABEL_COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
      }
    ]
  },
  {
    source: 'tribal-streams',
    url: () => `${URLS.usgsNhdMapServer}/6/query`,
    where: 'gnis_name IS NOT NULL',
    outFields: STREAM_OUT_FIELDS,
    withinAreas: false,
    shape: mergeStreams,
    layers: [
      {
        id: 'tribal-streams',
        type: 'line',
        source: 'tribal-streams',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': MAP_GROUND_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 14, 1.6] }
      },
      {
        id: 'tribal-streams-label',
        type: 'symbol',
        source: 'tribal-streams',
        // Joined streams under a kilometre (short drains and laterals) keep their line but not a name.
        filter: ['>=', ['get', 'km'], 1],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'gnis_name'], 'text-font': FONT, 'text-size': 10, 'symbol-spacing': 350 },
        paint: { 'text-color': BASE_WATER_LABEL_COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
      }
    ]
  },
  {
    source: 'tribal-communities',
    url: () => `${URLS.tigerwebPlaces}/5/query`,
    where: '1=1',
    outFields: COMMUNITY_OUT_FIELDS,
    withinAreas: true,
    points: true,
    shape: communityPoints,
    layers: [
      {
        id: 'tribal-communities-label',
        type: 'symbol',
        source: 'tribal-communities',
        layout: { 'text-field': ['get', 'BASENAME'], 'text-font': FONT, 'text-size': 11.5, 'text-max-width': 8 },
        paint: { 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': PLACE_LABEL_HALO, 'text-halo-width': 1.3 }
      }
    ]
  }
];

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

/**
 * NHD returns a named stream as many short reaches, too short to carry its name along the line. Join each
 * name's reaches end to end where they touch (rounded to about 1 m) into longer lines, each with its summed
 * length in km, so the label has room and a 1 km floor drops the short named ditches.
 */
export function mergeStreams(data: FeatureCollection): FeatureCollection {
  const byName = new Map<string, { coords: number[][]; km: number }[]>();
  for (const f of data.features) {
    const name = f.properties?.gnis_name;
    const g = f.geometry;
    if (typeof name !== 'string' || !g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    const km = Number(f.properties?.lengthkm) || 0;
    const list = byName.get(name) ?? [];
    for (const coords of parts) if (coords.length > 1) list.push({ coords: [...coords], km: km / parts.length });
    byName.set(name, list);
  }
  const key = (p: number[]): string => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const features: Feature[] = [];
  for (const [name, list] of byName) {
    const open = [...list];
    while (open.length) {
      const chain = open.pop()!;
      for (let joined = true; joined; ) {
        joined = false;
        for (let i = 0; i < open.length; i++) {
          const next = open[i].coords;
          const [head, tail] = [key(chain.coords[0]), key(chain.coords[chain.coords.length - 1])];
          const [nHead, nTail] = [key(next[0]), key(next[next.length - 1])];
          if (tail === nHead) chain.coords.push(...next.slice(1));
          else if (tail === nTail) chain.coords.push(...[...next].reverse().slice(1));
          else if (head === nTail) chain.coords.unshift(...next.slice(0, -1));
          else if (head === nHead) chain.coords.unshift(...[...next].reverse().slice(0, -1));
          else continue;
          chain.km += open[i].km;
          open.splice(i, 1);
          joined = true;
          break;
        }
      }
      features.push({ type: 'Feature', properties: { gnis_name: name, km: chain.km }, geometry: { type: 'LineString', coordinates: chain.coords } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Census places carry no geometry here: one point per place at its internal point, unparseable rows dropped. */
export function communityPoints(data: FeatureCollection): FeatureCollection {
  const features: Feature[] = [];
  for (const f of data.features) {
    const p = f.properties ?? {};
    const [lat, lon] = [Number(p.INTPTLAT), Number(p.INTPTLON)];
    if (!p.BASENAME || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    features.push({ type: 'Feature', properties: { BASENAME: p.BASENAME }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  }
  return { type: 'FeatureCollection', features };
}

function clear(map: maplibregl.Map): void {
  shownKey = '';
  for (const read of READS) (map.getSource(read.source) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
}

/** Before-id for a layer from its seat: the bottom stack (lines, fills) or the label list. */
function seatOf(map: maplibregl.Map, id: string): string | undefined {
  const bottom = BOTTOM_STACK_IDS.indexOf(id);
  if (bottom >= 0) return firstLayerIdAbove(map, BOTTOM_STACK_IDS.slice(0, bottom));
  return TOP_LABEL_IDS.slice(TOP_LABEL_IDS.indexOf(id) + 1).find((above) => map.getLayer(above));
}

function ensureLayers(map: maplibregl.Map, read: DetailRead): void {
  if (map.getSource(read.source)) return;
  map.addSource(read.source, { type: 'geojson', data: EMPTY });
  for (const layer of read.layers) map.addLayer(layer, seatOf(map, layer.id));
}

/** One read for the envelope; false when it failed (not when it was superseded). */
async function readOne(map: maplibregl.Map, read: DetailRead, envelope: Box, signal: AbortSignal): Promise<boolean> {
  const params = new URLSearchParams({
    where: read.where,
    geometry: envelope.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnGeometry: read.points ? 'false' : 'true',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: '0.00004',
    resultRecordCount: String(RECORD_LIMIT),
    f: 'geojson'
  });
  params.set('outFields', read.outFields);
  try {
    const res = await fetchBufferedWithBudget(`${read.url()}?${params}`, null, signal, FETCH_TIMEOUT_MS, MAX_DECODED_BYTES);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FeatureCollection;
    if (signal.aborted || activeMap !== map) return true;
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('not a FeatureCollection');
    if (isTruncated(data)) console.warn(`[tribal-detail] ${read.source} answer was cut at the service's record limit; drawing the part that came.`);
    ensureLayers(map, read);
    if (read.withinAreas) {
      const inside: FeatureCollection = { type: 'FeatureCollection', features: areas.map((a) => a.feature) };
      for (const layer of read.layers) {
        const own = 'filter' in layer && layer.filter ? [layer.filter] : [];
        map.setFilter(layer.id, ['all', ...own, ['within', inside]] as maplibregl.FilterSpecification);
      }
    }
    (map.getSource(read.source) as maplibregl.GeoJSONSource).setData(read.shape ? read.shape(data) : data);
    return true;
  } catch (err) {
    if (signal.aborted) return true;
    console.warn(`[tribal-detail] ${read.source} read failed; that detail stays off.`, err);
    (map.getSource(read.source) as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY);
    return false;
  }
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
  shownKey = key;
  const ok = await Promise.all(READS.map((read) => readOne(map, read, envelope, own.signal)));
  if (controller !== own) return;
  controller = null;
  // A failed read retries on the next move, even to the same view.
  if (ok.includes(false)) shownKey = '';
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refresh();
  }, DEBOUNCE_MS);
}

/** Start reading the detail for the view (Tribal Lands' activate). Idempotent. */
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

/** Abort the reads in flight without touching the map (Tribal Lands' cancelActivation). */
export function cancelTribalStreets(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
  shownKey = '';
}

/** Stop and remove every detail layer (Tribal Lands' deactivate). */
export function stopTribalStreets(map: maplibregl.Map): void {
  cancelTribalStreets();
  map.off('moveend', schedule);
  activeMap = null;
  areas = [];
  shownKey = '';
  for (const read of READS) {
    for (const layer of [...read.layers].reverse()) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    if (map.getSource(read.source)) map.removeSource(read.source);
  }
}
