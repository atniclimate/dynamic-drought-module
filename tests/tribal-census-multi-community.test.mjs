/**
 * A Nation whose formal name names several communities must not lend that
 * name to one community's Census area alone (ponytail round 4): the St. George
 * and Venetie ANVSAs keep their Census names, curated in KNOWN_AMBIGUOUS, in
 * the builder and in the committed public/data/tribal-roster.json.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { censusPass } from '../scripts/build-tribal-roster.mjs';

const PRIBILOF =
  'Pribilof Islands Aleut Communities of St. Paul & St. George Islands (St. George Island and Saint Paul Island)';
const VENETIE = 'Native Village of Venetie Tribal Government (Arctic Village and Village of Venetie)';
const feature = (NAME, BASENAME, AIANNH) => ({ attributes: { NAME, BASENAME, AIANNH, AIANNHCC: 'E1' } });

test('a single-community Census area never takes a multi-community Nation name', () => {
  const out = censusPass(
    [feature('St. George ANVSA', 'St. George', '7340'), feature('Venetie ANVSA', 'Venetie', '7725')],
    [PRIBILOF, VENETIE],
    new Set([PRIBILOF, VENETIE])
  );
  assert.deepEqual(
    out.censusAreas.map((a) => [a.aiannh, a.displayName, a.provenance]),
    [
      ['7340', 'St. George ANVSA', 'census-label'],
      ['7725', 'Venetie ANVSA', 'census-label']
    ]
  );
  assert.deepEqual(
    out.censusAmbiguous.map((a) => [a.aiannh, a.candidates]),
    [
      ['7340', [PRIBILOF]],
      ['7725', [VENETIE]]
    ]
  );
});

test('the committed roster keeps the Census names for St. George and Venetie', () => {
  const roster = JSON.parse(readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8'));
  for (const code of ['7340', '7725']) {
    const row = roster.censusAreas.find((a) => a.aiannh === code);
    assert.equal(row.provenance, 'census-label');
    assert.equal(row.displayName, row.name);
  }
});
