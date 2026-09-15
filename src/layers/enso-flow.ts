/**
 * Opt-in ENSO model context. Samples actual source grid cells; it does not
 * invent trajectories between cells or blend the field into the SST colors.
 * One user action fetches at most 40 locations, with a complete-body 12 s
 * budget. Panning never fetches. Cached frames live for ten minutes.
 */
import type * as maplibregl from 'maplibre-gl';
import { OPEN_METEO_MARINE_URL, OPEN_METEO_WEATHER_URL } from '../config/enso-flow-urls';
import { reassertThematicOrder } from '../map/layer-order';
import {
  parseEnsoFlowParams, syncEnsoFlowParams,
  type EnsoFlowKind, type EnsoFlowPreference
} from '../state/enso-flow';
import { fetchJsonWithBudget } from '../util/fetch';
import { FLOW_VARIABLES, normalizeFlowLongitude, parseFlowFrame, type ActiveFlowKind, type FlowFrame } from './enso-flow-data';
import '../ui/enso-flow.css';

const SOURCE = 'enso-flow';
const CASING = 'enso-flow-casing';
const ARROWS = 'enso-flow-arrows';
const CACHE_MS = 10 * 60 * 1000;
const LABELS: Record<EnsoFlowKind, string> = {
  off: 'Off', currents: 'Ocean currents', wind: 'Atmospheric currents', waves: 'Ocean waves'
};
const MODELS: Record<ActiveFlowKind, string> = {
  currents: 'meteofrance_currents', wind: 'gfs_global', waves: 'ncep_gfswave025'
};
const SOURCES: Record<ActiveFlowKind, string> = {
  currents: 'Météo-France / Copernicus SMOC, about 8 km; hourly model output, updated daily',
  wind: 'NOAA GFS, 10 m winds; global model output, updated every six hours',
  waves: 'NOAA GFS Wave, 0.25°; hourly model output, updated every six hours'
};
const cache = new Map<string, { stored: number; frame: FlowFrame }>();
let map: maplibregl.Map | null = null;
let controller: AbortController | null = null;
let observer: MutationObserver | null = null;
let host: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let statusNode: HTMLElement | null = null;
let detailNode: HTMLElement | null = null;
let sourceNode: HTMLElement | null = null;
let updateButton: HTMLButtonElement | null = null;
let desktopSeat: Comment | null = null;
let mobileQuery: MediaQueryList | null = null;
let frame: FlowFrame | null = null;
let preference: EnsoFlowPreference = { kind: 'off', ink: 'light' };
let epoch = 0;

function removeArrows(): void {
  if (!map) return;
  for (const id of [ARROWS, CASING]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

function setStatus(status: string, text: string): void {
  if (panel) panel.dataset['status'] = status;
  if (statusNode) statusNode.textContent = text;
}

function dateLabel(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(time);
}

/** Arrow geometry is screen-sized at the settled camera, anchored on the
 * returned source cell, with a geographic direction. No speed is animated. */
function arrowData(activeMap: maplibregl.Map, data: FlowFrame): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const point of data.points) {
    if (Math.abs(point.latitude) > 84 || point.value === 0) continue;
    const anchor = activeMap.project([point.longitude, point.latitude]);
    const angle = (point.bearing - activeMap.getBearing()) * Math.PI / 180;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const coordinate = (along: number, across: number): number[] => {
      const position = activeMap.unproject([anchor.x + dx * along - dy * across, anchor.y + dy * along + dx * across]);
      return [position.lng, position.lat];
    };
    features.push({
      type: 'Feature', properties: { value: point.value, bearing: point.bearing },
      geometry: { type: 'MultiLineString', coordinates: [
        [coordinate(-10, 0), coordinate(10, 0)],
        [coordinate(3, -5), coordinate(10, 0), coordinate(3, 5)]
      ] }
    });
  }
  return { type: 'FeatureCollection', features };
}

function paintArrows(): void {
  if (!map || !frame || preference.kind === 'off') return;
  const data = arrowData(map, frame);
  const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(SOURCE, {
    type: 'geojson', data,
    attribution: preference.kind === 'currents'
      ? '<a href="https://open-meteo.com/">Open-Meteo</a> · Météo-France / Copernicus · CC BY 4.0'
      : '<a href="https://open-meteo.com/">Open-Meteo</a> · NOAA GFS · CC BY 4.0'
  });
  const light = preference.ink === 'light';
  for (const [id, width, color] of [
    [CASING, 4.5, light ? '#142137' : '#f8fafc'],
    [ARROWS, 2, light ? '#f8fafc' : '#142137']
  ] as const) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', color);
    else map.addLayer({ id, type: 'line', source: SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-opacity': 0.92 }
    });
  }
  reassertThematicOrder(map);
}

