/**
 * National Interagency Fire Center (NIFC) current mapped fire perimeters.
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
 * The `_Current` view supplies the agency's current mapped perimeter product;
 * its incident categories still require the Wildfire, Prescribed fire, and
 * other or unclassified presentation split below.
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
 * Query scope (FE-16, 2026-08-28). The shipped national query with
 * `outFields=*` and full-precision geometry measured 42.75 MB in 41.6 s for
 * 243 perimeters against this layer's 15 s budget, so the layer aborted and
 * read `unavailable` on every boot. The query now names the nine attributes
 * the layer, popup, map key, and conditions strip read (NIFC_OUT_FIELDS,
 * schema-checked; a wrong name is an HTTP 400) and asks the service for
 * display generalization (`maxAllowableOffset` 0.0005 degree,
 * `geometryPrecision` 5): 1.83 MB in 4.5 s on the same day. The
 * generalization changes the drawn edge, so NIFC_GENERALIZATION_NOTE is
 * carried by the legend, the popup, and the map key. Viewport or region
 * scoping stays with roadmap task DDM-P1-T06.
 *
 * Render. WFIGS perimeters are polygons. Wildfire and incident-complex
 * records use a restrained orange pulse, Prescribed fire uses a neutral
 * treatment, and other or unclassified records receive a neutral outline.
 * No perimeter age is inferred from the service refresh cadence.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import {
  NIFC_GENERALIZATION_NOTE,
  NIFC_GEOMETRY_PRECISION,
  NIFC_INCIDENT_TYPE_PROPERTY,
  NIFC_INCIDENT_PRESENTATION,
  NIFC_MAX_ALLOWABLE_OFFSET_DEG,
  NIFC_OUT_FIELDS,
  WILDFIRE_PULSE_DURATION_MS,
  buildNifcFillPaint,
  buildNifcIncidentFilter,
  buildNifcLinePaint,
  classifyNifcIncidentType,
  interpolateWildfirePulseColor,
  nifcIncidentTypeLabel,
  parseArcGisPolygonFeatureCollection
} from '../config/wildfire-presentation';
import { registerClickTarget } from '../map/interaction-coordinator';
import { escapeHtml } from '../util/escape';
import { fetchJsonWithBudget } from '../util/fetch';
import { prefersReducedMotion } from '../util/motion';
import { registry } from '../state/registry';
import { showLegend, hideLegend, LEGEND_ORDER, renderSwatchLegend } from '../ui/legend-registry';
import { buildFireContextHtml } from '../impact/fire-context';

const LAYER_KEY = 'nifc-fires';
const SOURCE_ID = 'nifc-fires';
const FILL_LAYER_ID = 'nifc-fires-fill';
const OUTLINE_LAYER_ID = 'nifc-fires-outline';
const PRESCRIBED_FILL_LAYER_ID = 'nifc-prescribed-fill';
const PRESCRIBED_OUTLINE_LAYER_ID = 'nifc-prescribed-outline';
const OTHER_OUTLINE_LAYER_ID = 'nifc-other-outline';

/** The only MapLibre paint properties animated by the wildfire pulse. */
export const WILDFIRE_PULSE_PAINT_TARGETS = [
  { layerId: FILL_LAYER_ID, paintProperty: 'fill-color' },
  { layerId: OUTLINE_LAYER_ID, paintProperty: 'line-color' }
] as const;

/** About 17 paint updates per second, while requestAnimationFrame owns timing. */
const WILDFIRE_PULSE_PAINT_INTERVAL_MS = 60;

/**
 * One layer-level animation owner. Every WF/CX feature shares these two
 * filtered MapLibre layers, so no feature-level timer or DOM animation is
 * needed. Visibility and layer-existence guards avoid background/stale work.
 */
class WildfirePulseController {
  private frameId: number | null = null;
  private originMs: number | null = null;
  private lastPaintAtMs = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(private readonly map: maplibregl.Map) {}

  start(): void {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.scheduleFrame();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.cancelFrame();
  }

  private readonly onVisibilityChange = (): void => {
    if (this.stopped) return;
    if (document.hidden) {
      this.cancelFrame();
      return;
    }
    this.scheduleFrame();
  };

  private readonly paintFrame = (timestampMs: number): void => {
    this.frameId = null;
    if (this.stopped || document.hidden) return;

    // Begin at the canonical static midpoint, then ease toward the hot end.
    this.originMs ??= timestampMs - WILDFIRE_PULSE_DURATION_MS / 4;
    if (timestampMs - this.lastPaintAtMs >= WILDFIRE_PULSE_PAINT_INTERVAL_MS) {
      const color = interpolateWildfirePulseColor(timestampMs - this.originMs);
      let foundTarget = false;
      for (const target of WILDFIRE_PULSE_PAINT_TARGETS) {
        if (!this.map.getLayer(target.layerId)) continue;
        foundTarget = true;
        this.map.setPaintProperty(
          target.layerId,
          target.paintProperty,
          color
        );
      }
      if (!foundTarget) {
        this.stop();
        return;
      }
      this.lastPaintAtMs = timestampMs;
    }
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    if (this.stopped || document.hidden || this.frameId !== null) return;
    this.frameId = window.requestAnimationFrame(this.paintFrame);
  }

