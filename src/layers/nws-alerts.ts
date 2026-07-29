/**
 * National Weather Service (NWS) heat and fire-weather alert polygons (E2).
 *
 * Renders active NWS watches, warnings, and advisories for the module's two
 * foregrounded hazards: extreme heat (Extreme / Excessive Heat Warning and
 * Watch, Heat Advisory) and fire weather (Red Flag Warning, Fire Weather
 * Watch). Both the pre-2025 "Excessive Heat" and the post-Hazard-
 * Simplification "Extreme Heat" product names are requested so transitional
 * products never drop out silently.
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
 * Cancellation (CLAUDE.md section 6 invariant 5): master abort controller
 * superseded on each `activate`, aborted on `deactivate`, fetch through
 * `fetchJsonWithBudget`, late responses dropped.
 */

import type maplibregl from 'maplibre-gl';
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon
} from 'geojson';

import { URLS } from '../config/urls';
import {
  NWS_ALERT_COLORS,
  NWS_ALERT_DEFAULT_COLOR
} from '../config/palette';
import { registerClickTarget } from '../map/interaction-coordinator';
import { buildNwsAlertPopupHtml } from '../ui/popups';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
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

/**
 * The alert product names this layer requests: the two foregrounded hazards
 * only. Order is also the legend order if a legend panel is added later.
 */
const ALERT_EVENTS: readonly string[] = [ // vocab-allow: verbatim NWS product names, quoted source data
  'Extreme Heat Warning', // vocab-allow: verbatim NWS product names, quoted source data
  'Excessive Heat Warning',
  'Extreme Heat Watch',
  'Excessive Heat Watch',
  'Heat Advisory',
  'Red Flag Warning', // vocab-allow: verbatim NWS product names, quoted source data
  'Fire Weather Watch'
];

/**
 * Legend rows for the alert layer: the distinct hazards it requests, collapsing
 * the Extreme/Excessive heat pairs (which share a color) into one row each.
 * Colors come from the official NWS display palette in NWS_ALERT_COLORS.
 */
const ALERT_LEGEND: ReadonlyArray<{ color: string; label: string }> = [
  // vocab-allow: verbatim NWS product names, quoted source data
  { color: NWS_ALERT_COLORS['Extreme Heat Warning'], label: 'Extreme Heat Warning' },
  { color: NWS_ALERT_COLORS['Extreme Heat Watch'], label: 'Extreme Heat Watch' },
  { color: NWS_ALERT_COLORS['Heat Advisory'], label: 'Heat Advisory' },
  // vocab-allow: verbatim NWS product names, quoted source data
  { color: NWS_ALERT_COLORS['Red Flag Warning'], label: 'Red Flag Warning' },
  { color: NWS_ALERT_COLORS['Fire Weather Watch'], label: 'Fire Weather Watch' }
];

type Status = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';
type SnapshotEventStatus = Status | 'inactive';
type NwsAlertGeometry = Polygon | MultiPolygon;

interface NwsAlertProperties {
  readonly [key: string]: unknown;
  readonly prod_type: string;
  readonly onset?: string | number | null;
  readonly ends?: string | number | null;
  readonly expiration?: string | number | null;
  readonly wfo?: string | null;
}

type NwsAlertFeature = Feature<NwsAlertGeometry, NwsAlertProperties>;

interface NwsMapPayload {
  readonly features: readonly NwsAlertFeature[];
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
let snapshotFeatures: readonly NwsAlertFeature[] = [];
let snapshotTruncated = false;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

function emitSnapshot(status: SnapshotEventStatus): void {
  window.dispatchEvent(
    new CustomEvent(SNAPSHOT_EVENT, {
      detail: {
        status,
        asOf: snapshotAsOf,
        truncated: snapshotTruncated
      }
    })
  );
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Build the GeoJSON query URL. The `where` clause restricts to the heat and
 * fire-weather products; `outFields` is limited to what the popup reads.
 */
function buildQueryUrl(): string {
  const quoted = ALERT_EVENTS.map((e) => `'${e}'`).join(',');
  const params = new URLSearchParams({
    where: `prod_type IN (${quoted})`,
    outFields: 'prod_type,onset,ends,expiration,wfo',
    outSR: '4326',
    returnGeometry: 'true',
    f: 'geojson'
  });
  return `${URLS.nwsWwaMapServer}/query?${params.toString()}`;
}

function isIssuerTime(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Date.parse(value))
  );
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

/** A malformed HTTP 200 response must not become a clean zero. */
function parseMapPayload(json: unknown): NwsMapPayload | null {
  if (
    !isObject(json) ||
    json.type !== 'FeatureCollection' ||
    !Array.isArray(json.features) ||
    (json.exceededTransferLimit !== undefined &&
      typeof json.exceededTransferLimit !== 'boolean')
  ) {
    return null;
  }

  const features: NwsAlertFeature[] = [];
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
    const hasExpiry =
      (properties.expiration !== undefined &&
        properties.expiration !== null) ||
      (properties.ends !== undefined && properties.ends !== null);
    if (
      typeof properties.prod_type !== 'string' ||
      !ALERT_EVENTS.includes(properties.prod_type) ||
      !hasExpiry ||
      !isIssuerTime(properties.onset) ||
      !isIssuerTime(properties.ends) ||
      !isIssuerTime(properties.expiration) ||
      (properties.wfo !== undefined &&
        properties.wfo !== null &&
        typeof properties.wfo !== 'string')
    ) {
      return null;
    }
    features.push(candidate as unknown as NwsAlertFeature);
  }

