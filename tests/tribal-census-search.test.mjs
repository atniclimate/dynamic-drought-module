/**
 * The Census AIANNH areas in the names-only roster (search item I8): a
 * federally recognized Tribe with no AIAN-LAR land area (the Muscogee (Creek)
 * Nation, most Oklahoma Nations, most Alaska villages) is still findable by
 * search through its Census area. Pins the committed
 * public/data/tribal-roster.json `censusAreas` shape, the parenthetical-alias
 * match, the renaming-collision guard, and the prefix-first rank the search
 * view applies.
 *
 * Runs under `node --test`, importing the TypeScript source directly (node
 * strips types), same pattern as tests/chunk-retry.test.mjs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { prefixFirst } from '../src/util/search-fold.ts';

const roster = JSON.parse(
  readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8')
);
const crosswalk = JSON.parse(
  readFileSync(new URL('../public/data/tribal-larname-crosswalk.json', import.meta.url), 'utf8')
);
const census = roster.censusAreas;

test('censusAreas rows are well formed, unique and gated', () => {
  assert.ok(Array.isArray(census) && census.length > 0, 'censusAreas is a non-empty array');
  const codes = new Set();
  for (const a of census) {
    assert.match(a.aiannh, /^\d{4}$/, `AIANNH code for ${a.name}`);
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.displayName, 'string');
    assert.ok(['safe-match', 'census-label'].includes(a.provenance), `provenance for ${a.name}`);
    if (a.provenance === 'census-label') assert.equal(a.displayName, a.name);
    codes.add(a.aiannh);
  }
  assert.equal(codes.size, census.length, 'AIANNH codes are unique');
});

test('Creek OTSA carries the Muscogee (Creek) Nation by the parenthetical alias', () => {
  assert.deepEqual(
    census.find((a) => a.aiannh === '5620'),
    {
      aiannh: '5620',
      name: 'Creek OTSA',
      displayName: 'The Muscogee (Creek) Nation',
      provenance: 'safe-match'
    }
  );
});

test('ambiguous and renamed areas keep the Census label', () => {
  for (const name of ['Cherokee OTSA', 'Russian Mission ANVSA', 'Galena ANVSA']) {
    const row = census.find((a) => a.name === name);
    assert.ok(row, `${name} is present`);
    assert.equal(row.provenance, 'census-label', `${name} is not guessed`);
  }
});

test('Census reservation rows never duplicate a LAR-located Tribe', () => {
  const noLar = new Set(crosswalk.rosterNoLar);
  for (const a of census) {
    if (a.provenance !== 'safe-match' || noLar.has(a.displayName)) continue;
    assert.match(a.name, /(OTSA|TDSA|ANVSA)$/, `${a.name} duplicates a LAR-located Tribe`);
  }
});

test('prefixFirst puts labels that start with the query first, stably', () => {
  const items = [
    { label: 'Confederated Tribes of Oregon' },
    { label: 'Oregon' },
    { label: 'Burns Paiute Tribe, Oregon' },
    { label: 'Oregon City' }
  ];
  assert.deepEqual(
    prefixFirst(items, 'oregon').map((i) => i.label),
    ['Oregon', 'Oregon City', 'Confederated Tribes of Oregon', 'Burns Paiute Tribe, Oregon']
  );
  assert.deepEqual(prefixFirst(items, 'zzz').map((i) => i.label), items.map((i) => i.label));
});
