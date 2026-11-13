import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

const { censusLabelAreas, labelName } = await import('../scripts/build-tribal-roster.mjs');
const { fadeLayerIds, labelMinZoom, nationLabelPoints } = await import('../src/layers/aiannh.ts');
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
});

test('the shipped roster labels at least 540 areas: Creek OTSA, Warm Springs, both Nations of Wind River', () => {
  const labels = ROSTER.labelAreas;
  assert.ok(labels && typeof labels === 'object', 'the roster carries labelAreas');
  assert.ok(Object.keys(labels).length >= 540, `${Object.keys(labels).length} labelled areas`);
  const creek = ROSTER.censusAreas.find((a) => a.name === 'Creek OTSA');
  assert.deepEqual(labels[creek.aiannh], ['The Muscogee (Creek) Nation']);
  assert.deepEqual(labels['4545'], ['Confederated Tribes of the Warm Springs Reservation of Oregon']);
  assert.deepEqual(labels['4610'], [
    'Eastern Shoshone Tribe of the Wind River Reservation, Wyoming',
    'Northern Arapaho Tribe of the Wind River Reservation, Wyoming'
  ]);
  // A place or band one Nation's Federal Register name lists among several waits for the maintainer's word.
  for (const held of ['4595', '7390', '7725']) assert.equal(labels[held], undefined, held);
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