  private cancelFrame(): void {
    if (this.frameId === null) return;
    window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }
}

let wildfirePulseController: WildfirePulseController | null = null;

function stopWildfirePulse(): void {
  wildfirePulseController?.stop();
  wildfirePulseController = null;
}

function startWildfirePulse(map: maplibregl.Map): void {
  stopWildfirePulse();
  if (
    prefersReducedMotion() ||
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof window.requestAnimationFrame !== 'function' ||
    typeof window.cancelAnimationFrame !== 'function'
  ) {
    return;
  }
  wildfirePulseController = new WildfirePulseController(map);
  wildfirePulseController.start();
}

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [
  FILL_LAYER_ID,
  OUTLINE_LAYER_ID,
  PRESCRIBED_FILL_LAYER_ID,
  PRESCRIBED_OUTLINE_LAYER_ID,
  OTHER_OUTLINE_LAYER_ID
] as const;

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
 * never render into a torn-down layer (the cancellation invariant).
 */
let masterController: AbortController | null = null;

type NifcStatus = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';

function reportStatus(state: NifcStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

function resolveBeforeId(map: maplibregl.Map): string | undefined {
  return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
}

/**
 * Build the GeoJSON query URL. `where=1=1` returns every active perimeter
 * (national scope; viewport scoping is DDM-P1-T06), `outSR` pins EPSG:4326
 * so MapLibre receives lon/lat regardless of a server default change, and
 * the field list plus the generalization parameters keep the response
 * inside the 15 s budget (see the module header and NIFC_OUT_FIELDS).
 */
function buildQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: NIFC_OUT_FIELDS.join(','),
    outSR: '4326',
    geometryPrecision: String(NIFC_GEOMETRY_PRECISION),
    maxAllowableOffset: String(NIFC_MAX_ALLOWABLE_OFFSET_DEG),
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
  let truncated = false;
  try {
    const parsed = parseArcGisPolygonFeatureCollection(
      await fetchJsonWithBudget(
        buildQueryUrl(),
        null,
        signal,
        FETCH_TIMEOUT_MS
      ),
      'NIFC WFIGS'
    );
    geojson = parsed.collection;
    truncated = parsed.truncated;
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
    reportStatus(truncated ? 'degraded' : 'no-data');
    return;
  }

  const beforeId = resolveBeforeId(map);

  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('wildfire'),
      paint: buildNifcFillPaint('wildfire')
    },
    beforeId
  );

  map.addLayer(
    {
      id: OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('wildfire'),
      paint: buildNifcLinePaint('wildfire')
    },
    beforeId
  );

  map.addLayer(
    {
      id: PRESCRIBED_FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('prescribed'),
      paint: buildNifcFillPaint('prescribed')
    },
    beforeId
  );

  map.addLayer(
    {
      id: PRESCRIBED_OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('prescribed'),
      paint: buildNifcLinePaint('prescribed')
    },
    beforeId
  );

  map.addLayer(
    {
      id: OTHER_OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: buildNifcIncidentFilter('other'),
      paint: buildNifcLinePaint('other')
    },
    beforeId
  );

  const hasWildfirePerimeter = features.some(
    (feature) =>
      classifyNifcIncidentType(
        feature.properties?.[NIFC_INCIDENT_TYPE_PROPERTY]
      ) === 'wildfire'
  );
  if (hasWildfirePerimeter) startWildfirePulse(map);

  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.event + 1,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Mapped fire perimeters',
        [
          {
            color: NIFC_INCIDENT_PRESENTATION.wildfire.lineColor,
            label: NIFC_INCIDENT_PRESENTATION.wildfire.legendLabel
          },
          {
            color: NIFC_INCIDENT_PRESENTATION.prescribed.lineColor,
            label: NIFC_INCIDENT_PRESENTATION.prescribed.legendLabel
          },
          {
            color: NIFC_INCIDENT_PRESENTATION.other.lineColor,
            label: NIFC_INCIDENT_PRESENTATION.other.legendLabel
          }
        ],
        `NIFC WFIGS current interagency mapped perimeters. ${NIFC_GENERALIZATION_NOTE} Service cadence does not establish individual perimeter age. Not for evacuation, parcel, or tactical decisions; open NIFC for the source record.`
      )
  });
  if (truncated) {
    console.warn(
      '[nifc-fires] WFIGS response reached the ArcGIS transfer limit; rendering available perimeters as live (partial).'
    );
  }
  reportStatus(truncated ? 'degraded' : 'ready');
}

