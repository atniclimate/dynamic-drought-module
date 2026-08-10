import { expect, test } from '@playwright/test';
import type maplibregl from 'maplibre-gl';

import { USDM_NONE_SWATCH } from '../src/config/palette';
import { buildFireContextHtml } from '../src/impact/fire-context';
import {
  buildD4RimLayerSpecification,
  fadeLayerIds,
  USDM_D4_RIM_LAYER_IDS,
  USDM_D4_RIM_STYLE
} from '../src/layers/usdm';
import { registry } from '../src/state/registry';
import { timeline } from '../src/state/timeline';
import { droughtMetric } from '../src/ui/island/strip-metrics';

test.afterEach(() => {
  registry.deactivate('usdm');
  timeline.reset();
});

test('zero rendered USDM polygons stays an explicit unmasked absence', () => {
  registry.activate('usdm');
  registry.setStatus('usdm', 'ready');

  const map = {
    getLayer: (id: string) =>
      id === 'usdm-frame-a-fill' || id === 'usdm-frame-b-fill' ? { id } : undefined,
    queryRenderedFeatures: () => []
  } as unknown as maplibregl.Map;

  const { metric, dateMs } = droughtMetric(map);
  expect(metric).toEqual({
    value: 'No polygon',
    sublabel: 'no D0-D4 polygon rendered; no area mask to confirm no drought',
    tone: 'none'
  });
  expect(dateMs).toBeNull();
});

test('the no-polygon swatch does not claim a no-drought class', () => {
  expect(USDM_NONE_SWATCH).toEqual({
    code: 'No polygon',
    label: 'No D0-D4 category drawn',
    color: '#253247'
  });
});

test('fire context does not infer no drought without an analyzed-area mask', () => {
  const map = {
    getLayer: (id: string) =>
      id === 'usdm-frame-a-fill' || id === 'usdm-frame-b-fill' ? { id } : undefined,
    queryRenderedFeatures: () => []
  } as unknown as maplibregl.Map;
  const lngLat = { lng: -120, lat: 46 } as maplibregl.LngLat;

  const html = buildFireContextHtml(map, { x: 10, y: 10 }, lngLat);
  expect(html).toContain('No D0-D4 polygon rendered here.');
  expect(html).toContain('no analyzed-area mask here');
  expect(html).toContain('does not confirm no drought');
});

test('every absolute USDM frame carries the ratified D4 contrast rim', () => {
  expect(USDM_D4_RIM_LAYER_IDS).toEqual([
    'usdm-frame-a-d4-rim',
    'usdm-frame-b-d4-rim'
  ]);
  expect(USDM_D4_RIM_STYLE).toEqual({
    color: '#f87171',
    width: 1.5,
    opacity: 0.9
  });

  const visible = buildD4RimLayerSpecification('usdm-frame-a', true);
  expect(visible.id).toBe('usdm-frame-a-d4-rim');
  expect(visible.source).toBe('usdm-frame-a');
  expect(visible.filter).toEqual(['==', ['get', 'DM'], 4]);
  expect(visible.layout).toEqual({ visibility: 'visible' });
  expect(visible.paint).toEqual({
    'line-color': '#f87171',
    'line-width': 1.5,
    'line-opacity': 0.9
  });

  const hidden = buildD4RimLayerSpecification('usdm-frame-b', false);
  expect(hidden.layout).toEqual({ visibility: 'none' });
  for (const id of USDM_D4_RIM_LAYER_IDS) expect(fadeLayerIds).toContain(id);
});
