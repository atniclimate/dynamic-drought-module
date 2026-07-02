/**
 * Conditions strip (UX-3): a dated at-a-glance summary at the top of the
 * sidebar answering "what is happening in the view right now."
 *
 * Three metrics:
 *   - worst drought category in view (US Drought Monitor)
 *   - active heat and fire-weather alert count in view (NWS alerts)
 *   - active wildfire count in view (NIFC perimeters)
 *
 * Data model (ratified direction: reflect the map, honestly). The strip reads
 * ONLY what is currently rendered, through `map.queryRenderedFeatures` against
 * each layer's fill. It fetches nothing of its own and stands up no backend:
 * a metric shows a number only when its layer is active and rendered, and an
 * honest "off" state otherwise. This keeps the strip consistent with the
 * module's invariants (no backend, lazy-loaded layers, honest feedback) and
 * with the mutually-exclusive-surface rule: the US Drought Monitor is a
 * condition surface, so its number is present when it is the active surface
 * and yields to an "off" hint when the user switches to another surface.
 *
 * "In view" means the current viewport. Each source holds its whole
 * FeatureCollection, so only `queryRenderedFeatures` (viewport-clipped) gives
 * an in-view answer; `querySourceFeatures` would return the whole nation.
 *
 * Recompute is driven by the map settling (`idle`, `moveend`) and by the
 * layer registry changing (`change`, `status-change`), coalesced to one
 * render per frame so a burst of events does not thrash the DOM.
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { registry } from '../state/registry';
import { USDM_CATEGORIES } from '../config/palette';
import { escapeHtml } from '../util/escape';

// ---------------------------------------------------------------------------
// Layer keys and fill-layer ids
//
// These fill-layer ids are module-private constants in the layer modules
// (usdm.ts, nws-alerts.ts, nifc-fires.ts). They are restated here rather than
// exported so the strip stays a pure read-only observer that adds no coupling
// to those modules' public surface. The UX-3 smoke spec asserts the drought
// value renders, so a future id rename surfaces as a failing test, not a
// silent blank.
// ---------------------------------------------------------------------------

const USDM_KEY = 'usdm';
const USDM_FILL = 'usdm-current-fill';

const ALERTS_KEY = 'nws-alerts';
const ALERTS_FILL = 'nws-alerts-fill';

const FIRES_KEY = 'nifc-fires';
const FIRES_FILL = 'nifc-fires-fill';

interface Metric {
  /** Headline value: a category code, a count, or an em-dash-free placeholder. */
  readonly value: string;
  /** One-line context under the value. */
  readonly sublabel: string;
  /** Visual tone: live data, a real zero/none, or the layer being off. */
  readonly tone: 'data' | 'none' | 'off';
  /** Optional value color (the drought category color). */
  readonly color?: string;
}

// ---------------------------------------------------------------------------
// Property readers (defensive; the ESRI GeoJSON casing is uppercase canonical
// with lowercase fallbacks observed in the layer modules)
// ---------------------------------------------------------------------------

function readInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function readDm(props: GeoJsonProperties): number | null {
  if (!props) return null;
  return readInt(props['DM'] ?? props['dm']);
}

function readMapDateMs(props: GeoJsonProperties): number | null {
  if (!props) return null;
  const n = Number(props['MapDate'] ?? props['mapDate']);
  return Number.isFinite(n) ? n : null;
}

/**
 * Count distinct features by an identity key, so a multi-polygon alert or
 * perimeter counts once. Features whose identity is empty each count once
 * (a blank key must not collapse unrelated features into a single tally).
 */
