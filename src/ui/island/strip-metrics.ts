/**
 * Conditions-strip metric computation (UX-3), carried verbatim from the
 * retired vanilla `src/ui/conditions-strip.ts` when the island view
 * layer landed (ADR 0002, D-0.7.0-021). The rendering lives in
 * `conditions-strip.tsx`; everything in this file is framework-free
 * computation.
 *
 * Data model (ratified direction: reflect the map, honestly). The strip
 * reads ONLY what is currently rendered, through
 * `map.queryRenderedFeatures` against each layer's fill. It fetches
 * nothing of its own and stands up no backend: a metric shows a number
 * only when its layer is active and rendered, and an honest "off" state
 * otherwise. "In view" means the current viewport; only
 * `queryRenderedFeatures` (viewport-clipped) gives an in-view answer.
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { registry } from '../../state/registry';
import { timeline } from '../../state/timeline';
import { USDM_CATEGORIES } from '../../config/palette';

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
// The two frame-slot fills of the week scrubber (0.5.0b); only the visible
// slot matches queryRenderedFeatures (the hidden slot carries visibility
// 'none'), so the strip always reads the week actually on screen.
const USDM_FILLS = ['usdm-frame-a-fill', 'usdm-frame-b-fill'] as const;
// The change-map fill (the derivative register); rendered when the user
// swaps the absolute categories for the 1-week / 4-week change view.
const USDM_CHANGE_FILL = 'usdm-change-fill';

const ALERTS_KEY = 'nws-alerts';
const ALERTS_FILL = 'nws-alerts-fill';

const FIRES_KEY = 'nifc-fires';
const FIRES_FILL = 'nifc-fires-fill';

export interface Metric {
  /** Headline value: a category code, a count, or an em-dash-free placeholder. */
  readonly value: string;
  /** One-line context under the value. */
  readonly sublabel: string;
  /** Visual tone: live data, a real zero/none, the layer being off, or a
   * layer that is active but still fetching (the skeleton-shimmer tile). */
  readonly tone: 'data' | 'none' | 'off' | 'loading';
  /** Optional value color (the drought category color). */
  readonly color?: string;
  /**
   * The rendered data is real but older than the feed's publish cadence (a
   * drifted or frozen upstream). The value still shows (it is the best we have)
   * but is marked stale so it never reads as confidently current
   * (critical-review #6). Currently only the weekly USDM surface sets this.
   */
  readonly stale?: boolean;
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

/**
 * First candidate that is a non-blank string, else the empty string. The
 * WFIGS attribute fields can be present-but-empty (the IRWIN record and the
 * perimeter collector fall out of sync), and `??` stops at an empty string,
 * so a plain nullish chain would key several fragments of one incident to
 * distinct anonymous identities and overcount.
 */
