/**
 * United States Drought Monitor (USDM) layer module.
 *
 * The USDM is a weekly composite of current drought conditions across the
 * United States, jointly produced by the National Drought Mitigation Center
 * (NDMC) at the University of Nebraska-Lincoln (UNL), the National Oceanic
 * and Atmospheric Administration (NOAA), and the United States Department
 * of Agriculture (USDA). New maps publish every Thursday morning Eastern
 * Time, valid through the previous Tuesday at 07:00 Eastern.
 *
 * 0.5.0b (the temporal axis) turned this from a current-week snapshot into
 * a week-stepped scrubber (critical-review Section 5 item 3):
 *
 *   - A discrete rail whose stops are real valid-Tuesdays; the newest stop
 *     is read LIVE from the current release's MapDate (on a Wednesday the
 *     nearest past Tuesday is not yet published; never assume it is).
 *   - Each stop loads that week's polygons from the USDM archive
 *     FeatureServer and repaints D0-D4. Steps CROSSFADE between two real,
 *     dated frames (opacity only, via src/util/frame-stepper.ts); analyst
 *     polygons are never tweened. That line is bright and non-negotiable.
 *   - A change-map view (the honest derivative: 1-week and 4-week
 *     worsened / no change / improved) swaps in for the absolute fills at
 *     the CURRENT week only; no keyless historical-change archive exists,
 *     so the chips are disabled (with the reason) at historical stops.
 *   - Jump chips switch instrument to the CPC drought outlook register (a
 *     REAL surface switch through the sidebar checkbox path: registry,
 *     URL, and pill all stay honest; a hard cut, never a crossfade across
 *     the observed/forecast boundary).
 *
 * The selected week and view mode round-trip through the URL (`week=`,
 * `dmode=`) via the timeline store (src/state/timeline.ts).
 *
 * Endpoints (all stamped in src/config/urls.ts): `usdmFeatureServer` for
 * the current week (verified 2026-05-09), `usdmArchiveFeatureServer` for
 * any week since 2000-01-04 (verified 2026-07-08, wildcard CORS), and the
 * two change-map GeoJSONs (verified 2026-07-08, wildcard CORS).
 *
 * Render. Per USDM convention, the five categories use the canonical
 * yellow-to-dark-red ramp resolved by a MapLibre `match` expression keyed
 * off the integer `DM` field. The change view uses a color-blind-safe
 * diverging ramp keyed off the signed `DN` class delta (blue improved,
 * red worsened), stepped, with the class read also carried by the legend
 * labels rather than color alone.
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { registerClickTarget } from '../map/interaction-coordinator';
import { escapeHtml } from '../util/escape';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';
import { getCurrentRegion, onRegionChange } from '../state/region-store';
import {
  timeline,
  horizonForOutlookRange,
  type UsdmViewMode
} from '../state/timeline';
import { requestHorizon } from '../state/cluster-service';
import { USDM_CATEGORIES, USDM_NONE_SWATCH } from '../config/palette';
import {
  resetDroughtSurfacePresentation,
  setDroughtSurfacePresentation
} from '../config/layers';
import { requestLayerOn } from '../ui/layer-toggle-command';
import {
  FrameCache,
  crossfadeFrames,
  primeForFadeIn,
  type FadeTarget
} from '../util/frame-stepper';
import { setTimeBar, clearTimeBar } from '../ui/time-bar';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';

const LAYER_KEY = 'usdm';

/**
 * Two frame slots so a week step can crossfade between two real dated
 * states: the visible week fades out while the incoming week fades in,
 * opacity only. Layer ids derive from the source ids.
 */
const SLOT_SOURCES = ['usdm-frame-a', 'usdm-frame-b'] as const;
type Slot = 0 | 1;

const fillId = (src: string): string => `${src}-fill`;
const outlineId = (src: string): string => `${src}-outline`;
const rimId = (src: string): string => `${src}-d4-rim`;

/** Change-map view (the derivative register). */
const CHANGE_SOURCE = 'usdm-change';
const CHANGE_FILL = fillId(CHANGE_SOURCE);
const CHANGE_OUTLINE = outlineId(CHANGE_SOURCE);

/**
 * A presentation-only D4 edge for legibility against the shared dark scene.
 * It does not change, buffer, or reinterpret the official USDM category.
 */
export const USDM_D4_RIM_STYLE = {
  color: '#f87171',
  width: 1.5,
  opacity: 0
} as const;

