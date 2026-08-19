/**
 * Power infrastructure: baked transmission lines (archived HIFLD copy,
 * currency-caveated) plus live EIA power plants.
 *
 * A CATALOG LAYER since 2026-08-19 (owner direction). It began as a
 * presentation companion that rode the 3D Fire scene's activation and was
 * therefore always on there and unavailable everywhere else. It is now an
 * ordinary `LAYER_DEFS` entry, OFF by default, governed by one toggle in
 * every view including the 3D scene. The file keeps its name because the
 * key, the archive, and the disclosures are the same; only who decides
 * when it draws has changed.
 *
 * Two sources, two disciplines:
 *  - Transmission lines: public/data/power-lines-pnw.pmtiles, a one-time
 *    build extract of the ARCHIVED federal HIFLD dataset (last data
 *    update 2024-09-30; the program was discontinued 2025-08-26). Never
 *    fetched live; the legend carries the mandatory currency caveat, and
 *    the issuer's mixed operational-status records (IN SERVICE, INACTIVE,
 *    NOT AVAILABLE in the PNW extract) are disclosed rather than
 *    filtered. Lines with an unknown voltage class draw DASHED at the
 *    thinnest width so absent data never reads as a low-voltage claim.
 *  - Power plants: the U.S. Energy Information Administration layer on
 *    the Esri Federal User Community org, independently maintained (EIA
 *    Forms 860/860M), fetched live at activation with one bounded,
 *    cancellable request whose BODY READ stays inside the cancellation
 *    budget (fetchJsonWithBudget). The legend prints the issuer's own
 *    reporting Period, computed across ALL features (a single period, or
 *    an explicit 'mixed'/'unreported' statement), so the vintage is the
 *    issuer's claim, not an implied real-time read.
 *
 * Substations and distribution circuits are deliberately absent, and the
 * qualification says why rather than letting absence imply nonexistence:
 * no authoritative public national source publishes them.
 *
 * Zoom discipline: below POWER_MIN_ZOOM nothing is fetched and nothing is
 * drawn; the layer reports the canonical `zoom in to load` state. That is
 * the owner's "should appear when zoomed in", expressed in the vocabulary
 * the catalog already has rather than in a new convention.
 *
 * Failure posture: lines and plants activate independently; either alone
 * still counts as an active layer and reports `live (partial)`. Both
 * failing is `unavailable`. Every downstream disclosure (legend, popups,
 * and the 3D embed chip) describes only what is actually rendered.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import {
  POWER_LINE_COLOR,
  POWER_LINES_QUALIFICATION,
  POWER_MIN_ZOOM,
  POWER_PLANT_CLUSTER_PRESENTATION,
  POWER_PLANT_PRESENTATION,
  POWER_PLANTS_QUALIFICATION,
  POWER_SHARED_QUALIFICATION,
  buildPowerLinePaint,
  buildPowerPlantClusterPaint,
  buildPowerPlantPaint
} from '../config/wildfire-presentation';
import { URLS } from '../config/urls';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import { registerClickTarget } from '../map/interaction-coordinator';
import {
  getPowerContextState,
  setPowerContextState
} from '../state/power-context';
import type { PowerContextState } from '../state/power-context';
import { registry } from '../state/registry';
import type { LayerStatus } from '../types/layer';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import {
  buildPowerLinePopupHtml,
  buildPowerPlantPopupHtml
} from '../ui/power-popups';
import { fetchJsonWithBudget } from '../util/fetch';
import { probeArchiveHeader } from '../util/pmtiles-probe';

/** The catalog key; mirrors the LAYER_DEFS entry. */
export const POWER_LAYER_KEY = 'power-infrastructure';

const LINES_SOURCE_ID = 'power-lines';
const LINES_LAYER_ID = 'power-lines';
const LINES_UNKNOWN_LAYER_ID = 'power-lines-unknown';
const LINES_SOURCE_LAYER = 'power-lines';
const PLANTS_SOURCE_ID = 'power-plants';
const PLANTS_LAYER_ID = 'power-plants';
const PLANTS_CLUSTER_LAYER_ID = 'power-plants-clusters';
const PLANTS_CLUSTER_COUNT_LAYER_ID = 'power-plants-cluster-count';
const LEGEND_KEY = 'power-context';
const PLANTS_TIMEOUT_MS = 15_000;

/** The self-hosted fontstack; MapLibre's implicit default is not hosted. */
const GLYPH_FONT = 'Noto Sans Regular';

/** The issuer's unknown-voltage sentinel; drawn dashed, never as a class. */
const UNKNOWN_VOLT_CLASS = 'NOT AVAILABLE';

