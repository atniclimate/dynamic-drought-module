import { expect, test } from '@playwright/test';

import { resolveCanonicalGeography } from '../src/config/geography';
import type { CanonicalGeography } from '../src/config/geography';
import { coverageFamilyForGeography } from '../src/config/place-coverage';
import { resolveStateCode } from '../src/impact/resources';
import { briefingSourcePolicy } from '../src/impact/source-policy';
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

/**
 * DR-090 microtask 5: `coverageFamilyForGeography`
 * (src/config/place-coverage.ts), the postal-code-to-family hop the impact
 * synthesis gate now reads instead of the camera region. A minimal geography
 * builder stands in for `resolveCanonicalGeography`'s output shape, since
 * these cases test the hop in isolation from that resolver.
 */
function geography(
  overrides: Partial<CanonicalGeography> & Pick<CanonicalGeography, 'key'>
): CanonicalGeography {
  return {
    country: 'United States',
    basis: 'boundary-postal-code',
    note: 'test geography',
    ...overrides
  };
}

test.describe('coverageFamilyForGeography: the postal-code-to-family hop (DR-090)', () => {
  test('Washington, Oregon, and Idaho resolve to the pnw family', () => {
    expect(coverageFamilyForGeography(geography({ key: 'conus', postalCode: 'WA' }))).toBe('pnw');
    expect(coverageFamilyForGeography(geography({ key: 'conus', postalCode: 'OR' }))).toBe('pnw');
    expect(coverageFamilyForGeography(geography({ key: 'conus', postalCode: 'ID' }))).toBe('pnw');
  });

  test('Alaska and Hawaii resolve to the ak-hi family', () => {
    expect(
      coverageFamilyForGeography(geography({ key: 'alaska', postalCode: 'AK' }))
    ).toBe('ak-hi');
    expect(
      coverageFamilyForGeography(geography({ key: 'hawaii', postalCode: 'HI' }))
    ).toBe('ak-hi');
  });

  test('every other US postal code takes the conus default', () => {
    expect(coverageFamilyForGeography(geography({ key: 'conus', postalCode: 'FL' }))).toBe(
      'conus'
    );
    expect(coverageFamilyForGeography(geography({ key: 'conus', postalCode: 'NM' }))).toBe(
      'conus'
    );
  });

  test('a Canada geography resolves to the canada family', () => {
    expect(
      coverageFamilyForGeography(geography({ key: 'canada', country: 'Canada' }))
    ).toBe('canada');
  });

  test('a transboundary geography resolves to the transboundary family', () => {
    expect(
      coverageFamilyForGeography(
        geography({ key: 'transboundary', country: 'transboundary' })
      )
    ).toBe('transboundary');
  });

  test('an unknown geography resolves to no family (null, reads as capability none)', () => {
    expect(
      coverageFamilyForGeography(geography({ key: 'unknown', country: 'unknown' }))
    ).toBeNull();
  });
});

/**
 * DR-090: `briefingSourcePolicy`'s impact-synthesis gate
 * (src/impact/source-policy.ts) reads the PLACE's coverage family when the
 * geography came from the place (`basis: 'boundary-postal-code'`), and falls
 * back to the CAMERA region's family only when the place is silent and
 * `resolveCanonicalGeography` itself fell back to the camera. That camera
 * fallback is the one named at the gate's line; it is exercised here in both
 * directions, firing for a silent place and yielding to the place once the
 * context knows its state.
 */
test.describe('briefingSourcePolicy: impact synthesis gated by the place, with one named camera fallback (DR-090)', () => {
  test('the camera fallback fires for a silent place: washington_state (pnw) keeps synthesis enabled, as before DR-090', () => {
    const policy = briefingSourcePolicy(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: 'washington_state'
      })
    );
    // The geography is camera-derived (stamped 'region-framing' by
    // src/config/geography.ts), so the gate reads the camera region's
    // family: washington_state is pnw, whose impactSynthesis is 'partial'.
    expect(policy.geography.basis).toBe('region-framing');
    expect(policy.droughtImpact.enabled).toBe(true);
    expect(policy.droughtImpact.note).toBeNull();
  });

  test('the camera fallback fires for a silent place: national (conus) disables synthesis with the conus note', () => {
    const policy = briefingSourcePolicy(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: 'national'
      })
    );
    expect(policy.geography.basis).toBe('region-framing');
    expect(policy.droughtImpact.enabled).toBe(false);
    expect(policy.droughtImpact.note).toBe(
      'The briefing synthesis and resource routing are not validated outside the PNW.'
    );
  });

  test('the camera fallback fires for a silent place with no region: synthesis is none with the unrecognized-region note', () => {
    const policy = briefingSourcePolicy(
      context({
        containing: { state: null, basis: 'none' },
        regionKey: null
      })
    );
    expect(policy.geography.basis).toBe('unknown');
    expect(policy.droughtImpact.enabled).toBe(false);
    expect(policy.droughtImpact.note).toBe(
      'Drought impact analysis and resource routing are unavailable because this selection has no recognized coverage region.'
    );
  });

  test('a place with its own containing.state (AK) reads the place, not the washington_state camera', () => {
    const policy = briefingSourcePolicy(
      context({
        containing: { state: 'AK', basis: 'point-in-polygon' },
        regionKey: 'washington_state'
      })
    );
    expect(policy.geography.basis).toBe('boundary-postal-code');
    expect(policy.geography.key).toBe('alaska');
    // ak-hi impactSynthesis is 'none' in the matrix: no Washington-flavored
    // synthesis leaks onto a real Alaska place under the WA camera.
    expect(policy.droughtImpact.enabled).toBe(false);
    expect(policy.droughtImpact.note).toBe(
      'No briefing support for Alaska or Hawaii.'
    );
  });

  test('a Texas place under the washington_state camera: synthesis is disabled by the place (DR-090) while the seasonal heat source stays available by issuer extent (DR-075 a)', () => {
    const policy = briefingSourcePolicy(
      context({
        containing: { state: 'TX', basis: 'point-in-polygon' },
        regionKey: 'washington_state'
      })
    );
    expect(policy.geography.postalCode).toBe('TX');
    expect(policy.droughtImpact.enabled).toBe(false);
    expect(policy.droughtImpact.note).toBe(
      'The briefing synthesis and resource routing are not validated outside the PNW.'
    );
    // DR-075 a's gate is a separate branch of the same policy (the national
    // heat capability by geography key) and DR-090 does not reach it. That
    // the matrix collapse in hydrate.ts hides this available lane is a
    // rendering question on the S30 owner card, not a policy change here.
    expect(policy.sources.cpcSeasonalTemp.state).toBe('available');
    expect(policy.sources.pointHeat.state).toBe('available');
  });

  test('a place with its own containing.state (OR) reads the place, not the national camera: synthesis stays enabled', () => {
    const policy = briefingSourcePolicy(
      context({
        containing: { state: 'OR', basis: 'point-in-polygon' },
        regionKey: 'national'
      })
    );
    // The other direction of DR-090: a validated PNW place is not disabled
    // by a camera that happens to sit over the conus family.
    expect(policy.geography.basis).toBe('boundary-postal-code');
    expect(policy.geography.postalCode).toBe('OR');
    expect(policy.droughtImpact.enabled).toBe(true);
  });
});
