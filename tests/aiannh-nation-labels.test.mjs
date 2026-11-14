import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Tribal names on the Tribal Lands layer (owner, 2026-11-12: "reference the
 * Tribal land area to the Tribes' names (rather than the title like Creek
 * OSTA)"). Each federal Census AIANNH area is labelled with its Nation's
 * Federal Register name, from the roster's `labelAreas` (scripts/
 * build-tribal-roster.mjs), at one Census internal point per area
 * (src/layers/aiannh.ts). Pinned here: the zoom ladder, the dropped
 * "(previously listed as ...)" note, one Nation per line, the classes that
 * never carry a label, and the shipped label map. Stand-in features and codes;
 * the names are public Federal Register names.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const { areaLabelRows, censusLabelAreas, labelName, larNamesFromCensus } = await import('../scripts/build-tribal-roster.mjs');
const { fadeLayerIds, labelMinZoom, nationLabelPoints, nationTextField } = await import('../src/layers/aiannh.ts');
const { TOP_LABEL_IDS } = await import('../src/map/layer-order.ts');

const ROSTER = JSON.parse(readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8'));
const KM2 = 1e6;

test('the label ladder: by land area, a statistical area one step later', () => {
  const cases = [
    [6000 * KM2, 'D1', 5], [5000 * KM2, 'D2', 5], [4999 * KM2, 'D1', 6], [1000 * KM2, 'D3', 6],
    [999 * KM2, 'D1', 7], [200 * KM2, 'D2', 7], [199 * KM2, 'D1', 8], [50 * KM2, 'D1', 8],
    [49 * KM2, 'D1', 9], [0, 'D2', 9], [Number.NaN, 'D1', 9],
    [6000 * KM2, 'D6', 6], [1000 * KM2, 'E1', 7], [200 * KM2, 'D6', 8], [50 * KM2, 'E1', 9], [10 * KM2, 'E1', 10]
  ];
  for (const [area, cls, zoom] of cases) assert.equal(labelMinZoom(area, cls), zoom, `${area / KM2} km2, ${cls}`);
});

test('label text drops only the list\'s "(previously listed as ...)" note', () => {
  assert.equal(labelName('Kiowa Tribe (previously listed as Kiowa Indian Tribe of Oklahoma)'), 'Kiowa Tribe');
  assert.equal(labelName('Louden Tribe (previously listed as Galena Village (aka Louden Village))'), 'Louden Tribe');
  assert.equal(labelName('Ohkay Owingeh, New Mexico (previously listed as Pueblo of San Juan)'), 'Ohkay Owingeh, New Mexico');
  // A parenthetical that is part of the current name stays.
  assert.equal(labelName('The Muscogee (Creek) Nation'), 'The Muscogee (Creek) Nation');
  assert.equal(
    labelName('Wichita and Affiliated Tribes (Wichita, Keechi, Waco, & Tawakonie), Oklahoma'),
    'Wichita and Affiliated Tribes (Wichita, Keechi, Waco, & Tawakonie), Oklahoma'
  );
});

const area = (AIANNH, AIANNHCC, extra = {}) => ({
  type: 'Feature',
  properties: { NAME: 'Stand-in', AIANNH, AIANNHCC, AREALAND: '489295375', INTPTLAT: '+36.9097094', INTPTLON: '-112.6673019', ...extra },
  geometry: { type: 'Polygon', coordinates: [[[-113, 36], [-112, 36], [-112, 37], [-113, 36]]] }
});

test('one point per labelled area at the Census internal point, every Nation set apart', () => {
  const windRiver = [
    'Eastern Shoshone Tribe of the Wind River Reservation, Wyoming',
    'Northern Arapaho Tribe of the Wind River Reservation, Wyoming'
  ];
  const labels = new Map([['9010', windRiver], ['9011', ['The Muscogee (Creek) Nation']]]);
  const points = nationLabelPoints(
    { type: 'FeatureCollection', features: [area('9010', 'D1'), area('9011', 'D6', { AREALAND: 29e9 }), area('9012', 'D2')] },
    labels
  );
  assert.equal(points.features.length, 2, 'an area with no label map entry gets no point');
  const [first, second] = points.features;
  assert.deepEqual(first.geometry, { type: 'Point', coordinates: [-112.6673019, 36.9097094] });
  assert.equal(first.properties.text, windRiver.join('\n\n'), 'a blank line between Nations, never shortened');
  assert.equal(first.properties.minzoom, 7, 'the string AREALAND (489 km2) is parsed');
  assert.equal(second.properties.text, 'The Muscogee (Creek) Nation');
  assert.equal(second.properties.minzoom, 6, 'a statistical area of 29,000 km2 one step after zoom 5');
  assert.ok(first.properties.km2 > 0 && second.properties.km2 > first.properties.km2, 'the sort key reads land area');
  assert.equal(nationLabelPoints({ type: 'FeatureCollection', features: [area('9010', 'D1')] }, null).features.length, 0,
    'before the label map loads, no label');
});

test('a curated own-language name leads its Nation, a curated shorter name replaces its long one, and the click finds the area', () => {
  const warmSprings = 'Confederated Tribes of the Warm Springs Reservation of Oregon';
  const labels = new Map([['9010', ['Nez Perce Tribe', 'Kialegee Tribal Town']], ['9011', [warmSprings]]]);
  const curated = {
    own: new Map([['Nez Perce Tribe', 'Stand-in ə̓']]),
    short: new Map([[warmSprings, 'Stand-in Short Name']]),
    area: new Map()
  };
  const [shared, single] = nationLabelPoints(
    { type: 'FeatureCollection', features: [area('9010', 'D1', { NAME: 'Shared Area' }), area('9011', 'D1')] },
    labels,
    curated
  ).features.map((f) => f.properties);
  assert.equal(shared.text, 'Stand-in ə̓\nNez Perce Tribe\n\nKialegee Tribal Town');
  assert.deepEqual(
    [shared.own0, shared.en0, shared.own1, shared.en1],
    ['Stand-in ə̓', 'Nez Perce Tribe', undefined, 'Kialegee Tribal Town'],
    'a Nation with no curated row carries its Federal Register name alone, never a guess'
  );
  assert.equal(single.text, 'Stand-in Short Name', 'the label draws the shorter name; the briefing keeps the full one');
  assert.equal(single.en0, 'Stand-in Short Name');
  assert.deepEqual([shared.AIANNH, shared.NAME], ['9010', 'Shared Area'], 'a click on the name finds its area by code');
  // One slot per Nation: the own name in its face, then the Federal Register name; a blank line before a later Nation.
  const field = nationTextField(2);
  assert.equal(field[0], 'format');
  const flat = JSON.stringify(field);
  for (const key of ['own0', 'en0', 'own1', 'en1']) assert.ok(flat.includes(`"${key}"`), key);
  assert.ok(!flat.includes('"en2"'), 'no slot beyond the most Nations an area holds');
  assert.equal(flat.split('"DDM Nation Names"').length - 1, 2, 'the Nation-name face only on the own-language sections');
  assert.equal(JSON.stringify(nationTextField(1)).includes('\\n\\n'), false, 'one Nation, no separator');
});

test('an area label names one band, place or community of a Nation on its own area, and only where that area names one Nation', () => {
  const pitRiver = 'Pit River Tribe, California (includes XL Ranch, Big Bend, Likely, Lookout, Montgomery Creek, and Roaring Creek Rancherias)';
  const labels = new Map([['9010', [pitRiver]], ['9011', [pitRiver]], ['9012', ['Nez Perce Tribe', 'Kialegee Tribal Town']]]);
  const curated = {
    own: new Map(),
    short: new Map([[pitRiver, 'Stand-in Short Name']]),
    area: new Map([['9010', 'Big Bend Rancheria, Pit River Tribe'], ['9012', 'Stand-in Area Label']])
  };
  const [bigBend, sibling, shared] = nationLabelPoints(
    { type: 'FeatureCollection', features: [area('9010', 'D2'), area('9011', 'D2'), area('9012', 'D1')] },
    labels,
    curated
  ).features.map((f) => f.properties);
  assert.deepEqual([bigBend.text, bigBend.en0], ['Big Bend Rancheria, Pit River Tribe', 'Big Bend Rancheria, Pit River Tribe']);
  assert.equal(sibling.text, 'Stand-in Short Name', 'another area of the same Nation keeps the Nation\'s label');
  assert.equal(shared.text, 'Nez Perce Tribe\n\nKialegee Tribal Town', 'an area several Nations share names every Nation');
});

test('the shipped area labels: each area the label map names with its one Nation, sourced and dated, from shipped glyphs', () => {
  const { areaNames } = JSON.parse(readFileSync(new URL('../public/data/tribal-label-names.json', import.meta.url), 'utf8'));
  const ranges = readdirSync(new URL('../public/fonts/glyphs/Noto Sans Regular/', import.meta.url)).map((file) => file.replace('.pbf', '').split('-').map(Number));
  assert.ok(Array.isArray(areaNames) && areaNames.length > 0, 'the file carries areaNames');
  const seen = new Set();
  for (const row of areaNames) {
    assert.ok(!seen.has(row.aiannh), `${row.aiannh} has two areaName rows`);
    seen.add(row.aiannh);
    assert.deepEqual(ROSTER.labelAreas[row.aiannh], [row.nation], `${row.aiannh}: the label map names the area with its one Nation`);
    assert.ok(row.census && row.areaName && row.areaName === row.areaName.normalize('NFC') && row.areaName === row.areaName.trim(), row.aiannh);
    assert.match(row.page, /^https?:\/\/\S+$/, row.aiannh);
    assert.match(row.read, /^\d{4}-\d{2}-\d{2}$/, row.aiannh);
    assert.ok(row.premise.length > 20, `${row.aiannh}: why this form`);
    for (const char of row.areaName) {
      const cp = char.codePointAt(0);
      assert.ok(ranges.some(([lo, hi]) => cp >= lo && cp <= hi), `${row.aiannh}: U+${cp.toString(16).toUpperCase()} has no shipped glyph range`);
    }
  }
});

test('the shipped label names: labelled Nations once each, sourced and dated; a shorter name is shorter and draws from shipped glyphs', () => {
  const { ownNames, shortNames } = JSON.parse(readFileSync(new URL('../public/data/tribal-label-names.json', import.meta.url), 'utf8'));
  const labelled = new Set(Object.values(ROSTER.labelAreas).flat());
  // The glyph ranges the map's Noto Sans Regular files cover (public/fonts/glyphs); a shorter name draws from them.
  const ranges = readdirSync(new URL('../public/fonts/glyphs/Noto Sans Regular/', import.meta.url)).map((file) => file.replace('.pbf', '').split('-').map(Number));
  for (const [rows, field, why] of [[ownNames, 'ownName', 'premise'], [shortNames, 'shortName', 'basis']]) {
    const seen = new Set();
    for (const row of rows) {
      assert.ok(labelled.has(row.nation), `${row.nation} is not a name the Tribal Lands layer labels`);
      assert.ok(!seen.has(row.nation), `${row.nation} has two ${field} rows`);
      seen.add(row.nation);
      const name = row[field];
      assert.ok(name && name === name.normalize('NFC') && name === name.trim(), row.nation);
      assert.match(row.page, /^(https?:\/\/\S+|BIA Tribal Leaders Directory)$/, row.nation);
      assert.match(row.read, /^\d{4}-\d{2}-\d{2}$/, row.nation);
      assert.ok(row[why].length > 20, `${row.nation}: why this form`);
    }
  }
  for (const { nation, shortName } of shortNames) {
    assert.ok(shortName.length < nation.length, `${nation}: the shorter name is shorter`);
    for (const char of shortName) {
      const cp = char.codePointAt(0);
      assert.ok(ranges.some(([lo, hi]) => cp >= lo && cp <= hi), `${nation}: U+${cp.toString(16).toUpperCase()} has no shipped glyph range`);
    }
  }
});

test('joint-use, state and Hawaiian Home Land areas never carry a label', () => {
  const roster = [
    'Kialegee Tribal Town',
    'Mechoopda Indian Tribe of Chico Rancheria, California',
    'Kiowa Tribe (previously listed as Kiowa Indian Tribe of Oklahoma)'
  ];
  const feature = (NAME, BASENAME, AIANNH, AIANNHCC) => ({ attributes: { NAME, BASENAME, AIANNH, AIANNHCC } });
  const labels = censusLabelAreas(
    [
      feature('Kialegee Reservation', 'Kialegee', '9001', 'D1'),
      feature('Mechoopda Reservation', 'Mechoopda', '9002', 'D2'),
      feature('Kiowa OTSA', 'Kiowa', '9003', 'D6'),
      feature('Kialegee joint-use area', 'Kialegee', '9004', 'D0'),
      feature('Kialegee (state) Reservation', 'Kialegee', '9005', 'D4'),
      feature('Kialegee SDTSA', 'Kialegee', '9006', 'D9'),
      feature('Kialegee Hawaiian Home Land', 'Kialegee', '9007', 'F1')
    ],
    roster
  );
  assert.deepEqual(labels, {
    9001: ['Kialegee Tribal Town'],
    // A reservation is labelled whether or not AIAN-LAR also locates its Nation.
    9002: ['Mechoopda Indian Tribe of Chico Rancheria, California'],
    9003: ['Kiowa Tribe']
  });
  // The layer holds the same line if a label map ever names one of these classes.
  const all = new Map(['D0', 'D4', 'D9', 'F1'].map((cls, i) => [String(9100 + i), ['Kialegee Tribal Town']]));
  const points = nationLabelPoints(
    { type: 'FeatureCollection', features: ['D0', 'D4', 'D9', 'F1'].map((cls, i) => area(String(9100 + i), cls)) },
    all
  );
  assert.equal(points.features.length, 0);
});

test('a confirmed row names an area its Census name cannot settle, and reopens when its evidence moves', () => {
  const warmSprings = 'Confederated Tribes of the Warm Springs Reservation of Oregon';
  const roster = [
    warmSprings,
    'Fort Sill-Chiricahua-Warm Springs-Apache Tribe (previously listed as Fort Sill Apache Tribe of Oklahoma)',
    'Kiowa Tribe (previously listed as Kiowa Indian Tribe of Oklahoma)',
    'Kialegee Tribal Town'
  ];
  const feature = (BASENAME, AIANNH, AIANNHCC) => ({ attributes: { NAME: `${BASENAME} area`, BASENAME, AIANNH, AIANNHCC } });
  const features = [feature('Warm Springs', '9020', 'D1'), feature('Pine Ridge', '9021', 'D2'), feature('Kialegee', '9022', 'D1'),
    feature('Warm Springs', '9023', 'D4')];
  assert.deepEqual(censusLabelAreas(features, roster, []), { 9022: ['Kialegee Tribal Town'] }, 'two roster names hold "Warm Springs"');
  const rows = [
    ['9020', 'Warm Springs', [warmSprings]],
    // Several Nations in the order given, in label form; a row the matcher already answers the same way is harmless.
    ['9021', 'Pine Ridge', ['Kiowa Tribe', 'Kialegee Tribal Town']],
    ['9022', 'Kialegee', ['Kialegee Tribal Town']],
    // A state area and an area the Census no longer publishes never take a row.
    ['9023', 'Warm Springs', [warmSprings]],
    ['9099', 'Gone', [warmSprings]]
  ];
  assert.deepEqual(censusLabelAreas(features, roster, rows), {
    9020: [warmSprings],
    9021: ['Kiowa Tribe', 'Kialegee Tribal Town'],
    9022: ['Kialegee Tribal Town']
  });
  const reopened = (row, why) => assert.throws(() => censusLabelAreas(features, roster, [row]), why);
  reopened(['9020', 'Warm Spring', [warmSprings]], /REOPENED: the Census now names the area "Warm Springs"/);
  reopened(['9020', 'Warm Springs', ['Kiowa Indian Tribe of Oklahoma']], /is not a name in the Federal Register roster/);
  reopened(['9022', 'Kialegee', ['Kiowa Tribe']], /the name matcher now answers "Kialegee Tribal Town"/);
  // An area label row (tribal-label-names.json areaNames) pins its area to its Nation the same way.
  const areaRow = { aiannh: '9021', census: 'Pine Ridge', nation: 'Kialegee Tribal Town', areaName: 'Stand-in Area Label' };
  assert.deepEqual(censusLabelAreas(features, roster, areaLabelRows({ areaNames: [areaRow] }))['9021'], ['Kialegee Tribal Town']);
  assert.throws(() => censusLabelAreas(features, roster, areaLabelRows({ areaNames: [{ ...areaRow, census: 'Renamed' }] })), /REOPENED/);
  assert.deepEqual(areaLabelRows({}), [], 'a file with no areaNames pins nothing');
});

test('a BIA land area on its BIA label takes the one Nation of its one same-name Census reservation, never a statistical area', () => {
  const feature = (BASENAME, AIANNH, AIANNHCC) => ({ attributes: { BASENAME, AIANNH, AIANNHCC } });
  const features = [
    feature('Warm Springs', '9020', 'D1'),
    feature('Choctaw', '9021', 'D6'),
    feature('Santa Rosa', '9022', 'D2'),
    feature('Santa Rosa', '9023', 'D2'),
    feature('Unlabelled', '9024', 'D1'),
    feature('Wind River', '9025', 'D1')
  ];
  const labels = { 9020: ['Warm Springs Nation'], 9021: ['Choctaw Nation'], 9022: ['A'], 9023: ['B'], 9025: ['East', 'North'] };
  const named = larNamesFromCensus(['Warm Springs', 'Choctaw', 'Santa Rosa', 'Unlabelled', 'Wind River', 'Elsewhere'], features, labels);
  // An area two Nations share keeps its BIA label: the place catalog would list a joined name as a Nation.
  assert.deepEqual(Object.fromEntries(named), { 'Warm Springs': 'Warm Springs Nation' });
  const shipped = Object.fromEntries(ROSTER.areas.map((a) => [a.larName, a]));
  assert.equal(shipped['Warm Springs'].displayName, 'Confederated Tribes of the Warm Springs Reservation of Oregon');
  assert.equal(shipped['Warm Springs'].provenance, 'safe-match');
  for (const open of ['Choctaw', 'Iowa', 'Santa Rosa', 'Wind River', 'Celilo']) assert.equal(shipped[open].provenance, 'lar-label', open);
});

test('the shipped roster labels Creek OTSA, Warm Springs and both Nations of Wind River (the count is tests/truth-counts.test.mjs)', () => {
  const labels = ROSTER.labelAreas;
  assert.ok(labels && typeof labels === 'object', 'the roster carries labelAreas');
  const creek = ROSTER.censusAreas.find((a) => a.name === 'Creek OTSA');
  assert.deepEqual(labels[creek.aiannh], ['The Muscogee (Creek) Nation']);
  assert.deepEqual(labels['4545'], ['Confederated Tribes of the Warm Springs Reservation of Oregon']);
  assert.deepEqual(labels['4610'], [
    'Eastern Shoshone Tribe of the Wind River Reservation, Wyoming',
    'Northern Arapaho Tribe of the Wind River Reservation, Wyoming'
  ]);
  // A band or place one Nation's Federal Register name lists among several is labelled by its own area label
  // (tribal-label-names.json areaNames) and named by its Nation in the label map; the Te-Moak bands wait for the owner.
  for (const held of ['0165', '1005', '3930', '4580']) assert.equal(labels[held], undefined, held);
  assert.deepEqual(labels['4595'], ['Minnesota Chippewa Tribe, Minnesota (Six component reservations: Bois Forte Band (Nett Lake); ' +
    'Fond du Lac Band; Grand Portage Band; Leech Lake Band; Mille Lacs Band; White Earth Band)']);
  assert.deepEqual(labels['7725'], ['Native Village of Venetie Tribal Government (Arctic Village and Village of Venetie)']);
  for (const [code, names] of Object.entries(labels)) {
    assert.match(code, /^\d{4}$/);
    assert.ok(Array.isArray(names) && names.length > 0, code);
    for (const name of names) assert.doesNotMatch(name, /previously listed as/i, code);
  }
});

test('the Tribal name labels fade with the layer and win label collisions', () => {
  assert.ok(fadeLayerIds.includes('aiannh-nation-labels'));
  assert.equal(TOP_LABEL_IDS.at(-1), 'aiannh-nation-labels', 'the topmost label layer is placed first');
});