/** The PNW terrain-bake envelope; the plants request is bounded to it. */
const PLANTS_ENVELOPE = '-125,41.5,-110.5,49.5';
/** Trimmed to what the display needs; ~25 KB gzipped measured 2026-08-18. */
const PLANTS_OUT_FIELDS = 'Plant_Name,PrimSource,Total_MW,Utility_Na,Period';

/** Ids the sidebar's fade transition animates on toggle. */
export const fadeLayerIds: readonly string[] = [
  LINES_LAYER_ID,
  LINES_UNKNOWN_LAYER_ID,
  PLANTS_LAYER_ID,
  PLANTS_CLUSTER_LAYER_ID,
  PLANTS_CLUSTER_COUNT_LAYER_ID
];

let controller: AbortController | null = null;
let zoomWatcher: (() => void) | null = null;
/** The last status written, so a camera move cannot re-announce it. */
let lastStatus: LayerStatus | null = null;

function plantsQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: PLANTS_ENVELOPE,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: PLANTS_OUT_FIELDS,
    outSR: '4326',
    f: 'geojson'
  });
  return `${URLS.eiaPowerPlantsFeatureLayer}/query?${params.toString()}`;
}

/**
 * The issuer's reporting vintage across ALL features: one period prints
 * as 'YYYY-MM'; disagreement or absence is stated, never papered over
 * with the first feature's value.
 */
function periodLabelOf(body: FeatureCollection): string {
  const distinct = new Set<string>();
  for (const feature of body.features) {
    const raw = feature.properties?.['Period'];
    if (typeof raw === 'string' && raw.length > 0) distinct.add(raw);
  }
  if (distinct.size === 0) return 'unreported';
  if (distinct.size > 1) return 'mixed reporting periods';
  const period = [...distinct][0];
  return /^\d{6}$/.test(period)
    ? `${period.slice(0, 4)}-${period.slice(4)}`
    : period;
}

// ---------------------------------------------------------------------------
// The LayerModule contract
// ---------------------------------------------------------------------------

/**
 * Activate the layer. Below the zoom gate this only installs the watcher
 * and reports `zoom in to load`; the archive probe and the live plant
 * request wait until the view can actually show the result.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (zoomWatcher === null) {
    const onMoveEnd = (): void => {
      void syncForZoom(map);
    };
    map.on('moveend', onMoveEnd);
    zoomWatcher = () => {
      map.off('moveend', onMoveEnd);
    };
  }
  await syncForZoom(map);
}

/** Remove every power surface and the legend. Defensive; symmetric. */
export function deactivate(map: maplibregl.Map): void {
  cancelActivation();
  zoomWatcher?.();
  zoomWatcher = null;
  removeSurfaces(map);
  hideLegend(LEGEND_KEY);
  setPowerContextState(null);
  lastStatus = null;
}

/**
 * Synchronous cancellation seam: the controller calls this the moment
 * `off` intent is recorded, before the serialized teardown reaches
 * `deactivate`, so a slow EIA read stops immediately.
 */
export function cancelActivation(): void {
  controller?.abort();
  controller = null;
}

/**
 * Click targets for both surfaces, plus the cluster's own expand
 * behavior. Registered once, on first activation, by the layer
 * controller.
 */
export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [PLANTS_LAYER_ID],
    label: (feature) => {
      const name = feature.properties?.['Plant_Name'];
      return typeof name === 'string' && name.length > 0 ? name : 'Power plant';
    },
    respond: (feature) => ({
      content: buildPowerPlantPopupHtml(feature.properties ?? {})
    })
  });

  registerClickTarget({
    kind: 'point-event',
    layerIds: [LINES_LAYER_ID, LINES_UNKNOWN_LAYER_ID],
    label: () => 'Transmission line',
    respond: (feature) => ({
      content: buildPowerLinePopupHtml(feature.properties ?? {})
    })
  });

  // A cluster is a count, not a feature: clicking it zooms to the level
  // where the issuer's own records separate, rather than opening a popup
  // about a group DDM invented.
  map.on('click', PLANTS_CLUSTER_LAYER_ID, (event) => {
    const feature = event.features?.[0];
    const clusterId = feature?.properties?.['cluster_id'];
    if (typeof clusterId !== 'number') return;
    const source = map.getSource(PLANTS_SOURCE_ID);
    if (!source || !('getClusterExpansionZoom' in source)) return;
    void (source as maplibregl.GeoJSONSource)
      .getClusterExpansionZoom(clusterId)
      .then((zoom) => {
        const geometry = feature?.geometry;
        if (!geometry || geometry.type !== 'Point') return;
        map.easeTo({
          center: geometry.coordinates as [number, number],
          zoom
        });
      })
      .catch(() => {
        /* a stale cluster id after a data refresh is not an error */
      });
  });

  for (const id of [
    PLANTS_LAYER_ID,
    PLANTS_CLUSTER_LAYER_ID,
    LINES_LAYER_ID,
    LINES_UNKNOWN_LAYER_ID
  ]) {
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}

