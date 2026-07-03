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
 * `fetchWithBudget`, late responses dropped.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  NWS_ALERT_COLORS,
  NWS_ALERT_DEFAULT_COLOR
} from '../config/palette';
import { buildNwsAlertPopupHtml } from '../ui/popups';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';

const LAYER_KEY = 'nws-alerts';
const SOURCE_ID = 'nws-alerts';
const FILL_LAYER_ID = 'nws-alerts-fill';
const OUTLINE_LAYER_ID = 'nws-alerts-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

/**
 * Symbol layer ID used as the `beforeId` anchor so alert polygons stack below
 * the basemap label glyphs, matching the other polygon overlay modules.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the WWA query. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * The alert product names this layer requests: the two foregrounded hazards
 * only. Order is also the legend order if a legend panel is added later.
 */
const ALERT_EVENTS: readonly string[] = [
  'Extreme Heat Warning',
  'Excessive Heat Warning',
  'Extreme Heat Watch',
  'Excessive Heat Watch',
  'Heat Advisory',
  'Red Flag Warning',
  'Fire Weather Watch'
];

/**
 * Legend rows for the alert layer: the distinct hazards it requests, collapsing
 * the Extreme/Excessive heat pairs (which share a color) into one row each.
 * Colors come from the official NWS display palette in NWS_ALERT_COLORS.
 */
const ALERT_LEGEND: ReadonlyArray<{ color: string; label: string }> = [
  { color: NWS_ALERT_COLORS['Extreme Heat Warning'], label: 'Extreme Heat Warning' },
  { color: NWS_ALERT_COLORS['Extreme Heat Watch'], label: 'Extreme Heat Watch' },
  { color: NWS_ALERT_COLORS['Heat Advisory'], label: 'Heat Advisory' },
  { color: NWS_ALERT_COLORS['Red Flag Warning'], label: 'Red Flag Warning' },
  { color: NWS_ALERT_COLORS['Fire Weather Watch'], label: 'Fire Weather Watch' }
];

type Status = 'loading' | 'ready' | 'error' | 'no-data';

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` so a superseded request can
 * never render into a torn-down layer.
 */
let masterController: AbortController | null = null;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
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
    f: 'geojson'
  });
  return `${URLS.nwsWwaMapServer}/query?${params.toString()}`;
}

/**
 * Fetch the active heat and fire-weather alerts and add the source plus fill
 * and outline layers. Idempotent. An empty FeatureCollection is `'no-data'`:
 * no active heat or fire-weather alerts anywhere is a legitimate (and good)
 * result, not an error.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  // Supersede any prior in-flight fetch before starting a new one.
  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let geojson: FeatureCollection;
  try {
    const response = await fetchWithBudget(
      buildQueryUrl(),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    geojson = (await response.json()) as FeatureCollection;
  } catch (err) {
    // Aborted means superseded or deactivated; drop silently per invariant 5.
    if (signal.aborted) return;
    console.warn('[nws-alerts] WWA alerts fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'NOAA NWS'
  });

  if (features.length === 0) {
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  // Color by product type via a `match` expression against the official NWS
  // display colors. The fallback color only applies if NOAA ships a product
  // outside the requested set, which would be a data anomaly worth seeing.
  const matchArgs: (string | string[])[] = [];
  for (const [event, color] of Object.entries(NWS_ALERT_COLORS)) {
    matchArgs.push(event, color);
  }
  const colorExpression = [
    'match',
    ['get', 'prod_type'],
    ...matchArgs,
    NWS_ALERT_DEFAULT_COLOR
  ] as unknown as maplibregl.ExpressionSpecification;

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': colorExpression,
        'fill-opacity': 0.35
      }
    },
    beforeId
  );

  map.addLayer(
    {
      id: OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': colorExpression,
        'line-width': 1,
        'line-opacity': 0.9
      }
    },
    beforeId
  );

  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Heat & fire weather alerts',
        ALERT_LEGEND,
        'Active NWS watches, warnings, and advisories (heat and fire weather).'
      )
  });
  reportStatus('ready');
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
  hideLegend(LAYER_KEY);
}

/**
 * Wire the click-to-popup handler and hover cursor affordance on the fill
 * layer. Bound once at boot, independent of activation.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const props: GeoJsonProperties = feature.properties ?? null;
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(buildNwsAlertPopupHtml(props))
      .addTo(map);
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
