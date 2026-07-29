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
import { timeline, type OutlookRange } from '../state/timeline';
import { fetchWithBudget } from '../util/fetch';
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
/** Supersede counter for range switches (invariant 5). */
let loadEpoch = 0;
/** The range currently rendered, for idempotence checks. */
let renderedRange: OutlookRange | null = null;

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
 * Fetch and render an outlook range. Supersede-safe: a slower response for
 * a range the user has since switched away from is dropped, and an aborted
 * master signal drops silently (invariant 5).
 */
async function showRange(map: maplibregl.Map, range: OutlookRange): Promise<void> {
  const signal = masterController?.signal ?? null;
  if (!signal) return;
  const myEpoch = ++loadEpoch;

  timeline.setOutlookRange(range);

  let fc = outlookCache.get(range);
  if (!fc) {
    reportStatus('loading');
    try {
      const response = await fetchWithBudget(buildQueryUrl(range), null, signal, FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      fc = outlookOnly((await response.json()) as GeoJSON.FeatureCollection);
      outlookCache.set(range, fc);
    } catch (err) {
      if (signal.aborted || myEpoch !== loadEpoch) return;
      console.warn(`[drought] CPC ${range} outlook fetch failed.`, err);
      reportStatus('error');
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
      await showRange(map, timeline.outlookRange);
    }
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();

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

  await showRange(map, timeline.outlookRange);
}

/**
 * Abort in-flight work and remove the outlook layers, source, legend, and
 * time bar. The hatch images stay registered on the map (tiny, reusable).
 * Symmetric with `activate`; safe to call when never activated.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  loadEpoch++;
  renderedRange = null;
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