// ---------------------------------------------------------------------------
// Zoom gate and build
// ---------------------------------------------------------------------------

/**
 * Reconcile the layer with the current camera. Called on activation and on
 * every settled camera move; idempotent, and safe to re-enter because a
 * newer call aborts the older one's in-flight work through the shared
 * controller.
 */
async function syncForZoom(map: maplibregl.Map): Promise<void> {
  if (map.getZoom() < POWER_MIN_ZOOM) {
    // Nothing is drawn below the gate (every layer carries the same
    // minzoom), so the legend must not claim otherwise, and the composed
    // state must not survive to describe surfaces no one can see.
    cancelActivation();
    hideLegend(LEGEND_KEY);
    setPowerContextState(null);
    setStatusOnce('zoom-in');
    return;
  }
  const built = getPowerContextState();
  if (built !== null) {
    // Already built and still above the gate: an ordinary pan must not
    // re-render the legend or re-announce the status.
    setStatusOnce(built.linesOn && built.plantsOn ? 'ready' : 'degraded');
    return;
  }

  const signal = renewSignal();
  setStatusOnce('loading');
  const state = await buildSurfaces(map, signal);
  // A newer sync (or a teardown) superseded this one; it owns the outcome.
  if (signal.aborted) return;
  if (state === null) {
    setStatusOnce('error');
    return;
  }
  setPowerContextState(state);
  showPowerLegend(state);
  setStatusOnce(state.linesOn && state.plantsOn ? 'ready' : 'degraded');
}

function renewSignal(): AbortSignal {
  controller?.abort();
  controller = new AbortController();
  return controller.signal;
}

/**
 * Write a status only when it actually changes. `registry.setStatus`
 * emits on every call by design, and this layer re-evaluates on every
 * settled camera move, so an unguarded write would re-announce the same
 * state to the pill and its live region on every pan.
 */
function setStatusOnce(status: LayerStatus): void {
  if (lastStatus === status) return;
  lastStatus = status;
  registry.setStatus(POWER_LAYER_KEY, status);
}

/**
 * Add lines (baked) and plants (live) independently. Returns the
 * activation state, or null when both sources failed.
 */
async function buildSurfaces(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<PowerContextState | null> {
  const linesOn = await activateLines(map, signal);
  const periodLabel = await activatePlants(map, signal);
  const plantsOn = periodLabel !== null;
  if (!linesOn && !plantsOn) return null;
  return { linesOn, plantsOn, periodLabel };
}

function showPowerLegend(state: PowerContextState): void {
  const qualification = [
    ...(state.linesOn ? [POWER_LINES_QUALIFICATION] : []),
    ...(state.plantsOn ? [POWER_PLANTS_QUALIFICATION] : []),
    `Drawn from zoom ${POWER_MIN_ZOOM}; below that the layer reports zoom in to load.`,
    POWER_SHARED_QUALIFICATION
  ].join(' ');

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.event + 4,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Power infrastructure',
        [
          ...(state.linesOn
            ? [
                {
                  color: POWER_LINE_COLOR,
                  label:
                    'Transmission line (width follows the issuer\'s voltage class; unknown class dashed)'
                }
              ]
            : []),
          ...(state.plantsOn
            ? [
                {
                  color: POWER_PLANT_PRESENTATION.color,
                  label: `Power plant (EIA, reporting period ${state.periodLabel})`
                },
                {
                  color: POWER_PLANT_CLUSTER_PRESENTATION.color,
                  label: 'Grouped plants, labeled with the number of records'
                }
              ]
            : [])
        ],
        qualification
      )
  });
}

