/**
 * Opt-in ENSO model context (ENSO-FLOW-PLAN E2-1; C-fit.md 1.2).
 *
 * - Wind, jet-level wind and waves draw NOAA GFS 10 m wind, GFS 250 hPa wind
 *   and GFS-Wave peak direction as flowing paths (or their still form), read
 *   at runtime from NOAA's public NODD bucket by the lazy flow chunk
 *   (src/layers/flow/index.ts), which this module reaches through one dynamic
 *   import() and nothing else. A decoded frame is kept on the CPU for ten
 *   minutes, keyed by kind, grid, cycle and forecast hour, so an SST
 *   re-activate reads nothing again. Past cycle + 24 h a frame is never
 *   drawn. Panning never fetches.
 * - Ocean currents draw the same paths from the committed NOAA RTOFS
 *   surface-current frame (src/layers/flow/currents.ts), read same-origin:
 *   a dated model frame whose run, valid instant and age read in the state
 *   line; one valid more than 14 days ago is refused by its reader and
 *   reads unavailable. It holds one grid per region on its native
 *   spacing; the grid under the view's centre draws, and a pan across the
 *   seam swaps grids without a read.
 * - Precipitable water is NOAA GFS PWAT, one more message of the wind's own
 *   file by the same read, cache and 24-hour limit. It is a scalar, so it
 *   draws as a still shade (src/layers/flow/shade.ts) with no lines: no ink,
 *   no motion, and so no Pause in the key.
 */
import type * as maplibregl from 'maplibre-gl';
import {
  parseEnsoFlowParams, syncEnsoFlowParams,
  type EnsoFlowKind, type EnsoFlowPreference
} from '../state/enso-flow';
import {
  FLOW_WORDS, currentsBoxNote, flowFormNote, flowLiveLine, flowStaleLine, isShadeKind,
  type ActiveFlowKind, type FlowFieldKind
} from './enso-flow-data';
import type { FlowField, FlowView, FlowViewState, ScalarField, ShadeView } from './flow/index';
import '../ui/enso-flow.css';

const CACHE_MS = 10 * 60 * 1000;
/** Decoded frames kept at once (a wave frame is about 1.3 MB on the CPU). */
const FIELD_CACHE_SIZE = 4;
/** The control's buttons, in this order: a kind without a label does not compile. */
const LABELS: Record<EnsoFlowKind, string> = {
  off: 'Off', currents: 'Ocean currents', wind: 'Atmospheric currents', jet: 'Jet-level wind', waves: 'Ocean waves',
  // DRAFT wording (DR-177): the issuer's field name (NCEP GRIB2 table 4.2-0-1, "Precipitable Water").
  pwat: 'Precipitable water'
};
const SOURCES: Record<ActiveFlowKind, string> = {
  // DRAFT wording (DR-177): the issuer's field, UOGRD and VOGRD at 0 m (admission rtofs-currents-producer, 2026-10-13).
  currents: 'NOAA Global RTOFS surface currents; ocean model output, one dated frame',
  wind: 'NOAA GFS, 10 m winds; global model output, updated every six hours',
  // DRAFT wording (DR-177): the issuer's own field, UGRD and VGRD at 250 mb (admission gfs-runtime-nodd, 2026-10-13).
  jet: 'NOAA GFS 250 hPa wind; global model output, updated every six hours',
  waves: 'NOAA GFS Wave, 0.25°; hourly model output, updated every six hours',
  // DRAFT wording (DR-177): the issuer's field and its `.idx` level words (admission gfs-runtime-nodd, 2026-10-13).
  pwat: 'NOAA GFS precipitable water (entire atmosphere); global model output, updated every six hours'
};
/** Sentences the panel and the map key's drawer row share, one source each. */
const TIMING_NOTE = 'This is model context, independently timed from the observed SST map.';
const FAILED_NOTE = 'No direction or calm condition is inferred from a failed request.';
// DRAFT wording (DR-177): the same sentence for a kind with no direction.
const SHADE_FAILED_NOTE = 'No moist or dry condition is inferred from a failed request.';
const failedNote = (kind: ActiveFlowKind): string => (isShadeKind(kind) ? SHADE_FAILED_NOTE : FAILED_NOTE);
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
const fieldCache = new Map<string, { stored: number; field: FlowField | ScalarField }>();
/** The currents frame's grids, held like a NODD frame so a pan or an SST re-activate reads nothing again. */
let heldCurrents: { stored: number; fields: readonly FlowField[] } | null = null;
/** Currents only: mount the grid under the view's centre, after a pan. */
let repick: (() => void) | null = null;
let flowModule: Promise<FlowModule> | null = null;
let flowView: FlowView | ShadeView | null = null;
let map: maplibregl.Map | null = null;
let controller: AbortController | null = null;
let observer: MutationObserver | null = null;
let host: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let statusNode: HTMLElement | null = null;
let detailNode: HTMLElement | null = null;
let sourceNode: HTMLElement | null = null;
let creditNode: HTMLElement | null = null;
let desktopSeat: Comment | null = null;
let mobileQuery: MediaQueryList | null = null;
let preference: EnsoFlowPreference = { kind: 'off', ink: 'light' };
let epoch = 0;

