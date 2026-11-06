/**
 * National Weather Service (NWS) watch, warning and advisory polygons (E2).
 *
 * Renders the active NWS products the committed mode names
 * (`HazardClusterDef.alerts`, src/config/clusters.ts): the heat and fire
 * weather products in Drought (every custom layer set), Wildfire and
 * Extreme Heat, the flood, storm, wind and coastal Warnings and Watches in
 * ENSO. A mode that names none gets no read, and a mode change while the
 * layer is on reads the new mode's products at once.
 *
 * The read. Each WWA feature becomes one `NormalizedAlert` (event, onset,
 * ends, geometry, issuer); the map, the key, the popups, the place row, the
 * strip and the phone pane all read that shape. The service's field list
 * names its times only by alias ("Onset", "Ends", "Expiration"); `ends` is
 * the WWA `ends`, and a blank there (one space, on six Flood Warnings read
 * 2026-11-06) is unknown, never another field's time. The product's own
 * `expiration` stays the reader's: it only drops an expired product between
 * reads, as before.
 *
 * Endpoint choice. `api.weather.gov/alerts/active` (the impact briefing's
 * point-alert source) carries `geometry: null` for zone-based alerts, which
 * is most heat and fire-weather products, so it cannot feed a polygon layer.
 * The NOAA event-driven Watch/Warning/Advisory (WWA) MapServer resolves the
 * forecast-zone geometry server-side and emits polygon GeoJSON, updated about
 * every five minutes. The URL is centralized as `URLS.nwsWwaMapServer` with
 * the verification block (verified 2026-07-01; reflected-origin CORS).
 *
 * Render. Fill plus matching outline, colored by the official NWS
 * watch/warning/advisory display colors (`NWS_ALERT_COLORS`), so the module
 * speaks the severity language users already know from weather.gov rather
 * than inventing its own.
 *
 * Cancellation (the cancellation invariant): master abort controller
 * superseded on each `activate`, aborted on `deactivate` and, while the first
 * read is in flight, by the controller's `LayerActivation.signal` at the
 * moment off intent is recorded; fetch through `fetchJsonWithBudget`, late
 * responses dropped.
 */

import type * as maplibregl from 'maplibre-gl';
import type {
  FeatureCollection,
  GeoJsonProperties,
  MultiPolygon,
  Polygon
} from 'geojson';

import { HAZARD_CLUSTERS, HEAT_FIRE_ALERTS, type AlertSet } from '../config/clusters';
import type { LayerActivation } from '../config/layers';
import { URLS } from '../config/urls';
import { getHazardCluster, onHazardClusterChange } from '../state/cluster-store';
import {
  NWS_ALERT_COLORS,
  NWS_ALERT_DEFAULT_COLOR,
  NWS_ALERT_LEGEND
} from '../config/palette';
import { matchExpression } from '../config/style-expressions';
import { registerClickTarget } from '../map/interaction-coordinator';
import type { IssuedModel, PopupClock } from '../ui/popup-frame';
import { fetchJsonWithBudget, linkAbort } from '../util/fetch';
import { isObject } from '../util/guards';
import { formatSnapshotTime } from '../util/snapshot-time';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';

const LAYER_KEY = 'nws-alerts';
const SOURCE_ID = 'nws-alerts';
const FILL_LAYER_ID = 'nws-alerts-fill';
const OUTLINE_LAYER_ID = 'nws-alerts-outline';
const SNAPSHOT_EVENT = 'ddm:nws-products-snapshot';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor so alert polygons stack below
 * the basemap label glyphs, matching the other polygon overlay modules.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the WWA query. */
const FETCH_TIMEOUT_MS = 15_000;

/** The issuer updates this service about every five minutes. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type Status = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';
type SnapshotEventStatus = Status | 'inactive';
type NwsAlertGeometry = Polygon | MultiPolygon;

/**
 * One alert as the reader hands it on. The names follow ATNI-CAST's
 * NormalizedAlert where the concept is the same (`event`, `onset`,
 * `geometry`); `ends` is the hazard's end, which that model does not carry
 * (its `expires` is the message's, the WWA `expiration`), and `issuer` is the
 * issuing office. On the map, `geometry` is the feature's and the rest are
 * its properties.
 */
