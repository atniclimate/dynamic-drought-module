/**
 * Power infrastructure context for the desktop 3D Fire mode: baked
 * transmission lines (archived HIFLD copy, currency-caveated) plus live
 * EIA power plants. A presentation companion owned by the fire3d context
 * orchestrator (src/map/fire3d-context.ts); not a LAYER_DEFS entry.
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
 * Substations and distribution lines are deliberately absent: EIA and the
 * former HIFLD program withhold substation locations for security
 * reasons, and no authoritative public national distribution source
 * exists. The qualification says so rather than letting absence imply
 * their nonexistence.
 *
 * Failure posture: lines and plants activate independently; either alone
 * still counts as an active power context. The returned state says
 * exactly which surfaces are in the scene so every downstream disclosure
 * (legend AND embed chip) describes only what is actually rendered; the
 * caller treats a null return (both failed) as a NON-fatal partial
 * degrade.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import {
  POWER_LINE_COLOR,
  POWER_LINES_QUALIFICATION,
  POWER_PLANT_PRESENTATION,
  POWER_PLANTS_QUALIFICATION,
  POWER_SHARED_QUALIFICATION,
  buildPowerLinePaint,
  buildPowerPlantPaint
} from '../config/wildfire-presentation';
import { URLS } from '../config/urls';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import { fetchJsonWithBudget } from '../util/fetch';
import { probeArchiveHeader } from '../util/pmtiles-probe';

const LINES_SOURCE_ID = 'power-lines';
const LINES_LAYER_ID = 'power-lines';
const LINES_UNKNOWN_LAYER_ID = 'power-lines-unknown';
const LINES_SOURCE_LAYER = 'power-lines';
const PLANTS_SOURCE_ID = 'power-plants';
const PLANTS_LAYER_ID = 'power-plants';
const LEGEND_KEY = 'power-context';
const PLANTS_TIMEOUT_MS = 15_000;

/** The issuer's unknown-voltage sentinel; drawn dashed, never as a class. */
const UNKNOWN_VOLT_CLASS = 'NOT AVAILABLE';

/** The PNW terrain-bake envelope; the plants request is bounded to it. */
const PLANTS_ENVELOPE = '-125,41.5,-110.5,49.5';
/** Trimmed to what the display needs; ~25 KB gzipped measured 2026-08-18. */
const PLANTS_OUT_FIELDS = 'Plant_Name,PrimSource,Total_MW,Utility_Na,Period';

/** What actually activated, for truth-preserving downstream disclosures. */
export interface PowerContextState {
  readonly linesOn: boolean;
  readonly plantsOn: boolean;
  /** Issuer reporting period label: 'YYYY-MM', 'mixed reporting periods',
   * or 'unreported'; null while the plants surface is off. */
  readonly periodLabel: string | null;
}

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

/**
 * Activate lines (baked) and plants (live) independently, then register
 * a legend that describes ONLY the surfaces actually in the scene.
 * Returns the activation state, or null when both sources failed.
 */
export async function activatePowerContext(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<PowerContextState | null> {
  const linesOn = await activateLines(map, signal);
  const periodLabel = await activatePlants(map, signal);
  const plantsOn = periodLabel !== null;
  if (!linesOn && !plantsOn) return null;

  const qualification = [
    ...(linesOn ? [POWER_LINES_QUALIFICATION] : []),
    ...(plantsOn ? [POWER_PLANTS_QUALIFICATION] : []),
    POWER_SHARED_QUALIFICATION
  ].join(' ');

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.event + 4,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Power infrastructure (3D view)',
        [
          ...(linesOn
            ? [
                {
                  color: POWER_LINE_COLOR,
                  label:
                    'Transmission line (width follows the issuer\'s voltage class; unknown class dashed)'
                }
              ]
            : []),
          ...(plantsOn
            ? [
                {
                  color: POWER_PLANT_PRESENTATION.color,
                  label: `Power plant (EIA, reporting period ${periodLabel})`
                }
              ]
            : [])
        ],
        qualification
      )
  });
  return { linesOn, plantsOn, periodLabel };
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
        filter: ['==', ['get', 'VOLT_CLASS'], UNKNOWN_VOLT_CLASS],
        paint: { ...buildPowerLinePaint(), 'line-dasharray': [2, 2] }
      });
      // Added outside the layer controller (the hms-smoke-volume
      // discipline): re-assert the ruled chain so the context overlays
      // seat between condition surfaces and event overlays.
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
    // owning abort signal, so a stalled stream can never hold the mode in
    // 'checking' past the budget or outlive a teardown.
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
        attribution: 'Energy Information Administration (EIA)'
      });
    }
    if (!map.getLayer(PLANTS_LAYER_ID)) {
      map.addLayer({
        id: PLANTS_LAYER_ID,
        type: 'circle',
        source: PLANTS_SOURCE_ID,
        paint: buildPowerPlantPaint()
      });
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
    return periodLabelOf(body);
  } catch (err) {
    console.warn('[power-3d] power-plant setup failed.', err);
    if (map.getLayer(PLANTS_LAYER_ID)) map.removeLayer(PLANTS_LAYER_ID);
    if (map.getSource(PLANTS_SOURCE_ID)) map.removeSource(PLANTS_SOURCE_ID);
    return null;
  }
}

/** Remove all power surfaces and the legend. Defensive; symmetric. */
export function deactivatePowerContext(map: maplibregl.Map): void {
  for (const layerId of [
    LINES_LAYER_ID,
    LINES_UNKNOWN_LAYER_ID,
    PLANTS_LAYER_ID
  ]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [LINES_SOURCE_ID, PLANTS_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
  hideLegend(LEGEND_KEY);
}
