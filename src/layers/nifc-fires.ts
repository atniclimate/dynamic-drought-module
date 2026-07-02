/**
 * National Interagency Fire Center (NIFC) active wildland fire perimeters.
 *
 * Source: Wildland Fire Interagency Geospatial Services (WFIGS) "Current
 * Interagency Fire Perimeters" feature service, hosted on the NIFC Open
 * Data Hub as an Environmental Systems Research Institute (ESRI)
 * Representational State Transfer (REST) FeatureServer. Refreshed
 * approximately every five minutes from the upstream WFIGS database.
 *
 * Endpoint choice. The NIFC Open Data Hub publishes several WFIGS
 * perimeter products:
 *   - WFIGS_Interagency_Perimeters            (cumulative, all years)
 *   - WFIGS_Interagency_Perimeters_YearToDate (current calendar year)
 *   - WFIGS_Interagency_Perimeters_Current    (currently active fires)
 *   - WFIGS_Daily_Perimeters_Public           (daily snapshot)
 *   - WFIGS_Interagency_Perimeters_Certified  (post-incident, finalized)
 * For a "what is burning right now" overlay we want the
 * `_Current` view, which constrains to active incidents only.
 *
 * Verification (2026-05-09):
 *   GET <URLS.nifcFires>/query?where=1%3D1&outFields=*&f=geojson
 *     - HTTP 200
 *     - Content-Type: application/json; charset=utf-8
 *     - Access-Control-Allow-Origin: *
 *     - Body: GeoJSON FeatureCollection of polygons with WFIGS
 *       attribute schema (`poly_*` for geometry-derived fields,
 *       `attr_*` for incident metadata such as
 *       `attr_IncidentName`, `attr_IncidentTypeCategory`,
 *       `attr_IncidentSize`, `attr_FireDiscoveryDateTime`,
 *       `attr_POOState`).
 *
 * Render. WFIGS perimeters are polygons; we draw a translucent red fill
 * (`#dc2626` at 0.45 opacity) plus a darker outline (`#7f1d1d`) so the
 * shapes read clearly against both the basemap and over the
 * USDM and Wildfire Hazard Potential overlays. Click handlers expose
 * incident name, type category, size, discovery date, and state of
 * origin in the popup.
 */

import maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { escapeHtml } from '../util/escape';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';

const LAYER_KEY = 'nifc-fires';
const SOURCE_ID = 'nifc-fires';
const FILL_LAYER_ID = 'nifc-fires-fill';
const OUTLINE_LAYER_ID = 'nifc-fires-outline';

/**
 * Symbol layer ID used as the `beforeId` anchor when inserting fill and
 * outline layers. Matches the convention from `usdm.ts`, `ecoregions.ts`,
 * and `tribal.ts` so polygon overlays stack consistently below the
 * basemap label glyphs.
 */
const BEFORE_ID = 'first-symbol';

/** Per-call network budget for the WFIGS perimeters query. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Master cancellation controller for the in-flight fetch. Aborted on
 * `deactivate` and replaced on each `activate` so a superseded request can
 * never render into a torn-down layer (CLAUDE.md section 6 invariant 5).
 */
let masterController: AbortController | null = null;

type NifcStatus = 'loading' | 'ready' | 'error' | 'no-data';