  return {
    features,
    truncated: json.exceededTransferLimit === true
  };
}

function issuerTimeMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function featureExpiryMs(feature: NwsAlertFeature): number | null {
  return (
    issuerTimeMs(feature.properties.expiration) ??
    issuerTimeMs(feature.properties.ends)
  );
}

function activeFeaturesAt(now: number): NwsAlertFeature[] {
  return snapshotFeatures.filter((feature) => {
    const expiry = featureExpiryMs(feature);
    return expiry === null || expiry > now;
  });
}

function featureCollection(
  features: readonly NwsAlertFeature[]
): FeatureCollection<NwsAlertGeometry, NwsAlertProperties> {
  return {
    type: 'FeatureCollection',
    features: [...features]
  };
}

function colorExpression(): maplibregl.ExpressionSpecification {
  const matchArgs: (string | string[])[] = [];
  for (const [event, color] of Object.entries(NWS_ALERT_COLORS)) {
    matchArgs.push(event, color);
  }
  return [
    'match',
    ['get', 'prod_type'],
    ...matchArgs,
    NWS_ALERT_DEFAULT_COLOR
  ] as unknown as maplibregl.ExpressionSpecification;
}

function ensureMapLayers(
  map: maplibregl.Map,
  data: FeatureCollection<NwsAlertGeometry, NwsAlertProperties>
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

function formatSnapshotTime(time: number): string {
  return new Date(time).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function showSnapshotLegend(featureCount: number): void {
  const asOf =
    snapshotAsOf === null
      ? ''
      : ` Snapshot as of ${formatSnapshotTime(snapshotAsOf)}.`;
  const note = snapshotTruncated
    ? `Results may be incomplete because the National Weather Service response reached its transfer limit.${asOf}`
    : featureCount === 0
      ? `No active requested National Weather Service products.${asOf}`
      : `Active National Weather Service products.${asOf}`;
  const section = showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event,
    render: (body) =>
      renderSwatchLegend(
        body,
        // vocab-allow: names the NWS alert products layer, upstream data
        'Heat & fire weather alerts',
        ALERT_LEGEND,
        note
      )
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
        : 'no-data'
  );
}

function showUnavailableLegend(): void {
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event,
    render: (body) =>
      renderSwatchLegend(
        body,
        // vocab-allow: names the NWS alert products layer, upstream data
        'Heat & fire weather alerts',
        ALERT_LEGEND,
        'The National Weather Service product snapshot is unavailable.'
      )
  });
  emitSnapshot('error');
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
  const expiries = snapshotFeatures
    .map(featureExpiryMs)
    .filter((expiry): expiry is number => expiry !== null && expiry > now);
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
  const activeFeatures = activeFeaturesAt(Date.now());
  ensureMapLayers(map, featureCollection(activeFeatures));
  showSnapshotLegend(activeFeatures.length);
  reportStatus(
    snapshotTruncated
      ? 'degraded'
      : activeFeatures.length > 0
        ? 'ready'
        : 'no-data'
  );
  scheduleExpiryPrune(map, signal);
}

function clearDisplayedSnapshot(map: maplibregl.Map): void {
  clearTimer(expiryTimer);
  expiryTimer = null;
  snapshotFeatures = [];
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

  try {
    const json = await fetchJsonWithBudget(
      buildQueryUrl(),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (signal.aborted) return;
    const payload = parseMapPayload(json);
    if (payload === null) {
      throw new Error('invalid WWA MapServer payload');
    }
    snapshotFeatures = payload.features;
    snapshotTruncated = payload.truncated;
    snapshotAsOf = Date.now();
    applyCurrentSnapshot(map, signal);
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[nws-alerts] WWA alerts fetch failed.', err);
    clearDisplayedSnapshot(map);
    showUnavailableLegend();
    reportStatus('error');
  } finally {
    refreshInFlight = false;
    if (!signal.aborted) scheduleRefresh(map, signal);
  }
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
 * Fetch the active heat and fire-weather alerts and add the source plus fill
 * and outline layers. Idempotent. An empty FeatureCollection is `'no-data'`:
 * no active heat or fire-weather alerts anywhere is a legitimate (and good)
 * result, not an error.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (activeMap === map && map.getSource(SOURCE_ID)) return;

  // Supersede any prior in-flight fetch before starting a new one.
  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  activeMap = map;
  refreshInFlight = false;
  lastRefreshStartedAt = 0;
  snapshotAsOf = null;
  snapshotFeatures = [];
  snapshotTruncated = false;
  clearTimer(refreshTimer);
  clearTimer(expiryTimer);
  refreshTimer = null;
  expiryTimer = null;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  emitSnapshot('loading');
  await refreshSnapshot(map, signal, true);
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
  hideLegend(LAYER_KEY);
  activeMap = null;
  refreshInFlight = false;
  lastRefreshStartedAt = 0;
  snapshotAsOf = null;
  snapshotFeatures = [];
  snapshotTruncated = false;
  emitSnapshot('inactive');
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
      const event = feature.properties?.['prod_type'];
      // vocab-allow: fallback title for an NWS alert product, upstream data
      return typeof event === 'string' && event.trim() !== '' ? event : 'Weather alert';
    },
    respond: (feature) => ({
      content: buildNwsAlertPopupHtml(feature.properties ?? null)
    })
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
