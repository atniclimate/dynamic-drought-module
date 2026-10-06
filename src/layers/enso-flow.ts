/**
 * Opt-in ENSO model context (ENSO-FLOW-PLAN E2-1; C-fit.md 1.2).
 *
 * - Wind and waves draw NOAA GFS 10 m wind and GFS-Wave peak direction as
 *   flowing paths (or their still form), read at runtime from NOAA's public
 *   NODD bucket by the lazy flow chunk (src/layers/flow/index.ts), which
 *   this module reaches through one dynamic import() and nothing else. A
 *   decoded frame is kept on the CPU for ten minutes, keyed by kind, grid,
 *   cycle and forecast hour, so an SST re-activate reads nothing again.
 *   Past cycle + 24 h a frame is never drawn. Panning never fetches.
 * - Ocean currents keep the interim Open-Meteo sample: at most 40 fixed grid
 *   cells per user action, a complete-body 12 s budget, static arrows, and
 *   the DR-161 credits (owner question 4).
 */
import type * as maplibregl from 'maplibre-gl';
import { OPEN_METEO_MARINE_URL } from '../config/enso-flow-urls';
import { reassertThematicOrder } from '../map/layer-order';
import {
  parseEnsoFlowParams, syncEnsoFlowParams,
  type EnsoFlowKind, type EnsoFlowPreference
} from '../state/enso-flow';
import { fetchJsonWithBudget } from '../util/fetch';
import {
  FLOW_VARIABLES, FLOW_WORDS, dateLabel, flowFormNote, flowLiveLine, flowStaleLine, normalizeFlowLongitude, parseFlowFrame,
  type ActiveFlowKind, type FlowFieldKind, type FlowFrame
} from './enso-flow-data';
import type { FlowField, FlowView, FlowViewState } from './flow/index';
import '../ui/enso-flow.css';

const SOURCE = 'enso-flow';
const CASING = 'enso-flow-casing';
const ARROWS = 'enso-flow-arrows';
const CACHE_MS = 10 * 60 * 1000;
/** Decoded frames kept at once (a wave frame is about 1.3 MB on the CPU). */
const FIELD_CACHE_SIZE = 4;
const LABELS: Record<EnsoFlowKind, string> = {
  off: 'Off', currents: 'Ocean currents', wind: 'Atmospheric currents', waves: 'Ocean waves'
};
const SOURCES: Record<ActiveFlowKind, string> = {
  // ledger: copernicus-marine-smoc (cite sheet c23; DR-161): the producer
  // is Mercator Ocean International, per the product's STAC record.
  currents: 'Copernicus Marine SMOC (Mercator Ocean International), about 8 km; hourly model output, updated daily',
  wind: 'NOAA GFS, 10 m winds; global model output, updated every six hours',
  waves: 'NOAA GFS Wave, 0.25°; hourly model output, updated every six hours'
};
/** Sentences the panel and the map key's drawer row share, one source each. */
const CALM_NOTE = 'Arrows show travel direction only, with equal lengths; still water or calm wind has no arrow. Missing cells have no arrow and do not imply calm conditions.';
const TIMING_NOTE = 'This is model context, independently timed from the observed SST map.';
const LOADING_NOTE = 'Loading up to 40 source grid cells for this area.';
const FAILED_NOTE = 'No direction or calm condition is inferred from a failed request.';
const NAVIGATION_NOTE = 'It is unsuitable for coastal navigation.';
type FlowStatus = 'off' | 'loading' | 'live' | 'live (partial)' | 'no data' | 'unavailable';
type FlowModule = typeof import('./flow/index');
/**
 * found-115 (DR-188): the overlay draws wherever `flow=` and the SST layer
 * are on, but this panel sits in the sidebar, which an embed and a closed
 * sidebar hide. Each panel status change also goes to the map key's drawer,
 * carrying the panel's own words (label, status line, qualification
 * sentences) so the key composes and never re-types them. The key is a lazy
 * chunk that can start after the overlay (a boot with `flow=` in the URL),
 * so while active this module answers its one request with the current
 * snapshot. E1-4's two fields go live here for wind and waves: `provenance`
 * (the owner's credit, as its own text item) and `motion` (which alone
 * decides whether the key offers Pause motion).
 */