function countDistinct(
  feats: readonly maplibregl.MapGeoJSONFeature[],
  keyOf: (props: GeoJsonProperties) => string
): number {
  const seen = new Set<string>();
  feats.forEach((f, i) => {
    const key = keyOf(f.properties).trim();
    seen.add(key === '' ? `__anon_${i}` : key);
  });
  return seen.size;
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

/** The honest "active but not yet rendered" state, worded from the pill vocabulary. */
function pendingSublabel(key: string): string {
  switch (registry.getStatus(key)) {
    case 'loading':
      return 'loading...';
    case 'no-data':
      return 'no data';
    case 'error':
      return 'unavailable';
    default:
      return 'off';
  }
}

function droughtMetric(map: maplibregl.Map): { metric: Metric; dateMs: number | null } {
  const active = registry.getActiveKeys().has(USDM_KEY);
  if (!active) {
    return { metric: { value: '-', sublabel: 'US Drought Monitor off', tone: 'off' }, dateMs: null };
  }
  if (!map.getLayer(USDM_FILL)) {
    return { metric: { value: '-', sublabel: pendingSublabel(USDM_KEY), tone: 'off' }, dateMs: null };
  }

  const feats = map.queryRenderedFeatures({ layers: [USDM_FILL] });
  if (feats.length === 0) {
    // The USDM maps only D0 through D4 polygons; a viewport with none is
    // drought-free, which is a real reading, not missing data.
    return { metric: { value: 'None', sublabel: 'no drought in view', tone: 'none' }, dateMs: null };
  }

  let maxDm = -1;
  let dateMs: number | null = null;
  for (const f of feats) {
    const dm = readDm(f.properties);
    if (dm !== null && dm > maxDm) maxDm = dm;
    const d = readMapDateMs(f.properties);
    if (d !== null) dateMs = d; // every feature carries the same weekly MapDate
  }

  const cat = maxDm >= 0 && maxDm < USDM_CATEGORIES.length ? USDM_CATEGORIES[maxDm] : undefined;
  if (!cat) {
    return { metric: { value: 'None', sublabel: 'no drought in view', tone: 'none' }, dateMs };
  }
  return {
    metric: { value: cat.code, sublabel: `${cat.label} in view`, tone: 'data', color: cat.color },
    dateMs
  };
}

function alertsMetric(map: maplibregl.Map): Metric {
  if (!registry.getActiveKeys().has(ALERTS_KEY) || !map.getLayer(ALERTS_FILL)) {
    return { value: '-', sublabel: 'alerts layer off', tone: 'off' };
  }
  const feats = map.queryRenderedFeatures({ layers: [ALERTS_FILL] });
  const n = countDistinct(feats, (p) =>
    [p?.['prod_type'], p?.['onset'], p?.['ends'], p?.['wfo']].join('|')
  );
  return {
    value: String(n),
    sublabel: n === 1 ? 'heat/fire alert' : 'heat/fire alerts',
    tone: n > 0 ? 'data' : 'none'
  };
}

function firesMetric(map: maplibregl.Map): Metric {
  if (!registry.getActiveKeys().has(FIRES_KEY) || !map.getLayer(FIRES_FILL)) {
    return { value: '-', sublabel: 'wildfire layer off', tone: 'off' };
  }
  // Count wildfire (WF) and complex (CX) incidents; exclude prescribed burns
  // (RX), which are intentional and not "active wildfires" in the hazard read.
  const feats = map
    .queryRenderedFeatures({ layers: [FIRES_FILL] })
    .filter((f) => {
      const cat = f.properties?.['attr_IncidentTypeCategory'];
      return cat === 'WF' || cat === 'CX';
    });
  const n = countDistinct(feats, (p) =>
    String(p?.['attr_IncidentName'] ?? p?.['poly_IncidentName'] ?? p?.['IncidentName'] ?? '')
  );
  return {
    value: String(n),
    sublabel: n === 1 ? 'active wildfire' : 'active wildfires',
    tone: n > 0 ? 'data' : 'none'
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Compact "Mon D, YYYY" from a millisecond epoch, in UTC to match the USDM release date. */
function formatMapDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function renderMetric(key: string, m: Metric): string {
  const style = m.color ? ` style="color:${escapeHtml(m.color)}"` : '';
  return `
    <div class="conditions-metric" data-metric="${escapeHtml(key)}" data-tone="${m.tone}">
      <span class="conditions-value"${style}>${escapeHtml(m.value)}</span>
      <span class="conditions-sublabel">${escapeHtml(m.sublabel)}</span>
    </div>`;
}

function render(map: maplibregl.Map): void {
  const strip = document.getElementById('conditions-strip');
  const metricsEl = document.getElementById('conditions-metrics');
  const dateEl = document.getElementById('conditions-date');
  if (!strip || !metricsEl) return;

  const drought = droughtMetric(map);
  const alerts = alertsMetric(map);
  const fires = firesMetric(map);

  metricsEl.innerHTML = [
    renderMetric('drought', drought.metric),
    renderMetric('alerts', alerts),
    renderMetric('fires', fires)
  ].join('');

  if (dateEl) {
    dateEl.textContent = drought.dateMs !== null ? `as of ${formatMapDate(drought.dateMs)}` : '';
  }

  strip.hidden = false;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Build and wire the conditions strip. Called once from `buildSidebar` after
 * the map has loaded. Renders immediately (showing honest loading/off states
 * until layers settle) and re-renders when the map settles or the active-layer
 * set changes. The strip lives for the app lifetime, so listeners are not
 * torn down.
 */
export function buildConditionsStrip(map: maplibregl.Map): void {
  let scheduled = false;
  const scheduleRender = (): void => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      render(map);
    });
  };

  render(map);

  registry.on('change', scheduleRender);
  registry.on('status-change', scheduleRender);
  map.on('idle', scheduleRender);
  map.on('moveend', scheduleRender);
}
