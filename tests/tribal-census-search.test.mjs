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

import { enterChoice, foldSearchText, matchesTokens, prefixFirst } from '../src/util/search-fold.ts';

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

// Builder-level collision fixtures: the Census matcher itself, not only the
// committed output. Stand-in features; the roster names are public Federal
// Register names.
const fixtureRoster = [
  'San Juan Southern Paiute Tribe of Arizona',
  'Ohkay Owingeh, New Mexico (previously listed as Pueblo of San Juan)',
  'The Muscogee (Creek) Nation',
  'Poarch Band of Creek Indians',
  'Kialegee Tribal Town',
  'Cherokee Nation',
  'Eastern Band of Cherokee Indians',
  'Mechoopda Indian Tribe of Chico Rancheria, California'
];
const feature = (NAME, BASENAME, AIANNH, AIANNHCC) => ({
  attributes: { NAME, BASENAME, AIANNH, AIANNHCC }
});

test('the Census matcher honours the known-ambiguous gate and records its rules', async () => {
  const { censusPass } = await import('../scripts/build-tribal-roster.mjs');
  const out = censusPass(
    [
      feature('San Juan OTSA', 'San Juan', '9001', 'D6'),
      feature('Creek OTSA', 'Creek', '5620', 'D6'),
      feature('Cherokee OTSA', 'Cherokee', '5550', 'D6'),
      feature('Mechoopda TDSA', 'Mechoopda', '9002', 'D6'),
      feature('Mechoopda Reservation', 'Mechoopda', '9003', 'D1'),
      feature('Kialegee Reservation', 'Kialegee', '9004', 'D1'),
      feature('Nowhere Reservation', 'Nowhere', '9005', 'D1'),
      feature('Some State Reservation', 'Kialegee', '9006', 'D4')
    ],
    fixtureRoster,
    new Set(['Kialegee Tribal Town', 'San Juan Southern Paiute Tribe of Arizona'])
  );
  const byCode = new Map(out.censusAreas.map((a) => [a.aiannh, a]));
  // San Juan: one surface candidate, but the curated historical-name collision keeps the Census label.
  assert.equal(byCode.get('9001').provenance, 'census-label');
  assert.equal(byCode.get('9001').displayName, 'San Juan OTSA');
  assert.deepEqual(
    out.censusAmbiguous.find((a) => a.aiannh === '9001').candidates,
    ['San Juan Southern Paiute Tribe of Arizona', 'Ohkay Owingeh, New Mexico (previously listed as Pueblo of San Juan)']
  );
  assert.equal(byCode.get('5620').displayName, 'The Muscogee (Creek) Nation');
  assert.equal(out.censusMatched.find((m) => m.aiannh === '5620').rule, 'unique-parenthetical-alias');
  assert.equal(byCode.get('5550').provenance, 'census-label', 'two Cherokee Nations: no guess');
  // Statistical areas always ship; a legal area ships only for a Tribe LAR does not locate.
  assert.equal(byCode.get('9002').displayName, 'Mechoopda Indian Tribe of Chico Rancheria, California');
  assert.ok(!byCode.has('9003'), 'reservation of a LAR-located Tribe is not duplicated');
  assert.equal(byCode.get('9004').displayName, 'Kialegee Tribal Town');
  assert.equal(out.censusMatched.find((m) => m.aiannh === '9004').rule, 'unique-containment');
  assert.ok(!byCode.has('9005'), 'an unmatched legal area is not shipped');
  assert.ok(!byCode.has('9006'), 'a state class never carries a federal Tribe name');
});