export interface NormalizedAlert {
  /** The product name verbatim, the WWA `prod_type` (alias "Hazard Type"). */
  readonly event: string;
  /** The WWA `onset` (alias "Onset") as ISO 8601 text, or null where the service states none. */
  readonly onset: string | null;
  /** The WWA `ends` (alias "Ends") as ISO 8601 text, or null where the service states none. */
  readonly ends: string | null;
  readonly geometry: NwsAlertGeometry;
  /** The issuing NWS office, the WWA `wfo` (alias "Forecast Office"), or null when blank. */
  readonly issuer: string | null;
}

/** A read alert and when to stop drawing it: the product's `expiration`, else its `ends` (the reader's own). */
interface HeldAlert {
  readonly alert: NormalizedAlert;
  readonly expiresAt: number;
}

interface NwsMapPayload {
  readonly held: readonly HeldAlert[];
  readonly truncated: boolean;
}

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` so a superseded request can
 * never render into a torn-down layer.
 */
let masterController: AbortController | null = null;
let activeMap: maplibregl.Map | null = null;
let refreshTimer: number | null = null;
let expiryTimer: number | null = null;
let refreshInFlight = false;
let lastRefreshStartedAt = 0;
let snapshotAsOf: number | null = null;
let snapshotAlerts: readonly HeldAlert[] = [];
let snapshotTruncated = false;
/** The set the snapshot was read with; null before the first answer. */
let snapshotSet: AlertSet | null = null;
let stopModeWatch: (() => void) | null = null;

/** The products the committed mode names, or null: it names none. */
function modeAlertSet(): AlertSet | null {
  return HAZARD_CLUSTERS[getHazardCluster()].alerts ?? null;
}

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

/** `events`: the product names the key lists for this snapshot (`keyEvents`). */
function emitSnapshot(status: SnapshotEventStatus, events: readonly string[] = []): void {
  window.dispatchEvent(
    new CustomEvent(SNAPSHOT_EVENT, {
      detail: {
        status,
        asOf: snapshotAsOf,
        truncated: snapshotTruncated,
        events
      }
    })
  );
}

/**
 * The products the key lists: every heat and fire weather product, as it
 * always has; for any other set only those in the current read, in the set's
 * order, so none for an empty or failed read.
 */
function keyEvents(set: AlertSet | null, drawn: readonly HeldAlert[]): readonly string[] {
  if (set === HEAT_FIRE_ALERTS) return set.events;
  const present = new Set(drawn.map(({ alert }) => alert.event));
  return set?.events.filter((event) => present.has(event)) ?? [];
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Build the GeoJSON query URL. The `where` clause restricts to the mode's
 * products; `outFields` is limited to what the reader reads.
 */
export function buildQueryUrl(events: readonly string[]): string {
  const quoted = events.map((e) => `'${e}'`).join(',');
  const params = new URLSearchParams({
    where: `prod_type IN (${quoted})`,
    outFields: 'prod_type,onset,ends,expiration,wfo',
    outSR: '4326',
    returnGeometry: 'true',
    f: 'geojson',
    // Load-bearing on the 5-minute refresh: 310 alerts were 1.88 MB gzipped
    // (6.2 MB decoded) at full detail and 224 KB with these two (measured
    // 2026-10-15); zone edges move at most about 200 m.
    maxAllowableOffset: '0.002',
    geometryPrecision: '5'
  });
  return `${URLS.nwsWwaMapServer}/query?${params.toString()}`;
}

/**
 * An issuer time as ISO 8601 text: null when the service states none (absent,
 * or the blank it sends for an open end), undefined when malformed. Epoch
 * milliseconds are read as the instant they name.
 */
function issuerTime(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return null;
  return Number.isFinite(Date.parse(text)) ? text : undefined;
}

function isPosition(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function isRing(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(isPosition)
  );
}

function isPolygonCoordinates(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isRing)
  );
}

function isAlertGeometry(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === 'Polygon') {
    return isPolygonCoordinates(value.coordinates);
  }
  return (
    value.type === 'MultiPolygon' &&
    Array.isArray(value.coordinates) &&
    value.coordinates.length > 0 &&
    value.coordinates.every(isPolygonCoordinates)
  );
}

/**
 * Read a WWA answer into normalized alerts, only the `events` asked for. A
 * malformed HTTP 200 response must not become a clean zero: any feature
 * that does not read whole fails the whole answer.
 */
export function parseMapPayload(json: unknown, events: readonly string[]): NwsMapPayload | null {
  if (
    !isObject(json) ||
    json.type !== 'FeatureCollection' ||
    !Array.isArray(json.features) ||
    (json.exceededTransferLimit !== undefined &&
      typeof json.exceededTransferLimit !== 'boolean')
  ) {
    return null;
  }

  const held: HeldAlert[] = [];
  for (const candidate of json.features) {
    if (
      !isObject(candidate) ||
      candidate.type !== 'Feature' ||
      !isAlertGeometry(candidate.geometry) ||
      !isObject(candidate.properties)
    ) {
      return null;
    }
    const properties = candidate.properties;
    const onset = issuerTime(properties.onset);
    const ends = issuerTime(properties.ends);
    const expiration = issuerTime(properties.expiration);
    const wfo = properties.wfo;
    if (
      typeof properties.prod_type !== 'string' ||
      !events.includes(properties.prod_type) ||
      onset === undefined ||
      ends === undefined ||
      expiration === undefined ||
      // An alert without its window would read as a permanent condition.
      (expiration === null && ends === null) ||
      (wfo !== undefined && wfo !== null && typeof wfo !== 'string')
    ) {
      return null;
    }
    held.push({
      alert: {
        event: properties.prod_type,
        onset,
        ends,
        geometry: candidate.geometry as NwsAlertGeometry,
        issuer: typeof wfo === 'string' && wfo.trim() !== '' ? wfo.trim() : null
      },
      expiresAt: Date.parse((expiration ?? ends)!)
    });
  }

  return {
    held,
    truncated: json.exceededTransferLimit === true
  };
}

function activeAlertsAt(now: number): HeldAlert[] {
  return snapshotAlerts.filter(({ expiresAt }) => expiresAt > now);
}

/** The map's form of the shape: the geometry is the feature's, the other four fields its properties. */
function featureCollection(held: readonly HeldAlert[]): FeatureCollection<NwsAlertGeometry> {
  return {
    type: 'FeatureCollection',
    features: held.map(({ alert: { geometry, ...properties } }) => ({ type: 'Feature', geometry, properties }))
  };
}

function colorExpression(): maplibregl.ExpressionSpecification {
  // `matchExpression` does the head-pair/tail split the Style Spec tuple type
  // requires. For every non-empty palette, and so for NWS_ALERT_COLORS as
  // shipped, the emitted array is the same one the older cast-and-spread form
  // produced; for an empty palette the two disagree and both are invalid, so
  // the helper throws instead of emitting either.
  return matchExpression(
    ['get', 'event'],
    Object.entries(NWS_ALERT_COLORS),
    NWS_ALERT_DEFAULT_COLOR,
    'NWS_ALERT_COLORS'
  );
}

function ensureMapLayers(
  map: maplibregl.Map,
  data: FeatureCollection<NwsAlertGeometry>
): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data,
      attribution: 'NOAA NWS'
    });
  } else {
    (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource).setData(data);
  }

  const beforeId = resolveBeforeId(map);
  const color = colorExpression();
  if (!map.getLayer(FILL_LAYER_ID)) {
    map.addLayer(
      {
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-color': color,
          'fill-opacity': 0.35
        }
      },
      beforeId
    );
  }
  if (!map.getLayer(OUTLINE_LAYER_ID)) {
    map.addLayer(
      {
        id: OUTLINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': color,
          'line-width': 1,
          'line-opacity': 0.9
        }
      },
      beforeId
    );
  }
}

function showSnapshotLegend(active: readonly HeldAlert[]): void {
  const featureCount = active.length;
  const asOf =
    snapshotAsOf === null
      ? ''
      : ` As of ${formatSnapshotTime(snapshotAsOf)}.`;
  const note = snapshotTruncated
    ? `Results may be incomplete because the National Weather Service response reached its transfer limit.${asOf}`
    : featureCount === 0
      ? `No active requested National Weather Service products.${asOf}`
      : `Active National Weather Service products.${asOf}`;
  const set = snapshotSet;
  const events = keyEvents(set, active);
  const section = showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event,
    render: (body) => renderSetLegend(body, set, events, note)
  });
  const noteElement = section?.querySelector<HTMLElement>('.legend-note');
  if (noteElement && snapshotAsOf !== null) {
    noteElement.dataset['snapshotAsOf'] = new Date(snapshotAsOf).toISOString();
  }
  emitSnapshot(
    snapshotTruncated
      ? 'degraded'
      : featureCount > 0
        ? 'ready'
        : 'no-data',
    events
  );
}

function showUnavailableLegend(set: AlertSet | null): void {
  const events = keyEvents(set, []);
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event,
    render: (body) => renderSetLegend(body, set, events, 'The National Weather Service product snapshot is unavailable.')
  });
  emitSnapshot('error', events);
}

/** The key rows `events` names, under the heat and fire weather set's long-standing title or the set's name. */
function renderSetLegend(body: HTMLElement, set: AlertSet | null, events: readonly string[], note: string): void {
  renderSwatchLegend(
    body,
    // vocab-allow: names the NWS alert products layer, upstream data
    set === HEAT_FIRE_ALERTS ? 'Heat & fire weather alerts' : (set ?? HEAT_FIRE_ALERTS).name,
    NWS_ALERT_LEGEND.filter(({ label }) => events.includes(label)),
    note
  );
}

function clearTimer(timer: number | null): void {
  if (timer !== null) window.clearTimeout(timer);
}

function scheduleExpiryPrune(
  map: maplibregl.Map,
  signal: AbortSignal
): void {
  clearTimer(expiryTimer);
  expiryTimer = null;
  const now = Date.now();
  const expiries = snapshotAlerts
    .map(({ expiresAt }) => expiresAt)
    .filter((expiry) => expiry > now);
  if (expiries.length === 0) return;
  const nextExpiry = Math.min(...expiries);
  const delay = Math.min(
    Math.max(nextExpiry - now + 25, 25),
    2_147_000_000
  );
  expiryTimer = window.setTimeout(() => {
    expiryTimer = null;
    if (signal.aborted) return;
    applyCurrentSnapshot(map, signal);
  }, delay);
}

function applyCurrentSnapshot(
  map: maplibregl.Map,
  signal: AbortSignal
): void {
  const active = activeAlertsAt(Date.now());
  ensureMapLayers(map, featureCollection(active));
  showSnapshotLegend(active);
  reportStatus(
    snapshotTruncated
      ? 'degraded'
      : active.length > 0
        ? 'ready'
        : 'no-data'
  );
  scheduleExpiryPrune(map, signal);
}

function clearDisplayedSnapshot(map: maplibregl.Map): void {
  clearTimer(expiryTimer);
  expiryTimer = null;
  snapshotAlerts = [];
  snapshotSet = null;
  snapshotTruncated = false;
  snapshotAsOf = null;
  const source = map.getSource(SOURCE_ID) as
    | maplibregl.GeoJSONSource
    | undefined;
  source?.setData(featureCollection([]));
}

function scheduleRefresh(map: maplibregl.Map, signal: AbortSignal): void {
  clearTimer(refreshTimer);
  refreshTimer = null;
  if (document.hidden || signal.aborted) return;
  const elapsed = Date.now() - lastRefreshStartedAt;
  const delay = Math.max(REFRESH_INTERVAL_MS - elapsed, 0);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshSnapshot(map, signal, false);
  }, delay);
}

async function refreshSnapshot(
  map: maplibregl.Map,
  signal: AbortSignal,
  initial: boolean
): Promise<void> {
  if (refreshInFlight || signal.aborted) return;
  refreshInFlight = true;
  lastRefreshStartedAt = Date.now();
  if (initial) reportStatus('loading');
  const set = modeAlertSet();

  try {
    // A mode that names no products gets no read, and no claim of none.
    if (set === null) throw new Error('the committed mode names no NWS products');
    const json = await fetchJsonWithBudget(
      buildQueryUrl(set.events),
      null,
      signal,
      FETCH_TIMEOUT_MS,
      // Simplified at the service (buildQueryUrl): 310 alerts were 224 KB gzipped
      // (measured 2026-10-15), 6.2 MB decoded unsimplified; this cap is headroom.
      64 * 1024 * 1024
    );
    // A mode change during the read: its answer is dropped, the finally reads again.
    if (signal.aborted || set !== modeAlertSet()) return;
    const payload = parseMapPayload(json, set.events);
    if (payload === null) {
      throw new Error('invalid WWA MapServer payload');
    }
    snapshotSet = set;
    snapshotAlerts = payload.held;
    snapshotTruncated = payload.truncated;
    snapshotAsOf = Date.now();
    applyCurrentSnapshot(map, signal);
  } catch (err) {
    if (signal.aborted || set !== modeAlertSet()) return;
    console.warn('[nws-alerts] WWA alerts fetch failed.', err);
    clearDisplayedSnapshot(map);
    showUnavailableLegend(set);
    reportStatus('error');
  } finally {
    refreshInFlight = false;
    if (!signal.aborted) {
      if (set !== modeAlertSet()) void refreshSnapshot(map, signal, true);
      else scheduleRefresh(map, signal);
    }
  }
}

/** The mode changed while the layer is on: its own products replace the old at once. */
function onModeChange(): void {
  if (!activeMap || !masterController || modeAlertSet() === snapshotSet) return;
  clearDisplayedSnapshot(activeMap);
  hideLegend(LAYER_KEY);
  emitSnapshot('loading');
  void refreshSnapshot(activeMap, masterController.signal, true);
}

function onVisibilityChange(): void {
  if (!activeMap || !masterController) return;
  const signal = masterController.signal;
  if (document.hidden) {
    clearTimer(refreshTimer);
    refreshTimer = null;
    return;
  }

  const snapshotAge =
    snapshotAsOf === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - snapshotAsOf;
  const attemptAge = Date.now() - lastRefreshStartedAt;
  if (
    snapshotAge >= REFRESH_INTERVAL_MS &&
    attemptAge >= REFRESH_INTERVAL_MS &&
    !refreshInFlight
  ) {
    void refreshSnapshot(activeMap, signal, false);
    return;
  }
  scheduleRefresh(activeMap, signal);
}

/**
 * Fetch the mode's active products and add the source plus fill and outline
 * layers. Idempotent. An empty FeatureCollection is `'no-data'`: none of the
 * requested products in force anywhere is a legitimate (and good) result,
 * not an error.
 */
export async function activate(
  map: maplibregl.Map,
  activation?: LayerActivation
): Promise<void> {
  if (activeMap === map && map.getSource(SOURCE_ID)) return;

  // Supersede any prior in-flight fetch before starting a new one.
  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  // The controller-owned attempt signal joins the private controller, so an
  // off intent aborts the held first read at that moment and not at the 15 s
  // budget behind the queued teardown (plan rule 5). The link lasts only
  // while the first read is in flight; later refreshes are aborted by
  // `deactivate`, as before.
  const unlink = linkAbort(masterController, activation?.signal ?? null);
  activeMap = map;
  refreshInFlight = false;
  lastRefreshStartedAt = 0;
  snapshotAsOf = null;
  snapshotAlerts = [];
  snapshotSet = null;
  snapshotTruncated = false;
  clearTimer(refreshTimer);
  clearTimer(expiryTimer);
  refreshTimer = null;
  expiryTimer = null;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  stopModeWatch?.();
  stopModeWatch = onHazardClusterChange(onModeChange);
  emitSnapshot('loading');
  try {
    await refreshSnapshot(map, signal, true);
  } finally {
    unlink();
  }
}

/**
 * Off intent (the controller calls this synchronously, ahead of the teardown
 * it queues behind the fade): stop following the mode, so a mode change
 * during the fade neither empties the polygons nor starts a read the
 * teardown would abort. Any later activation follows the mode again.
 */
export function cancelActivation(): void {
  stopModeWatch?.();
  stopModeWatch = null;
}

/**
 * Abort any in-flight fetch and remove the fill, outline, and source. All
 * guards are defensive so callers can invoke `deactivate` without first
 * verifying activation state.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  clearTimer(refreshTimer);
  clearTimer(expiryTimer);
  refreshTimer = null;
  expiryTimer = null;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopModeWatch?.();
  stopModeWatch = null;
  hideLegend(LAYER_KEY);
  activeMap = null;
  refreshInFlight = false;
  lastRefreshStartedAt = 0;
  snapshotAsOf = null;
  snapshotAlerts = [];
  snapshotSet = null;
  snapshotTruncated = false;
  emitSnapshot('inactive');
}

/** The frame's explanation for issuer time text DDM does not parse (PF1; the M25 builders' wording). */
const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';

/**
 * One alert time as the WWA feature states it (PF1): epoch milliseconds or
 * date text read as an instant, shown in the viewer's zone with the zone
 * named (the legacy popup showed local time with no zone, and printed an
 * empty line for an epoch value); any other text as the issuer supplied it,
 * never dropped; a missing, blank, or non-text non-numeric value absent.
 */
function alertClock(label: 'From' | 'Until', value: unknown): PopupClock | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 1000) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return { kind: 'point', meaning: 'valid', label, at: { precision: 'instant', at: ms, zone } };
  }
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null;
  return { kind: 'point', meaning: 'valid', label, at: { precision: 'supplied', text: String(value), explanation: SUPPLIED_TIME_EXPLANATION } };
}

/**
 * The alert polygon's popup model (S30D D1 M26b; DDM-P11-T04;
 * interface-chrome-popups-text.md 3.5 row 8). The head: "National Weather
 * Service alert"; "Issued by: NOAA NWS", with the issuing office where the
 * feature names one (its leading K dropped, as the legacy popup printed
 * it); the product name verbatim with the NWS display swatch the map draws
 * it in; the first present clock of From and Until (the head keeps one
 * line, DR-179's note for M26's builders; the frame moves Until to the
 * body's clock slot directly under the head); NWS Active Alerts. The body:
 * the layer's own description, then NWS Heat Safety, for the heat and fire
 * weather products only; any other product has no qualification sentence
 * (the zone sentence is not true of storm-based polygons). The valid window
 * is shown where the alert states it (an alert without its window would read
 * as a permanent condition; an end the alert does not state reads "End not
 * stated"), and the link routes to the NWS active-alerts page rather than
 * the raw Common Alerting Protocol JSON the WWA `url` attribute carries.
 * Reads the map feature's properties: the NormalizedAlert fields.
 */
export function buildNwsAlertPopupModel(props: GeoJsonProperties): IssuedModel {
  const p = props ?? {};
  const named = p['event'];
  // vocab-allow: fallback title for an NWS alert product, upstream data
  const event = typeof named === 'string' && named.trim() !== '' ? named : 'Weather alert';
  const issuer = p['issuer'];
  const office = typeof issuer === 'string' && issuer.trim() !== '' ? issuer.replace(/^K/, '') : null;
  const swatch = Object.hasOwn(NWS_ALERT_COLORS, event)
    ? { table: 'NWS_ALERT_COLORS', classKey: event, color: NWS_ALERT_COLORS[event]! }
    : { table: 'NWS_ALERT_COLORS', classKey: 'default', color: NWS_ALERT_DEFAULT_COLOR };
  const from = alertClock('From', p['onset']);
  // An end the alert does not state is said to be so, never filled from another time.
  // DRAFT wording (pending the owner's read-back): "End not stated"; the place row and phone pane say "end not stated".
  const until: PopupClock = alertClock('Until', p['ends']) ?? { kind: 'not-stated', label: 'End', reason: 'not stated' };
  const heatFire = HEAT_FIRE_ALERTS.events.includes(event);
  return {
    kind: 'event',
    // vocab-allow: names the NWS alert product (design record 3.5 row 8), upstream data
    title: 'National Weather Service alert',
    issuer: { role: 'issued-by', name: office === null ? 'NOAA NWS' : `NOAA NWS, office ${office}`, productKey: 'nws-alerts' },
    value: [{ text: event, swatch }],
    clocks: from === null ? [until] : [from, until],
    // vocab-allow: names the NWS active-alerts page, upstream product name
    source: { link: { label: 'NWS Active Alerts', href: 'https://alerts.weather.gov/' } },
    moreLinks: heatFire ? [{ label: 'NWS Heat Safety', href: 'https://www.weather.gov/safety/heat' }] : [],
    qualifications: heatFire
      ? [
          // vocab-allow: describes the NWS alert products verbatim, upstream data
          'Active National Weather Service watch, warning, or advisory for extreme heat or fire weather. Polygons are NWS forecast-zone shapes, updated about every five minutes.'
        ]
      : []
  };
}

/**
 * Register the fill layer's click target with the InteractionCoordinator
 * (one response per click; D-0.7.0-058 ruling 5) and wire the hover
 * cursor affordance. Bound once on first activation.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [FILL_LAYER_ID],
    label: (feature) => {
      const event = feature.properties?.['event'];
      // vocab-allow: fallback title for an NWS alert product, upstream data
      return typeof event === 'string' && event.trim() !== '' ? event : 'Weather alert';
    },
    // The alert's frame model (S30D D1 M26b), painted by the coordinator.
    respond: (feature) => ({
      model: buildNwsAlertPopupModel(feature.properties ?? null)
    })
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
