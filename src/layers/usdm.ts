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
 * This layer renders the most recent USDM week. It is a different product
 * than the National Oceanic and Atmospheric Administration (NOAA) Climate
 * Prediction Center (CPC) Seasonal Drought Outlook handled by the M4
 * `drought.ts` module: USDM is a current-conditions composite, while CPC
 * Seasonal Drought Outlook is a forward-looking forecast.
 *
 * Endpoint choice. Three transport options were evaluated during M9:
 *   a. `https://droughtmonitor.unl.edu/data/json/usdm_<YYYYMMDD>.json` --
 *      requires the caller to compute the most recent Tuesday-aligned
 *      release date and probe backwards on a 404, plus the path predates
 *      the formal Open Data publication.
 *   b. `https://droughtmonitor.unl.edu/data/shapefiles_m/USDM_current_M.zip`
 *      -- shapefile, not directly browser-consumable.
 *   c. NDMC ArcGIS Online FeatureServer (the "USDM_current" service) --
 *      Environmental Systems Research Institute (ESRI) Representational
 *      State Transfer (REST) feature service that emits GeoJSON with
 *      `f=geojson`, refreshed each Thursday by NDMC. Uses date fields in
 *      milliseconds-since-epoch (`MapDate`, `ValidStart`, `ValidEnd`).
 *
 * Option (c) is the cleanest browser-reachable choice and is what we use.
 * The URL is centralized in `src/config/urls.ts` as `URLS.usdmFeatureServer`.
 *
 * Verification (2026-05-09):
 *   GET <URLS.usdmFeatureServer>/query?where=1%3D1&outFields=*&f=geojson
 *     - HTTP 200
 *     - Content-Type: application/json; charset=utf-8
 *     - Access-Control-Allow-Origin: *
 *     - Body: GeoJSON FeatureCollection of polygons, one feature per
 *       drought category present that week, with `properties.DM` in 0..4.
 *
 * Render. Per USDM convention, the five categories use the canonical
 * yellow-to-dark-red ramp (D0 #FFFF00, D1 #FCD37F, D2 #FFAA00, D3 #E60000,
 * D4 #730000). Fill opacity 0.6 keeps the basemap visible. A thin matching
 * outline disambiguates adjacent categories. Color is resolved by a
 * MapLibre `match` data-driven expression keyed off the integer `DM`
 * field; no per-feature precomputation is needed.
 */

import maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { escapeHtml } from '../util/escape';

const SOURCE_ID = 'usdm-current';
const FILL_LAYER_ID = 'usdm-current-fill';
const OUTLINE_LAYER_ID = 'usdm-current-outline';

/**
 * Symbol layer ID used as the `beforeId` anchor when inserting the fill
 * and outline layers; matches the convention from `ecoregions.ts` and
 * `tribal.ts` so reference polygon layers stack consistently below the
 * basemap label glyphs. If the active style does not declare this layer
 * MapLibre falls back to appending at the top of the layer list.
 */
const BEFORE_ID = 'first-symbol';

/**
 * Canonical USDM category palette. Indices align with the integer `DM`
 * attribute that NDMC publishes (0=D0 Abnormally Dry through 4=D4
 * Exceptional Drought).
 */
const USDM_COLORS: ReadonlyArray<string> = [
  '#FFFF00', // D0 Abnormally Dry
  '#FCD37F', // D1 Moderate Drought
  '#FFAA00', // D2 Severe Drought
  '#E60000', // D3 Extreme Drought
  '#730000'  // D4 Exceptional Drought
];

/**
 * Human-readable label per USDM category, indexed by `DM` value. Used by
 * `bindPopups` to render readable category names and by
 * `formatCategoryLabel` for any future legend chip work.
 */
const USDM_LABELS: ReadonlyArray<string> = [
  'D0 - Abnormally Dry',
  'D1 - Moderate Drought',
  'D2 - Severe Drought',
  'D3 - Extreme Drought',
  'D4 - Exceptional Drought'
];

type UsdmStatus = 'loading' | 'live' | 'unavailable' | 'no-data';

function reportStatus(state: UsdmStatus): void {
  // Placeholder until M7 wires the LayerRegistry; mirrors the convention
  // used by `treaty.ts` and `tribal.ts`.
  console.info('[usdm]', state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Build the GeoJSON query URL for the USDM FeatureServer. We request all
 * fields (`outFields=*`) so popups can show release/validity dates without
 * a second round trip, and pin `outSR=4326` so MapLibre receives native
 * lon/lat coordinates regardless of any future server default change.
 */
function buildQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.usdmFeatureServer}/query?${params.toString()}`;
}

/**
 * Add the USDM source plus fill and outline layers. Idempotent: if the
 * source already exists, the function exits after re-reporting status so
 * the registry observes a terminal state on a re-activation.
 *
 * Network failures surface as `'unavailable'` rather than throwing; the
 * caller (LayerRegistry, M7) is responsible for surfacing this in the
 * sidebar status pill.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  reportStatus('loading');

  let geojson: GeoJSON.FeatureCollection;
  try {
    const response = await fetch(buildQueryUrl());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    geojson = (await response.json()) as GeoJSON.FeatureCollection;
  } catch (err) {
    console.warn('[usdm] Drought Monitor fetch failed.', err);
    reportStatus('unavailable');
    return;
  }

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'USDM (NDMC / NOAA / USDA)'
  });

  if (features.length === 0) {
    // The USDM is published weekly; an empty FeatureCollection means
    // every category is absent (full national coverage, no drought),
    // which is rare but valid. Surface as `'no-data'` so the sidebar
    // can communicate it without alarming the user.
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  // Color is resolved at render time via a `match` expression keyed off
  // the integer `DM` attribute. The fallback color (`#cccccc`) only
  // applies if NDMC ever ships a feature outside 0..4, which would be a
  // data anomaly worth noticing in the rendered output.
  const colorExpression: maplibregl.ExpressionSpecification = [
    'match',
    ['get', 'DM'],
    0, USDM_COLORS[0],
    1, USDM_COLORS[1],
    2, USDM_COLORS[2],
    3, USDM_COLORS[3],
    4, USDM_COLORS[4],
    '#cccccc'
  ];

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': colorExpression,
        'fill-opacity': 0.6
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
        'line-width': 0.6,
        'line-opacity': 0.85
      }
    },
    beforeId
  );

  reportStatus('live');
}