test('roster meta describes the Census matcher apart from the LAR matcher', () => {
  assert.match(roster.meta.censusMatcher, /known-ambiguous/);
  assert.doesNotMatch(roster.meta.censusMatcher, /state-constrained/);
  assert.doesNotMatch(roster._comment, /absent from AIAN-LAR/);
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

test('Enter picks an exact label over an earlier Tribal row that only starts with it', () => {
  // Rows in the search's group order: the Tribal group comes first.
  const rows = [
    { kind: 'tribal', label: 'Colorado River Indian Tribes of the Colorado River Indian Reservation, Arizona and California' },
    { kind: 'place', label: 'Colorado' },
    { kind: 'city', label: 'Colorado Springs' }
  ];
  assert.equal(enterChoice(rows, 'colorado')?.kind, 'place');
  assert.equal(enterChoice(rows, 'colorado r')?.kind, 'tribal');
  // No exact or prefix match: Enter opens nothing; the caller highlights the first row.
  assert.equal(enterChoice(rows, 'springs'), undefined);
  assert.equal(enterChoice([], 'colorado'), undefined);
});

test('Enter on a partly typed state skips an earlier Tribe whose name only contains it', () => {
  // The Tribal group renders first and roster names end in "of Oregon".
  const rows = [
    { kind: 'tribal', label: 'Confederated Tribes of Siletz Indians of Oregon' },
    { kind: 'tribal', label: 'Coquille Indian Tribe' },
    { kind: 'place', label: 'Oregon' }
  ];
  assert.equal(enterChoice(rows, 'oregon')?.kind, 'place');
  assert.equal(enterChoice(rows, 'oreg')?.kind, 'place');
});

test('Enter on a two-letter state code opens the state, not a Tribe whose name starts with it', () => {
  // A state row's id is its code; its haystack carries the code on purpose.
  const rows = [
    { kind: 'tribal', id: 'Cahto Tribe', label: 'Cahto Tribe' },
    { kind: 'place', id: 'CA', label: 'California' }
  ];
  assert.equal(enterChoice(rows, 'ca')?.kind, 'place');
  assert.equal(enterChoice(rows, 'cah')?.kind, 'tribal');
});

test('a formal Nation name finds its Census area, whose label keeps the Census name', () => {
  // The haystack search-controller builds for a census-label row: name plus the gated label.
  const row = census.find((a) => a.name === 'Cherokee OTSA');
  assert.equal(row.provenance, 'census-label');
  const haystack = foldSearchText(`${row.name} ${row.displayName}`);
  const tokens = (q) => foldSearchText(q).split(' ');
  assert.ok(matchesTokens(haystack, tokens('Cherokee Nation'), true));
  assert.ok(matchesTokens(haystack, tokens('Cherokee Nat'), true), 'no dead end while typing');
  assert.ok(!matchesTokens(haystack, tokens('Cherokee Nation'), false), 'only Tribal rows relax');
  assert.ok(!matchesTokens(haystack, tokens('Nation'), true), 'a generic word alone finds nothing new');
  assert.ok(!matchesTokens(haystack, tokens('Cherokee Creek'), true));
  // An OTSA's haystack carries "oklahoma" (search-controller loadTribal); "oklahoma" is never skipped.
  const seminole = census.find((a) => a.name === 'Seminole OTSA');
  assert.ok(matchesTokens(foldSearchText(`${seminole.name} oklahoma`), tokens('The Seminole Nation of Oklahoma'), true));
  assert.ok(!matchesTokens(foldSearchText(seminole.name), tokens('Seminole Oklahoma'), true));
  assert.ok(
    !matchesTokens(foldSearchText('Kickapoo Traditional (Texas) Kickapoo Traditional Tribe of Texas'), tokens('Kickapoo Tribe of Oklahoma'), true),
    'a same-named Nation in another state does not match'
  );
});

test('the search view relaxes only Census rows and Enter goes through enterChoice', () => {
  // The Oklahoma Nation cases run against the real loadTribal items in
  // search-failure-paths.test.mjs; this pins the two search.tsx lines that case mirrors.
  const searchSrc = readFileSync(new URL('../src/ui/island/search.tsx', import.meta.url), 'utf8');
  assert.match(searchSrc, /matchesTokens\(item\.haystack, tokens, item\.kind === 'tribal' && item\.id\.startsWith\('census:'\)\)/);
  // Not `activeRow ?? flatRows[0]`: that opened the Colorado River Indian Tribes on "Colorado".
  assert.match(searchSrc, /activeRow\?\.item \?\?\s*enterChoice\(/);
});
