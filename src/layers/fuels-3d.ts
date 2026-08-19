/**
 * LANDFIRE fuel-model drape for the desktop 3D Fire mode (the vegetation
 * and fuels context layer).
 *
 * NOT a LAYER_DEFS entry and NOT a LayerModule: like hms-smoke-volume, this
 * module is a presentation companion owned by the fire3d context
 * orchestrator (src/map/fire3d-context.ts, reached only through the 3D
 * mode's dynamic import chain). It drapes the bundled LF2024 FBFM40
 * archive (public/data/fuels-fbfm40-pnw.pmtiles) over the 3D terrain
 * through MapLibre's ordinary render-to-texture path; there is no
 * per-layer 3D code because a raster source draped on active terrain needs
 * none.
 *
 * Meaning discipline: every pixel carries LANDFIRE's own published class
 * color, rendered server-side at bake time; DDM chooses no colors and
 * computes nothing from the classes. The legend states the vintage, the
 * resolution reduction, and that the drape is a static classified snapshot
 * of vegetation as fuel, never fire behavior. LANDFIRE's canopy bulk
 * density and canopy base height layers are deliberately NOT used here or
 * anywhere: LANDFIRE documents them as inputs to fire-behavior-prediction
 * systems, and computing anything from them is out of scope by owner
 * invariant.
 *
 * Failure posture: the caller treats a false return as a NON-fatal partial
 * degrade (terrain and smoke stay; the scene simply lacks the drape).
 */

import type maplibregl from 'maplibre-gl';

import {
  FBFM40_PRESENTATION,
  FUELS_DRAPE_OPACITY
} from '../config/wildfire-presentation';
import { URLS } from '../config/urls';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import { probeArchiveHeader } from '../util/pmtiles-probe';

const SOURCE_ID = 'fuels-fbfm40';
const LAYER_ID = 'fuels-fbfm40';
const LEGEND_KEY = 'fuels-fbfm40';

/**
 * Probe the bundled archive, then add the raster source and drape layer
 * and register the legend. Idempotent. Returns false (nothing added) when
 * the archive is unreachable or invalid; the caller degrades partially.
 */
export async function activateFuelsDrape(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  try {
    await probeArchiveHeader(URLS.fuelsFbfm40PmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[fuels-3d] the fuel drape archive is unreachable or invalid.', err);
    }
    return false;
  }
  if (signal.aborted) return false;

  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        url: 'pmtiles://' + URLS.fuelsFbfm40PmtilesLocal,
        tileSize: 512,
        attribution: 'LANDFIRE LF2024 FBFM40'
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          'raster-opacity': FUELS_DRAPE_OPACITY
        }
      });
      // Added outside the layer controller, so this module re-asserts the
      // ruled chain itself (the hms-smoke-volume discipline): the drape id
      // is a CONDITION_SURFACE_IDS member and seats below every event
      // overlay and reference boundary.
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
  } catch (err) {
    console.warn('[fuels-3d] drape setup failed.', err);
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    return false;
  }

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.surface + 5,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Fuel models (3D view)',
        FBFM40_PRESENTATION.classes.map((c) => ({
          color: c.color,
          label: `${c.code}: ${c.label}`
        })),
        FBFM40_PRESENTATION.qualification
      )
  });

  return true;
}

/**
 * Remove the drape layer, source, and legend. Defensive guards throughout;
 * symmetric with activate.
 */
export function deactivateFuelsDrape(map: maplibregl.Map): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LEGEND_KEY);
}
