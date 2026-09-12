import { expect, test } from '@playwright/test';

import { resolveCanonicalGeography } from '../src/config/geography';
import { resolveStateCode } from '../src/impact/resources';
import type { BoundarySelectionContext } from '../src/impact/types';
import { resolveWaterSupplyPoint } from '../src/impact/water-supply';

/**
 * Every remaining place decision that can still reach the camera region
 * fallback, named at its call site (src/impact/resources.ts:100,
 * src/config/geography.ts:262) and exercised here. Each fallback fires only
 * when the place itself is silent (no postal-code property, no
 * `containing.state`); a place-derived answer always wins first.
 */

const LNG_LAT = { lng: -120.5, lat: 47.2 };

function context(
  overrides: Partial<BoundarySelectionContext> &
    Pick<BoundarySelectionContext, 'containing' | 'regionKey'>
): BoundarySelectionContext {
  return {
    kind: 'ecoregion',
    title: 'Test selection',
    properties: null,
    lngLat: LNG_LAT,
    ...overrides
  };
}

test.describe('resolveStateCode: place before camera', () => {
  test('a state feature\'s own STUSPS wins over both containing.state and the camera region', () => {
    const code = resolveStateCode(
      context({
        kind: 'state',
        properties: { STUSPS: 'ID' },
        containing: { state: 'OR', basis: 'feature-property' },
        regionKey: 'washington_state'
      })
    );
    expect(code).toBe('ID');
  });

  test('containing.state, resolved from the place, wins over the camera region', () => {
    const code = resolveStateCode(
      context({
        containing: { state: 'OR', basis: 'point-in-polygon' },
        regionKey: 'washington_state'
      })
    );
    expect(code).toBe('OR');
  });

  test('the camera-region fallback fires only when the place is silent (no property, no containing.state)', () => {
    const code = resolveStateCode(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: 'washington_state'
      })
    );
    // regionPrimaryState('washington_state') === 'WA' (src/impact/resources.ts).
    expect(code).toBe('WA');
  });

  test('a silent place with no camera region resolves no state at all', () => {
    const code = resolveStateCode(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: null
      })
    );
    expect(code).toBeNull();
  });
});

test.describe('resolveCanonicalGeography: place before camera', () => {
  test('containing.state stands in for a missing postal-code property and is not the camera fallback', () => {
    const geography = resolveCanonicalGeography(
      context({
        containing: { state: 'AK', basis: 'point-in-polygon' },
        regionKey: 'washington_state'
      })
    );
    expect(geography.key).toBe('alaska');
    // geographyForPostalCode stamps this rung, not the camera fallback.
    expect(geography.basis).toBe('boundary-postal-code');
  });

  test('the camera-region fallback fires for a silent place and announces itself as region-framing (alaska)', () => {
    const geography = resolveCanonicalGeography(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: 'alaska'
      })
    );
    expect(geography.key).toBe('alaska');
    expect(geography.basis).toBe('region-framing');
  });

  test('the camera-region fallback fires for a silent place and announces itself as region-framing (washington_state)', () => {
    const geography = resolveCanonicalGeography(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: 'washington_state'
      })
    );
    expect(geography.key).toBe('conus');
    expect(geography.basis).toBe('region-framing');
  });

  test('a silent place with no camera region resolves the unknown default, not a guess', () => {
    const geography = resolveCanonicalGeography(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: null
      })
    );
    // regionFallback's default branch (src/config/geography.ts) returns
    // key 'unknown' with basis 'unknown', not a silent guess.
    expect(geography.key).toBe('unknown');
    expect(geography.basis).toBe('unknown');
  });
});

test.describe('resolveWaterSupplyPoint: place before camera (DDM-P2-T08 microtask 3)', () => {
  test('an Oregon place resolves its own MODO3 forecast point, never the washington_state camera\'s BONO3', () => {
    const point = resolveWaterSupplyPoint(
      context({
        kind: 'aiannh',
        containing: { state: 'OR', basis: 'point-in-polygon' },
        regionKey: 'washington_state'
      }),
      'OR'
    );
    // STATE_POINTS.OR === 'MODO3', REGION_POINTS.washington_state === 'BONO3'
    // (src/impact/water-supply.ts).
    expect(point).toBe('MODO3');
    expect(point).not.toBe('BONO3');
  });

  test('the camera-region fallback fires for a silent place and resolves south_puget_sound\'s own CONW1 point', () => {
    const point = resolveWaterSupplyPoint(
      context({
        kind: 'ecoregion',
        containing: { state: null, basis: 'none' },
        regionKey: 'south_puget_sound'
      }),
      'WA'
    );
    // REGION_POINTS.south_puget_sound === 'CONW1' (src/impact/water-supply.ts).
    expect(point).toBe('CONW1');
  });
});
