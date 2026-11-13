/**
 * National Forests layer: the USDA Forest Service's administrative forest
 * boundaries (112 units, CC0), drawn as a quiet green outline from zoom 6 with
 * the forest's name from zoom 8, and no fill (owner, 2026-11-12: minimal, a
 * name at close zoom). An administrative boundary takes in lands the Forest
 * Service does not own. Read from DDM's own archive
 * (public/data/ddm-forests-<edition>.pmtiles, baked by
 * scripts/build-base-tiles.mjs), same-origin, so it has no live fetch and no
 * cancellation; the pmtiles protocol is registered at boot.
 */

import type * as maplibregl from 'maplibre-gl';

import { MAP_GROUND_COLOR } from '../config/interface-tokens';
import { URLS } from '../config/urls';
import { registry } from '../state/registry';

const LAYER_KEY = 'forests';
const SOURCE_ID = 'forests';
const LINE_ID = 'forests-outline';
const LABEL_ID = 'forests-label';
const COLOR = '#8fbf86';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LINE_ID, LABEL_ID] as const;

export async function activate(map: maplibregl.Map): Promise<void> {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'vector', url: 'pmtiles://' + URLS.forestsPmtiles });
  }
  if (!map.getLayer(LINE_ID)) {
    map.addLayer({
      id: LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'forest',
      minzoom: 5.5,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 1.2, 13, 1.8],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 0, 7, 0.75]
      }
    });
  }
  if (!map.getLayer(LABEL_ID)) {
    map.addLayer({
      id: LABEL_ID,
      type: 'symbol',
      source: SOURCE_ID,
      // Labelled on the shape, not a single point: MapLibre places one name per tile piece, so a
      // forest larger than the view is still named wherever it is seen. Only parts of 40 km2 and
      // up are named, and the padding spaces the names, so checkerboard pieces carry none.
      'source-layer': 'forest',
      minzoom: 8,
      filter: ['>=', ['get', 'km2'], 40],
      layout: {
        'text-padding': 160,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-max-width': 8,
        'text-letter-spacing': 0.04
      },
      paint: { 'text-color': COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
    });
  }
  registry.setStatus(LAYER_KEY, 'ready');
}

export function deactivate(map: maplibregl.Map): void {
  for (const id of [LABEL_ID, LINE_ID]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
