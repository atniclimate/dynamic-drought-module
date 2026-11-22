// Page-free tests moved from e1-calm.spec.ts: they never open a page, so they run in the pure lane.
import { test, expect } from './offline-test';

import { getLayerDef, DEFAULT_ON_KEYS } from '../src/config/layers';

test.describe('E1 deliverable 4: hillshade default-on (D-0.7.0-043 part 3)', () => {
  test('the config flag is on (node-level pin)', () => {
    expect(getLayerDef('hillshade')?.defaultOn).toBe(true);
    expect(DEFAULT_ON_KEYS.has('hillshade')).toBe(true);
  });
});

test.describe('E1 hard fence: the sovereign default set never narrows', () => {
  test('the two present-day Tribal-geography layers stay default-on', () => {
    // A stewardship decision (D-0.7.0-032/033, narrowed only by
    // D-0.7.0-038): E1 tunes paint and order, never membership.
    expect(getLayerDef('aiannh')?.defaultOn).toBe(true);
    expect(getLayerDef('bia-reservations')?.defaultOn).toBe(true);
    expect(getLayerDef('nadm-drought')?.defaultOn).toBe(true);
    expect(getLayerDef('usdm')?.defaultOn).toBe(false);
    expect(getLayerDef('states')?.defaultOn).toBe(true);
  });
});