/**
 * Remove the USDM fill, outline, and source. Each guard is defensive so
 * callers can safely invoke `deactivate` without first checking activation
 * state. Symmetric with `activate`.
 */
export function deactivate(map: maplibregl.Map): void {
  if (map.getLayer(FILL_LAYER_ID)) {
    map.removeLayer(FILL_LAYER_ID);
  }
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    map.removeLayer(OUTLINE_LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
}

/**
 * Format a USDM category integer (0..4) into a human-readable label.
 * Returns the literal `'Unknown drought category'` for anything else; this
 * is intentional and surfaces upstream data anomalies in the popup rather
 * than silently substituting a guess.
 */
function formatCategoryLabel(dm: unknown): string {
  if (typeof dm !== 'number') return 'Unknown drought category';
  if (dm < 0 || dm > 4 || !Number.isInteger(dm)) {
    return 'Unknown drought category';
  }
  return USDM_LABELS[dm];
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

/**
 * Build the popup HTML for a USDM polygon feature. Kept in-file (rather
 * than in `src/ui/popups.ts`) for M9 to avoid touching the popups module,
 * which the M5 work owns. Future consolidation may move this to the
 * shared popups module without changing call sites.
 */
function buildUsdmPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const dm = (p.DM ?? p.dm) as unknown;
  const category = formatCategoryLabel(dm);
  const mapDate = formatDate(p.MapDate ?? p.mapDate);
  const validStart = formatDate(p.ValidStart ?? p.validStart);
  const validEnd = formatDate(p.ValidEnd ?? p.validEnd);

  return `
    <div class="popup-title">${escapeHtml(category)}</div>
    <div class="popup-agency">USDM (NDMC / NOAA / USDA)</div>
    ${mapDate ? `<div class="popup-treaty-meta">Map date: ${escapeHtml(mapDate)}</div>` : ''}
    ${validStart && validEnd ? `<div class="popup-treaty-meta">Valid: ${escapeHtml(validStart)} to ${escapeHtml(validEnd)}</div>` : ''}
    <div class="popup-description">United States Drought Monitor categories range from D0 (abnormally dry) through D4 (exceptional drought). Updated weekly each Thursday morning Eastern Time.</div>
    <div class="popup-links">
      <a href="https://droughtmonitor.unl.edu/" target="_blank" rel="noopener">U.S. Drought Monitor</a>
      <a href="https://www.drought.gov/" target="_blank" rel="noopener">Drought.gov</a>
    </div>
  `;
}

/**
 * Wire a click handler on the USDM fill layer that opens a MapLibre popup
 * with category, map date, and validity window for the clicked polygon.
 * Mirrors the cursor affordance pattern from `treaty.ts`.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features && e.features[0];
    if (!feature) return;
    const html = buildUsdmPopupHtml(feature.properties ?? {});
    new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
  });

  map.on('mouseenter', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