/**
 * Abort any in-flight fetch and remove the fill, outline, and source. All
 * guards are defensive so callers can invoke `deactivate` without first
 * verifying activation state.
 */
export function cancelActivation(): void {
  // Keep animation teardown in deactivate(). This hook can be followed by a
  // rapid on intent that skips queued map teardown, so stopping here without a
  // matching resume hook would strand an otherwise active layer.
  masterController?.abort();
}

export function deactivate(map: maplibregl.Map): void {
  stopWildfirePulse();
  cancelActivation();
  masterController = null;
  for (const id of [
    OTHER_OUTLINE_LAYER_ID,
    PRESCRIBED_OUTLINE_LAYER_ID,
    PRESCRIBED_FILL_LAYER_ID,
    OUTLINE_LAYER_ID,
    FILL_LAYER_ID
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
  hideLegend(LAYER_KEY);
}

/**
 * Resolve the most useful incident name from the WFIGS attribute schema.
 * `attr_IncidentName` is canonical, `poly_IncidentName` is the geometry
 * source's name (sometimes more specific), and `IncidentName` and
 * `incidentName` are legacy field names that the scoped query no longer
 * requests (kept for stub fixtures and older responses). Returns a neutral mapped-perimeter label if every candidate
 * is blank.
 */
function pickIncidentName(props: GeoJsonProperties): string {
  const p = props ?? {};
  // Fall through on blank strings, not only on null/undefined: the IRWIN
  // record (`attr_*`) and the perimeter collector (`poly_*`) can disagree,
  // and a present-but-empty `attr_IncidentName` must not mask a real name
  // in `poly_IncidentName`.
  for (const candidate of [p.attr_IncidentName, p.poly_IncidentName, p.IncidentName, p.incidentName]) {
    if (candidate === null || candidate === undefined) continue;
    const s = String(candidate).trim();
    if (s !== '') return s;
  }
  return 'Mapped Fire Perimeter';
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
 * `poly_GISAcres` as floats; we round to whole acres for display since
 * sub-acre precision exceeds typical perimeter accuracy.
 */
function formatAcres(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Build the popup HTML for a mapped NIFC perimeter. Kept in-file for
 * M9 (the M5 popups module is being written concurrently and we do not
 * want to fight over `src/ui/popups.ts`).
 */
function buildNifcPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const incidentName = pickIncidentName(p);
  const type = nifcIncidentTypeLabel(p.attr_IncidentTypeCategory);
  const acres = formatAcres(
    p.attr_IncidentSize ?? p.poly_GISAcres
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
    <div class="popup-agency">NIFC WFIGS - Mapped Perimeter</div>
    ${type ? `<div class="popup-treaty-meta">Type: ${escapeHtml(type)}</div>` : ''}
    ${acres ? `<div class="popup-treaty-meta">Size: ${escapeHtml(acres)} acres</div>` : ''}
    ${discovered ? `<div class="popup-treaty-meta">Discovered: ${escapeHtml(discovered)}</div>` : ''}
    ${state ? `<div class="popup-treaty-meta">State: ${escapeHtml(String(state))}</div>` : ''}
    <div class="popup-description">Perimeter sourced from the National Interagency Fire Center (NIFC) Wildland Fire Interagency Geospatial Services (WFIGS) feed. The service is checked for updates approximately every five minutes during active operations; individual perimeter age can differ.</div>
    <div class="popup-description">${escapeHtml(NIFC_GENERALIZATION_NOTE)}</div>
    <div class="popup-description">Strategic context only, not tactical fire operations, evacuation, or parcel decisions.</div>
    <div class="popup-links">
      <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener">NIFC Open Data</a>
      <a href="https://inciweb.wildfire.gov/" target="_blank" rel="noopener">InciWeb</a>
    </div>
  `;
}

/**
 * Register the perimeter fill's click target with the
 * InteractionCoordinator (one response per click; D-0.7.0-058 ruling 5).
 * Cursor affordance switches to pointer on hover so users see that
 * perimeters are interactive.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [FILL_LAYER_ID, PRESCRIBED_FILL_LAYER_ID, OTHER_OUTLINE_LAYER_ID],
    label: (feature) => pickIncidentName(feature.properties ?? {}),
    // B1 fire-in-context: the incident metadata, then a composed read of the
    // drought class beneath the clicked point and the nearest telemetry
    // stations. The context block composes existing surfaces only; it does not
    // compute a fire outlook or combine the sources into a risk class.
    respond: (feature, click, m) => ({
      content:
        buildNifcPopupHtml(feature.properties ?? {}) +
        buildFireContextHtml(m, click.point, click.lngLat)
    })
  });

  for (const id of [FILL_LAYER_ID, PRESCRIBED_FILL_LAYER_ID, OTHER_OUTLINE_LAYER_ID]) {
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}