interface FlowSnapshot {
  readonly status: FlowStatus | 'inactive';
  readonly label: string;
  readonly line: string;
  readonly notes: readonly string[];
  readonly motion?: FlowViewState['motion'];
  readonly provenance?: string;
}
const SNAPSHOT_EVENT = 'ddm:enso-flow-snapshot';
const SNAPSHOT_REQUEST_EVENT = 'ddm:enso-flow-snapshot-request';
const INACTIVE: FlowSnapshot = { status: 'inactive', label: '', line: '', notes: [] };
let snapshot: FlowSnapshot = INACTIVE;
const cache = new Map<string, { stored: number; frame: FlowFrame }>();
const fieldCache = new Map<string, { stored: number; field: FlowField }>();
let flowModule: Promise<FlowModule> | null = null;
let flowView: FlowView | null = null;
let map: maplibregl.Map | null = null;
let controller: AbortController | null = null;
let observer: MutationObserver | null = null;
let host: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let statusNode: HTMLElement | null = null;
let detailNode: HTMLElement | null = null;
let sourceNode: HTMLElement | null = null;
let creditNode: HTMLElement | null = null;
let changesNode: HTMLElement | null = null;
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

/** The panel's stamps of what the flow view draws, for the specs and the key. */
function stampForm(state: FlowViewState | null, kind: EnsoFlowKind): void {
  if (!panel) return;
  panel.dataset['flowForm'] = state?.form ?? 'none';
  panel.dataset['flowMotion'] = state?.motion ?? 'none';
  panel.dataset['flowFeatures'] = String(state?.features ?? 0);
  panel.dataset['flowDrawn'] = state && state.form !== 'none' ? kind : '';
}

function disposeFlowView(): void {
  flowView?.dispose();
  flowView = null;
  stampForm(null, 'off');
}

function publish(next: FlowSnapshot): void {
  snapshot = next;
  window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail: next }));
}

function replaySnapshot(): void {
  publish(snapshot);
}

function announceFlowStatus(text: string): void {
  const live = document.getElementById('layer-status-live');
  if (live) live.textContent = text;
}

