/**
 * The Alerts pane (mobile shell, 2026-07-14; the footer's fourth door,
 * from the ratified 2026-07-11 mockup).
 *
 * Reflect-the-map, like the conditions strip and the hover inspector: the
 * pane renders ONLY what the `nws-alerts` layer already fetched (the NOAA
 * Watch/Warning/Advisory features in the loaded map view). Opening the
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

import type maplibregl from 'maplibre-gl';

import { NWS_ALERT_COLORS, NWS_ALERT_DEFAULT_COLOR } from '../config/palette';
import { registry } from '../state/registry';
import { requestLayerOn } from './layer-toggle-command';
import { escapeHtml } from '../util/escape';

const LAYER_KEY = 'nws-alerts';
const SOURCE_ID = 'nws-alerts';

let armed = false;
let mapRef: maplibregl.Map | null = null;

interface AlertRow {
  readonly type: string;
  readonly office: string;
  readonly ends: string;
  readonly color: string;
}

/** Format an epoch-milliseconds end time as a short local readout. */
function formatEnds(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `to ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${day} ${time}`;
}

/** The deduplicated alert rows currently present in the loaded source tiles. */
function collectAlerts(map: maplibregl.Map): AlertRow[] {
  if (!map.getSource(SOURCE_ID)) return [];
  const features = map.querySourceFeatures(SOURCE_ID);
  const seen = new Set<string>();
  const rows: AlertRow[] = [];
  for (const f of features) {
    const props = f.properties ?? {};
    const type = typeof props['prod_type'] === 'string' ? props['prod_type'] : '';
    if (!type) continue;
    const office = typeof props['wfo'] === 'string' ? props['wfo'] : '';
    const key = `${type}|${office}|${String(props['onset'] ?? '')}|${String(props['ends'] ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      type,
      office,
      ends: formatEnds(props['ends'] ?? props['expiration']),
      color: NWS_ALERT_COLORS[type] ?? NWS_ALERT_DEFAULT_COLOR
    });
  }
  // Warnings ahead of watches ahead of the rest, then alphabetical: the
  // most urgent word first, matching the severity language of weather.gov.
  const rank = (t: string): number =>
    t.includes('Warning') ? 0 : t.includes('Watch') ? 1 : 2;
  rows.sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type));
  return rows;
}

function render(): void {
  const body = document.getElementById('sheet-alerts-body');
  if (!body || !mapRef) return;

  const status = registry.getStatus(LAYER_KEY);
  const active = registry.getActiveKeys().has(LAYER_KEY);
  const rows = active ? collectAlerts(mapRef) : [];

  if (rows.length > 0) {
    body.innerHTML =
      '<p class="sheet-alerts-note">Active National Weather Service heat and fire-weather alerts in the current map view. Each alert also shades its area on the map.</p>' +
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

  if (!active || status === 'loading') {
    body.innerHTML = '<p class="sheet-alerts-note">Checking the National Weather Service alert feed for the current view.</p>';
    return;
  }
  if (status === 'error') {
    body.innerHTML =
      '<p class="sheet-alerts-note">The National Weather Service alert feed is not reachable right now. Current alerts are always available at <a href="https://www.weather.gov/alerts" target="_blank" rel="noopener">weather.gov/alerts</a>.</p>';
    return;
  }
  body.innerHTML = '<p class="sheet-alerts-note">No active heat or fire-weather alerts in the current map view.</p>';
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
  map.on('sourcedata', (e) => {
    if (e.sourceId === SOURCE_ID) render();
  });
  map.on('moveend', render);
}
