/**
 * NOAA Climate Prediction Center (CPC) Drought Outlook layer: the OUTLOOK
 * register of the 0.5.0b observed-vs-outlook visual grammar.
 *
 * Through 0.5.0a this module rendered the Seasonal Drought Outlook as the
 * upstream Web Map Service (WMS) raster: solid server-styled fills that
 * were visually indistinguishable in kind from the observed US Drought
 * Monitor (USDM) week. That was precisely the "map that quietly lies about
 * time" failure the critical review named (Section 5 item 1). 0.5.0b
 * rewires it as the vector ArcGIS REST layers of the same service
 * (`cpcDroughtOutlookVectorMapServer`; the raster `cpcDroughtWMS` entry
 * remains in urls.ts as the documented fallback) so the forecast register
 * can visibly CHANGE INSTRUMENT:
 *
 *   - hatched, see-through class fills (src/util/hatch.ts), never solid;
 *   - an ISSUED date plus valid-through range in the time bar's outlook
 *     typography (warn amber, body face), never a hard VALID stamp;
 *   - the ENSO doctrine's framing in every copy surface: a shift in odds,
 *     not a forecast of outcomes.
 *
 * Both outlook ranges live here: layer 1 = Monthly, layer 4 = Seasonal
 * (US + Puerto Rico), selected through the timeline store's
 * `outlookRange` (URL parameter `outlook=monthly`; seasonal is the
 * default, preserving what this layer key meant before 0.5.0b). The time
 * bar offers the range switch and the jump back to the observed USDM
 * register; that jump is a REAL surface switch (hard cut), never a
 * crossfade across the observed/forecast boundary.
 *
 * Attributes (verified live 2026-07-08, ddm-source-sweep wf_6ab55eaf):
 * `outlook` in {Persistence, Development, Improvement, Removal,
 * No_Drought}, `fcst_date` (issued, 'MM/DD/YYYY'), `target` (the
 * valid-through label, e.g. 'Jul 2026' or 'September 30'). `No_Drought`
 * areas render nothing, matching CPC's own blank.
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { registerClickTarget } from '../map/interaction-coordinator';
import { registry } from '../state/registry';
import { requestLayerOn } from '../ui/layer-toggle-command';
import { timeline, horizonForOutlookRange, type OutlookRange } from '../state/timeline';
import { requestHorizon } from '../state/cluster-service';
import { fetchJsonWithBudget } from '../util/fetch';
import { escapeHtml } from '../util/escape';
import { ensureHatchImages, hatchImageId } from '../util/hatch';
import { DROUGHT_COLORS } from '../config/palette';
import { setTimeBar, clearTimeBar } from '../ui/time-bar';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';

const LAYER_KEY = 'drought';
const SOURCE_ID = 'drought-outlook';
const FILL_LAYER_ID = 'drought-outlook-fill';
const OUTLINE_LAYER_ID = 'drought-outlook-outline';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL_LAYER_ID, OUTLINE_LAYER_ID] as const;

const BEFORE_ID = 'first-symbol';
const FETCH_TIMEOUT_MS = 20_000;

/** ArcGIS REST layer index per outlook range (see the urls.ts stamp). */
const RANGE_LAYER_INDEX: Record<OutlookRange, number> = {
  monthly: 1,
  seasonal: 4
};

let masterController: AbortController | null = null;
/** The in-flight range request's own controller (invariant 5: the abort
 * path fires on layer-off AND on supersede). Linked to the layer master
 * signal on creation and aborted by every newer showRange call, so a
 * superseded uncached fetch stops immediately instead of running out
 * its 20-second budget with only the epoch guard dropping its result
 * (DG-080 r2 finding 3). */
let rangeController: AbortController | null = null;
/** Supersede counter for range switches (invariant 5, defense in depth
 * behind the per-range abort above). */
