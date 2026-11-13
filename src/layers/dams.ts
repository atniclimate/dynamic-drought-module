/**
 * Dams layer: large dams (50 ft and up) and dams with high hazard potential
 * from the U.S. Army Corps of Engineers National Inventory of Dams, a small
 * point from zoom 7.5 sized by height, named from zoom 11 (owner, 2026-11-12:
 * dams with discretion, a small symbol, named at close zoom). Hazard potential
 * selects which dams are drawn and is not shown. Drawn from the base map's
 * roads archive (src/map/style.ts, source `base-roads`, layer `dam`; baked by
 * scripts/build-base-tiles.mjs), so no request leaves the app for it.
 */

import type * as maplibregl from 'maplibre-gl';

import { MAP_GROUND_COLOR } from '../config/interface-tokens';
import { registry } from '../state/registry';

const LAYER_KEY = 'dams';
const SOURCE_ID = 'base-roads';
const POINT_ID = 'dams';
const LABEL_ID = 'dams-label';
const COLOR = '#9fb7c9';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [POINT_ID, LABEL_ID] as const;

export async function activate(map: maplibregl.Map): Promise<void> {
  if (!map.getSource(SOURCE_ID)) {
    registry.setStatus(LAYER_KEY, 'error');
    return;
  }
  if (!map.getLayer(POINT_ID)) {
    map.addLayer({
      id: POINT_ID,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': 'dam',
      minzoom: 7.5,
      paint: {
        'circle-color': COLOR,
        'circle-radius': ['interpolate', ['linear'], ['get', 'height'], 0, 2, 100, 3, 400, 4.5],
        'circle-stroke-color': MAP_GROUND_COLOR,
        'circle-stroke-width': 1,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 8.5, 0.9],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 8.5, 0.9]
      }
    });
  }
  if (!map.getLayer(LABEL_ID)) {
    map.addLayer({
      id: LABEL_ID,
      type: 'symbol',
      source: SOURCE_ID,
      'source-layer': 'dam',
      minzoom: 11,
      filter: ['!=', ['get', 'name'], ''],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-max-width': 8
      },
      paint: { 'text-color': COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
    });
  }
  registry.setStatus(LAYER_KEY, 'ready');
}

export function deactivate(map: maplibregl.Map): void {
  for (const id of [LABEL_ID, POINT_ID]) if (map.getLayer(id)) map.removeLayer(id);
}