function firstNonBlank(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (s !== '') return s;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

/**
 * The honest "active but not yet rendered" state, worded from the
 * canonical six-state pill vocabulary (U1 alignment: every status
 * surface carries all six states with the canonical wording; no
 * per-surface synonyms).
 */
function pendingSublabel(key: string): string {
  switch (registry.getStatus(key)) {
    case 'loading':
      return 'loading...';
    case 'degraded':
      return 'live (partial)';
    case 'no-data':
      return 'no data';
    case 'error':
      return 'unavailable';
    case 'zoom-in':
      return 'zoom in to load';
    default:
      return 'off';
  }
}

/**
 * The deliberate off tile: the layer is not on and not being turned on.
 * "Layer off" (not a bare "Off") per the ratified tile guardrail spec
 * (D-0.7.0-008): the wording must not conflate "layer off" with "no
 * events exist"; the tile's action cue ("Show") is rendered by the view.
 */
function offMetric(sublabel: string): Metric {
  return { value: 'Layer off', sublabel, tone: 'off' };
}

/**
 * The "on its way or degraded" tile: the layer is on (or activating)
 * but its fill has nothing rendered yet. A genuinely loading layer
 * shimmers; any other pending status (no data, unavailable, zoom in to
 * load) reads muted with its honest canonical sublabel. Never a zero:
 * a failed activation must not read as "0 alerts" (guardrail spec).
 */
function pendingMetric(key: string): Metric {
  const tone = registry.getStatus(key) === 'loading' ? 'loading' : 'off';
  return { value: '-', sublabel: pendingSublabel(key), tone };
}

/**
 * A layer counts as "on" for the tile the moment its activation starts:
 * the registry records active keys only after `activate` resolves, but
 * it sets the `loading` status synchronously at the start, so
 * `active || loading` tracks the checkbox intent without reaching for
 * DOM. Keeps the button semantics stable across the whole lifecycle
 * (off, loading, ready, zero, error; guardrail spec).
 */
function isLayerOn(key: string): boolean {
  return registry.getActiveKeys().has(key) || registry.getStatus(key) === 'loading';
}

export function droughtMetric(map: maplibregl.Map): { metric: Metric; dateMs: number | null } {
  if (!isLayerOn(USDM_KEY)) {
    // A deliberate small-caps state phrase (styled via data-tone), not a
    // dash that could read as missing data; the sublabel names the layer.
    return { metric: offMetric('US Drought Monitor'), dateMs: null };
  }

  // The change-map register (0.5.0b): the absolute categories are hidden,
  // so a "worst category in view" number would be dishonest. Name the view
  // instead, and read the product date off the rendered change features.
  if (timeline.usdmMode !== 'absolute' && map.getLayer(USDM_CHANGE_FILL)) {
    const span = timeline.usdmMode === 'chg4' ? '4-wk' : '1-wk';
    const changeFeats = map.queryRenderedFeatures({ layers: [USDM_CHANGE_FILL] });
    let changeDateMs: number | null = null;
    for (const f of changeFeats) {
      const d = readMapDateMs(f.properties);
      if (d !== null) changeDateMs = d;
    }
    return {
      metric: { value: span, sublabel: 'drought change in view', tone: 'data' },
      dateMs: changeDateMs
    };
  }

  const presentFills = USDM_FILLS.filter((id) => map.getLayer(id));
  if (presentFills.length === 0) {
    // On (or activating) but the fill has not been created yet: while the
    // status is genuinely loading, the tile shimmers; any other pending
    // status reads muted with its honest canonical sublabel.
    return { metric: pendingMetric(USDM_KEY), dateMs: null };
  }

  const feats = map.queryRenderedFeatures({ layers: [...presentFills] });
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

export function alertsMetric(map: maplibregl.Map): Metric {
  if (!isLayerOn(ALERTS_KEY)) return offMetric('alerts');
  if (!map.getLayer(ALERTS_FILL)) return pendingMetric(ALERTS_KEY);
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

export function firesMetric(map: maplibregl.Map): Metric {
  if (!isLayerOn(FIRES_KEY)) return offMetric('wildfires');
  if (!map.getLayer(FIRES_FILL)) return pendingMetric(FIRES_KEY);
  // Count wildfire (WF) and complex (CX) incidents; exclude prescribed burns
  // (RX), which are intentional and not "active wildfires" in the hazard read.
  const feats = map
    .queryRenderedFeatures({ layers: [FIRES_FILL] })
    .filter((f) => {
      const cat = f.properties?.['attr_IncidentTypeCategory'];
      return cat === 'WF' || cat === 'CX';
    });
  // Prefer the stable WFIGS identifiers over the incident name (names are
  // reused across unrelated fires; identifiers are unique per incident).
  const n = countDistinct(feats, (p) =>
    firstNonBlank(
      p?.['attr_UniqueFireIdentifier'],
      p?.['attr_IrwinID'],
      p?.['attr_IncidentName'],
      p?.['poly_IncidentName'],
      p?.['IncidentName']
    )
  );
  return {
    value: String(n),
    sublabel: n === 1 ? 'active wildfire' : 'active wildfires',
    tone: n > 0 ? 'data' : 'none'
  };
}

// ---------------------------------------------------------------------------
// Staleness and date formatting
// ---------------------------------------------------------------------------

// The USDM publishes weekly (released each Thursday for the week ending the
// prior Tuesday), so the current map is always within about a week. A MapDate
// older than two full cycles means at least one release was missed: the upstream
// has frozen or drifted and the map is showing an old week. That is the
// "confident-looking stale map" harm from critical-review #6, so we flag it.
const USDM_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** True when a USDM MapDate is old enough that the feed has plainly stopped updating. */
export function isUsdmStale(dateMs: number | null, nowMs = Date.now()): boolean {
  return dateMs !== null && nowMs - dateMs > USDM_STALE_AFTER_MS;
}

/** Compact "Mon D, YYYY" from a millisecond epoch, in UTC to match the USDM release date. */
export function formatMapDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}