/** What a view draws: a path view's own state, or the still shade of a scalar kind. */
type DrawnState = Pick<FlowViewState, 'motion' | 'features'> & { readonly form: FlowViewState['form'] | 'shade' };

/** The panel's stamps of what the flow view draws, for the specs and the key. */
function stampForm(state: DrawnState | null, kind: EnsoFlowKind): void {
  if (!panel) return;
  const form = state?.form ?? 'none';
  // Moving paths and the shade draw on the GPU; only native forms require GeoJSON features.
  const drawn = form === 'moving' || form === 'shade' || (form !== 'none' && (state?.features ?? 0) > 0);
  panel.dataset['flowForm'] = drawn ? form : 'none';
  panel.dataset['flowMotion'] = state?.motion ?? 'none';
  panel.dataset['flowFeatures'] = String(state?.features ?? 0);
  panel.dataset['flowDrawn'] = drawn ? kind : '';
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

function loadFlowModule(signal: AbortSignal): Promise<FlowModule> {
  flowModule ??= import('./flow/index').catch((error: unknown) => {
    flowModule = null;
    throw error;
  });
  const pending = flowModule;
  // Native import has no abortable transport. Bound this generation's wait
  // with the existing 12 s read duration; later module evaluation stays cached
  // but cannot resume a cancelled or timed-out field load.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, module?: FlowModule): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (module) resolve(module);
      else reject(error);
    };
    const stop = (): void => finish(new DOMException('Flow module wait aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Flow module wait timed out')), 12_000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    // Attach both handlers even on abort so a late rejection is consumed.
    pending.then((module) => finish(null, module), (error: unknown) => finish(error));
  });
}

const fieldKey = (kind: FlowFieldKind, cycle: number, forecastHour: number): string =>
  `${kind}|${kind === 'waves' ? 'gfswave-global-0p25' : 'gfs-1p00'}|${cycle}|${forecastHour}`;

/**
 * A held frame the reader would read now: one of the cycles it would try
 * (the candidate and its step-backs, each at its own forecast hour), kept
 * less than ten minutes, and inside its 24-hour limit.
 */
