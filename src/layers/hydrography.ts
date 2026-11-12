/**
 * Hydrography layer: rivers, canals and water bodies, drawn bright from the
 * base map's own archive (src/map/style.ts, source `base`; baked by
 * scripts/build-base-tiles.mjs from the USGS 1:1,000,000-scale streams and
 * waterbodies, the Atlas of Canada 1:1,000,000 rivers and waterbodies, and
 * Natural Earth elsewhere). It replaced the live OpenStreetMap Overpass read
 * (DDM-P17-T12): no request leaves the app for it, so it has no fetch, no
 * cancellation and no zoom floor; it draws from the national view, larger
 * rivers first, by stream order.
 *
 * River names under the cursor come through the shared hover inspector
 * (src/ui/hover-inspector.ts reads this line layer's `name`).
 */

import type * as maplibregl from 'maplibre-gl';

import { registry } from '../state/registry';

const LAYER_KEY = 'hydrography';
const SOURCE_ID = 'base';
const LAYER_ID = 'hydrography';
const WATER_LAYER_ID = 'hydrography-water';
const COLOR = '#1f78b4';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [WATER_LAYER_ID, LAYER_ID] as const;

export async function activate(map: maplibregl.Map): Promise<void> {
  if (!map.getSource(SOURCE_ID)) {
    registry.setStatus(LAYER_KEY, 'error');
    return;
  }
  if (!map.getLayer(WATER_LAYER_ID)) {
    map.addLayer({
      id: WATER_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'water',
      filter: ['match', ['get', 'kind'], ['lake', 'reservoir', 'river', 'intermittent'], true, false],
      paint: { 'fill-color': COLOR, 'fill-opacity': ['match', ['get', 'kind'], 'intermittent', 0.3, 0.55] }
    });
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'river',
      // Stream order (Strahler; 3 for canals), one step denser than the ground's rivers.
      filter: ['>=', ['get', 'rank'], ['step', ['zoom'], 6, 4.5, 5, 5.5, 4, 6.5, 0]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': COLOR,
        'line-opacity': ['match', ['get', 'kind'], 'intermittent', 0.6, 0.92],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          4, ['*', 0.25, ['-', ['get', 'rank'], 2]],
          8, ['*', 0.5, ['-', ['get', 'rank'], 2]],
          12, ['*', 0.9, ['-', ['get', 'rank'], 2]]]
      }
    });
  }
  registry.setStatus(LAYER_KEY, 'ready');
}

export function deactivate(map: maplibregl.Map): void {
  for (const id of [LAYER_ID, WATER_LAYER_ID]) if (map.getLayer(id)) map.removeLayer(id);
}
