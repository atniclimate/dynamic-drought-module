import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Truth counts (2026-11-13). A floor ("at least 540 areas") or a shape check
 * cannot see what is missing: 126 unnamed Tribal areas passed one. Each count
 * here is an equation against an outside list, kept in the roster files when
 * they are built from the live sources (scripts/build-tribal-roster.mjs):
 * every item is handled or on a named list with its reason, and the parts add
 * up to the outside total. A red prints the Nations or areas that break it.
 *
 * The first run found two gaps no test had seen: 81 of 573 Nations had no
 * search row under their own name (54 of them named on the map; the search
 * reached 22 only under a Census title or another Nation's row, 59 not at
 * all), and 32 labelled areas had a click titled with the Census name
 * (Cherokee OTSA among them). Rule 11 of the build closed both: 546 Nations
 * now have a row under their own name and the 27 others are listed below.
 * Names here are public Federal Register and Census names.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const { censusSearchRows, censusUnlabelled, labelName } = await import('../scripts/build-tribal-roster.mjs');
const context = await import('../src/impact/context.ts');
const { TRUSTED_PROVENANCE } = await import('../src/state/tribal-roster.ts');

const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8'));
const ROSTER = read('tribal-roster.json');
const CROSSWALK = read('tribal-larname-crosswalk.json');
const trusted = (row) => TRUSTED_PROVENANCE.has(row.provenance ?? '');
/** The first ten of a list, for a red a person can read. */
const some = (list) => `${list.length}: ${list.slice(0, 10).join(' | ')}`;

test('count 1: every federal Census Tribal area is labelled, held for a Nation, or named by no source, and they add up', () => {
  const labelled = Object.keys(ROSTER.labelAreas);
  const unlabelled = CROSSWALK.censusUnlabelled;
  const held = unlabelled.filter((row) => row.nation);
  const noNation = unlabelled.filter((row) => !row.nation);
  assert.equal(ROSTER.meta.censusFederalCount, 578, 'the Census federal total moved: rebuild read a different list, look at what changed');
  assert.equal(
    labelled.length + held.length + noNation.length,
    ROSTER.meta.censusFederalCount,
    `${labelled.length} labelled + ${held.length} held + ${noNation.length} no source names`
  );
  const both = unlabelled.filter((row) => ROSTER.labelAreas[row.aiannh]).map((row) => row.name);
  assert.deepEqual(both, [], `on an unlabelled list and labelled, ${some(both)}`);
  assert.equal(new Set(unlabelled.map((row) => row.aiannh)).size, unlabelled.length, 'an unlabelled area is listed once');
  // The two lists only shrink: a new unlabelled area is a finding, never a quiet addition.
  assert.ok(held.length <= 29, `held areas grew, ${some(held.map((row) => row.name))}`);
  assert.deepEqual(noNation.map((row) => row.name), ['Canyon Village ANVSA', 'Lake Minchumina ANVSA', 'Port Alsworth ANVSA', 'Uyak ANVSA']);
  const nations = new Set([...CROSSWALK.rosterNoLar, ...CROSSWALK.matched.map((row) => row.tribe)]);
  for (const row of held) assert.ok(nations.has(row.nation), `${row.name}: held for a name the roster does not carry`);
});