function setStatus(
  status: FlowStatus, text: string, kind: EnsoFlowKind, notes: readonly string[] = [],
  extra: Pick<FlowSnapshot, 'motion' | 'provenance'> = {}
): void {
  if (panel) panel.dataset['status'] = status;
  if (statusNode) statusNode.textContent = text;
  const next: FlowSnapshot = { status, label: LABELS[kind], line: text, notes, ...extra };
  if (next.status === snapshot.status && next.label === snapshot.label && next.line === snapshot.line &&
      next.motion === snapshot.motion && next.provenance === snapshot.provenance &&
      next.notes.join('\n') === snapshot.notes.join('\n')) return;
  if (next.status !== snapshot.status || next.label !== snapshot.label || next.line !== snapshot.line) {
    // The shell's one announcer stays exposed when the panel and Key are hidden.
    // Snapshot replay and motion-only repaints must not announce the same words again.
    announceFlowStatus(status === 'off' ? text : `${next.label} · ${next.line}`);
  }
  publish(next);
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

/** The interim ocean-current arrows (DR-161), the only Open-Meteo drawing left. */
function paintArrows(): void {
  if (!map || !frame || preference.kind !== 'currents') return;
  const data = arrowData(map, frame);
  const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(SOURCE, {
    type: 'geojson', data,
    attribution: '<a href="https://open-meteo.com/">Open-Meteo</a> · Météo-France / Copernicus · CC BY 4.0'
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

function currentsUrl(positions: readonly (readonly [number, number])[]): string {
  const params = new URLSearchParams({
    latitude: positions.map((p) => p[1]).join(','), longitude: positions.map((p) => p[0]).join(','),
    current: FLOW_VARIABLES.currents.join(','), models: 'meteofrance_currents', cell_selection: 'nearest',
    timeformat: 'unixtime', wind_speed_unit: 'ms'
  });
  return `${OPEN_METEO_MARINE_URL}?${params}`;
}

function presentFrame(data: FlowFrame): void {
  frame = data;
  paintArrows();
  const status = data.points.length === 0 ? 'no data' : data.missing > 0 ? 'live (partial)' : 'live';
  const coverage = `${data.points.length} of ${data.total} sampled cells have data.`;
  setStatus(status, `${status} · Model valid ${dateLabel(data.time)}`, 'currents', [coverage, CALM_NOTE, TIMING_NOTE]);
  if (detailNode) {
    const values = data.points.map((p) => p.value);
    const range = values.length ? `${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)} m/s. ` : '';
    detailNode.textContent = `${coverage} ${range}${CALM_NOTE} Move the map and choose Update area for new samples.`;
  }
}

async function loadCurrents(activeMap: maplibregl.Map, generation: number): Promise<void> {
  const positions = samplePositions(activeMap);
  const url = currentsUrl(positions);
  const cached = cache.get(url);
  if (sourceNode) sourceNode.textContent = `${SOURCES.currents}, via Open-Meteo. The API supplies 15-minute valid instants by interpolating model output. ${TIMING_NOTE} The response does not supply the model issue time. ${NAVIGATION_NOTE}`;
  if (cached && Date.now() - cached.stored < CACHE_MS) { presentFrame(cached.frame); return; }
  const owned = new AbortController();
  controller = owned;
  setStatus('loading', 'loading · Model direction samples', 'currents', [LOADING_NOTE]);
  if (detailNode) detailNode.textContent = LOADING_NOTE;
  try {
    const json = await fetchJsonWithBudget(url, { credentials: 'omit' }, owned.signal, 12_000);
    if (owned.signal.aborted || generation !== epoch || map !== activeMap) return;
    const result = parseFlowFrame(json, 'currents', positions.length);
    // Reject an implausible timestamp; a valid model time is not the browser
    // retrieval time, nor permission to silently display a stale field.
    if (Math.abs(Date.now() - result.time) > 48 * 60 * 60 * 1000) throw new Error('No recent model time.');
    cache.set(url, { stored: Date.now(), frame: result });
    while (cache.size > 6) cache.delete(cache.keys().next().value!);
    presentFrame(result);
  } catch {
    if (owned.signal.aborted || generation !== epoch) return;
    setStatus('unavailable', 'unavailable · Direction samples did not load', 'currents', [FAILED_NOTE]);
    if (detailNode) detailNode.textContent = `Choose Update area to try again. ${FAILED_NOTE}`;
  }
}

function loadFlowModule(): Promise<FlowModule> {
  flowModule ??= import('./flow/index').catch((error: unknown) => {
    flowModule = null;
    throw error;
  });
  return flowModule;
}

const fieldKey = (kind: FlowFieldKind, cycle: number, forecastHour: number): string =>
  `${kind}|${kind === 'wind' ? 'gfs-1p00' : 'gfswave-global-0p25'}|${cycle}|${forecastHour}`;

/**
 * A held frame the reader would read now: one of the cycles it would try
 * (the candidate and its step-backs, each at its own forecast hour), kept
 * less than ten minutes, and inside its 24-hour limit.
 */
function cachedField(flow: FlowModule, kind: FlowFieldKind, now: number): FlowField | null {
  let cycle = flow.candidateCycle(now);
  for (let tries = 0; tries < flow.MAX_CYCLE_TRIES; tries++, cycle -= 6 * 3_600_000) {
    const key = fieldKey(kind, cycle, flow.forecastHourFor(kind, cycle, now));
    const held = fieldCache.get(key);
    if (!held) continue;
    if (now - held.stored >= CACHE_MS || flow.isStale(held.field, now)) { fieldCache.delete(key); continue; }
    return held.field;
  }
  return null;
}

function storeField(field: FlowField): void {
  const { cycle, forecastHour } = field.meta;
  if (cycle === null || forecastHour === null) return;
  fieldCache.set(fieldKey(field.kind, cycle, forecastHour), { stored: Date.now(), field });
  while (fieldCache.size > FIELD_CACHE_SIZE) fieldCache.delete(fieldCache.keys().next().value!);
}

/** The notes of a drawn wind or wave frame, in the order the drawer reads them. */
function fieldNotes(kind: FlowFieldKind, state: FlowViewState): string[] {
  const form = flowFormNote(state);
  const notes: string[] = kind === 'wind'
    ? [FLOW_WORDS.pace, FLOW_WORDS.instant, FLOW_WORDS.modelOutput, FLOW_WORDS.bins.wind, FLOW_WORDS.binsNote, TIMING_NOTE]
    : [FLOW_WORDS.waves, FLOW_WORDS.mask, FLOW_WORDS.modelOutput, FLOW_WORDS.bins.waves, FLOW_WORDS.binsNote, TIMING_NOTE];
  // The wave crop's box sentence is the waves' alone; a global grid has no outside.
  if (kind === 'waves' && state.coverage === 'partial') notes.unshift(FLOW_WORDS.waveBox);
  if (form) notes.unshift(form);
  return notes;
}

function presentStale(kind: FlowFieldKind, field: FlowField): void {
  disposeFlowView();
  const { cycle, forecastHour } = field.meta;
  if (cycle !== null && forecastHour !== null) fieldCache.delete(fieldKey(kind, cycle, forecastHour));
  setStatus('unavailable', flowStaleLine(kind, field.meta.cycle ?? field.meta.validTime), kind, [FAILED_NOTE]);
  if (detailNode) detailNode.textContent = FAILED_NOTE;
}

function presentFieldState(kind: FlowFieldKind, field: FlowField, state: FlowViewState): void {
  stampForm(state, kind);
  if (state.stale) {
    presentStale(kind, field);
    return;
  }
  const provenance = FLOW_WORDS.provenance;
  if (state.coverage === 'masked' || state.coverage === 'outside') {
    // "Outside the area the wave marks cover" is said for waves only (the
    // wave crop); src/layers/flow/index.ts never reports it for a global grid.
    const masked = state.coverage === 'masked' || kind !== 'waves';
    const notes = [masked ? FLOW_WORDS.mask : FLOW_WORDS.waveBox, TIMING_NOTE];
    setStatus('no data', `no data · ${masked ? FLOW_WORDS.noOcean : FLOW_WORDS.outside}`, kind, notes, { motion: 'none', provenance });
    if (detailNode) detailNode.textContent = notes.join(' ');
    return;
  }
  const status = kind === 'waves' && state.coverage === 'partial' ? 'live (partial)' : 'live';
  const notes = fieldNotes(kind, state);
  setStatus(status, flowLiveLine(status, field.meta.cycle ?? field.meta.validTime, field.meta.validTime), kind, notes, {
    motion: state.motion, provenance
  });
  if (detailNode) detailNode.textContent = notes.join(' ');
}

async function loadField(activeMap: maplibregl.Map, kind: FlowFieldKind, generation: number): Promise<void> {
  if (sourceNode) sourceNode.textContent = `${SOURCES[kind]}. ${TIMING_NOTE} ${NAVIGATION_NOTE}`;
  const owned = new AbortController();
  controller = owned;
  setStatus('loading', `loading · ${FLOW_WORDS.loading[kind]}`, kind);
  if (detailNode) detailNode.textContent = TIMING_NOTE;
  const current = (): boolean => !owned.signal.aborted && generation === epoch && map === activeMap;
  try {
    const flow = await loadFlowModule();
    if (!current()) return;
    let field = cachedField(flow, kind, Date.now());
    if (!field) {
      field = await flow.readFlowFrame(kind, { signal: owned.signal });
      if (!current()) return;
      storeField(field);
    }
    if (controller === owned) controller = null;
    if (flow.isStale(field, Date.now())) {
      presentStale(kind, field);
      return;
    }
    const drawn = field;
    flowView = flow.mountFlowView(activeMap, drawn, {
      ink: preference.ink,
      onState: (state) => { if (generation === epoch) presentFieldState(kind, drawn, state); },
      onRender: (count, steps) => {
        if (!panel) return;
        panel.dataset['flowRenders'] = String(count);
        panel.dataset['flowSteps'] = String(steps);
      }
    });
    presentFieldState(kind, drawn, flowView.state);
  } catch {
    if (!current()) return;
    disposeFlowView();
    setStatus('unavailable', `unavailable · ${FLOW_WORDS.unavailable[kind]}`, kind, [FAILED_NOTE]);
    if (detailNode) detailNode.textContent = FAILED_NOTE;
  }
}

/** The credit line under the controls: the owner's words for wind and waves, the DR-161 credits for currents. */
function renderCredits(kind: EnsoFlowKind): void {
  if (!creditNode || !changesNode) return;
  const link = (href: string, text: string): HTMLAnchorElement => {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = text;
    return anchor;
  };
  if (kind === 'wind' || kind === 'waves') {
    // The owner's credit as text (RATIFICATION-11 row 15): no link, no emblem, no attribution line.
    const provenance = document.createElement('p');
    provenance.className = 'enso-flow-credit';
    provenance.dataset['ensoFlowProvenance'] = '';
    provenance.textContent = FLOW_WORDS.provenance;
    creditNode.replaceChildren(provenance);
    changesNode.replaceChildren();
    changesNode.hidden = true;
    return;
  }
  // DR-161 (b), the interim credits (no acknowledgements row, DR-115): the
  // Open-Meteo credit with its licence link and the Copernicus line sit
  // outside the closed "Key & source" disclosure, so they are visible
  // without interaction; the changes line stays in the key it describes.
  // ledger: open-meteo-licence (cite sheet c20)
  const credit = document.createElement('p');
  credit.className = 'enso-flow-credit';
  credit.append(
    link('https://open-meteo.com/', 'Weather data by Open-Meteo.com'),
    ' · ',
    link('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')
  );
  // ledger: copernicus-marine-smoc (cite sheet c22); currents only
  const copernicus = document.createElement('p');
  copernicus.className = 'enso-flow-credit';
  copernicus.append(
    'Generated using E.U. Copernicus Marine Service Information; ',
    link('https://doi.org/10.48670/moi-00016', 'https://doi.org/10.48670/moi-00016')
  );
  copernicus.hidden = kind !== 'currents';
  creditNode.replaceChildren(credit, copernicus);
  // ledger: open-meteo-licence (cite sheet c21), the CC BY changes line
  // DRAFT wording (DR-177)
  changesNode.textContent =
    'DDM samples points in the view and draws each as a static direction arrow; no value is interpolated between samples.';
  changesNode.hidden = false;
}

async function loadArea(): Promise<void> {
  controller?.abort();
  controller = null;
  const generation = ++epoch;
  frame = null;
  removeArrows();
  // The old field leaves before the new one is read, so two never draw at once.
  disposeFlowView();
  const activeMap = map;
  const kind = preference.kind;
  renderCredits(kind);
  updateSelection();
  if (!activeMap || kind === 'off') {
    setStatus('off', 'Direction overlay off', kind);
    return;
  }
  if (kind === 'currents') await loadCurrents(activeMap, generation);
  else await loadField(activeMap, kind, generation);
}

function updateSelection(): void {
  for (const button of panel?.querySelectorAll<HTMLButtonElement>('[data-flow-kind]') ?? []) {
    button.setAttribute('aria-pressed', String(button.dataset['flowKind'] === preference.kind));
  }
  if (updateButton) {
    updateButton.disabled = preference.kind === 'off';
    // A global grid needs no resampling on pan (C-fit.md 1.2): currents only.
    updateButton.hidden = preference.kind === 'wind' || preference.kind === 'waves';
  }
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
    flowView?.setInk(preference.ink);
  });
  label.append(ink);
  updateButton = document.createElement('button');
  updateButton.type = 'button';
  updateButton.textContent = 'Update area';
  updateButton.addEventListener('click', () => { void loadArea(); });
  toolbar.append(label, updateButton);
  statusNode = document.createElement('p');
  statusNode.className = 'enso-flow-status';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Key & source';
  detailNode = document.createElement('p');
  sourceNode = document.createElement('p');
  creditNode = document.createElement('div');
  changesNode = document.createElement('p');
  details.append(summary, detailNode, sourceNode, changesNode);
  panel.append(heading, options, toolbar, statusNode, creditNode, details);
  host.replaceChildren(panel);
  stampForm(null, 'off');
  updateSelection();
  void loadArea();
  return true;
}

function onMoveEnd(): void {
  // Wind and waves rebuild in their own view (src/layers/flow/index.ts).
  if (preference.kind !== 'currents') return;
  paintArrows();
  if (frame && statusNode) {
    const status = frame.points.length === 0 ? 'no data' : frame.missing ? 'live (partial)' : 'live';
    const text = `${status} · Model valid ${dateLabel(frame.time)} · Update area to resample`;
    if (statusNode.textContent === text) return;
    statusNode.textContent = text;
    // Preserve the panel's existing prompt only where its control can be used.
    // The Key keeps its source status without an unavailable resample instruction.
    if (updateButton && updateButton.getClientRects().length > 0 &&
        !updateButton.closest('[inert], [aria-hidden="true"]')) {
      announceFlowStatus(`${LABELS.currents} · ${text}`);
    }
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
  window.addEventListener(SNAPSHOT_REQUEST_EVENT, replaySnapshot);
  if (!mountControls()) {
    observer = new MutationObserver(() => {
      if (mountControls()) { observer?.disconnect(); observer = null; }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

/**
 * Abort immediately when layer intent changes; serialized teardown follows.
 * Every read (the sample, the NODD `.idx` and ranges) is aborted, the decode
 * Worker ends with its read, and the motion loop stops with no further
 * repaint; no map layer is touched here.
 */
export function cancelEnsoFlowLoad(): void {
  epoch += 1;
  controller?.abort();
  controller = null;
  flowView?.halt();
  observer?.disconnect();
  observer = null;
}

export function deactivateEnsoFlow(): void {
  cancelEnsoFlowLoad();
  map?.off('moveend', onMoveEnd);
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener(SNAPSHOT_REQUEST_EVENT, replaySnapshot);
  removeArrows();
  disposeFlowView();
  map = null;
  frame = null;
  if (host) { host.replaceChildren(); host.hidden = true; }
  // The drawer row leaves with the panel, never before it nor after it.
  if (snapshot.status !== 'inactive') publish(INACTIVE);
  mobileQuery?.removeEventListener('change', seatControls);
  mobileQuery = null;
  if (host && desktopSeat?.parentNode) desktopSeat.after(host);
  desktopSeat?.remove();
  desktopSeat = null;
  host = null;
  panel = statusNode = detailNode = sourceNode = creditNode = changesNode = updateButton = null;
}