/** Fixed public sampling locations from the viewport, never selected-place
 * coordinates. Rounded to hundredths and deduplicated across world copies. */
function samplePositions(activeMap: maplibregl.Map): readonly [number, number][] {
  const canvas = activeMap.getCanvas();
  const positions = new Map<string, [number, number]>();
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const p = activeMap.unproject([canvas.clientWidth * (column + 0.5) / 8, canvas.clientHeight * (row + 0.5) / 5]);
      const latitude = Number(Math.max(-80, Math.min(84, p.lat)).toFixed(2));
      const longitude = Number(normalizeFlowLongitude(p.lng).toFixed(2));
      positions.set(`${longitude},${latitude}`, [longitude, latitude]);
    }
  }
  return [...positions.values()];
}

function requestUrl(kind: ActiveFlowKind, positions: readonly (readonly [number, number])[]): string {
  const params = new URLSearchParams({
    latitude: positions.map((p) => p[1]).join(','), longitude: positions.map((p) => p[0]).join(','),
    current: FLOW_VARIABLES[kind].join(','), models: MODELS[kind], cell_selection: 'nearest',
    timeformat: 'unixtime', wind_speed_unit: 'ms'
  });
  return `${kind === 'wind' ? OPEN_METEO_WEATHER_URL : OPEN_METEO_MARINE_URL}?${params}`;
}

function presentFrame(data: FlowFrame, kind: ActiveFlowKind): void {
  frame = data;
  paintArrows();
  const status = data.points.length === 0 ? 'no data' : data.missing > 0 ? 'live (partial)' : 'live';
  setStatus(status, `${status} · Model valid ${dateLabel(data.time)}`);
  if (detailNode) {
    const values = data.points.map((p) => p.value);
    const range = values.length ? `${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)} ${kind === 'waves' ? 'm significant wave height' : 'm/s'}. ` : '';
    detailNode.textContent = `${data.points.length} of ${data.total} sampled cells have data. ${range}` +
      'Arrows show travel direction only, with equal lengths; still water or calm wind has no arrow. Missing cells have no arrow and do not imply calm conditions. Move the map and choose Update area for new samples.';
  }
}

async function loadArea(): Promise<void> {
  controller?.abort();
  controller = null;
  const generation = ++epoch;
  frame = null;
  removeArrows();
  const activeMap = map;
  const kind = preference.kind;
  if (!activeMap || kind === 'off') {
    setStatus('off', 'Direction overlay off');
    return;
  }
  const positions = samplePositions(activeMap);
  const url = requestUrl(kind, positions);
  const cached = cache.get(url);
  if (sourceNode) sourceNode.textContent = `${SOURCES[kind]}, via Open-Meteo. The API supplies 15-minute valid instants by interpolating model output. This is model context, independently timed from the observed SST map. The response does not supply the model issue time. It is unsuitable for coastal navigation.`;
  if (cached && Date.now() - cached.stored < CACHE_MS) { presentFrame(cached.frame, kind); return; }
  const owned = new AbortController();
  controller = owned;
  setStatus('loading', 'loading · Model direction samples');
  if (detailNode) detailNode.textContent = 'Loading up to 40 source grid cells for this area.';
  try {
    const json = await fetchJsonWithBudget(url, { credentials: 'omit' }, owned.signal, 12_000);
    if (owned.signal.aborted || generation !== epoch || map !== activeMap) return;
    const result = parseFlowFrame(json, kind, positions.length);
    // Reject an implausible timestamp; a valid model time is not the browser
    // retrieval time, nor permission to silently display a stale field.
    if (Math.abs(Date.now() - result.time) > 48 * 60 * 60 * 1000) throw new Error('No recent model time.');
    cache.set(url, { stored: Date.now(), frame: result });
    while (cache.size > 6) cache.delete(cache.keys().next().value!);
    presentFrame(result, kind);
  } catch {
    if (owned.signal.aborted || generation !== epoch) return;
    setStatus('unavailable', 'unavailable · Direction samples did not load');
    if (detailNode) detailNode.textContent = 'Choose Update area to try again. No direction or calm condition is inferred from a failed request.';
  }
}

function updateSelection(): void {
  for (const button of panel?.querySelectorAll<HTMLButtonElement>('[data-flow-kind]') ?? []) {
    button.setAttribute('aria-pressed', String(button.dataset['flowKind'] === preference.kind));
  }
  if (updateButton) updateButton.disabled = preference.kind === 'off';
  const details = panel?.querySelector('details');
  if (details) details.hidden = preference.kind === 'off';
}

