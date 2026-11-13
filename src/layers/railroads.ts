/**
 * Railroads layer: main-line railroads in the United States (Census TIGER/Line
 * 2025, MTFCC R1011; carlines and cog railways left out), a thin dashed line
 * from zoom 7.5 (owner, 2026-11-12: railroads with discretion). Drawn from the
 * base map's roads archive (src/map/style.ts, source `base-roads`, layer
 * `rail`; baked by scripts/build-base-tiles.mjs), so no request leaves the
 * app for it. Canada and Mexico are not drawn yet.
 */

import type * as maplibregl from 'maplibre-gl';

import { registry } from '../state/registry';

const LAYER_KEY = 'railroads';
const SOURCE_ID = 'base-roads';
const LAYER_ID = 'railroads';
const COLOR = '#a7adb5';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

export async function activate(map: maplibregl.Map): Promise<void> {
  if (!map.getSource(SOURCE_ID)) {
    registry.setStatus(LAYER_KEY, 'error');
    return;
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'rail',
      minzoom: 7.5,
      paint: {
        'line-color': COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 12, 1.4],
        // Between the U.S. and state highways in weight, so a railroad never outshines an interstate.
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 8.5, 0.55],
        'line-dasharray': [3, 2]
      }
    });
  }
  registry.setStatus(LAYER_KEY, 'ready');
}

export function deactivate(map: maplibregl.Map): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
}
