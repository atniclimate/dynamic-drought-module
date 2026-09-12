import { expect, test } from '@playwright/test';

import {
  formatPlaceRef,
  parsePlaceRef,
  PLACE_SCHEMES,
  placeRefFromBoundary,
  placeRefFromTypedPlace,
  type PlaceRef
} from '../src/config/entities';
import { buildBoundaryContext } from '../src/impact/context';
import type { TypedPlaceRef } from '../src/state/typed-place';

/**
 * DDM-P2-T09: one canonical `scheme:code` place reference for every
 * selection door. Pure Node assertions (the s1-substrate pattern): no
 * fixture, no browser, no navigation.
 */

const LNG_LAT = { lng: -120.5, lat: 47.5 };

test.describe('formatPlaceRef / parsePlaceRef: round trip', () => {
  for (const scheme of PLACE_SCHEMES) {
    test(`${scheme}:CODE round-trips`, () => {
      const ref: PlaceRef = { scheme, code: 'CODE' };
      expect(parsePlaceRef(formatPlaceRef(ref))).toEqual(ref);
    });
  }

  test('an unknown scheme parses to null', () => {
    expect(parsePlaceRef('county:WA-053')).toBeNull();
  });

  test('an empty code parses to null', () => {
    expect(parsePlaceRef('state:')).toBeNull();
  });

  test('text with no colon parses to null', () => {
    expect(parsePlaceRef('WA')).toBeNull();
  });
});

test.describe('placeRefFromBoundary: one property read per kind', () => {
  test('state reads STUSPS', () => {
    expect(placeRefFromBoundary('state', { STUSPS: 'WA' })).toEqual({
      scheme: 'state',
      code: 'WA'
    });
  });

  test('bia-reservation reads a numeric LARID as its decimal string', () => {
    expect(placeRefFromBoundary('bia-reservation', { LARID: 4522 })).toEqual({
      scheme: 'bia',
      code: '4522'
    });
  });

  test('aiannh reads AIANNHNS', () => {
    expect(placeRefFromBoundary('aiannh', { AIANNHNS: '01234567' })).toEqual({
      scheme: 'aiannh',
      code: '01234567'
    });
  });

  test('ecoregion reads US_L4CODE at Level IV', () => {
    expect(
      placeRefFromBoundary('ecoregion', { US_L4CODE: '9.4.1a', US_L3CODE: '9.4.1' })
    ).toEqual({ scheme: 'ecoregion', code: '9.4.1a' });
  });

  test('ecoregion falls back to US_L3CODE at Level III (no US_L4CODE)', () => {
    expect(placeRefFromBoundary('ecoregion', { US_L3CODE: '9.4.1' })).toEqual({
      scheme: 'ecoregion',
      code: '9.4.1'
    });
  });

  test('watershed reads the HUC property', () => {
    expect(placeRefFromBoundary('watershed', { huc4: '1701' })).toEqual({
      scheme: 'watershed',
      code: '1701'
    });
    expect(placeRefFromBoundary('watershed', { huc2: '17' })).toEqual({
      scheme: 'watershed',
      code: '17'
    });
  });

  test('tribal has no stable polygon code and returns null', () => {
    expect(placeRefFromBoundary('tribal', { LARNAME: 'Example Nation' })).toBeNull();
  });

  test('treaty has no stable polygon code and returns null', () => {
    expect(placeRefFromBoundary('treaty', { name: 'Example Treaty' })).toBeNull();
  });

  test('null properties return null for every kind', () => {
    expect(placeRefFromBoundary('state', null)).toBeNull();
    expect(placeRefFromBoundary('bia-reservation', null)).toBeNull();
    expect(placeRefFromBoundary('aiannh', null)).toBeNull();
    expect(placeRefFromBoundary('ecoregion', null)).toBeNull();
    expect(placeRefFromBoundary('watershed', null)).toBeNull();
  });

  test('a missing code property returns null', () => {
    expect(placeRefFromBoundary('state', { NAME: 'Washington' })).toBeNull();
  });
});

test.describe('placeRefFromTypedPlace: agrees with placeRefFromBoundary for the same code', () => {
  test('state', () => {
    const typed: TypedPlaceRef = { kind: 'state', id: 'WA', label: 'Washington' };
    expect(placeRefFromTypedPlace(typed)).toEqual(placeRefFromBoundary('state', { STUSPS: 'WA' }));
  });

  test('ecoregion', () => {
    const typed: TypedPlaceRef = { kind: 'ecoregion', id: '9.4.1', label: 'Example ecoregion' };
    expect(placeRefFromTypedPlace(typed)).toEqual(
      placeRefFromBoundary('ecoregion', { US_L3CODE: '9.4.1' })
    );
  });

  test('watershed', () => {
    const typed: TypedPlaceRef = { kind: 'watershed', id: '1701', label: 'Example watershed (HUC 1701)' };
    expect(placeRefFromTypedPlace(typed)).toEqual(
      placeRefFromBoundary('watershed', { huc4: '1701' })
    );
  });

  test('tribe is DDM-P2-T10\'s reference, not this one, and returns null', () => {
    const typed: TypedPlaceRef = { kind: 'tribe', id: '1234', label: 'Example Tribal Nation' };
    expect(placeRefFromTypedPlace(typed)).toBeNull();
  });
});

test.describe('buildBoundaryContext: context.place equals placeRefFromBoundary of the same inputs', () => {
  test('state', () => {
    const properties = { STUSPS: 'WA', NAME: 'Washington' };
    const context = buildBoundaryContext('state', properties, null, LNG_LAT);
    expect(context.place).toEqual(placeRefFromBoundary('state', properties));
  });

  test('bia-reservation', () => {
    const properties = { LARID: 4522, LARNAME: 'Example Reservation' };
    const context = buildBoundaryContext('bia-reservation', properties, null, LNG_LAT);
    expect(context.place).toEqual(placeRefFromBoundary('bia-reservation', properties));
  });

  test('aiannh', () => {
    const properties = { AIANNHNS: '01234567', NAME: 'Example Area' };
    const context = buildBoundaryContext('aiannh', properties, null, LNG_LAT);
    expect(context.place).toEqual(placeRefFromBoundary('aiannh', properties));
  });

  test('ecoregion', () => {
    const properties = { US_L4CODE: '9.4.1a', US_L3CODE: '9.4.1', US_L4NAME: 'Example ecoregion' };
    const context = buildBoundaryContext('ecoregion', properties, null, LNG_LAT);
    expect(context.place).toEqual(placeRefFromBoundary('ecoregion', properties));
  });
});
