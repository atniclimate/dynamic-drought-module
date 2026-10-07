import { expect, test } from './offline-test';
import type * as maplibregl from 'maplibre-gl';

import { USDM_NONE_SWATCH } from '../src/config/palette';
import { buildFireContextHtml } from '../src/impact/fire-context';
import {
  buildUsdmFillPaint,
  fadeLayerIds
} from '../src/layers/usdm';
import { buildOutlookFillPaint } from '../src/layers/drought';
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

  // A tuple, not a bare `{x,y}` object: maplibre-gl's `PointLike` is
  // `Point | [number, number]`, and a plain literal lacks the `Point`
  // class's own methods (`clone`, `add`, ...).
  const html = buildFireContextHtml(map, [10, 10], lngLat);
  expect(html).toContain('No D0-D4 polygon rendered here.');
  expect(html).toContain('no analyzed-area mask here');
  expect(html).toContain('does not confirm no drought');
});

test('USDM fade targets contain the actual fill and outline layers only', () => {
  expect(fadeLayerIds).toEqual([
    'usdm-frame-a-fill', 'usdm-frame-a-outline',
    'usdm-frame-b-fill', 'usdm-frame-b-outline',
    'usdm-change-fill', 'usdm-change-outline',
    'bc-drought-fill', 'bc-drought-outline'
  ]);
});

// ---------------------------------------------------------------------------
// The observed-vs-outlook register split (DR-070): the CPC outlook is
// hatched (`fill-pattern`), the USDM observed week is solid (`fill-color`).
// Both modules build their fill paint through a pure, exported seam
// (buildOutlookFillPaint / buildUsdmFillPaint) precisely so this split can be
// pinned here without a network-backed activation; a future edit that
// flattens either surface onto the other's paint property fails this test.
// ---------------------------------------------------------------------------

test('the CPC drought outlook fills with a hatch fill-pattern, never a solid fill-color', () => {
  const paint = buildOutlookFillPaint() as Record<string, unknown>;
  expect(Object.keys(paint).sort()).toEqual(['fill-opacity', 'fill-pattern']);
  expect(paint['fill-pattern']).toBeTruthy();
  expect(paint['fill-opacity']).toBe(1);
});

test('the USDM observed week fills with a solid fill-color, never a hatch fill-pattern', () => {
  const dummyColor = '#123456' as unknown as maplibregl.ExpressionSpecification;
  const paint = buildUsdmFillPaint(dummyColor) as Record<string, unknown>;
  expect(Object.keys(paint).sort()).toEqual(['fill-color', 'fill-opacity']);
  expect(paint['fill-color']).toBe(dummyColor);
});