export const USDM_D4_RIM_LAYER_IDS = [
  rimId(SLOT_SOURCES[0]),
  rimId(SLOT_SOURCES[1])
] as const;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [
  fillId(SLOT_SOURCES[0]),
  outlineId(SLOT_SOURCES[0]),
  rimId(SLOT_SOURCES[0]),
  fillId(SLOT_SOURCES[1]),
  outlineId(SLOT_SOURCES[1]),
  rimId(SLOT_SOURCES[1]),
  CHANGE_FILL,
  CHANGE_OUTLINE,
  'bc-drought-fill',
  'bc-drought-outline'
] as const;

/** The fill ids the conditions strip reads (src/ui/conditions-strip.ts). */
export const USDM_FILL_LAYER_IDS = [
  fillId(SLOT_SOURCES[0]),
  fillId(SLOT_SOURCES[1])
] as const;

const BEFORE_ID = 'first-symbol';
const FETCH_TIMEOUT_MS = 20_000;

/**
 * E1 composition targets (D-0.7.0-041 part 2; the 2026-07-16 design review
 * E1.3): starting values for the stewardship visual review at unit close.
 * The surface fill drops from 0.6 into the ratified 0.52-0.56 band and the
 * outline quiets to a 0.4 px line at 0.35-0.50 opacity, so the drought
 * statement stays primary without shouting over the hillshade underlay and
 * the boundary chain.
 */
const FILL_OPACITY = 0.54;
const OUTLINE_OPACITY = 0;
const OUTLINE_WIDTH = 0.4;

/** Rail depth: 52 stops covers a full water year of weekly frames. */
const WEEKS_BACK = 52;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let masterController: AbortController | null = null;

/** Ascending YYYYMMDD valid-Tuesday keys; empty until activation succeeds. */
let weeks: string[] = [];
let weekIndex = 0;
let activeSlot: Slot = 0;
/** Monotonic step counter; a resolved load for a stale step is dropped. */
let stepEpoch = 0;

/** Session cache of weekly frames (survives toggle-off, like HYDRO_CACHE). */
const frameCache = new FrameCache<GeoJSON.FeatureCollection>(12);
const changeCache = new Map<UsdmViewMode, GeoJSON.FeatureCollection>();

const USDM_COLORS: ReadonlyArray<string> = USDM_CATEGORIES.map((c) => c.color);

const USDM_LABELS: ReadonlyArray<string> = [
  'D0 - Abnormally Dry',
  'D1 - Moderate Drought',
  'D2 - Severe Drought',
  'D3 - Extreme Drought',
  'D4 - Exceptional Drought'
];

/**
 * Diverging change ramp (ColorBrewer RdBu endpoints, color-blind safe):
 * blue = improved, red = worsened, muted slate for no change. Class is
 * also carried in the legend text, never by hue alone.
 */
const CHANGE_COLORS = {
  improved2: '#2166ac',
  improved1: '#92c5de',
  same: '#8b93a3',
  worsened1: '#f4a582',
  worsened2: '#b2182b'
} as const;

type UsdmStatus = 'loading' | 'ready' | 'error' | 'no-data';

function reportStatus(state: UsdmStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

// ---------------------------------------------------------------------------
// Week arithmetic (keys are YYYYMMDD in UTC)
// ---------------------------------------------------------------------------

function msToWeekKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function weekKeyToMs(key: string): number {
  return Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8))
  );
}

