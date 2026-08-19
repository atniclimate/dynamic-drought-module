/**
 * Volumetric smoke presentation for the desktop 3D Fire mode (W4).
 *
 * NOT a LAYER_DEFS entry and NOT a LayerModule: this module is a
 * presentation companion owned by the fire3d orchestrator
 * (src/map/fire3d.ts, which reaches it via dynamic import). The NOAA HMS
 * smoke layer (src/layers/hms-smoke.ts) keeps sole ownership of its data,
 * clock, status pill, popup, and 2D legend; this module only re-presents
 * the SAME GeoJSON source as a fill-extrusion volume while the 3D mode is
 * active, hiding the flat veil so the plumes are not drawn twice.
 *
 * Meaning discipline: the vertical extent is a stylized encoding of the
 * issuer's density class, never measured plume height, concentration, or
 * transport; the legend section registered here says exactly that
 * (HMS_VOLUME_QUALIFICATION), and the heights are ranked identically to
 * the ruled 2D opacity ramp by construction (opacity times one scale).
 *
 * Partial degrade: when the hms-smoke source is absent (layer off, still
 * loading, or failed), `activateSmokeVolume` returns false and the mode
 * simply continues without a smoke volume; nothing here may block terrain.
 */

import type maplibregl from 'maplibre-gl';

import {
  HMS_DENSITY_PRESENTATION,
  HMS_VOLUME_QUALIFICATION,
  buildHmsSmokeVolumePaint
} from '../config/wildfire-presentation';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';

/** Mirrored literals from src/layers/hms-smoke.ts (lazy-chunk independence). */
const SOURCE_ID = 'hms-smoke';
const FILL_LAYER_ID = 'hms-smoke-fill';

const VOLUME_LAYER_ID = 'hms-smoke-volume';
const LEGEND_KEY = 'hms-smoke-volume';

/**
 * Add the fill-extrusion volume over the EXISTING hms-smoke source and hide
 * the flat veil. Idempotent. Returns false (nothing added) when the source
 * is absent; the caller treats that as a non-fatal partial degrade.
 */
export function activateSmokeVolume(map: maplibregl.Map): boolean {
  if (!map.getSource(SOURCE_ID)) return false;

  if (!map.getLayer(VOLUME_LAYER_ID)) {
    map.addLayer({
      id: VOLUME_LAYER_ID,
      type: 'fill-extrusion',
      source: SOURCE_ID,
      paint: buildHmsSmokeVolumePaint()
    });
    // Seat the volume at its ruled position (EVENT_OVERLAY_IDS, right above
    // the flat veil) instead of relying on activation-order luck; this
    // module adds outside the layer controller, so it re-asserts the chain
    // itself.
    reassertThematicOrder(map);
    reassertLabelOrder(map);
  }

  if (map.getLayer(FILL_LAYER_ID)) {
    map.setLayoutProperty(FILL_LAYER_ID, 'visibility', 'none');
  }

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.event + 3,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Smoke volume (3D view)',
        [
          {
            color: HMS_DENSITY_PRESENTATION.Light.color,
            label: 'Light smoke (stylized 320 m rise)'
          },
          {
            color: HMS_DENSITY_PRESENTATION.Medium.color,
            label: 'Medium smoke (stylized 680 m rise)'
          },
          {
            color: HMS_DENSITY_PRESENTATION.Heavy.color,
            label: 'Heavy smoke (stylized 1320 m rise)'
          },
          {
            color: HMS_DENSITY_PRESENTATION.Unknown.color,
            label: 'Unclassified smoke density (stylized 480 m rise)'
          }
        ],
        HMS_VOLUME_QUALIFICATION
      )
  });

  return true;
}

/**
 * Remove the volume, restore the flat veil's visibility, and drop the
 * volume legend. Defensive guards throughout; symmetric with activate.
 */
export function deactivateSmokeVolume(map: maplibregl.Map): void {
  if (map.getLayer(VOLUME_LAYER_ID)) map.removeLayer(VOLUME_LAYER_ID);
  if (map.getLayer(FILL_LAYER_ID)) {
    map.setLayoutProperty(FILL_LAYER_ID, 'visibility', 'visible');
  }
  hideLegend(LEGEND_KEY);
}

/**
 * Complete an interrupted hms-smoke teardown. While the volume layer holds
 * the source, the owning module's `removeSource` is refused by MapLibre
 * (an error event, not an exception), so toggling the smoke layer off
 * during the 3D mode leaves an orphaned source behind. The fire3d
 * controller calls this AFTER `deactivateSmokeVolume` once the registry
 * confirms hms-smoke is off; it removes the source only when no layer
 * still references it, so a live hms-smoke activation is never mutated.
 */
export function cleanupOrphanedSmokeSource(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) return;
  if (map.getLayer(FILL_LAYER_ID) || map.getLayer(VOLUME_LAYER_ID)) return;
  map.removeSource(SOURCE_ID);
}
