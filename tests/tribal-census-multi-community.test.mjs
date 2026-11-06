/**
 * A Nation whose formal name names several communities must not lend that
 * name to one community's Census area alone (ponytail round 4): the St. George
 * and Venetie ANVSAs keep their Census names, curated in KNOWN_AMBIGUOUS, in
 * the builder and in the committed public/data/tribal-roster.json.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { censusPass, parseRoster } from '../scripts/build-tribal-roster.mjs';

const PRIBILOF =
  'Pribilof Islands Aleut Communities of St. Paul & St. George Islands (St. George Island and Saint Paul Island)';
const VENETIE = 'Native Village of Venetie Tribal Government (Arctic Village and Village of Venetie)';
const feature = (NAME, BASENAME, AIANNH) => ({ attributes: { NAME, BASENAME, AIANNH, AIANNHCC: 'E1' } });

test('a single-community Census area never takes a multi-community Nation name', () => {
  const out = censusPass(
    [
      feature('St. George ANVSA', 'St. George', '7340'),
      feature('St. Paul ANVSA', 'St. Paul', '7390'),
      feature('Venetie ANVSA', 'Venetie', '7725')
    ],
    [PRIBILOF, VENETIE],
    new Set([PRIBILOF, VENETIE])
  );
  assert.deepEqual(
    out.censusAreas.map((a) => [a.aiannh, a.displayName, a.provenance]),
    [
      ['7340', 'St. George ANVSA', 'census-label'],
      ['7390', 'St. Paul ANVSA', 'census-label'],
      ['7725', 'Venetie ANVSA', 'census-label']
    ]
  );
  assert.deepEqual(
    out.censusAmbiguous.map((a) => [a.aiannh, a.candidates]),
    [
      ['7340', [PRIBILOF]],
      ['7390', [PRIBILOF]],
      ['7725', [VENETIE]]
    ]
  );
});

// The three "(See ...)" shapes in Federal Register 2026-01899, markup as published.
test('the roster drops cross-references and keeps a Nation whose See note names no entry', () => {
  const fp = (body) => `<FP SOURCE="FP-1">\n  ${body}\n</FP>`;
  const xml = [
    fp('Arctic Village (See Native Village of Venetie Tribal Government)'),
    fp(
      'Aleut Community of St. Paul Island (See Pribilof Islands Aleut Communities of St. Paul &amp; St. George Islands) (previously listed as Saint Paul Island (\n<E T="03">See</E>\n Pribilof Islands Aleut Communities of St. Paul &amp; St. George Islands))'
    ),
    fp(
      'Lumbee Tribe of North Carolina (See \n<E T="02">Supplementary Information</E>\n \n<E T="03">supra,</E>\n noting conditions on the Tribe\'s eligibility for Federal services)'
    ),
    fp(VENETIE),
    fp(PRIBILOF.replace('&', '&amp;'))
  ].join('\n');
  assert.deepEqual(parseRoster(xml), ['Lumbee Tribe of North Carolina', VENETIE, PRIBILOF]);
});

// R5-41: Federal Register 2026-01899 drops one space that its prior edition
// (2024-29005, 2024-12-11) prints; the roster restores it and nothing else.
test('the roster restores the space the 2026 notice drops from the Pulikla Tribe of Yurok People', () => {
  const PULIKLA = 'Pulikla Tribe of Yurok People (previously listed as Resighini Rancheria, California)';
  const xml = `<FP SOURCE="FP-1">${PULIKLA.replace('Pulikla Tribe', 'PuliklaTribe')}</FP>\n<FP SOURCE="FP-1">${PULIKLA}</FP>`;
  assert.deepEqual(parseRoster(xml), [PULIKLA, PULIKLA]);
  const committed = ['tribal-roster.json', 'tribal-larname-crosswalk.json']
    .map((file) => readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8'))
    .join('\n');
  assert.equal(committed.includes('PuliklaTribe'), false, 'the committed roster and crosswalk carry the space');
  assert.ok(committed.includes(PULIKLA));
});

test('the committed roster keeps the Census names for St. George, St. Paul and Venetie', () => {
  const roster = JSON.parse(readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8'));
  for (const code of ['7340', '7390', '7725']) {
    const row = roster.censusAreas.find((a) => a.aiannh === code);
    assert.equal(row.provenance, 'census-label');
    assert.equal(row.displayName, row.name);
  }
});