function reportStatus(state: NifcStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Build the GeoJSON query URL. We request all attribute fields so popups
 * have everything they need without a second round trip, pin output to
 * `EPSG:4326` so MapLibre receives lon/lat coordinates regardless of any
 * future server default change, and pass `where=1=1` so the server returns
 * every active perimeter.
 */
function buildQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.nifcFires}/query?${params.toString()}`;
}

/**
 * Add the NIFC fires source plus fill and outline layers. Idempotent: if
 * the source already exists this returns early after re-reporting status.
 * Empty FeatureCollection input is mapped to `'no-data'` rather than an
 * error since "no active fires anywhere" is a legitimate (if rare) result.
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
    console.warn('[nifc-fires] WFIGS perimeters fetch failed.', err);
    reportStatus('error');
    return;
  }

  // A late response to a torn-down activation must not render.
  if (signal.aborted) return;

  const features = geojson?.features ?? [];

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: geojson,
    attribution: 'NIFC WFIGS'
  });

  if (features.length === 0) {
    reportStatus('no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      paint: {
        'fill-color': '#dc2626',
        'fill-opacity': 0.45
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
        'line-color': '#7f1d1d',
        'line-width': 1.4,
        'line-opacity': 0.95
      }
    },
    beforeId
  );

  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event + 1,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Active wildfires',
        [{ color: '#dc2626', label: 'Active fire perimeter' }],
        'NIFC WFIGS current interagency perimeters.'
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
  if (map.getLayer(FILL_LAYER_ID)) {
    map.removeLayer(FILL_LAYER_ID);
  }
  if (map.getLayer(OUTLINE_LAYER_ID)) {
    map.removeLayer(OUTLINE_LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
  hideLegend(LAYER_KEY);
}

/**
 * Resolve the most useful incident name from the WFIGS attribute schema.
 * `attr_IncidentName` is canonical, `poly_IncidentName` is the geometry
 * source's name (sometimes more specific), and `IncidentName` is the
 * legacy field name. Returns `'Active Wildland Fire'` if every candidate
 * is blank.
 */
function pickIncidentName(props: GeoJsonProperties): string {
  const p = props ?? {};
  const candidate =
    p.attr_IncidentName ??
    p.poly_IncidentName ??
    p.IncidentName ??
    p.incidentName;
  if (candidate === null || candidate === undefined || candidate === '') {
    return 'Active Wildland Fire';
  }
  return String(candidate);
}

/**
 * Format a WFIGS date field. Like NDMC, ESRI ImageServer feature outputs
 * use milliseconds-since-epoch integers; we render `YYYY-MM-DD` in UTC.
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
 * Format a numeric acreage value. WFIGS exposes `attr_IncidentSize` and
 * `attr_DailyAcres` as floats; we round to whole acres for display since
 * sub-acre precision exceeds typical perimeter accuracy.
 */
function formatAcres(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Translate the WFIGS `attr_IncidentTypeCategory` short code to a human
 * label. Most active perimeters are `'WF'` (Wildfire); `'RX'` is a
 * prescribed fire and `'CX'` is a complex (multiple incidents managed
 * together). Unknown codes fall through unchanged.
 */
function formatIncidentType(code: unknown): string {
  if (typeof code !== 'string' || code.length === 0) return '';
  switch (code.toUpperCase()) {
    case 'WF':
      return 'Wildfire';
    case 'RX':
      return 'Prescribed fire';
    case 'CX':
      return 'Incident complex';
    default:
      return code;
  }
}

/**
 * Build the popup HTML for an active wildfire perimeter. Kept in-file for
 * M9 (the M5 popups module is being written concurrently and we do not
 * want to fight over `src/ui/popups.ts`).
 */
function buildNifcPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const incidentName = pickIncidentName(p);
  const type = formatIncidentType(p.attr_IncidentTypeCategory);
  const acres = formatAcres(
    p.attr_IncidentSize ?? p.attr_DailyAcres ?? p.poly_GISAcres
  );
  const discovered = formatDate(p.attr_FireDiscoveryDateTime);
  const stateRaw = p.attr_POOState;
  // POOState arrives as `US-XX`; trim the prefix for readable display.
  const state =
    typeof stateRaw === 'string' && stateRaw.startsWith('US-')
      ? stateRaw.slice(3)
      : (stateRaw ?? '');

  return `
    <div class="popup-title">${escapeHtml(incidentName)}</div>
    <div class="popup-agency">NIFC WFIGS - Active Perimeter</div>
    ${type ? `<div class="popup-treaty-meta">Type: ${escapeHtml(type)}</div>` : ''}
    ${acres ? `<div class="popup-treaty-meta">Size: ${escapeHtml(acres)} acres</div>` : ''}
    ${discovered ? `<div class="popup-treaty-meta">Discovered: ${escapeHtml(discovered)}</div>` : ''}
    ${state ? `<div class="popup-treaty-meta">State: ${escapeHtml(String(state))}</div>` : ''}
    <div class="popup-description">Perimeter sourced from the National Interagency Fire Center (NIFC) Wildland Fire Interagency Geospatial Services (WFIGS) feed. Updated approximately every five minutes during active operations.</div>
    <div class="popup-links">
      <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener">NIFC Open Data</a>
      <a href="https://inciweb.wildfire.gov/" target="_blank" rel="noopener">InciWeb</a>
    </div>
  `;
}

/**
 * Wire a click handler on the fill layer that opens a MapLibre popup with
 * incident metadata for the clicked perimeter. Cursor affordance switches
 * to pointer on hover so users see that perimeters are interactive.
 */
export function bindPopups(map: maplibregl.Map): void {
  map.on('click', FILL_LAYER_ID, (e) => {
    const feature = e.features && e.features[0];
    if (!feature) return;
    const html = buildNifcPopupHtml(feature.properties ?? {});
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
