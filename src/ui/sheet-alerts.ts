/**
 * The Alerts pane (mobile shell, 2026-07-14; the footer's fourth door,
 * from the ratified 2026-07-11 mockup).
 *
 * Reflect-the-map, like the conditions strip and the hover inspector: the
 * pane renders ONLY what the `nws-alerts` layer already fetched (the NOAA
 * Watch/Warning/Advisory features drawn in the current view). Opening the
 * pane requests the layer on through the one toggle command, so the
 * registry, the URL, and the catalog checkbox stay honest; nothing is
 * fetched here directly. Severity colors come from the same
 * NWS_ALERT_COLORS table the map fill uses, so a row's dot always matches
 * its polygon.
 *
 * Honest states: the layer's own status word while it is loading or
 * unavailable; a plain "no active alerts in the current map view" when the
 * feed returns clean; never an invented alert and never a spinner that
 * outlives the fetch.
 *
 * Lazy-loaded from the footer wiring (mobile, non-embed only), so desktop
 * and embed sessions never download this chunk.
 */

import type * as maplibregl from 'maplibre-gl';

import { HAZARD_CLUSTERS, HEAT_FIRE_ALERTS } from '../config/clusters';
import { NWS_ALERT_COLORS, NWS_ALERT_DEFAULT_COLOR } from '../config/palette';
import { getSelectedHazard } from '../state/cluster-service';
import { registry } from '../state/registry';
import { isChecked } from './island/bridge';
import { requestLayerOn } from './layer-toggle-command';
import { escapeHtml } from '../util/escape';

const LAYER_KEY = 'nws-alerts';
const SOURCE_ID = 'nws-alerts';
// The alerts fill (src/layers/nws-alerts.ts), restated as strip-metrics.ts does.
const FILL_ID = 'nws-alerts-fill';

let armed = false;
let mapRef: maplibregl.Map | null = null;

interface AlertRow {
  readonly type: string;
  readonly office: string;
  readonly ends: string;
  readonly color: string;
}

/** Format an alert's end (ISO 8601 text, src/layers/nws-alerts.ts NormalizedAlert) as a short local readout. */
function formatEnds(value: unknown): string {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `to ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${day} ${time}`;
}

/**
 * The deduplicated alert rows drawn in the current view. Rendered features,
 * as the desktop strip counts them (src/ui/island/strip-metrics.ts): the
 * source's loaded tiles reach past the view, and the pane says "in the
 * current map view".
 */
