/**
 * Building structures context for the desktop 3D Fire mode: Overture Maps
 * Foundation footprints extruded over the terrain. A presentation
 * companion owned by the fire3d context orchestrator
 * (src/map/fire3d-context.ts); not a LAYER_DEFS entry.
 *
 * Coverage honesty: the bundled archive covers the central_oregon region
 * framing ONLY (the full PNW box holds 9.16 million footprints, far past
 * same-origin hosting; scripts/extract-overture-buildings.py --bbox is
 * the deployer path for other regions). The 3D Fire control's coverage
 * note and this layer's legend both state the pilot scope, and the
 * archive stores z13-14 only, so buildings appear when zoomed in.
 *
 * Height honesty: two fill-extrusion layers split the read. Footprints
 * with an issuer-published height extrude to it in the measured tone;
 * the rest draw in a visibly dimmer tone at a disclosed placeholder
 * height (three meters per published floor, otherwise four meters),
 * never implying a precision the source does not carry. The placeholder
 * rule is a presentation constant stated in the legend, not an estimate
 * dressed as data.
 *
 * Failure posture: the caller treats a false return as a NON-fatal
 * partial degrade (the scene keeps everything else).
 */

import type maplibregl from 'maplibre-gl';

import {
  STRUCTURES_PRESENTATION,
  STRUCTURES_QUALIFICATION,
  buildStructuresMeasuredPaint,
  buildStructuresPlaceholderPaint
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

const SOURCE_ID = 'structures-3d';
const SOURCE_LAYER = 'structures';
const MEASURED_LAYER_ID = 'structures-3d';
const PLACEHOLDER_LAYER_ID = 'structures-3d-est';
const LEGEND_KEY = 'structures-3d';

/**
 * Probe the bundled archive, then add the vector source, both extrusion
 * layers, and the legend. Idempotent. Returns false (nothing added) when
 * the archive is unreachable or invalid.
 */
export async function activateStructures(
  map: maplibregl.Map,
  signal: AbortSignal
): Promise<boolean> {
  try {
    await probeArchiveHeader(URLS.structuresPmtilesLocal, signal);
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[structures-3d] the structures archive is unreachable or invalid.', err);
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
    if (!map.getLayer(MEASURED_LAYER_ID)) {
      map.addLayer({
        id: MEASURED_LAYER_ID,
        type: 'fill-extrusion',
        source: SOURCE_ID,
        'source-layer': SOURCE_LAYER,
        filter: ['has', 'h'],
        paint: buildStructuresMeasuredPaint()
      });
    }
    if (!map.getLayer(PLACEHOLDER_LAYER_ID)) {
      map.addLayer({
        id: PLACEHOLDER_LAYER_ID,
        type: 'fill-extrusion',
        source: SOURCE_ID,
        'source-layer': SOURCE_LAYER,
        filter: ['!', ['has', 'h']],
        paint: buildStructuresPlaceholderPaint()
      });
      // Added outside the layer controller (the hms-smoke-volume
      // discipline): re-assert the ruled chain so structures seat with
      // the context overlays, under every event overlay.
      reassertThematicOrder(map);
      reassertLabelOrder(map);
    }
  } catch (err) {
    console.warn('[structures-3d] setup failed.', err);
    for (const layerId of [MEASURED_LAYER_ID, PLACEHOLDER_LAYER_ID]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    return false;
  }

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.event + 5,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Structures (3D view)',
        [
          {
            color: STRUCTURES_PRESENTATION.measuredColor,
            label: 'Building (issuer-published height)'
          },
          {
            color: STRUCTURES_PRESENTATION.placeholderColor,
            label: 'Building (no published height; disclosed placeholder height)'
          }
        ],
        STRUCTURES_QUALIFICATION
      )
  });
  return true;
}

/** Remove both extrusion layers, the source, and the legend. Defensive. */
export function deactivateStructures(map: maplibregl.Map): void {
  for (const layerId of [MEASURED_LAYER_ID, PLACEHOLDER_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  hideLegend(LEGEND_KEY);
}