/** Keep one set of controls and listeners as the shell changes its seat. */
function seatControls(): void {
  if (!host || !desktopSeat?.parentNode) return;
  const mobileSeat = document.getElementById('sheet-enso-flow-host');
  if (mobileQuery?.matches && mobileSeat) mobileSeat.append(host);
  else desktopSeat.after(host);
}

function mountControls(): boolean {
  host = document.getElementById('enso-flow-controls');
  if (!host || !map) return false;
  host.hidden = false;
  desktopSeat = document.createComment('ENSO desktop controls seat');
  host.before(desktopSeat);
  mobileQuery = window.matchMedia('(max-width: 720px)');
  mobileQuery.addEventListener('change', seatControls);
  seatControls();
  panel = document.createElement('section');
  panel.className = 'enso-flow';
  panel.setAttribute('aria-label', 'Ocean and atmospheric direction overlays');
  const heading = document.createElement('h3');
  heading.textContent = 'Ocean & atmosphere';
  const options = document.createElement('div');
  options.className = 'enso-flow-options';
  for (const kind of ['off', 'currents', 'wind', 'waves'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = LABELS[kind];
    button.dataset['flowKind'] = kind;
    button.addEventListener('click', () => {
      preference = { ...preference, kind };
      syncEnsoFlowParams(preference);
      updateSelection();
      void loadArea();
    });
    options.append(button);
  }
  const toolbar = document.createElement('div');
  toolbar.className = 'enso-flow-toolbar';
  const label = document.createElement('label');
  label.textContent = 'Arrow color';
  const ink = document.createElement('select');
  ink.setAttribute('aria-label', 'Direction arrow color');
  for (const value of ['light', 'dark'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'light' ? 'White' : 'Dark';
    ink.append(option);
  }
  ink.value = preference.ink;
  ink.addEventListener('change', () => {
    preference = { ...preference, ink: ink.value === 'dark' ? 'dark' : 'light' };
    syncEnsoFlowParams(preference);
    paintArrows();
  });
  label.append(ink);
  updateButton = document.createElement('button');
  updateButton.type = 'button';
  updateButton.textContent = 'Update area';
  updateButton.addEventListener('click', () => { void loadArea(); });
  toolbar.append(label, updateButton);
  statusNode = document.createElement('p');
  statusNode.className = 'enso-flow-status';
  statusNode.setAttribute('role', 'status');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Key & source';
  detailNode = document.createElement('p');
  sourceNode = document.createElement('p');
  const credit = document.createElement('a');
  credit.href = 'https://open-meteo.com/en/docs/marine-weather-api';
  credit.target = '_blank';
  credit.rel = 'noopener noreferrer';
  credit.textContent = 'Open-Meteo · CC BY 4.0';
  details.append(summary, detailNode, sourceNode, credit);
  panel.append(heading, options, toolbar, statusNode, details);
  host.replaceChildren(panel);
  updateSelection();
  void loadArea();
  return true;
}

function onMoveEnd(): void {
  paintArrows();
  if (frame && statusNode) {
    const status = frame.points.length === 0 ? 'no data' : frame.missing ? 'live (partial)' : 'live';
    statusNode.textContent = `${status} · Model valid ${dateLabel(frame.time)} · Update area to resample`;
  }
}

function onPopState(): void {
  preference = parseEnsoFlowParams(new URLSearchParams(window.location.search));
  updateSelection();
  const ink = panel?.querySelector('select');
  if (ink) ink.value = preference.ink;
  void loadArea();
}

export function activateEnsoFlow(activeMap: maplibregl.Map): void {
  deactivateEnsoFlow();
  map = activeMap;
  preference = parseEnsoFlowParams(new URLSearchParams(window.location.search));
  map.on('moveend', onMoveEnd);
  window.addEventListener('popstate', onPopState);
  if (!mountControls()) {
    observer = new MutationObserver(() => {
      if (mountControls()) { observer?.disconnect(); observer = null; }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

/** Abort immediately when layer intent changes; serialized teardown follows. */
export function cancelEnsoFlowLoad(): void {
  epoch += 1;
  controller?.abort();
  controller = null;
  observer?.disconnect();
  observer = null;
}

export function deactivateEnsoFlow(): void {
  cancelEnsoFlowLoad();
  map?.off('moveend', onMoveEnd);
  window.removeEventListener('popstate', onPopState);
  removeArrows();
  map = null;
  frame = null;
  if (host) { host.replaceChildren(); host.hidden = true; }
  mobileQuery?.removeEventListener('change', seatControls);
  mobileQuery = null;
  if (host && desktopSeat?.parentNode) desktopSeat.after(host);
  desktopSeat?.remove();
  desktopSeat = null;
  host = null;
  panel = statusNode = detailNode = sourceNode = updateButton = null;
}