function collectAlerts(map: maplibregl.Map): AlertRow[] {
  if (!map.getLayer(FILL_ID)) return [];
  const features = map.queryRenderedFeatures({ layers: [FILL_ID] });
  const seen = new Set<string>();
  const rows: AlertRow[] = [];
  for (const f of features) {
    const props = f.properties ?? {};
    const type = typeof props['event'] === 'string' ? props['event'] : '';
    if (!type) continue;
    const office = typeof props['issuer'] === 'string' ? props['issuer'] : '';
    const key = `${type}|${office}|${String(props['onset'] ?? '')}|${String(props['ends'] ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      type,
      office,
      // DRAFT wording (pending the owner's read-back): the alert popup's "End not stated".
      ends: props['ends'] == null ? 'end not stated' : formatEnds(props['ends']),
      color: NWS_ALERT_COLORS[type] ?? NWS_ALERT_DEFAULT_COLOR
    });
  }
  // Warnings ahead of watches ahead of the rest, then alphabetical: the
  // most urgent word first, matching the severity language of weather.gov.
  const rank = (t: string): number => // vocab-allow: matches the verbatim NWS product type strings, upstream data
    t.includes('Warning') ? 0 : t.includes('Watch') ? 1 : 2;
  rows.sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type));
  return rows;
}

function render(): void {
  const body = document.getElementById('sheet-alerts-body');
  if (!body || !mapRef) return;
  // The stylesheet's own gate: a hidden pane is not queried or rewritten on
  // every pan; each Alerts tap renders once as it opens.
  const app = document.getElementById('app');
  const detent = app?.getAttribute('data-sheet-detent');
  // vocab-allow: the sheet tab's DOM token, not surface copy
  if (app?.getAttribute('data-sheet-tab') !== 'alerts' || (detent !== 'half' && detent !== 'full')) return;

  const status = registry.getStatus(LAYER_KEY);
  const active = registry.getActiveKeys().has(LAYER_KEY);
  const rows = active ? collectAlerts(mapRef) : [];
  // The heat and fire weather set keeps its own words; any other set the layer's own no-result note.
  const heatFire = HAZARD_CLUSTERS[getSelectedHazard()].alerts === HEAT_FIRE_ALERTS;

  if (rows.length > 0) {
    body.innerHTML =
      (heatFire
        // vocab-allow: describes the NWS alert products and feed, upstream data
        ? '<p class="sheet-alerts-note">Active National Weather Service heat and fire-weather alerts in the current map view. Each alert also shades its area on the map.</p>'
        // DRAFT wording (pending the owner's read-back)
        // vocab-allow: describes the NWS alert products, upstream data
        : '<p class="sheet-alerts-note">Active National Weather Service products in the current map view. Each alert also shades its area on the map.</p>') +
      '<div class="sheet-alerts-list">' +
      rows
        .map(
          (r) =>
            `<div class="sheet-alert-row"><span class="sheet-alert-dot" style="background:${escapeHtml(
              r.color
            )}"></span><span class="sheet-alert-type">${escapeHtml(r.type)}</span><span class="sheet-alert-meta">${escapeHtml(
              [r.office ? `NWS ${r.office}` : '', r.ends].filter(Boolean).join(' · ')
            )}</span></div>`
        )
        .join('') +
      '</div>';
    return;
  }

  // A failed activation that stays checked (a recipe member of the committed
  // cluster, D1 M5, 2026-09-27) is not registered active, so the failure is
  // read before the not-yet-active case, which would otherwise say
  // "Checking" for good. A failed key the controller unchecked is re-asked
  // by the pane's own requestLayerOn, and its 'loading' status-change
  // (subscribed below) replaces the stale failure before the next paint.
  const failedButChecked = status === 'error' && !active && isChecked(LAYER_KEY);
  if (!failedButChecked && (!active || status === 'loading')) {
    // vocab-allow: describes the NWS alert products and feed, upstream data
    body.innerHTML = '<p class="sheet-alerts-note">Checking the National Weather Service alert feed for the current view.</p>';
    return;
  }
  if (status === 'error') {
    body.innerHTML = // vocab-allow: describes the NWS alert products and feed, upstream data
      '<p class="sheet-alerts-note">The National Weather Service alert feed is not reachable right now. Current alerts are always available at <a href="https://www.weather.gov/alerts" target="_blank" rel="noopener">weather.gov/alerts</a>.</p>';
    return;
  }
  // A cut-off answer may have dropped the alerts of this view: no claim of none.
  if (status === 'degraded') {
    // DRAFT wording (pending the owner's read-back): the place popup's own "the response was incomplete".
    body.innerHTML = // vocab-allow: describes the NWS alert feed, upstream data
      '<p class="sheet-alerts-note">The National Weather Service response was incomplete, so this view cannot rule an alert out.</p>';
    return;
  }
  body.innerHTML = heatFire
    // vocab-allow: describes the NWS alert products and feed, upstream data
    ? '<p class="sheet-alerts-note">No active heat or fire-weather alerts in the current map view.</p>'
    // DRAFT wording (pending the owner's read-back): the layer's own no-result note, scoped to the view.
    : '<p class="sheet-alerts-note">No active requested National Weather Service products in the current map view.</p>';
}

/**
 * Open the Alerts pane: request the alerts layer on (idempotent through
 * the one toggle command) and keep the list in step with the layer's
 * status and arriving source data. Called by the footer wiring on every
 * Alerts tap; arming is once.
 */
export function openSheetAlerts(map: maplibregl.Map): void {
  mapRef = map;
  requestLayerOn(LAYER_KEY);
  render();
  if (armed) return;
  armed = true;
  registry.on('change', render);
  registry.on('status-change', (key) => {
    if (key === LAYER_KEY) render();
  });
  // Rendered features exist only after the frame draws: arriving alert data
  // is read on the next render, as the strip does (src/ui/island/index.tsx),
  // never on global idle, which an animated layer can hold off.
  let sourceDirty = false;
  map.on('sourcedata', (e) => {
    if (e.sourceId === SOURCE_ID) sourceDirty = true;
  });
  map.on('render', () => {
    if (!sourceDirty) return;
    sourceDirty = false;
    render();
  });
  map.on('moveend', render);
}
