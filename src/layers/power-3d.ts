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
 *    fetched live; the legend carries the mandatory currency caveat.
 *  - Power plants: the U.S. Energy Information Administration layer on
 *    the Esri Federal User Community org, independently maintained (EIA
 *    Forms 860/860M), fetched live at activation with one bounded,
 *    cancellable request (625 points, ~25 KB gzipped in the PNW envelope,
 *    measured 2026-08-18). The legend prints the issuer's own reporting
 *    Period so the vintage is the issuer's claim, not an implied
 *    real-time read.
 *
 * Substations and distribution lines are deliberately absent: EIA and the
 * former HIFLD program withhold substation locations for security
 * reasons, and no honest public national distribution-circuit source
 * exists. The qualification says so rather than letting absence imply
 * their nonexistence.
 *
 * Failure posture: lines and plants activate independently; either alone
 * still counts as an active power context, and the caller treats a false
 * return (both failed) as a NON-fatal partial degrade.
 */

import type maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import {
  POWER_CONTEXT_QUALIFICATION,
  POWER_LINE_COLOR,
  POWER_PLANT_PRESENTATION,
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
import { fetchWithBudget } from '../util/fetch';
import { probeArchiveHeader } from '../util/pmtiles-probe';

const LINES_SOURCE_ID = 'power-lines';
const LINES_LAYER_ID = 'power-lines';
const LINES_SOURCE_LAYER = 'power-lines';
const PLANTS_SOURCE_ID = 'power-plants';
const PLANTS_LAYER_ID = 'power-plants';
const LEGEND_KEY = 'power-context';
const PLANTS_TIMEOUT_MS = 15_000;

/** The PNW terrain-bake envelope; the plants request is bounded to it. */
const PLANTS_ENVELOPE = '-125,41.5,-110.5,49.5';
/** Trimmed to what the display needs; ~25 KB gzipped measured 2026-08-18. */
const PLANTS_OUT_FIELDS = 'Plant_Name,PrimSource,Total_MW,Utility_Na,Period';

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

/** 'YYYYMM' -> 'YYYY-MM'; anything else passes through verbatim. */
function formatPeriod(period: string): string {
  return /^\d{6}$/.test(period)
    ? `${period.slice(0, 4)}-${period.slice(4)}`
    : period;
}

/**
 * Activate lines (baked) and plants (live) independently, then register
 * the combined legend for whatever actually activated. Returns false only
 * when BOTH sources failed (nothing added).
 */
export async function activatePowerContext(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  const linesOn = await activateLines(map, signal);
  const plants = await activatePlants(map, signal);
  if (!linesOn && plants === null) return false;

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
                    'Transmission line (width follows the issuer\'s voltage class)'
                }
              ]
            : []),
          ...(plants !== null
            ? [
                {
                  color: POWER_PLANT_PRESENTATION.color,
                  label: `Power plant (EIA, reporting period ${plants.period})`
                }
              ]
            : [])
        ],
        POWER_CONTEXT_QUALIFICATION
      )
  });
  return true;
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
        paint: buildPowerLinePaint()
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
    if (map.getLayer(LINES_LAYER_ID)) map.removeLayer(LINES_LAYER_ID);
    if (map.getSource(LINES_SOURCE_ID)) map.removeSource(LINES_SOURCE_ID);
    return false;
  }
}

/** Returns the issuer's reporting period on success, null on failure. */
async function activatePlants(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<{ readonly period: string } | null> {
  let body: FeatureCollection;
  try {
    const response = await fetchWithBudget(
      plantsQueryUrl(),
      {},
      signal,
      PLANTS_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = (await response.json()) as FeatureCollection;
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
    const rawPeriod = body.features
      .map((f) => f.properties?.['Period'])
      .find((value) => typeof value === 'string' && value.length > 0);
    return {
      period: formatPeriod(typeof rawPeriod === 'string' ? rawPeriod : 'unreported')
    };
  } catch (err) {
    console.warn('[power-3d] power-plant setup failed.', err);
    if (map.getLayer(PLANTS_LAYER_ID)) map.removeLayer(PLANTS_LAYER_ID);
    if (map.getSource(PLANTS_SOURCE_ID)) map.removeSource(PLANTS_SOURCE_ID);
    return null;
  }
}

/** Remove both power surfaces and the legend. Defensive; symmetric. */
export function deactivatePowerContext(map: maplibregl.Map): void {
  for (const layerId of [LINES_LAYER_ID, PLANTS_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [LINES_SOURCE_ID, PLANTS_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
  hideLegend(LEGEND_KEY);
}