let loadEpoch = 0;
/** The range currently rendered, for idempotence checks. */
let renderedRange: OutlookRange | null = null;
/** The range last REQUESTED (set synchronously at the top of showRange,
 * before its own timeline writes), so the timeline follow subscription
 * below can tell an external register change from its own echo. */
let requestedRange: OutlookRange | null = null;
/** Disposer for the timeline follow subscription; armed on activate. */
let unsubscribeTimeline: (() => void) | null = null;
/** The most recent showRange invocation's promise (DG-080 r3 finding 1):
 * the handle the activation spine settles on, so the promise `activate`
 * returns always follows the LATEST range owner instead of resolving on
 * a superseded first request. Set synchronously by every showRange call;
 * cleared on deactivate. */
let latestRangeRun: Promise<void> | null = null;

/** Session cache per range; an outlook re-issue lands on the next boot. */
const outlookCache = new Map<OutlookRange, GeoJSON.FeatureCollection>();

type OutlookStatus = 'loading' | 'ready' | 'error' | 'no-data';

function reportStatus(state: OutlookStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

const OUTLOOK_LEGEND: ReadonlyArray<{ color: string; label: string }> = [
  { color: DROUGHT_COLORS['PERSISTS']!, label: 'Drought persists' },
  { color: DROUGHT_COLORS['DEVELOPS']!, label: 'Drought develops' },
  { color: DROUGHT_COLORS['IMPROVES']!, label: 'Drought improves' },
  { color: DROUGHT_COLORS['REMOVAL']!, label: 'Drought removal likely' }
];

function buildQueryUrl(range: OutlookRange): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'outlook,fcst_date,target,idp_filedate',
    outSR: '4326',
    f: 'geojson',
    // Load-bearing on rural connections: the seasonal layer at full
    // precision is ~32.5 MB; with server-side simplification it is
    // ~870 KB (measured 2026-07-08). 0.01 degrees (~1 km) is invisible
    // at outlook zooms.
    maxAllowableOffset: '0.01',
    geometryPrecision: '4'
  });
  return `${URLS.cpcDroughtOutlookVectorMapServer}/${RANGE_LAYER_INDEX[range]}/query?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Stamp copy
// ---------------------------------------------------------------------------

/** "07/31/2026" is machine-ish; render "Jun 30, 2026" for the stamp. */
function humanIssueDate(fcstDate: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fcstDate.trim());
  if (!m) return fcstDate;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  if (Number.isNaN(d.getTime())) return fcstDate;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/** Issued/target read off the loaded features (the product's own dates). */
function stampFields(fc: GeoJSON.FeatureCollection): { issued: string; target: string } {
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const issued = typeof p['fcst_date'] === 'string' ? p['fcst_date'] : '';
    const target = typeof p['target'] === 'string' ? p['target'] : '';
    if (issued || target) return { issued, target };
  }
  return { issued: '', target: '' };
}

function rangeName(range: OutlookRange): string {
  return range === 'monthly' ? 'Monthly' : 'Seasonal';
}

// ---------------------------------------------------------------------------
// Time bar
// ---------------------------------------------------------------------------

function installTimeBar(map: maplibregl.Map, fc: GeoJSON.FeatureCollection): void {
  const range = timeline.outlookRange;
  const { issued, target } = stampFields(fc);
  const issuedPart = issued ? `Issued ${humanIssueDate(issued)}` : 'Issue date unavailable';
  const targetPart = target ? ` · through ${target}` : '';

  setTimeBar(LAYER_KEY, {
    ariaLabel: 'CPC Drought Outlook register',
    stamp: {
      headline: `${issuedPart}${targetPart}`,
      // vocab-allow: honesty disclaimer, denies being a forecast
      detail: `CPC ${rangeName(range)} Drought Outlook · a shift in odds, not a forecast of outcomes`,
      register: 'outlook'
    },
    modes: {
      options: [
        {
          key: 'monthly',
          label: 'Monthly',
          title: 'CPC Monthly Drought Outlook (issued the last day of each month)'
        },
        {
          key: 'seasonal',
          label: 'Seasonal',
          title: 'CPC Seasonal Drought Outlook (three-month horizon)'
        }
      ],
      activeKey: range,
      onSelect: (key) => {
        void showRange(map, key === 'monthly' ? 'monthly' : 'seasonal');
      }
    },
    jumps: {
      options: [
        {
          key: 'observed',
          label: 'Observed weeks',
          title: 'Back to the US Drought Monitor: observed conditions, solid fills',
          hatched: false
        }
      ],
      onJump: () => switchToObserved()
    }
  });
}

/**
 * The instrument switch back: a real surface switch via the shared
 * toggle command (ADR 0002 condition 2, D-0.7.0-008; DOM-free, so it
 * works even before the catalog island mounts).
 */
function switchToObserved(): void {
  // The jump back is a surface switch INTO the observed register:
  // commit the 'current' horizon through the ONE temporal authority
  // (the S3 service's requestHorizon, the same door the shell's
  // horizon chips use; DG-080 review blocker 1). For a
  // drought-composition display the service re-resolves the current
  // recipe (the US Drought Monitor on, this outlook off) in one
  // shielded transaction, so the clean cluster claim survives the
  // switch; a custom display keeps its granular set there, and the
  // direct layer door below performs the surface switch for it (an
  // idempotent no-op otherwise).
  requestHorizon('current');
  requestLayerOn('usdm');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Hatch pattern per class; No_Drought matches nothing and renders blank. */
const patternExpression: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'outlook'],
  'Persistence', hatchImageId('PERSISTS'),
  'Development', hatchImageId('DEVELOPS'),
  'Improvement', hatchImageId('IMPROVES'),
  'Removal', hatchImageId('REMOVAL'),
  ''
];

const outlineColorExpression: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'outlook'],
  'Persistence', DROUGHT_COLORS['PERSISTS']!,
  'Development', DROUGHT_COLORS['DEVELOPS']!,
  'Improvement', DROUGHT_COLORS['IMPROVES']!,
  'Removal', DROUGHT_COLORS['REMOVAL']!,
  'rgba(0,0,0,0)'
];

/** Forecast classes only; No_Drought stays blank like CPC's own map. */
function outlookOnly(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features.filter(
      (f) => (f.properties ?? {})['outlook'] !== 'No_Drought'
    )
  };
}

/**
 * Roll the temporal claim back to the range the map is actually showing
 * (DG-080 r2 finding 1, the commit-before-render half): a range switch
 * commits its horizon, outlook register, and URL at request time, so a
 * terminal fetch failure would otherwise leave the pressed chip and the
 * URL claiming a range the old polygons still render. Re-commit the
 * DISPLAYED range's horizon and register in one synchronous pass (the
 * sidebar's timeline subscription re-serializes the URL from the same
 * writes) and restore the honest status of what is on screen. The
 * rendered range's features are in the session cache by construction
 * (they rendered), so the status mirrors the render-time report.
 */
function rollBackToRenderedRange(range: OutlookRange): void {
  requestedRange = range;
  timeline.setHorizon(horizonForOutlookRange(range));
  timeline.setOutlookRange(range);
  const fc = outlookCache.get(range);
  reportStatus(fc !== undefined && fc.features.length === 0 ? 'no-data' : 'ready');
}

/**
 * Fetch and render an outlook range. Supersede-safe: a newer call ABORTS
 * the previous call's in-flight request through its per-range controller
 * (linked to the layer master signal; DG-080 r2 finding 3), the epoch
 * guard drops any result that slips through, and an aborted master
 * signal drops silently (invariant 5). A terminal failure of an
 * uncached range change rolls the committed claim back to the rendered
 * range instead of leaving a chip and URL the map does not show.
 *
 * The thin wrapper records each invocation in `latestRangeRun` so the
 * activation spine can settle on the newest owner (DG-080 r3 finding 1;
 * settleLatestRange below).
 */
function showRange(map: maplibregl.Map, range: OutlookRange): Promise<void> {
  const run = runShowRange(map, range);
  latestRangeRun = run;
  return run;
}

/**
 * Await range requests until the newest one has settled with no newer
 * request superseding it (DG-080 r3 finding 1): a horizon supersession
 * during the FIRST load aborts the awaited showRange, which returns
 * silently while the replacement runs unowned. If the replacement then
 * fails terminally before anything rendered, no controller operation is
 * awaiting that failure, so the terminal-error cleanup in
 * createLayerController (uncheck, deactivate, URL withdrawal) never
 * runs and a checked, URL-claimed, empty failed surface remains. This
 * serialized latest-promise loop keeps `activate` attached to whichever
 * request currently owns the surface, so the controller observes the
 * FINAL ready / no-data / error state; the cleanup itself stays in the
 * controller, never duplicated here.
 */
async function settleLatestRange(): Promise<void> {
  let settled: Promise<void> | null = null;
  while (latestRangeRun !== null && latestRangeRun !== settled) {
    settled = latestRangeRun;
    await settled;
  }
}

async function runShowRange(map: maplibregl.Map, range: OutlookRange): Promise<void> {
  const masterSignal = masterController?.signal ?? null;
  if (!masterSignal) return;
  const myEpoch = ++loadEpoch;

  // Supersede: cancel the previous range request's network work now.
  rangeController?.abort();
  const myController = new AbortController();
  rangeController = myController;
  const onMasterAbort = (): void => myController.abort();
  masterSignal.addEventListener('abort', onMasterAbort, { once: true });
  const signal = myController.signal;

  // The range the map currently shows, for the failure rollback below.
  const priorRendered = renderedRange;

  // The displayed outlook register IS the temporal claim (DG-080 review
  // blocker 1): rendering a range commits the matching horizon, so the
  // pressed chip and the legacy `outlook=` URL restore can never claim
  // 'current' over an outlook display. requestedRange is set before the
  // writes so the follow subscription ignores this echo; setHorizon
  // (which maps the register in the same write) runs first so no
  // intermediate emit pairs a new register with a stale horizon, and
  // the direct setOutlookRange after it covers the inherited edge where
  // the horizon is already right but the register is not. All no-ops
  // when the claim is already coherent. On terminal fetch failure the
  // rollback below withdraws this commit together with the status.
  requestedRange = range;
  timeline.setHorizon(horizonForOutlookRange(range));
  timeline.setOutlookRange(range);

  try {
    let fc = outlookCache.get(range);
    if (!fc) {
      reportStatus('loading');
      try {
        // fetchJsonWithBudget, NOT fetchWithBudget + response.json(): the
        // latter's contract ends at response HEADERS, so a stalled body
        // outlived both the abort signal and the timeout and could hold
        // settleLatestRange indefinitely (DG-080 r4 finding 1). This helper
        // reads the body through an explicit reader, so a supersede or a
        // layer-off abort cancels a hung stream mid-parse.
        const parsed = await fetchJsonWithBudget(
          buildQueryUrl(range),
          null,
          signal,
          FETCH_TIMEOUT_MS
        );
        fc = outlookOnly(parsed as GeoJSON.FeatureCollection);
        outlookCache.set(range, fc);
      } catch (err) {
        // Aborted (layer-off or a newer range request) or superseded:
        // the newer owner holds the claim; do not touch it.
        if (signal.aborted || myEpoch !== loadEpoch) return;
        console.warn(`[drought] CPC ${range} outlook fetch failed.`, err);
        if (priorRendered !== null && priorRendered !== range) {
          // A failed SWITCH on an already-rendered surface: the old
          // range still renders, so horizon, register, URL, and status
          // roll back to it together (r2 finding 1).
          rollBackToRenderedRange(priorRendered);
        } else {
          // Initial load (nothing rendered yet): honest terminal error;
          // the activation spine's failure cleanup owns the rest.
          // `activate` is still awaiting this settle even when this call
          // REPLACED a superseded first request (settleLatestRange), so
          // the controller always observes this terminal state.
          reportStatus('error');
        }
        return;
      }
    }
    if (signal.aborted || myEpoch !== loadEpoch) return;

    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    src?.setData(fc);
    renderedRange = range;

    if (fc.features.length === 0) {
      // A whole-country outlook with no forecast-class polygons would be
      // extraordinary; surface it honestly rather than as a blank surprise.
      reportStatus('no-data');
    } else {
      reportStatus('ready');
    }
    installTimeBar(map, fc);
  } finally {
    masterSignal.removeEventListener('abort', onMasterAbort);
    if (rangeController === myController) rangeController = null;
  }
}

/**
 * Add the outlook source, the hatched fill, the class outline, the legend,
 * and the time bar, then load the range the timeline selects. Idempotent:
 * a re-activation with the source present re-renders the selected range
 * only if it changed.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    if (renderedRange !== timeline.outlookRange) {
      void showRange(map, timeline.outlookRange);
      await settleLatestRange();
    }
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();

  // Follow the outlook register while this surface is active (DG-080
  // review blocker 1): a committed-horizon flip between weeks-ahead and
  // season-ahead re-runs the S3 cluster transaction, but the exact
  // toggle door no-ops on this already-on layer, so the register change
  // must reach the mounted surface directly or the map keeps rendering
  // the old outlook under a new claim. requestedRange filters this
  // subscription's own echo (showRange writes the registers it renders).
  if (!unsubscribeTimeline) {
    unsubscribeTimeline = timeline.onChange(() => {
      if (!masterController) return;
      if (requestedRange !== null && timeline.outlookRange !== requestedRange) {
        void showRange(map, timeline.outlookRange);
      }
    });
  }

  reportStatus('loading');

  try {
    ensureHatchImages(map);

    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: 'NOAA CPC'
    });

    const beforeId = map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;

    map.addLayer(
      {
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-pattern': patternExpression,
          // The hatch tiles carry their own transparency; full layer
          // opacity keeps the strokes crisp over the basemap.
          'fill-opacity': 1
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
          'line-color': outlineColorExpression,
          'line-width': 1.1,
          'line-opacity': 0.9
        }
      },
      beforeId
    );

    showLegend(LAYER_KEY, {
      order: LEGEND_ORDER.surface,
      render: (body) =>
        renderSwatchLegend(
          body,
          'Drought outlook key',
          OUTLOOK_LEGEND,
          // vocab-allow: names the CPC outlook (an upstream forecast product) and disclaims outcomes
          'NOAA CPC Drought Outlook · hatched fills mark a FORECAST register; a shift in odds, not a forecast of outcomes'
        )
    });
  } catch (err) {
    reportStatus('error');
    throw err;
  }

  // Settle on the LATEST range owner, not merely the first request
  // (DG-080 r3 finding 1): a horizon flip during this initial load
  // launches a replacement through the timeline subscription above, and
  // the returned promise must follow it (and any later replacement) so
  // createLayerController observes the final terminal state.
  void showRange(map, timeline.outlookRange);
  await settleLatestRange();
}

/**
 * The shared cancellation primitive behind `cancelActivation` and
 * `deactivate` (DG-080 r4 finding 2). Touches NO map state: it drops every
 * in-flight network owner and invalidates anything already racing past an
 * abort check, so the activation spine's `settleLatestRange` loop can
 * observe a settled owner and return.
 *
 * Nulling `masterController` also makes the timeline follow subscription
 * inert on its existing `if (!masterController) return;` guard, which is
 * what keeps a register change from launching a replacement range during
 * the window between synchronous off intent and the queued teardown that
 * actually unsubscribes it.
 */
function cancelInFlight(): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (rangeController) {
    // Linked to the master signal already; explicit for symmetry and for
    // the never-activated edge.
    rangeController.abort();
    rangeController = null;
  }
  loadEpoch++;
  latestRangeRun = null;
}

/**
 * Synchronous cancellation seam (the optional LayerModule hook): invoked by
 * the layer controller the moment off intent is recorded, BEFORE the
 * serialized teardown op reaches this module. Without it, turning Drought
 * off during activation could not reach any abort path, because the queued
 * `deactivate` waits on the very promise it needs to cancel (DG-080 r4
 * finding 2; CLAUDE.md section 6 invariant 5). Touches no map state;
 * `deactivate` still owns the serialized source and layer removal.
 */
export function cancelActivation(): void {
  cancelInFlight();
}

/**
 * Abort in-flight work and remove the outlook layers, source, legend, and
 * time bar. The hatch images stay registered on the map (tiny, reusable).
 * Symmetric with `activate`; safe to call when never activated.
 */
export function deactivate(map: maplibregl.Map): void {
  cancelInFlight();
  if (unsubscribeTimeline) {
    unsubscribeTimeline();
    unsubscribeTimeline = null;
  }
  renderedRange = null;
  requestedRange = null;
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  clearTimeBar(LAYER_KEY);
  hideLegend(LAYER_KEY);
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

const OUTLOOK_CLASS_COPY: Readonly<Record<string, string>> = {
  Persistence: 'Existing drought is favored to persist through the outlook period.',
  Development: 'Drought development is favored in this currently non-drought area.',
  Improvement: 'Existing drought is favored to improve, though some may remain.',
  Removal: 'Existing drought is favored to end within the outlook period.'
};

function buildOutlookPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const cls = typeof p['outlook'] === 'string' ? p['outlook'] : '';
  const issued = typeof p['fcst_date'] === 'string' ? humanIssueDate(p['fcst_date']) : '';
  const target = typeof p['target'] === 'string' ? p['target'] : '';
  const copy = OUTLOOK_CLASS_COPY[cls] ?? 'CPC drought outlook class.';
  const title = cls === 'Persistence' ? 'Drought persists'
    : cls === 'Development' ? 'Drought develops'
    : cls === 'Improvement' ? 'Drought improves'
    : cls === 'Removal' ? 'Drought removal likely'
    : 'Drought outlook';

  // vocab-allow: names the CPC outlook (an upstream forecast product) and disclaims outcomes
  return `
    <div class="popup-title">${escapeHtml(title)}</div>
    <div class="popup-agency">NOAA CPC ${escapeHtml(rangeName(timeline.outlookRange))} Drought Outlook</div>
    ${issued ? `<div class="popup-treaty-meta">Issued: ${escapeHtml(issued)}</div>` : ''}
    ${target ? `<div class="popup-treaty-meta">Valid through: ${escapeHtml(target)}</div>` : ''}
    <div class="popup-description">${escapeHtml(copy)} This is a forecast register: a shift in odds, not a forecast of outcomes.</div>
    <div class="popup-links">
      <a href="https://www.cpc.ncep.noaa.gov/products/expert_assessment/sdo_summary.php" target="_blank" rel="noopener">CPC Drought Outlook</a>
      <a href="https://www.drought.gov/" target="_blank" rel="noopener">Drought.gov</a>
    </div>
  `;
}

/**
 * Register the hatched fill's click target with the
 * InteractionCoordinator (one response per click; D-0.7.0-058 ruling 5;
 * condition surfaces rank last so they never blanket a boundary).
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [FILL_LAYER_ID],
    label: (feature) => {
      const cls = feature.properties?.['outlook'];
      return typeof cls === 'string' && cls.trim() !== ''
        ? `Drought outlook: ${cls}`
        : 'Drought outlook';
    },
    respond: (feature) => ({
      content: buildOutlookPopupHtml(feature.properties ?? {})
    })
  });
  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