/** ISO date (YYYY-MM-DD) for the archive timestamp literal. */
function weekKeyToIso(key: string): string {
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

/** Human date for stamps: "Jun 30, 2026" (UTC, matching the release date). */
function weekLabel(key: string): string {
  return new Date(weekKeyToMs(key)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/**
 * Build the rail from the LIVE latest MapDate: `WEEKS_BACK` consecutive
 * weekly stops ending at the current release. The USDM has published every
 * week since 2000-01-04, so each arithmetic Tuesday in this window is a
 * real product; the newest stop is data-derived, never assumed.
 */
function buildWeeks(latestMapDateMs: number): string[] {
  const list: string[] = [];
  for (let i = WEEKS_BACK - 1; i >= 0; i--) {
    list.push(msToWeekKey(latestMapDateMs - i * WEEK_MS));
  }
  return list;
}

/** Snap an arbitrary YYYYMMDD to the nearest rail stop index. */
function nearestWeekIndex(key: string): number {
  if (weeks.length === 0) return 0;
  const target = weekKeyToMs(key);
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < weeks.length; i++) {
    const dist = Math.abs(weekKeyToMs(weeks[i]!) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fields the popups and conditions strip need; `*` on a bad-drought week
 * is a large payload on rural connections (archive stamp caveat). The two
 * services spell the validity fields differently (verified live
 * 2026-07-08): USDM_current uses ValidStart/ValidEnd, USDM_archive uses
 * ValidStartDate/ValidEndDate; the popup reads both.
 */
const CURRENT_OUT_FIELDS = 'DM,MapDate,ValidStart,ValidEnd';
const ARCHIVE_OUT_FIELDS = 'DM,MapDate,ValidStartDate,ValidEndDate';

function buildCurrentQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: CURRENT_OUT_FIELDS,
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.usdmFeatureServer}/query?${params.toString()}`;
}

function buildArchiveQueryUrl(weekKey: string): string {
  const params = new URLSearchParams({
    where: `MapDate=timestamp '${weekKeyToIso(weekKey)} 00:00:00'`,
    outFields: ARCHIVE_OUT_FIELDS,
    outSR: '4326',
    f: 'geojson',
    // Historical frames are stepped at national scale; server-side
    // simplification cuts a bad-drought week from ~6.5 MB to ~440 KB
    // (measured 2026-07-08) with no visible difference at the zooms the
    // scrubber serves. The current week keeps full precision.
    maxAllowableOffset: '0.01',
    geometryPrecision: '4'
  });
  return `${URLS.usdmArchiveFeatureServer}/query?${params.toString()}`;
}

async function fetchFrame(
  url: string,
  signal: AbortSignal
): Promise<GeoJSON.FeatureCollection> {
  const response = await fetchWithBudget(url, null, signal, FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GeoJSON.FeatureCollection;
}

/** Frame loader for the cache: the newest stop uses the current-week
 * service, every older stop the archive. */
function frameLoader(signal: AbortSignal): (key: string) => Promise<GeoJSON.FeatureCollection> {
  return (key: string) => {
    const latest = weeks[weeks.length - 1];
    const url = key === latest ? buildCurrentQueryUrl() : buildArchiveQueryUrl(key);
    return fetchFrame(url, signal);
  };
}

// ---------------------------------------------------------------------------
// Map plumbing
// ---------------------------------------------------------------------------

const dmColorExpression: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'DM'],
  0, USDM_COLORS[0]!,
  1, USDM_COLORS[1]!,
  2, USDM_COLORS[2]!,
  3, USDM_COLORS[3]!,
  4, USDM_COLORS[4]!,
  '#cccccc'
];

/** Stepped diverging ramp over the signed DN class delta. */
const changeColorExpression: maplibregl.ExpressionSpecification = [
  'step',
  ['get', 'DN'],
  CHANGE_COLORS.improved2,
  -1, CHANGE_COLORS.improved1,
  0, CHANGE_COLORS.same,
  1, CHANGE_COLORS.worsened1,
  2, CHANGE_COLORS.worsened2
];

/** Build one frame's presentation-only D4 edge. Exported as a pure seam so
 * its source/category/style contract can be verified without network work. */
export function buildD4RimLayerSpecification(
  sourceId: string,
  visible: boolean
): maplibregl.LineLayerSpecification {
  return {
    id: rimId(sourceId),
    type: 'line',
    source: sourceId,
    filter: ['==', ['get', 'DM'], 4],
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'line-color': USDM_D4_RIM_STYLE.color,
      'line-width': USDM_D4_RIM_STYLE.width,
      'line-opacity': USDM_D4_RIM_STYLE.opacity
    }
  };
}

function addPolygonPair(
  map: maplibregl.Map,
  sourceId: string,
  color: maplibregl.ExpressionSpecification,
  visible: boolean,
  withD4Rim = false
): void {
  const beforeId = resolveBeforeId(map);
  const visibility = visible ? 'visible' : 'none';
  if (!map.getLayer(fillId(sourceId))) {
    map.addLayer(
      {
        id: fillId(sourceId),
        type: 'fill',
        source: sourceId,
        layout: { visibility },
        paint: { 'fill-color': color, 'fill-opacity': FILL_OPACITY }
      },
      beforeId
    );
  }
  if (!map.getLayer(outlineId(sourceId))) {
    map.addLayer(
      {
        id: outlineId(sourceId),
        type: 'line',
        source: sourceId,
        layout: { visibility },
        paint: {
          'line-color': color,
          'line-width': OUTLINE_WIDTH,
          'line-opacity': OUTLINE_OPACITY
        }
      },
      beforeId
    );
  }
  if (withD4Rim && !map.getLayer(rimId(sourceId))) {
    map.addLayer(buildD4RimLayerSpecification(sourceId, visible), beforeId);
  }
}

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: []
};

function ensureSources(map: maplibregl.Map, initial: GeoJSON.FeatureCollection): void {
  if (!map.getSource(SLOT_SOURCES[0])) {
    map.addSource(SLOT_SOURCES[0], {
      type: 'geojson',
      data: initial,
      attribution: 'USDM (NDMC / NOAA / USDA)'
    });
  }
  if (!map.getSource(SLOT_SOURCES[1])) {
    map.addSource(SLOT_SOURCES[1], { type: 'geojson', data: EMPTY_FC });
  }
  if (!map.getSource(CHANGE_SOURCE)) {
    map.addSource(CHANGE_SOURCE, {
      type: 'geojson',
      data: EMPTY_FC,
      attribution: 'USDM change (NDMC / NOAA / USDA via drought.gov)'
    });
  }
  addPolygonPair(map, SLOT_SOURCES[0], dmColorExpression, true, true);
  addPolygonPair(map, SLOT_SOURCES[1], dmColorExpression, false, true);
  addPolygonPair(map, CHANGE_SOURCE, changeColorExpression, false);
}

function setPairData(map: maplibregl.Map, sourceId: string, data: GeoJSON.FeatureCollection): void {
  const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data);
}

function setPairVisibility(map: maplibregl.Map, sourceId: string, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  for (const id of [fillId(sourceId), outlineId(sourceId), rimId(sourceId)]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  }
}

function pairFadeTargets(sourceId: string): FadeTarget[] {
  const targets: FadeTarget[] = [
    { layerId: fillId(sourceId), prop: 'fill-opacity', target: FILL_OPACITY },
    { layerId: outlineId(sourceId), prop: 'line-opacity', target: OUTLINE_OPACITY }
  ];
  if (sourceId !== CHANGE_SOURCE) {
    targets.push({
      layerId: rimId(sourceId),
      prop: 'line-opacity',
      target: USDM_D4_RIM_STYLE.opacity
    });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Legends
// ---------------------------------------------------------------------------

function showAbsoluteLegend(): void {
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Drought monitor key',
        // The no-polygon swatch names only what the renderer can prove.
        [USDM_NONE_SWATCH, ...USDM_CATEGORIES].map((c) => ({
          color: c.color,
          label: `${c.code} · ${c.label}`
        })),
        'U.S. Drought Monitor · observed weekly conditions (NDMC / NOAA / USDA). No polygon means no D0-D4 category is drawn; without an analyzed-area mask it does not confirm no drought. D4 pink rim is presentation contrast only; official category unchanged.'
      )
  });
}

function showChangeLegend(mode: UsdmViewMode): void {
  const span = mode === 'chg4' ? '4-week' : '1-week';
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) =>
      renderSwatchLegend(
        body,
        `Drought change key (${span})`,
        [
          { color: CHANGE_COLORS.improved2, label: 'Improved 2+ categories' },
          { color: CHANGE_COLORS.improved1, label: 'Improved 1 category' },
          { color: CHANGE_COLORS.same, label: 'No category change' },
          { color: CHANGE_COLORS.worsened1, label: 'Worsened 1 category' },
          { color: CHANGE_COLORS.worsened2, label: 'Worsened 2+ categories' }
        ],
        `USDM ${span} change · what moved, not where it stands`
      )
  });
}

// ---------------------------------------------------------------------------
// The time bar
// ---------------------------------------------------------------------------

function atLatestStop(): boolean {
  return weekIndex === weeks.length - 1;
}

function installTimeBar(map: maplibregl.Map): void {
  if (weeks.length === 0) return;
  const mode = timeline.usdmMode;
  const currentKey = weeks[weekIndex]!;
  const changeTitle = (span: string): string =>
    atLatestStop()
      ? `Show the ${span} drought change classes (worsened, no change, improved)`
      : 'Change maps are published for the current week only; step to the newest week to use them';

  setTimeBar(LAYER_KEY, {
    ariaLabel: 'US Drought Monitor timeline',
    stamp:
      mode === 'absolute'
        ? {
            headline: `Valid ${weekLabel(currentKey)}`,
            detail: 'US Drought Monitor week · solid fills are observed conditions',
            register: 'observed'
          }
        : {
            headline: `Change through ${weekLabel(currentKey)}`,
            // vocab-allow: honesty disclaimer, denies being a forecast
            detail: `USDM ${mode === 'chg4' ? '4-week' : '1-week'} change · observed, not forecast`,
            register: 'observed'
          },
    rail: {
      count: weeks.length,
      index: weekIndex,
      valueText: (i) => `Week of ${weekLabel(weeks[i] ?? currentKey)}`,
      onStep: (i) => void showWeek(map, i)
    },
    modes: {
      options: [
        {
          key: 'absolute',
          label: 'Drought level',
          title: 'Observed D0 to D4 categories for the selected week'
        },
        {
          key: 'chg1',
          label: '1-wk change',
          title: changeTitle('1-week'),
          disabled: !atLatestStop()
        },
        {
          key: 'chg4',
          label: '4-wk change',
          title: changeTitle('4-week'),
          disabled: !atLatestStop()
        }
      ],
      activeKey: mode,
      onSelect: (key) => void setMode(map, key as UsdmViewMode)
    },
    jumps: {
      options: [
        {
          key: 'monthly',
          label: 'Monthly outlook',
          title: // vocab-allow: names the CPC outlook (an upstream forecast product) and disclaims outcomes
            'Switch to the CPC Monthly Drought Outlook: a forecast register (a shift in odds, not a forecast of outcomes)',
          hatched: true
        },
        {
          key: 'seasonal',
          label: 'Seasonal outlook',
          title: // vocab-allow: names the CPC outlook (an upstream forecast product) and disclaims outcomes
            'Switch to the CPC Seasonal Drought Outlook: a forecast register (a shift in odds, not a forecast of outcomes)',
          hatched: true
        }
      ],
      onJump: (key) => switchToOutlook(key)
    }
  });
}

/**
 * The instrument switch: a REAL surface switch to the outlook layer via
 * the shared toggle command, so the registry, the URL `layers=` list,
 * and the status pill all record what is actually on screen. A hard cut
 * by design; the observed/forecast boundary is never crossfaded.
 *
 * The command (ADR 0002 condition 2, D-0.7.0-008) replaced the old
 * checkbox `cb.click()` door: the catalog checkbox is rendered by a
 * lazily-mounted island now, so a `querySelector` door would silently
 * no-op in the pre-mount window (the spike's Codex adversarial
 * finding). The command records the checkbox intent in the eager bridge
 * and routes through the controller, DOM-free.
 */
function switchToOutlook(range: string): void {
  // Commit the temporal horizon through the S3 cluster service so the
  // pressed shell chip always describes the drought register being shown.
  requestHorizon(
    horizonForOutlookRange(range === 'monthly' ? 'monthly' : 'seasonal')
  );
  requestLayerOn('drought');
}

// ---------------------------------------------------------------------------
// Week stepping and mode switching
// ---------------------------------------------------------------------------

/**
 * Show the week at rail stop `index`, crossfading from the visible frame.
 * Supersede-safe: a slower load that resolves after a newer step is
 * dropped (invariant 5), and an aborted master signal drops silently.
 */
async function showWeek(map: maplibregl.Map, index: number): Promise<void> {
  if (weeks.length === 0) return;
  const clamped = Math.min(weeks.length - 1, Math.max(0, index));
  const signal = masterController?.signal ?? null;
  if (!signal) return;

  const myEpoch = ++stepEpoch;
  const key = weeks[clamped]!;

  // Leaving the newest stop while in a change mode falls back to the
  // absolute register (change maps exist for the current week only).
  if (timeline.usdmMode !== 'absolute' && clamped !== weeks.length - 1) {
    setPairVisibility(map, CHANGE_SOURCE, false);
    setPairVisibility(map, SLOT_SOURCES[activeSlot], true);
    timeline.setUsdmMode('absolute');
    showAbsoluteLegend();
  }

  const cached = frameCache.peek(key) !== undefined;
  if (!cached) reportStatus('loading');

  let frame: GeoJSON.FeatureCollection;
  try {
    frame = await frameCache.get(key, frameLoader(signal));
  } catch (err) {
    if (signal.aborted || myEpoch !== stepEpoch) return;
    console.warn(`[usdm] week ${key} fetch failed.`, err);
    reportStatus('error');
    return;
  }
  if (signal.aborted || myEpoch !== stepEpoch) return;

  const outSource = SLOT_SOURCES[activeSlot];
  const inSlot: Slot = activeSlot === 0 ? 1 : 0;
  const inSource = SLOT_SOURCES[inSlot];

  setPairData(map, inSource, frame);
  primeForFadeIn(map, pairFadeTargets(inSource));
  setPairVisibility(map, inSource, true);

  weekIndex = clamped;
  activeSlot = inSlot;
  timeline.setUsdmWeek(clamped === weeks.length - 1 ? null : key);
  installTimeBar(map);
  reportStatus('ready');

  await crossfadeFrames(map, pairFadeTargets(outSource), pairFadeTargets(inSource));
  if (signal.aborted || myEpoch !== stepEpoch) return;
  setPairVisibility(map, outSource, false);

  // Warm the neighbors so the next step is instant (polite: the cache
  // skips prefetch entirely on constrained connections).
  const neighbors: string[] = [];
  if (clamped > 0) neighbors.push(weeks[clamped - 1]!);
  if (clamped < weeks.length - 1) neighbors.push(weeks[clamped + 1]!);
  frameCache.prefetch(neighbors, frameLoader(signal));
}

/**
 * Inject the change file's own top-level `date` (YYYYMMDD) into each
 * feature as an epoch-ms MapDate, so the conditions strip's date line can
 * read the product date off rendered features exactly as it does for the
 * absolute register. The date is the product's, never invented.
 */
function stampChangeFeatures(
  fc: GeoJSON.FeatureCollection & { date?: unknown }
): GeoJSON.FeatureCollection {
  const raw = String(fc.date ?? '');
  const ms = /^\d{8}$/.test(raw) ? weekKeyToMs(raw) : null;
  if (ms === null) return fc;
  for (const f of fc.features) {
    f.properties = { ...(f.properties ?? {}), MapDate: ms };
  }
  return fc;
}

/** Switch between the absolute register and a change-map view. */
async function setMode(map: maplibregl.Map, mode: UsdmViewMode): Promise<void> {
  if (mode === timeline.usdmMode) return;
  const signal = masterController?.signal ?? null;
  if (!signal) return;
  const myEpoch = ++stepEpoch;

  if (mode === 'absolute') {
    const slotSource = SLOT_SOURCES[activeSlot];
    primeForFadeIn(map, pairFadeTargets(slotSource));
    setPairVisibility(map, slotSource, true);
    timeline.setUsdmMode('absolute');
    installTimeBar(map);
    showAbsoluteLegend();
    await crossfadeFrames(map, pairFadeTargets(CHANGE_SOURCE), pairFadeTargets(slotSource));
    if (signal.aborted || myEpoch !== stepEpoch) return;
    setPairVisibility(map, CHANGE_SOURCE, false);
    return;
  }

  // Change maps are published for the current week only.
  if (!atLatestStop()) return;

  let fc = changeCache.get(mode);
  if (!fc) {
    reportStatus('loading');
    try {
      const url = mode === 'chg4' ? URLS.usdmChange4wkGeojson : URLS.usdmChange1wkGeojson;
      const response = await fetchWithBudget(url, null, signal, FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      fc = stampChangeFeatures(
        (await response.json()) as GeoJSON.FeatureCollection & { date?: unknown }
      );
      changeCache.set(mode, fc);
    } catch (err) {
      if (signal.aborted || myEpoch !== stepEpoch) return;
      console.warn(`[usdm] change map (${mode}) fetch failed.`, err);
      reportStatus('error');
      return;
    }
  }
  if (signal.aborted || myEpoch !== stepEpoch) return;

  setPairData(map, CHANGE_SOURCE, fc);
  primeForFadeIn(map, pairFadeTargets(CHANGE_SOURCE));
  setPairVisibility(map, CHANGE_SOURCE, true);
  timeline.setUsdmMode(mode);
  installTimeBar(map);
  showChangeLegend(mode);
  reportStatus('ready');

  const slotSource = SLOT_SOURCES[activeSlot];
  await crossfadeFrames(map, pairFadeTargets(slotSource), pairFadeTargets(CHANGE_SOURCE));
  if (signal.aborted || myEpoch !== stepEpoch) return;
  setPairVisibility(map, slotSource, false);
}

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------

/**
 * Fetch the current week, stand up the frame slots and the time bar, and
 * restore any URL-selected week or view mode. Idempotent: if the frame
 * sources already exist the function exits after re-reporting status.
 *
 * Network failures surface as `'error'` rather than throwing; the caller
 * (the sidebar activation spine) surfaces this in the status pill.
 */
async function activateUsdm(map: maplibregl.Map): Promise<void> {
  // The US Drought Monitor is the observed register. Commit the current
  // horizon before mounting it so URL restoration and shell state cannot
  // claim an outlook horizon over an observed display.
  timeline.setHorizon('current');
  if (map.getSource(SLOT_SOURCES[0])) {
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let geojson: GeoJSON.FeatureCollection;
  try {
    geojson = await fetchFrame(buildCurrentQueryUrl(), signal);
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[usdm] Drought Monitor fetch failed.', err);
    reportStatus('error');
    return;
  }
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  ensureSources(map, geojson);

  if (features.length === 0) {
    // An empty artifact is a genuine no-data state. Without an analyzed-area
    // mask it cannot be promoted to a national "no drought" conclusion; with
    // no MapDate there is also no anchor for the temporal rail.
    reportStatus('no-data');
    return;
  }

  // The newest stop comes from the release itself (the archive-stamp
  // caveat: on a Wednesday the nearest past Tuesday is not yet published).
  const latestMs = Number(features[0]?.properties?.['MapDate']);
  if (Number.isFinite(latestMs) && latestMs > 0) {
    weeks = buildWeeks(latestMs);
    weekIndex = weeks.length - 1;
    activeSlot = 0;
    frameCache.get(weeks[weekIndex]!, () => Promise.resolve(geojson)).catch(() => undefined);
  } else {
    weeks = [];
  }

  showAbsoluteLegend();
  reportStatus('ready');

  if (weeks.length > 0) {
    installTimeBar(map);

    // URL restore: a shared week lands on its rail stop (snapped to a real
    // Tuesday); a shared change mode reapplies only where it is honest
    // (the newest stop), otherwise the URL falls back to absolute.
    const urlWeek = timeline.usdmWeek;
    if (urlWeek !== null) {
      const idx = nearestWeekIndex(urlWeek);
      if (idx !== weekIndex) await showWeek(map, idx);
    }
    const urlMode = timeline.usdmMode;
    if (urlMode !== 'absolute') {
      if (atLatestStop()) {
        timeline.setUsdmMode('absolute'); // setMode() re-enters cleanly
        await setMode(map, urlMode);
      } else {
        timeline.setUsdmMode('absolute');
      }
    }
  }
}

/**
 * Abort in-flight work and remove every USDM layer and source (both frame
 * slots and the change pair). Resets the temporal selection to "now" so
 * the URL never carries a week for a surface that is off.
 */
function deactivateUsdm(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  stepEpoch++;
  for (const src of [...SLOT_SOURCES, CHANGE_SOURCE]) {
    for (const id of [fillId(src), outlineId(src), rimId(src)]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(src)) map.removeSource(src);
  }
  weeks = [];
  weekIndex = 0;
  activeSlot = 0;
  clearTimeBar(LAYER_KEY);
  hideLegend(LAYER_KEY);
  timeline.setUsdmWeek(null);
  timeline.setUsdmMode('absolute');
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

function formatCategoryLabel(dm: unknown): string {
  if (typeof dm !== 'number') return 'Unknown drought category';
  if (dm < 0 || dm > 4 || !Number.isInteger(dm)) {
    return 'Unknown drought category';
  }
  return USDM_LABELS[dm]!;
}

function categoryImpact(dm: unknown): string {
  if (typeof dm === 'number' && Number.isInteger(dm) && dm >= 0 && dm <= 4) {
    return USDM_CATEGORIES[dm]!.impact;
  }
  return 'U.S. Drought Monitor categories range from D0 (abnormally dry) through D4 (exceptional drought).';
}

/**
 * Format an NDMC date field. The FeatureServer emits dates as
 * milliseconds-since-epoch integers; we render `YYYY-MM-DD` in UTC to
 * avoid the local-time day rollover that confuses end-users in Pacific
 * time zones during the late-Wednesday update window.
 */
function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildUsdmPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const dm = (p.DM ?? p.dm) as unknown;
  const category = formatCategoryLabel(dm);
  const mapDate = formatDate(p.MapDate ?? p.mapDate);
  const validStart = formatDate(p.ValidStart ?? p.ValidStartDate ?? p.validStart);
  const validEnd = formatDate(p.ValidEnd ?? p.ValidEndDate ?? p.validEnd);

  return `
    <div class="popup-title">${escapeHtml(category)}</div>
    <div class="popup-agency">U.S. Drought Monitor (NDMC / NOAA / USDA)</div>
    ${mapDate ? `<div class="popup-treaty-meta">Map date: ${escapeHtml(mapDate)}</div>` : ''}
    ${validStart && validEnd ? `<div class="popup-treaty-meta">Valid: ${escapeHtml(validStart)} to ${escapeHtml(validEnd)}</div>` : ''}
    <div class="popup-description">${escapeHtml(categoryImpact(dm))}</div>
    <div class="popup-treaty-meta">Updated weekly each Thursday.</div>
    <div class="popup-links">
      <a href="https://droughtmonitor.unl.edu/" target="_blank" rel="noopener">U.S. Drought Monitor</a>
      <a href="https://www.drought.gov/" target="_blank" rel="noopener">Drought.gov</a>
    </div>
  `;
}

/** Plain-language read of a signed change class delta. */
function changeLabel(dn: unknown): string {
  const n = typeof dn === 'number' ? dn : Number(dn);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Unknown change class';
  if (n === 0) return 'No category change';
  const dir = n > 0 ? 'Worsened' : 'Improved';
  const steps = Math.abs(n);
  return `${dir} ${steps} ${steps === 1 ? 'category' : 'categories'}`;
}

function buildChangePopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const mapDate = formatDate(p.MapDate);
  // vocab-allow: honesty disclaimer, denies being a forecast
  return `
    <div class="popup-title">${escapeHtml(changeLabel(p.DN))}</div>
    <div class="popup-agency">U.S. Drought Monitor change map (via drought.gov)</div>
    ${mapDate ? `<div class="popup-treaty-meta">Through: ${escapeHtml(mapDate)}</div>` : ''}
    <div class="popup-description">How the drought category moved over the window, not where it stands. Observed analysis, not a forecast.</div>
    <div class="popup-links">
      <a href="https://droughtmonitor.unl.edu/Maps/ChangeMaps.aspx" target="_blank" rel="noopener">USDM Change Maps</a>
    </div>
  `;
}

/**
 * Register the click targets for both frame-slot fills and the change
 * fill with the InteractionCoordinator (one response per click;
 * D-0.7.0-058 ruling 5). The hidden frame pair never matches (its
 * layers carry visibility 'none'), so a click always reads the week or
 * register actually on screen. The condition surface ranks LAST in the
 * precedence table: it blankets every other target, and ranking it
 * higher would make sovereign geography visible but unreachable.
 */
function bindUsdmPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [...USDM_FILL_LAYER_IDS],
    label: (feature) => formatCategoryLabel((feature.properties ?? {}).DM ?? (feature.properties ?? {}).dm),
    respond: (feature) => ({
      content: buildUsdmPopupHtml(feature.properties ?? {})
    })
  });
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [CHANGE_FILL],
    label: (feature) => changeLabel((feature.properties ?? {}).DN),
    respond: (feature) => ({
      content: buildChangePopupHtml(feature.properties ?? {})
    })
  });

  for (const id of [...USDM_FILL_LAYER_IDS, CHANGE_FILL]) {
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}

// ---------------------------------------------------------------------------
// Issuer-aware drought controller
// ---------------------------------------------------------------------------

type DroughtEdition = 'usdm' | 'bc-basin';
type BcDroughtModule = typeof import('./bc-drought');

let activeEdition: DroughtEdition | null = null;
let activeMap: maplibregl.Map | null = null;
let unsubscribeRegion: (() => void) | null = null;
let editionEpoch = 0;
let bcModule: BcDroughtModule | null = null;
let bcPopupsBound = false;

function editionForRegion(region: string | null): DroughtEdition {
  return region === 'british_columbia' ? 'bc-basin' : 'usdm';
}

function preparePresentation(edition: DroughtEdition): void {
  if (edition === 'usdm') {
    resetDroughtSurfacePresentation();
    return;
  }
  setDroughtSurfacePresentation({
    edition: 'bc-basin',
    name: 'British Columbia Basin Drought Levels',
    source: 'Province of British Columbia · source date loads with data',
    sourceDate: null
  });
}

function teardownEdition(map: maplibregl.Map, edition: DroughtEdition): void {
  if (edition === 'usdm') {
    deactivateUsdm(map);
  } else {
    bcModule?.deactivate(map);
  }
}

async function switchEdition(
  map: maplibregl.Map,
  next: DroughtEdition
): Promise<void> {
  if (activeEdition === next) return;
  const epoch = ++editionEpoch;
  const previous = activeEdition;
  activeEdition = null;
  if (previous !== null) teardownEdition(map, previous);

  preparePresentation(next);
  registry.setStatus(LAYER_KEY, 'loading');

  if (next === 'bc-basin') {
    const mod = bcModule ?? (await import('./bc-drought'));
    if (epoch !== editionEpoch || activeMap !== map) return;
    bcModule = mod;
    if (!bcPopupsBound) {
      mod.bindPopups(map);
      bcPopupsBound = true;
    }
    activeEdition = next;
    await mod.activate(map);
  } else {
    activeEdition = next;
    await activateUsdm(map);
  }

  if (
    (epoch !== editionEpoch || activeMap !== map) &&
    activeEdition === next
  ) {
    teardownEdition(map, next);
    activeEdition = null;
  }
}

/**
 * Activate the one registered drought surface for the current region. The
 * region listener removes the old issuer completely before mounting the new
 * one, so no frame, legend, or date stamp can survive across the seam.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  activeMap = map;
  unsubscribeRegion?.();
  unsubscribeRegion = onRegionChange((region) => {
    void switchEdition(map, editionForRegion(region));
  });
  await switchEdition(map, editionForRegion(getCurrentRegion()));
}

/** Synchronous cancellation seam used by the layer controller. */
export function cancelActivation(): void {
  editionEpoch++;
  masterController?.abort();
  bcModule?.cancelActivation();
}

export function deactivate(map: maplibregl.Map): void {
  editionEpoch++;
  unsubscribeRegion?.();
  unsubscribeRegion = null;
  if (activeEdition !== null) teardownEdition(map, activeEdition);
  activeEdition = null;
  activeMap = null;
  preparePresentation(editionForRegion(getCurrentRegion()));
}

export function bindPopups(map: maplibregl.Map): void {
  bindUsdmPopups(map);
}