// Federal Register Nations a search cannot find: no trusted BIA row, no trusted
// Census row. Each is here for one of two reasons, and the list only shrinks.
const NO_SEARCH_ROW = [
  // Its communities each have a Census area held until the form of a band's or place's label is settled (count 1).
  'Native Village of Venetie Tribal Government (Arctic Village and Village of Venetie)',
  'Pribilof Islands Aleut Communities of St. Paul & St. George Islands (St. George Island and Saint Paul Island)',
  // Neither public source the map reads (BIA AIAN-LAR, Census AIANNH) names an area for the Nation alone.
  'Alabama-Quassarte Tribal Town',
  'California Valley Miwok Tribe, California',
  'Central Council of the Tlingit & Haida Indian Tribes',
  'Delaware Tribe of Indians',
  'Inupiat Community of the Arctic Slope',
  'Kaguyak Village',
  'Kialegee Tribal Town',
  'King Island Native Community',
  'Koi Nation of Northern California',
  'Little Shell Tribe of Chippewa Indians of Montana',
  'Lumbee Tribe of North Carolina',
  'Monacan Indian Nation',
  'Nansemond Indian Nation',
  'Native Village of Afognak',
  'Native Village of Kanatak',
  'Native Village of Unga',
  'Pamunkey Indian Tribe',
  'Pauloff Harbor Village',
  'San Juan Southern Paiute Tribe of Arizona',
  'Shinnecock Indian Nation',
  'Tejon Indian Tribe',
  'Thlopthlocco Tribal Town',
  'Umkumiut Native Village',
  'United Keetoowah Band of Cherokee Indians in Oklahoma',
  'Upper Mattaponi Tribe'
];

test('count 2: every Nation on the Federal Register list is found by search, or is on the named list of those no area names', () => {
  // The whole list, from the audit file: Nations the BIA matcher located and those it did not (rule 10 rows repeat a name in label form).
  const federalRegister = new Set([
    ...CROSSWALK.rosterNoLar,
    ...CROSSWALK.matched.filter((row) => !row.rule.includes('rule 10')).map((row) => row.tribe)
  ]);
  assert.equal(federalRegister.size, ROSTER.meta.rosterCount, 'the audit file carries the whole Federal Register list');
  assert.equal(ROSTER.meta.rosterCount, 573, 'the Federal Register list moved: a new notice, look at what changed');
  const found = new Set([
    ...ROSTER.areas.filter(trusted).map((row) => labelName(row.displayName)),
    ...ROSTER.censusAreas.filter(trusted).map((row) => labelName(row.displayName))
  ]);
  const missing = [...federalRegister].filter((name) => !found.has(labelName(name))).sort();
  const unexplained = missing.filter((name) => !NO_SEARCH_ROW.includes(name));
  assert.deepEqual(unexplained, [], `a search cannot find, ${some(unexplained)}`);
  const stale = NO_SEARCH_ROW.filter((name) => !missing.includes(name));
  assert.deepEqual(stale, [], `now found by search, take off the list, ${some(stale)}`);
  assert.equal(federalRegister.size - missing.length + NO_SEARCH_ROW.length, 573, 'found + named exceptions = the list');
  // A Nation the map names is never one a search cannot find.
  const labelled = new Set(Object.values(ROSTER.labelAreas).flat());
  const namedNotFound = missing.filter((name) => labelled.has(labelName(name)));
  assert.deepEqual(namedNotFound, [], `named on the map, not found by search, ${some(namedNotFound)}`);
});

test('count 3: every BIA land area is titled with a Nation or is on the audit list of BIA labels, and the list only shrinks', () => {
  const nation = ROSTER.areas.filter(trusted);
  const biaLabel = ROSTER.areas.filter((row) => !trusted(row)).map((row) => row.larName).sort();
  assert.equal(nation.length + biaLabel.length, ROSTER.meta.landAreaCount, `${nation.length} Nation-titled + ${biaLabel.length} on the BIA label`);
  assert.deepEqual(biaLabel, [...CROSSWALK.larLabel].sort(), 'the audit list names exactly the areas on a BIA label');
  assert.ok(biaLabel.length <= 48, `BIA-label areas grew, ${some(biaLabel)}`);
  for (const row of ROSTER.areas) if (!trusted(row)) assert.equal(row.displayName, row.larName, `${row.larName}: a BIA label is the area's own name`);
});