async function activateLines(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  try {
    await probeArchiveHeader(URLS.powerLinesPmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn(
        '[power-3d] the transmission-line archive is unreachable or invalid.',
        err
      );
    }
    return false;
  }
  if (signal.aborted) return false;
  try {
    if (!map.getSource(LINES_SOURCE_ID)) {
      map.addSource(LINES_SOURCE_ID, {
        type: 'vector',
        url: 'pmtiles://' + URLS.powerLinesPmtilesLocal
      });
    }
    if (!map.getLayer(LINES_LAYER_ID)) {
      map.addLayer({
        id: LINES_LAYER_ID,
        type: 'line',
        source: LINES_SOURCE_ID,
        'source-layer': LINES_SOURCE_LAYER,
        minzoom: POWER_MIN_ZOOM,
        filter: ['!=', ['get', 'VOLT_CLASS'], UNKNOWN_VOLT_CLASS],
        paint: buildPowerLinePaint()
      });
    }
    if (!map.getLayer(LINES_UNKNOWN_LAYER_ID)) {
      // Unknown voltage class draws DASHED at the thinnest width: a
      // visibly different treatment, so missing issuer data never reads
      // as a definite low-voltage line. line-dasharray is not
      // data-driven in the MapLibre style specification, hence the
      // second layer instead of a per-feature expression.
      map.addLayer({
        id: LINES_UNKNOWN_LAYER_ID,
        type: 'line',
        source: LINES_SOURCE_ID,
        'source-layer': LINES_SOURCE_LAYER,
        minzoom: POWER_MIN_ZOOM,
        filter: ['==', ['get', 'VOLT_CLASS'], UNKNOWN_VOLT_CLASS],
        paint: { ...buildPowerLinePaint(), 'line-dasharray': [2, 2] }
      });
      // Added outside the layer controller's own insertion point (the
      // hms-smoke-volume discipline): re-assert the ruled chain so the
      // context overlays seat between condition surfaces and event
      // overlays.
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
    return true;
  } catch (err) {
    console.warn('[power-3d] transmission-line setup failed.', err);
    for (const layerId of [LINES_LAYER_ID, LINES_UNKNOWN_LAYER_ID]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    if (map.getSource(LINES_SOURCE_ID)) map.removeSource(LINES_SOURCE_ID);
    return false;
  }
}

/** Returns the issuer's reporting-period label on success, null on failure. */
async function activatePlants(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<string | null> {
  let body: FeatureCollection;
  try {
    // fetchJsonWithBudget keeps the BODY READ inside the timeout and the
    // owning abort signal, so a stalled stream can never hold activation
    // past the budget or outlive a teardown.
    const parsed = await fetchJsonWithBudget(
      plantsQueryUrl(),
      {},
      signal,
      PLANTS_TIMEOUT_MS
    );
    body = parsed as FeatureCollection;
    if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
      throw new Error('not a FeatureCollection');
    }
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[power-3d] the EIA power-plant fetch failed.', err);
    }
    return null;
  }
  if (signal.aborted) return null;
  try {
    if (!map.getSource(PLANTS_SOURCE_ID)) {
      map.addSource(PLANTS_SOURCE_ID, {
        type: 'geojson',
        data: body,
        attribution: 'Energy Information Administration (EIA)',
        // Grouping is presentation only: MapLibre counts the issuer's own
        // records, and the count is printed rather than turned into any
        // derived quantity. clusterMaxZoom leaves individual plants
        // separate well before the 3D scene's framing.
        cluster: true,
        clusterRadius: 44,
        clusterMaxZoom: 9
      });
    }
    if (!map.getLayer(PLANTS_CLUSTER_LAYER_ID)) {
      map.addLayer({
        id: PLANTS_CLUSTER_LAYER_ID,
        type: 'circle',
        source: PLANTS_SOURCE_ID,
        minzoom: POWER_MIN_ZOOM,
        filter: ['has', 'point_count'],
        paint: buildPowerPlantClusterPaint()
      });
    }
    if (!map.getLayer(PLANTS_CLUSTER_COUNT_LAYER_ID)) {
      map.addLayer({
        id: PLANTS_CLUSTER_COUNT_LAYER_ID,
        type: 'symbol',
        source: PLANTS_SOURCE_ID,
        minzoom: POWER_MIN_ZOOM,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': [GLYPH_FONT],
          'text-size': 11,
          'text-allow-overlap': true
        },
        paint: {
          'text-color': POWER_PLANT_CLUSTER_PRESENTATION.textColor
        }
      });
    }
    if (!map.getLayer(PLANTS_LAYER_ID)) {
      map.addLayer({
        id: PLANTS_LAYER_ID,
        type: 'circle',
        source: PLANTS_SOURCE_ID,
        minzoom: POWER_MIN_ZOOM,
        filter: ['!', ['has', 'point_count']],
        paint: buildPowerPlantPaint()
      });
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
    return periodLabelOf(body);
  } catch (err) {
    console.warn('[power-3d] power-plant setup failed.', err);
    removePlantSurfaces(map);
    return null;
  }
}

function removePlantSurfaces(map: maplibregl.Map): void {
  for (const layerId of [
    PLANTS_LAYER_ID,
    PLANTS_CLUSTER_COUNT_LAYER_ID,
    PLANTS_CLUSTER_LAYER_ID
  ]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(PLANTS_SOURCE_ID)) map.removeSource(PLANTS_SOURCE_ID);
}

function removeSurfaces(map: maplibregl.Map): void {
  for (const layerId of [LINES_LAYER_ID, LINES_UNKNOWN_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(LINES_SOURCE_ID)) map.removeSource(LINES_SOURCE_ID);
  removePlantSurfaces(map);
}
