import { test, expect } from '@playwright/test';

import {
  BOTTOM_STACK_IDS,
  CONDITION_SURFACE_IDS,
  EVENT_OVERLAY_IDS,
  REFERENCE_BOUNDARY_IDS,
  THEMATIC_STACK_IDS,
  firstLayerIdAbove,
  reassertLabelOrder,
  reassertThematicOrder
} from '../src/map/layer-order';

/**
 * The z-order discipline module (U4 stage-5 adversarial major 2): the
 * bottom-stack insertion arithmetic and the label reassert hook must be
 * correct for BOTH activation orders, proven here in Node against a fake
 * map (the production build exposes no map handle; the rendered result is
 * stage-5 screenshot evidence).
 */

interface FakeLayer {
  id: string;
}

function fakeMap(ids: string[]): {
  getStyle: () => { layers: FakeLayer[] };
  getLayer: (id: string) => FakeLayer | undefined;
  moveLayer: (id: string, beforeId?: string) => void;
  order: () => string[];
} {
  let layers = ids.map((id) => ({ id }));
  return {
    getStyle: () => ({ layers }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    // Mirrors MapLibre semantics: no beforeId moves to the top; a beforeId
    // inserts the layer directly below it (before it in paint order).
    moveLayer: (id: string, beforeId?: string) => {
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      layers = layers.filter((l) => l.id !== id);
      const idx = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (idx === -1) {
        layers = layers.concat(layer);
      } else {
        layers.splice(idx, 0, layer);
      }
    },
    order: () => layers.map((l) => l.id)
  };
}

test.describe('layer-order: bottom-stack insertion', () => {
  test('satellite inserted late lands under an existing hillshade and data', () => {
    const map = fakeMap([
      'background',
      'basemap',
      'basemap-ground',
      'hillshade',
      'usdm-fill'
    ]);
    // Recent satellite skips the persistent ground stack, so its anchor is hillshade:
    // it inserts below hillshade, inside the stack.
    const beforeId = firstLayerIdAbove(
      map as never,
      ['background', 'basemap', 'basemap-ground']
    );
    expect(beforeId).toBe('hillshade');
  });

  test('hillshade inserted late lands above satellite and under data', () => {
    const map = fakeMap(['background', 'basemap', 'basemap-satellite', 'ecoregions-l3-fill']);
    const beforeId = firstLayerIdAbove(map as never, BOTTOM_STACK_IDS);
    expect(beforeId).toBe('ecoregions-l3-fill');
  });

  test('a bottom-stack-only style appends at the top (undefined anchor)', () => {
    const map = fakeMap(['background', 'basemap', 'basemap-satellite']);
    expect(firstLayerIdAbove(map as never, BOTTOM_STACK_IDS)).toBeUndefined();
  });

  test('a data layer skipping the whole stack lands above satellite AND hillshade', () => {
    // The ecoregions case that failed the adversarial review: satellite or
    // hillshade activated FIRST must not become a data layer's beforeId.
    const map = fakeMap(['background', 'basemap', 'basemap-satellite', 'hillshade', 'states-line']);
    const beforeId = firstLayerIdAbove(map as never, [
      ...BOTTOM_STACK_IDS,
      'ecoregions-l3-fill',
      'ecoregions-l4-fill'
    ]);
    expect(beforeId).toBe('states-line');
  });
});

test.describe('layer-order: label reassert', () => {
  test('a surface activated after the labels is moved back under them', () => {
    const map = fakeMap(['background', 'basemap', 'us-places-labels', 'usdm-fill']);
    // The controller calls reassertLabelOrder after each activation; the
    // labels move back to the very top.
    reassertLabelOrder(map as never);
    expect(map.order()).toEqual(['background', 'basemap', 'usdm-fill', 'us-places-labels']);
  });

  test('no-op when the labels layer is absent', () => {
    const map = fakeMap(['background', 'basemap', 'usdm-fill']);
    reassertLabelOrder(map as never);
    expect(map.order()).toEqual(['background', 'basemap', 'usdm-fill']);
  });
});

/**
 * E1 deliverable 2 (D-0.7.0-041 part 2; the 2026-07-16 design review E1.3):
 * the deterministic thematic chain. `reassertThematicOrder` runs after each
 * activation, so the stack basemap < hillshade < USDM < state hairline <
 * Tribal Lands < Reservation Boundaries < labels holds regardless of which
 * activation's network fetch resolved first, and the existing
 * AIANNH-below-BIA pair rule is carried by the chain itself.
 */
test.describe('layer-order: thematic reassert (E1 deliverable 2)', () => {
  test('the chain names the ruled order, AIANNH below BIA', () => {
    // A revert that reorders the chain (or drops the pair rule) fails here.
    const idx = (id: string): number => THEMATIC_STACK_IDS.indexOf(id);
    expect(idx('usdm-frame-a-fill')).toBeGreaterThanOrEqual(0);
    expect(idx('usdm-frame-a-fill')).toBeLessThan(idx('us-states-outline'));
    expect(idx('hms-smoke-fill')).toBeGreaterThan(idx('usdm-frame-a-fill'));
    expect(idx('hms-smoke-fill')).toBeLessThan(idx('us-states-casing'));
    expect(idx('us-states-outline')).toBeLessThan(idx('aiannh-fill'));
    expect(idx('aiannh-fill')).toBeLessThan(idx('bia-reservations-fill'));
  });

  test('the complete chain has explicit condition, event, and reference bands', () => {
    expect(THEMATIC_STACK_IDS).toEqual([
      ...CONDITION_SURFACE_IDS,
      ...EVENT_OVERLAY_IDS,
      ...REFERENCE_BOUNDARY_IDS
    ]);
    expect(CONDITION_SURFACE_IDS).toEqual(
      expect.arrayContaining([
        'gridded-index-raster',
        'sst-anomaly',
        'heatrisk',
        'usfs-whp',
        'nadm-drought-fill',
        'cdm-drought-fill',
        'bc-drought-fill'
      ])
    );
    expect(REFERENCE_BOUNDARY_IDS).toEqual(
      expect.arrayContaining([
        'us-states-casing',
        'tribal-lands-outline',
        'aiannh-outline',
        'bia-reservations-outline',
        'treaty-areas-outline'
      ])
    );
  });

  test('a scrambled completion order is re-seated to the ruled stack', () => {
    // The pathological network order: states first, then USDM, then BIA,
    // then AIANNH (each appended above the last, as insertion would).
    const map = fakeMap([
      'background',
      'basemap',
      'hillshade',
      'us-states-fill',
      'us-states-outline',
      'usdm-frame-a-fill',
      'usdm-frame-a-outline',
      'bia-reservations-fill',
      'bia-reservations-outline',
      'aiannh-fill',
      'aiannh-outline',
      'us-places-labels'
    ]);
    reassertThematicOrder(map as never);
    reassertLabelOrder(map as never);
    expect(map.order()).toEqual([
      'background',
      'basemap',
      'hillshade',
      'usdm-frame-a-fill',
      'usdm-frame-a-outline',
      'us-states-fill',
      'us-states-outline',
      'aiannh-fill',
      'aiannh-outline',
      'bia-reservations-fill',
      'bia-reservations-outline',
      'us-places-labels'
    ]);
  });

  test('a surface activated last still lands below the boundary chain', () => {
    const map = fakeMap([
      'background',
      'basemap',
      'aiannh-fill',
      'bia-reservations-fill',
      'usdm-frame-a-fill'
    ]);
    reassertThematicOrder(map as never);
    expect(map.order()).toEqual([
      'background',
      'basemap',
      'usdm-frame-a-fill',
      'aiannh-fill',
      'bia-reservations-fill'
    ]);
  });

  test('events stay above conditions and below references; ecoregions stay below', () => {
    const map = fakeMap([
      'background',
      'basemap',
      'ecoregions-l3-fill',
      'bia-reservations-fill',
      'nifc-fires-fill',
      'usdm-frame-a-fill',
      'aiannh-fill'
    ]);
    reassertThematicOrder(map as never);
    expect(map.order()).toEqual([
      'background',
      'basemap',
      'ecoregions-l3-fill',
      'usdm-frame-a-fill',
      'nifc-fires-fill',
      'aiannh-fill',
      'bia-reservations-fill'
    ]);
  });

  test('idempotent: a second pass changes nothing', () => {
    const map = fakeMap([
      'background',
      'basemap',
      'bia-reservations-fill',
      'usdm-frame-a-fill',
      'aiannh-fill',
      'us-places-labels'
    ]);
    reassertThematicOrder(map as never);
    const once = map.order();
    reassertThematicOrder(map as never);
    expect(map.order()).toEqual(once);
  });
});