test('count 4: a click on a labelled Census area is titled with the Nations its map label names, and each search row names one of them', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(ROSTER), { headers: { 'content-type': 'application/json' } });
  try {
    await context.loadCensusNationNames();
  } finally {
    globalThis.fetch = original;
  }
  const censusName = new Map(ROSTER.censusAreas.map((row) => [row.aiannh, row.name]));
  const differs = [];
  for (const [code, nations] of Object.entries(ROSTER.labelAreas)) {
    const title = context.resolveBoundaryTitle('aiannh', { AIANNH: code, NAME: censusName.get(code) ?? 'Stand-in area' });
    // The title keeps a "(previously listed as ...)" note the label drops; nothing else may differ.
    if (title.split('; ').map(labelName).join('; ') !== nations.join('; ')) differs.push(`${code} "${title}"`);
  }
  assert.deepEqual(differs, [], `of ${Object.keys(ROSTER.labelAreas).length} labelled areas, the click title differs on ${some(differs)}`);
  const strays = ROSTER.censusAreas
    .filter((row) => trusted(row) && !(ROSTER.labelAreas[row.aiannh] ?? []).includes(labelName(row.displayName)))
    .map((row) => `${row.name}: ${row.displayName}`);
  assert.deepEqual(strays, [], `a search row names a Nation its area's label does not, ${some(strays)}`);
  // An area with no label keeps its Census name.
  for (const row of CROSSWALK.censusUnlabelled) {
    assert.equal(context.resolveBoundaryTitle('aiannh', { AIANNH: row.aiannh, NAME: row.name }), row.name);
  }
});

test('the rules behind the counts: label-map search rows, and an unlabelled area on no list fails the build', () => {
  const roster = ['Kiowa Tribe (previously listed as Kiowa Indian Tribe of Oklahoma)', 'Comanche Nation, Oklahoma', 'Cherokee Nation', 'Kialegee Tribal Town'];
  const feature = (NAME, AIANNH, AIANNHCC) => ({ attributes: { NAME, BASENAME: NAME, AIANNH, AIANNHCC } });
  const features = [feature('Shared OTSA', '9001', 'D6'), feature('Cherokee OTSA', '9002', 'D6'), feature('Kialegee Reservation', '9003', 'D1'),
    feature('Open ANVSA', '9004', 'E1'), feature('State Reservation', '9005', 'D4')];
  const labels = { 9001: ['Kiowa Tribe', 'Comanche Nation, Oklahoma'], 9002: ['Cherokee Nation'], 9003: ['Kialegee Tribal Town'] };
  const matcherRows = ['9001', '9002', '9004'].map((aiannh) => {
    const name = features.find((f) => f.attributes.AIANNH === aiannh).attributes.NAME;
    return { aiannh, name, displayName: name, provenance: 'census-label' };
  });
  const rows = censusSearchRows(matcherRows, features, roster, labels, new Set(['Kialegee Tribal Town']));
  assert.deepEqual(rows.map((row) => `${row.aiannh} ${row.displayName} ${row.provenance}`), [
    '9002 Cherokee Nation safe-match',
    '9001 Comanche Nation, Oklahoma safe-match',
    '9001 Kiowa Tribe (previously listed as Kiowa Indian Tribe of Oklahoma) safe-match',
    '9004 Open ANVSA census-label',
    '9001 Shared OTSA census-label'
  ], 'one Nation takes the row; a shared area keeps its own row and gains one per Nation; a Nation a BIA row finds gains none');
  assert.equal(rows.find((row) => row.displayName === 'Comanche Nation, Oklahoma').name, 'Shared OTSA');

  assert.deepEqual(censusUnlabelled(features, roster, labels, [], ['9004']), {
    federalCount: 4,
    rows: [{ aiannh: '9004', name: 'Open ANVSA', nation: null }]
  });
  assert.deepEqual(censusUnlabelled(features, roster, labels, [['9004', 'Cherokee Nation']], []).rows, [
    { aiannh: '9004', name: 'Open ANVSA', nation: 'Cherokee Nation' }
  ]);
  assert.throws(() => censusUnlabelled(features, roster, labels, [], []), /9004 \(Open ANVSA\) carries no Nation's name and is on neither unlabelled list/);
  assert.throws(() => censusUnlabelled(features, roster, labels, [['9002', 'Cherokee Nation']], ['9004']), /row 9002 is REOPENED/);
  assert.throws(() => censusUnlabelled(features, roster, labels, [['9004', 'A Name Not Listed']], []), /is not a name in the Federal Register roster/);
});
