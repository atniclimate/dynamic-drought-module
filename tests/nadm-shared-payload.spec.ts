import { expect, test } from '@playwright/test';

import { validateNadmSnapshot } from '../src/layers/nadm-drought';
import { deriveMinimapDroughtSnapshot } from '../src/state/minimap-drought';
import {
  NadmCollectionError,
  validateNadmCollection
} from '../src/util/nadm-collection';

/**
 * The focused NADM validator agreement (DR-052 follow-up, 2026-09-03).
 *
 * The map layer and the drought minimap share ONE transport through the
 * `'nadm-current'` key, and each may evict the fulfilled entry when it
 * rejects the payload. Before 2026-09-03 they validated separately and
 * disagreed at the edges (an empty collection: `no-data` to the layer, a
 * thrown eviction to the minimap), so a payload one had accepted was thrown
 * away by the other and fetched again. The rule now: both read the payload
 * through `validateNadmCollection`, and the eviction rule on both sides is
 * "that function threw". This spec pins the verdict and both consumers'
 * readings of it, case by case, with no browser.
 */

const RING = [
  [-120, 48],
  [-118, 48],
  [-118, 50],
  [-120, 50],
  [-120, 48]
];

function feature(
  droughtClass: string,
  month: string,
  geometry: unknown = { type: 'Polygon', coordinates: [RING] }
) {
  return {
    type: 'Feature',
    properties: { DROUGHTCAT: droughtClass, YEAR_MONTH: month },
    geometry
  };
}

function collection(features: readonly unknown[]) {
  return { type: 'FeatureCollection', features };
}

/**
 * The minimap's sibling inputs, well-formed. The land base spans the whole
 * continent as one country so every authored framing the summarizer
 * samples (Hawaii included) finds land under it; this spec is about the
 * shared payload, not about the summaries.
 */
const CONTINENT = [
  [-180, 5],
  [-50, 5],
  [-50, 85],
  [-180, 85],
  [-180, 5]
];
const LAND = collection(
  ['US', 'CA', 'MX'].map((country) => ({
    type: 'Feature',
    properties: { FIPS_CNTRY: country },
    geometry: { type: 'Polygon', coordinates: [CONTINENT] }
  }))
);
const EXCLUSIONS = collection([
  {
    type: 'Feature',
    properties: { PRUID: '62' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-100, 68],
          [-90, 68],
          [-90, 75],
          [-100, 75],
          [-100, 68]
        ]
      ]
    }
  }
]);

const VALID = collection([feature('d2', '202607'), feature('D0', '202607')]);
const EMPTY = collection([]);

const MALFORMED: ReadonlyArray<readonly [string, unknown, RegExp]> = [
  ['not a collection', { type: 'Feature' }, /not a FeatureCollection/],
  ['features not an array', { type: 'FeatureCollection', features: null }, /not a FeatureCollection/],
  ['a non-Feature member', collection([{ type: 'Polygon' }]), /malformed polygon feature/],
  ['a feature without properties', collection([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [RING] } }]), /malformed polygon feature/],
  ['a point geometry', collection([feature('d1', '202607', { type: 'Point', coordinates: [-119, 49] })]), /malformed polygon feature/],
  ['an open ring', collection([feature('d1', '202607', { type: 'Polygon', coordinates: [[[-120, 50]]] })]), /malformed polygon feature/],
  ['an unknown class', collection([feature('d9', '202607')]), /DROUGHTCAT is invalid/],
  ['an invalid month', collection([feature('d1', '2026-07')]), /YEAR_MONTH is invalid/],
  ['mixed months', collection([feature('d1', '202607'), feature('d2', '202606')]), /mixes consensus months/]
];

test('the shared verdict accepts a well-formed single-month collection and normalizes it', () => {
  const verdict = validateNadmCollection(VALID);
  expect(verdict.kind).toBe('ok');
  if (verdict.kind !== 'ok') return;
  expect(verdict.month).toBe('2026-07');
  expect(verdict.features.map((f) => f.code)).toEqual(['D2', 'D0']);
});

test('the shared verdict reads an empty collection as empty, not as malformed', () => {
  expect(validateNadmCollection(EMPTY)).toEqual({ kind: 'empty' });
});

for (const [name, payload, message] of MALFORMED) {
  test(`the shared verdict throws a NadmCollectionError for ${name}`, () => {
    expect(() => validateNadmCollection(payload)).toThrow(NadmCollectionError);
    expect(() => validateNadmCollection(payload)).toThrow(message);
  });
}

test('the layer keeps what the verdict accepts: a snapshot for ok, null (no-data) for empty', () => {
  expect(validateNadmSnapshot(VALID)).toEqual({ month: '2026-07', collection: VALID });
  expect(validateNadmSnapshot(EMPTY)).toBeNull();
});

test('the minimap keeps what the verdict accepts and refuses only what it refuses', () => {
  const live = deriveMinimapDroughtSnapshot(VALID, LAND, EXCLUSIONS);
  expect(live.status).toBe('live');
  expect(live.month).toBe('2026-07');
  // Empty is the one case the minimap cannot summarize; it throws for
  // derive's callers, and load() screens it out BEFORE derive so the shared
  // entry is never evicted for it (the layer holds it as no-data).
  expect(() => deriveMinimapDroughtSnapshot(EMPTY, LAND, EXCLUSIONS)).toThrow(
    /no classified features/
  );
});

for (const [name, payload] of MALFORMED) {
  test(`both consumers refuse ${name}, with the same error class`, () => {
    expect(() => validateNadmSnapshot(payload)).toThrow(NadmCollectionError);
    expect(() => deriveMinimapDroughtSnapshot(payload, LAND, EXCLUSIONS)).toThrow(
      NadmCollectionError
    );
  });
}

test('a sibling input the minimap rejects is not a NadmCollectionError, so it cannot evict the shared entry', () => {
  // The minimap's load() evicts 'nadm-current' only when the shared payload
  // fails the verdict; a malformed land base fails derive with an ordinary
  // Error, which the catch does not treat as grounds for eviction.
  let caught: unknown = null;
  try {
    deriveMinimapDroughtSnapshot(VALID, { type: 'nope' }, EXCLUSIONS);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(NadmCollectionError);
});
