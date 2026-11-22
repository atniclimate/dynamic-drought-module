// The emphasis-surface case of place-studio-watersheds.spec.ts, moved here because it opens no page and so runs in the pure lane.
import { expect, test } from './offline-test';
import type * as maplibregl from 'maplibre-gl';

import {
  clearStudioBoundary,
  showStudioBoundary
} from '../src/state/studio-boundary';
import { PACIFIC_NORTHWEST, YAKIMA } from './watershed-geometry-fixtures';

test('the ephemeral emphasis surface shows, updates, and clears areal geometry', () => {
  const sources = new Map<
    string,
    { setData: (data: GeoJSON.GeoJSON) => void }
  >();
  const layers = new Map<string, maplibregl.LayerSpecification>();
  let latestData: GeoJSON.GeoJSON | null = null;
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      sources.set(id, {
        setData: (data: GeoJSON.GeoJSON) => {
          latestData = data;
        }
      });
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: maplibregl.LayerSpecification) => {
      layers.set(layer.id, layer);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    }
  } as unknown as maplibregl.Map;

  showStudioBoundary(map, YAKIMA);
  expect(sources.has('place-studio-boundary')).toBe(true);
  expect(layers.get('place-studio-boundary-fill')).toMatchObject({
    type: 'fill',
    paint: { 'fill-opacity': 0.1, 'fill-color': '#FFFFFF' }
  });
  expect(layers.get('place-studio-boundary-line')).toMatchObject({
    type: 'line',
    paint: { 'line-width': 2, 'line-color': '#FFFFFF', 'line-dasharray': [2, 2] }
  });
  expect(layers.get('place-studio-boundary-casing')).toMatchObject({
    type: 'line',
    paint: { 'line-width': 4, 'line-color': '#010B13' }
  });
  expect([...layers.keys()]).toEqual([
    'place-studio-boundary-fill', 'place-studio-boundary-casing', 'place-studio-boundary-line'
  ]);

  showStudioBoundary(map, PACIFIC_NORTHWEST);
  expect(latestData).toMatchObject({
    type: 'Feature',
    geometry: { type: 'MultiPolygon' }
  });

  clearStudioBoundary(map);
  expect(sources.has('place-studio-boundary')).toBe(false);
  expect(layers.has('place-studio-boundary-fill')).toBe(false);
  expect(layers.has('place-studio-boundary-line')).toBe(false);
  expect(layers.has('place-studio-boundary-casing')).toBe(false);
  showStudioBoundary(map, YAKIMA);
  expect(layers.size).toBe(3);
  expect(layers.get('place-studio-boundary-line')).toMatchObject({ paint: { 'line-dasharray': [2, 2] } });
  clearStudioBoundary(map);
  expect(layers.size).toBe(0);
});