function cachedField(flow: FlowModule, kind: FlowFieldKind, now: number): FlowField | ScalarField | null {
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

function storeField(kind: FlowFieldKind, field: FlowField | ScalarField): void {
  const { cycle, forecastHour } = field.meta;
  if (cycle === null || forecastHour === null) return;
  fieldCache.set(fieldKey(kind, cycle, forecastHour), { stored: Date.now(), field });
  while (fieldCache.size > FIELD_CACHE_SIZE) fieldCache.delete(fieldCache.keys().next().value!);
}

/**
 * The notes of a drawn field frame, in the order the drawer reads them: any
 * live-state sentence first (why the lines hold still, then the box of a
 * regional grid the view leaves), then the kind's bins, which decode the marks.
 * The explanations read in the Impact Briefing (src/ui/map-technical-information.ts).
 */
function fieldNotes(kind: ActiveFlowKind, state: FlowViewState, box: string | null): string[] {
  const form = flowFormNote(state);
  const notes: string[] = [FLOW_WORDS.bins[kind]];
  if (box) notes.unshift(box);
  if (form) notes.unshift(form);
  return notes;
}

function presentStale(kind: FlowFieldKind, field: Pick<FlowField, 'meta'>): void {
  disposeFlowView();
  const { cycle, forecastHour } = field.meta;
  if (cycle !== null && forecastHour !== null) fieldCache.delete(fieldKey(kind, cycle, forecastHour));
  setStatus('unavailable', flowStaleLine(kind, field.meta.cycle ?? field.meta.validTime), kind, [failedNote(kind)]);
  if (detailNode) detailNode.textContent = failedNote(kind);
}

function presentFailure(kind: ActiveFlowKind, error: unknown): void {
  console.warn('[enso-flow]', error);
  disposeFlowView();
  setStatus('unavailable', `unavailable · ${FLOW_WORDS.unavailable[kind]}`, kind, [failedNote(kind)]);
  if (detailNode) detailNode.textContent = failedNote(kind);
}

/**
 * A drawn shade: live with its run and valid instant, and the bins that decode
 * it. A global field with a value at every node has no partial and no masked
 * view, and a still field has no form note; `motion: 'none'` keeps the key's
 * Pause away.
 */
function presentShade(kind: ActiveFlowKind, field: ScalarField): void {
  stampForm({ form: 'shade', motion: 'none', features: 0 }, kind);
  const notes = [FLOW_WORDS.bins[kind]];
  const { cycle, validTime } = field.meta;
  setStatus('live', flowLiveLine('live', kind, cycle ?? validTime, validTime), kind, notes, { motion: 'none', provenance: FLOW_WORDS.provenance[kind] });
  if (detailNode) detailNode.textContent = notes.join(' ');
}

function presentFieldState(kind: ActiveFlowKind, field: FlowField, state: FlowViewState): void {
  stampForm(state, kind);
  // The currents frame never falls stale (its reader refuses one past 14 days), so only a NODD frame does.
  if (state.stale && kind !== 'currents') {
    presentStale(kind, field);
    return;
  }
  const provenance = FLOW_WORDS.provenance[kind];
  // Only a regional grid has an outside (the wave crop, each currents grid);
  // src/layers/flow/index.ts never reports one for a global grid.
  const regional = kind === 'waves' || kind === 'currents';
  const box = (): string => (kind === 'currents' ? currentsBoxNote(field.grid) : FLOW_WORDS.waveBox);
  if (state.coverage === 'masked' || state.coverage === 'outside') {
    const masked = state.coverage === 'masked' || !regional;
    const notes = [masked ? FLOW_WORDS.mask : box()];
    const reason = masked ? FLOW_WORDS.noOcean : kind === 'currents' ? FLOW_WORDS.currentsOutside : FLOW_WORDS.outside;
    setStatus('no data', `no data · ${reason}`, kind, notes, { motion: 'none', provenance });
    if (detailNode) detailNode.textContent = notes.join(' ');
    return;
  }
  const status = regional && state.coverage === 'partial' ? 'live (partial)' : 'live';
  const notes = fieldNotes(kind, state, status === 'live (partial)' ? box() : null);
  const { cycle, validTime } = field.meta;
  // The currents frame is dated, never "now": its line ends with its age.
  const line = flowLiveLine(status, kind, cycle ?? validTime, validTime, kind === 'currents' ? Date.now() : undefined);
  setStatus(status, line, kind, notes, { motion: state.motion, provenance });
  if (detailNode) detailNode.textContent = notes.join(' ');
}

async function loadField(activeMap: maplibregl.Map, kind: ActiveFlowKind, generation: number): Promise<void> {
  if (sourceNode) sourceNode.textContent = `${SOURCES[kind]}. ${TIMING_NOTE}`;
  const owned = new AbortController();
  controller = owned;
  setStatus('loading', `loading · ${FLOW_WORDS.source[kind]}`, kind);
  if (detailNode) detailNode.textContent = TIMING_NOTE;
  const current = (): boolean => !owned.signal.aborted && generation === epoch && map === activeMap;
  try {
    const flow = await loadFlowModule(owned.signal);
    if (!current()) return;
    let fields: readonly FlowField[];
    if (kind === 'currents') {
      if (!heldCurrents || Date.now() - heldCurrents.stored >= CACHE_MS) {
        const read = await flow.readCurrentsFrame({ signal: owned.signal });
        if (!current()) return;
        heldCurrents = { stored: Date.now(), fields: read };
      }
      fields = heldCurrents.fields;
    } else {
      let field = cachedField(flow, kind, Date.now());
      if (!field) {
        field = await flow.readFlowFrame(kind, { signal: owned.signal });
        if (!current()) return;
        storeField(kind, field);
      }
      if (flow.isStale(field, Date.now())) {
        if (controller === owned) controller = null;
        presentStale(kind, field);
        return;
      }
      if ('values' in field) {
        // A scalar field: one still shade, made once from the frame; a pan reads and rebuilds nothing.
        const shade = field;
        if (controller === owned) controller = null;
        flowView = flow.mountShadeView(activeMap, shade, {
          onStale: () => { if (generation === epoch) presentStale(kind, shade); }
        });
        presentShade(kind, shade);
        return;
      }
      fields = [field];
    }
    if (controller === owned) controller = null;
    // One field draws at a time. The currents frame holds a grid per region,
    // never joined: the one under the view's centre draws, and a pan that
    // crosses to the other mounts it here without a read.
    const mount = (): void => {
      if (generation !== epoch) return;
      const field = fields.length > 1 ? flow.fieldNearestLatitude(fields, activeMap.getCenter().lat) : (fields[0] as FlowField);
      if (flowView?.field === field) return;
      disposeFlowView();
      const view = flow.mountFlowView(activeMap, field, {
        ink: preference.ink,
        onState: (state) => { if (generation === epoch) presentFieldState(kind, field, state); },
        onRender: (count, steps) => {
          if (!panel) return;
          panel.dataset['flowRenders'] = String(count);
          panel.dataset['flowSteps'] = String(steps);
        }
      });
      flowView = view;
      presentFieldState(kind, field, view.state);
    };
    mount();
    if (fields.length > 1) repick = mount;
  } catch (error) {
    if (!current()) return;
    presentFailure(kind, error);
  } finally {
    if (controller === owned) controller = null;
  }
}

/** The credit under the controls, as text (RATIFICATION-11 row 15): no link, no emblem, no attribution line. */
function renderCredits(kind: EnsoFlowKind): void {
  if (!creditNode) return;
  if (kind === 'off') {
    creditNode.replaceChildren();
    return;
  }
  const provenance = document.createElement('p');
  provenance.className = 'enso-flow-credit';
  provenance.dataset['ensoFlowProvenance'] = '';
  provenance.textContent = FLOW_WORDS.provenance[kind];
  creditNode.replaceChildren(provenance);
}

async function loadArea(): Promise<void> {
  controller?.abort();
  controller = null;
  repick = null;
  const generation = ++epoch;
  // The old field leaves before the new one is read, so two never draw at once.
  disposeFlowView();
  const activeMap = map;
  const kind = preference.kind;
  renderCredits(kind);
  updateSelection();
  if (!activeMap || kind === 'off') {
    setStatus('off', 'Overlay off', kind);
    return;
  }
  await loadField(activeMap, kind, generation);
}

function updateSelection(): void {
  for (const button of panel?.querySelectorAll<HTMLButtonElement>('[data-flow-kind]') ?? []) {
    button.setAttribute('aria-pressed', String(button.dataset['flowKind'] === preference.kind));
  }
  const details = panel?.querySelector('details');
  if (details) details.hidden = preference.kind === 'off';
  // The arrow colour is for lines: Off draws none, and a shade has none.
  const toolbar = panel?.querySelector<HTMLElement>('.enso-flow-toolbar');
  if (toolbar) toolbar.hidden = preference.kind === 'off' || isShadeKind(preference.kind);
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
  panel.setAttribute('aria-label', 'Ocean and atmosphere overlays');
  const heading = document.createElement('h3');
  heading.textContent = 'Ocean & atmosphere';
  const options = document.createElement('div');
  options.className = 'enso-flow-options';
  for (const kind of Object.keys(LABELS) as EnsoFlowKind[]) {
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
    // Light ink moves as the inverse of the ground beneath (ribbon-layer.ts), so it is not named White.
    option.textContent = value === 'light' ? 'Contrast' : 'Dark';
    ink.append(option);
  }
  ink.value = preference.ink;
  ink.addEventListener('change', () => {
    preference = { ...preference, ink: ink.value === 'dark' ? 'dark' : 'light' };
    syncEnsoFlowParams(preference);
    if (flowView && 'setInk' in flowView) flowView.setInk(preference.ink);
  });
  label.append(ink);
  toolbar.append(label);
  statusNode = document.createElement('p');
  statusNode.className = 'enso-flow-status';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Key & source';
  detailNode = document.createElement('p');
  sourceNode = document.createElement('p');
  creditNode = document.createElement('div');
  details.append(summary, detailNode, sourceNode);
  panel.append(heading, options, toolbar, statusNode, creditNode, details);
  host.replaceChildren(panel);
  stampForm(null, 'off');
  updateSelection();
  void loadArea();
  return true;
}

function onMoveEnd(): void {
  // A field rebuilds in its own view (src/layers/flow/index.ts); only the
  // currents frame has another grid to swap to.
  try {
    repick?.();
  } catch (error) {
    repick = null;
    presentFailure('currents', error);
  }
}

function onPopState(): void {
  const next = parseEnsoFlowParams(new URLSearchParams(window.location.search));
  // A studio's history step pops with the same flow=; keep the drawn field.
  if (next.kind === preference.kind && next.ink === preference.ink) return;
  const kindChanged = next.kind !== preference.kind;
  preference = next;
  updateSelection();
  const ink = panel?.querySelector('select');
  if (ink) ink.value = preference.ink;
  if (kindChanged) void loadArea();
  else if (flowView && 'setInk' in flowView) flowView.setInk(preference.ink);
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
 * Every read (the currents frame, the NODD `.idx` and ranges) is aborted, the
 * decode Worker ends with its read, and the motion loop stops with no further
 * repaint; no map layer is touched here.
 */
export function cancelEnsoFlowLoad(): void {
  epoch += 1;
  controller?.abort();
  controller = null;
  repick = null;
  flowView?.halt();
  observer?.disconnect();
  observer = null;
}

export function deactivateEnsoFlow(): void {
  cancelEnsoFlowLoad();
  map?.off('moveend', onMoveEnd);
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener(SNAPSHOT_REQUEST_EVENT, replaySnapshot);
  disposeFlowView();
  map = null;
  if (host) { host.replaceChildren(); host.hidden = true; }
  // The drawer row leaves with the panel, never before it nor after it.
  if (snapshot.status !== 'inactive') publish(INACTIVE);
  mobileQuery?.removeEventListener('change', seatControls);
  mobileQuery = null;
  if (host && desktopSeat?.parentNode) desktopSeat.after(host);
  desktopSeat?.remove();
  desktopSeat = null;
  host = null;
  panel = statusNode = detailNode = sourceNode = creditNode = null;
}
