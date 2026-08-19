/**
 * Wildfire Hazard Potential drape for the desktop 3D Fire mode (the
 * landscape hazard context layer).
 *
 * REPLACED THE FUEL-MODEL DRAPE on 2026-08-19, on owner direction. The
 * ask was "only the yellow through red colors to indicate risk", and the
 * LANDFIRE FBFM40 drape could not honestly answer it: FBFM40 is a
 * fuel-model classification, not a hazard scale, so recoloring its 44
 * classes into a risk ramp would have fabricated a claim its issuer never
 * made. (MapLibre also has no client-side raster recolor, so it was not
 * even mechanically available.) USFS Wildfire Hazard Potential IS a
 * published hazard scale, and its issuer palette already runs green
 * through yellow and orange to red. The answer was a different issuer,
 * not a repainted one.
 *
 * NOT a LAYER_DEFS entry and NOT a LayerModule: like hms-smoke-volume,
 * this module is a presentation companion owned by the fire3d context
 * orchestrator (src/map/fire3d-context.ts, reached only through the 3D
 * mode's dynamic import chain). It drapes the bundled WHP 2023 archive
 * (public/data/whp-2023-pnw.pmtiles) over the 3D terrain through
 * MapLibre's ordinary render-to-texture path.
 *
 * The same service backs the flat `usfs-whp` catalog layer, so the drape
 * and the 2D surface can never disagree about what WHP says.
 *
 * Meaning discipline: every pixel carries the issuer's own published
 * class color, rendered server-side at bake time; DDM chooses no colors
 * and computes nothing from the classes. The legend states the vintage,
 * the resolution reduction, and that the drape is a static hazard
 * classification, never current fire conditions and never a prediction.
 *
 * Failure posture: the caller treats a false return as a NON-fatal
 * partial degrade (terrain and smoke stay; the scene simply lacks the
 * drape).
 */

import type maplibregl from 'maplibre-gl';

import {
  DRAPE_OPACITY,
  USFS_WHP_PRESENTATION
} from '../config/wildfire-presentation';
import { URLS } from '../config/urls';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import { registry } from '../state/registry';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import { probeArchiveHeader } from '../util/pmtiles-probe';

const SOURCE_ID = 'whp-2023';
const LAYER_ID = 'whp-2023';
const LEGEND_KEY = 'whp-2023';

/** The flat catalog layer that draws the SAME issuer product, live. */
const FLAT_WHP_LAYER_KEY = 'usfs-whp';

/** Released when the drape is torn down; watches for the flat layer. */
let releaseFlatLayerWatch: (() => void) | null = null;

/**
 * One issuer, one legend, per layer: never draw this drape while the flat
 * `usfs-whp` catalog surface is on.
 *
 * The two render the same USFS product from the same service. Stacked,
 * they would double the translucency of one classification, print two
 * legends for one issuer, and show the PNW bake box as a hard rectangular
 * seam over the live CONUS layer. The wildfire cluster's season-ahead
 * horizon activates exactly that flat layer
 * (src/config/clusters.ts:119), so this is a real pairing, not a
 * hypothetical one.
 *
 * The flat layer wins when both are eligible: it is live rather than a
 * snapshot, and it covers the conterminous United States rather than the
 * Pacific Northwest box. It also drapes over terrain on its own, so the
 * 3D scene still shows hazard relief; it simply shows the better copy.
 */
function flatWhpLayerIsOn(): boolean {
  return registry.getActiveKeys().has(FLAT_WHP_LAYER_KEY);
}

/**
 * Probe the bundled archive, then add the raster source and drape layer
 * and register the legend. Idempotent. Returns false (nothing added) when
 * the flat WHP surface already covers this ground, or when the archive is
 * unreachable or invalid; the caller degrades partially either way.
 */
export async function activateWhpDrape(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  if (flatWhpLayerIsOn()) {
    console.info(
      '[whp-3d] the flat USFS WHP layer is on; standing down so one issuer keeps one legend.'
    );
    return false;
  }

  try {
    await probeArchiveHeader(URLS.whp2023PmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[whp-3d] the hazard drape archive is unreachable or invalid.', err);
    }
    return false;
  }
  if (signal.aborted) return false;

  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        url: 'pmtiles://' + URLS.whp2023PmtilesLocal,
        tileSize: 512,
        attribution: 'USFS Wildfire Hazard Potential 2023'
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          'raster-opacity': DRAPE_OPACITY,
          // NEAREST, not MapLibre's default linear. This is a categorical
          // raster of seven issuer classes, and the archive is over-zoomed
          // well past its bake depth at the scene's framing. Linear
          // interpolation between two class colors produces a color that
          // appears in no legend: green blended into red reads as an
          // orange hazard the issuer never assigned to that ground, and
          // water blended into Very High reads as nothing at all. Crisp
          // class boundaries are the honest presentation of a
          // classification. Note this may be inert on MapLibre 4, which
          // has a known nearest-resampling defect; re-verify when the
          // library is upgraded.
          'raster-resampling': 'nearest'
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
    console.warn('[whp-3d] drape setup failed.', err);
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    return false;
  }

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.surface + 5,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Wildfire hazard potential (3D view)',
        USFS_WHP_PRESENTATION.categories.map((c) => ({
          color: c.color,
          label: c.label
        })),
        USFS_WHP_PRESENTATION.qualification
      )
  });

  // The flat layer can be switched on AFTER the scene is up (the
  // season-ahead horizon does exactly that). Watch for it and stand down
  // rather than stacking two copies of one issuer. The reverse is not
  // symmetric on purpose: switching the flat layer back off does not
  // resurrect the drape until the scene is re-entered, which
  // under-claims rather than over-claims and needs no disclosure.
  releaseFlatLayerWatch?.();
  releaseFlatLayerWatch = registry.on('change', () => {
    if (!flatWhpLayerIsOn()) return;
    console.info(
      '[whp-3d] the flat USFS WHP layer came on; removing the drape so one issuer keeps one legend.'
    );
    deactivateWhpDrape(map);
  });

  return true;
}

/**
 * Remove the drape layer, source, and legend. Defensive guards throughout;
 * symmetric with activate.
 */
export function deactivateWhpDrape(map: maplibregl.Map): void {
  releaseFlatLayerWatch?.();
  releaseFlatLayerWatch = null;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LEGEND_KEY);
}
