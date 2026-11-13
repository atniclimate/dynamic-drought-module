/**
 * Buildings for the desktop 3D Fire mode: USA Structures footprints (Oak
 * Ridge National Laboratory for the FEMA Geospatial Response Office) extruded
 * over the terrain. A presentation companion owned by the fire3d context
 * orchestrator (src/map/fire3d-context.ts); not a LAYER_DEFS entry.
 *
 * Coverage: the bundled archive covers the central_oregon region framing
 * only (a whole state is far past same-origin hosting) and stores z13-14
 * only, so buildings appear when zoomed in.
 *
 * Height: the source publishes none for any footprint in that box, so one
 * layer draws every building at one low stated height in one quiet tone
 * (STRUCTURES_PRESENTATION), never implying a measurement.
 *
 * Nothing but the word: the map and its key carry no credit, source line or
 * caveat for this layer (owner, 2026-11-12). The credit is the
 * Acknowledgements row.
 *
 * Failure posture: the caller treats a false return as a NON-fatal
 * partial degrade (the scene keeps everything else).
 */

import type * as maplibregl from 'maplibre-gl';

import {
  STRUCTURES_PRESENTATION,
  buildStructuresPaint
} from '../config/wildfire-presentation';
import { URLS } from '../config/urls';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import { LEGEND_ORDER, getLegendSection, hideLegend, showLegend } from '../ui/legend-registry';
import { probeArchiveHeader } from '../util/pmtiles-probe';
import type { PmtilesHeader } from '../util/pmtiles-probe';

const SOURCE_ID = 'structures-3d';
const SOURCE_LAYER = 'structures';
const LAYER_ID = 'structures-3d';
const LEGEND_KEY = 'structures-3d';

/** Stops the key following the view; set while the layer is on the map. */
let stopKeyTracking: (() => void) | null = null;

/**
 * The key lists "Buildings" only while one can draw: at or above the
 * archive's own zoom floor with the view touching its box (both read from
 * the probed header, so no second copy of either exists). Nothing on the
 * map explains an absent building, so the key must not promise one.
 */
function trackKey(map: maplibregl.Map, archive: PmtilesHeader): void {
  stopKeyTracking?.();
  const sync = (): void => {
    const view = map.getBounds();
    const canDraw =
      map.getZoom() >= archive.minZoom &&
      view.getWest() < archive.east && view.getEast() > archive.west &&
      view.getSouth() < archive.north && view.getNorth() > archive.south;
    if (!canDraw) {
      hideLegend(LEGEND_KEY);
    } else if (!getLegendSection(LEGEND_KEY)) {
      showLegend(LEGEND_KEY, {
        // After the stations slot: the event band is full (smoke volume at
        // +3, power at +4) and event+5 would collide with LEGEND_ORDER.stations.
        order: LEGEND_ORDER.stations + 1,
        // One swatch and the one word; both values are this module's own constants.
        render: (body) => {
          body.innerHTML = `<ul class="legend"><li><span class="swatch" style="background:${STRUCTURES_PRESENTATION.color}"></span>Buildings</li></ul>`;
        }
      });
    }
  };
  map.on('moveend', sync);
  stopKeyTracking = () => map.off('moveend', sync);
  sync();
}

/**
 * Probe the bundled archive, then add the vector source, the extrusion
 * layer, and the key (shown only where a building can draw). Idempotent. Returns false (nothing added) when the
 * archive is unreachable or invalid, or the scene left during the probe.
 */
export async function activateStructures(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  let archive: PmtilesHeader;
  try {
    archive = await probeArchiveHeader(URLS.structuresPmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[structures-3d] invalid or unavailable archive.', err);
    }
    return false;
  }
  if (signal.aborted) return false;

  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'vector',
        url: 'pmtiles://' + URLS.structuresPmtilesLocal
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'fill-extrusion',
        source: SOURCE_ID,
        'source-layer': SOURCE_LAYER,
        paint: buildStructuresPaint()
      });
      // Added outside the layer controller (the hms-smoke-volume
      // discipline): re-assert the ruled chain so the buildings seat with
      // the context overlays, under every event overlay.
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
  } catch (err) {
    console.warn('[structures-3d] setup failed.', err);
    deactivateStructures(map);
    return false;
  }

  trackKey(map, archive);
  return true;
}

/** Remove the extrusion layer, the source, and the key. Defensive. */
export function deactivateStructures(map: maplibregl.Map): void {
  stopKeyTracking?.();
  stopKeyTracking = null;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LEGEND_KEY);
}
