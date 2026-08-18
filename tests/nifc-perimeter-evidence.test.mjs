/**
 * Node-level pure-function tests for the selected-place NIFC mapped-
 * perimeter evidence (ring conversion, query-body shape, attributes-only
 * parsing, claim wording, and the national fire-capability table).
 *
 * The TypeScript modules are imported directly via Node's native type
 * stripping (the scripts/generate-coverage-matrix.mjs pattern). Because the
 * evidence module carries extensionless RUNTIME imports (the codebase
 * convention), a small synchronous resolve hook appends `.ts` to a relative
 * specifier from a `.ts` parent when that file exists; it changes nothing
 * else about resolution.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.(?:[cm]?[jt]sx?|json|css)$/.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { geoJsonPolygonToEsriRings } = await import(
  '../src/util/esri-geometry.ts'
);
const {
  arealGeometry,
  buildPerimeterEvidenceClaim,
  buildPerimeterQueryBody,
  parsePerimeterFeatureCollection,
  summarizePerimeterTypes,
  PERIMETER_RESULT_RECORD_COUNT
} = await import('../src/impact/nifc-perimeter-evidence.ts');
const { NATIONAL_FIRE_SOURCE_CAPABILITY } = await import(
  '../src/config/source-capability.ts'
);
const { CANONICAL_GEOGRAPHY_KEYS } = await import(
  '../src/config/geography.ts'
);

const EM_DASH = String.fromCharCode(0x2014);

/** Twice-signed shoelace area over a CLOSED ring; positive = counterclockwise. */
function signedArea(ring) {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

const CCW_SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0]
];
// GeoJSON-conventional (clockwise) hole.
const CW_HOLE = [
  [0.2, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
  [0.8, 0.2],
  [0.2, 0.2]
];

test('a counterclockwise GeoJSON exterior becomes a closed clockwise Esri ring', () => {
  const rings = geoJsonPolygonToEsriRings({
    type: 'Polygon',
    coordinates: [CCW_SQUARE]
  });
  assert.equal(rings.length, 1);
  const ring = rings[0];
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(signedArea(ring) < 0, 'exterior must be clockwise');
});

test('a hole is preserved as its own counterclockwise ring', () => {
  const rings = geoJsonPolygonToEsriRings({
    type: 'Polygon',
    coordinates: [CCW_SQUARE, CW_HOLE]
  });
  assert.equal(rings.length, 2);
  assert.ok(signedArea(rings[0]) < 0, 'exterior must be clockwise');
  assert.ok(signedArea(rings[1]) > 0, 'hole must be counterclockwise');
});

test('each ring is flipped by its OWN winding, so noncompliant input still lands right', () => {
  const cwExterior = [...CCW_SQUARE].reverse();
  const ccwHole = [...CW_HOLE].reverse();
  const rings = geoJsonPolygonToEsriRings({
    type: 'Polygon',
    coordinates: [cwExterior, ccwHole]
  });
  assert.ok(signedArea(rings[0]) < 0, 'already-clockwise exterior stays clockwise');
  assert.ok(signedArea(rings[1]) > 0, 'already-counterclockwise hole stays counterclockwise');
});

test('a MultiPolygon contributes every ring of every part', () => {
  const shifted = (ring, dx) => ring.map(([x, y]) => [x + dx, y]);
  const rings = geoJsonPolygonToEsriRings({
    type: 'MultiPolygon',
    coordinates: [
      [CCW_SQUARE],
      [shifted(CCW_SQUARE, 5), shifted(CW_HOLE, 5)]
    ]
  });
  assert.equal(rings.length, 3);
  assert.ok(signedArea(rings[0]) < 0);
  assert.ok(signedArea(rings[1]) < 0);
  assert.ok(signedArea(rings[2]) > 0);
});

test('coordinates are rounded to 4 decimals by default', () => {
  const rings = geoJsonPolygonToEsriRings({
    type: 'Polygon',
    coordinates: [[
      [-120.123456789, 45.987654321],
      [-119.111111111, 45.987654321],
      [-119.111111111, 46.222222222],
      [-120.123456789, 45.987654321]
    ]]
  });
  const flat = rings.flat(1);
  assert.ok(flat.some(([x]) => x === -120.1235));
  assert.ok(flat.some(([, y]) => y === 45.9877));
  for (const [x, y] of flat) {
    assert.equal(x, Math.round(x * 10000) / 10000);
    assert.equal(y, Math.round(y * 10000) / 10000);
  }
});

test('a degenerate ring fails closed instead of querying a wrong shape', () => {
  assert.throws(
    () =>
      geoJsonPolygonToEsriRings({
        type: 'Polygon',
        coordinates: [[
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0]
        ]]
      }),
    /fewer than three distinct positions/
  );
});

test('arealGeometry accepts only Polygon and MultiPolygon', () => {
  const polygon = { type: 'Polygon', coordinates: [CCW_SQUARE] };
  assert.equal(arealGeometry(polygon), polygon);
  assert.equal(arealGeometry(undefined), null);
  assert.equal(arealGeometry({ type: 'Point', coordinates: [0, 0] }), null);
  assert.equal(
    arealGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
    null
  );
});

test('the query body carries the exact verified ArcGIS polygon-intersects contract', () => {
  const body = buildPerimeterQueryBody({
    type: 'Polygon',
    coordinates: [CCW_SQUARE]
  });
  assert.equal(body.get('where'), '1=1');
  assert.equal(body.get('geometryType'), 'esriGeometryPolygon');
  assert.equal(body.get('inSR'), '4326');
  assert.equal(body.get('spatialRel'), 'esriSpatialRelIntersects');
  assert.equal(body.get('outFields'), 'attr_IncidentTypeCategory');
  assert.equal(body.get('returnGeometry'), 'false');
  assert.equal(body.get('resultRecordCount'), '2000');
  assert.equal(PERIMETER_RESULT_RECORD_COUNT, 2000);
  assert.equal(body.get('f'), 'geojson');
  const geometry = JSON.parse(body.get('geometry'));
  assert.ok(Array.isArray(geometry.rings));
  assert.equal(geometry.rings.length, 1);
  assert.deepEqual(geometry.spatialReference, { wkid: 4326 });
});

function feature(type) {
  return {
    type: 'Feature',
    properties: { attr_IncidentTypeCategory: type },
    geometry: null
  };
}

test('the parser extracts incident types and reads the transfer-limit flag', () => {
  const complete = parsePerimeterFeatureCollection({
    type: 'FeatureCollection',
    features: [feature('WF'), feature('RX')]
  });
  assert.deepEqual(complete.types, ['WF', 'RX']);
  assert.equal(complete.truncated, false, 'absent flag means complete');

  const truncated = parsePerimeterFeatureCollection({
    type: 'FeatureCollection',
    exceededTransferLimit: true,
    features: [feature('WF')]
  });
  assert.equal(truncated.truncated, true);

  const explicitFalse = parsePerimeterFeatureCollection({
    type: 'FeatureCollection',
    exceededTransferLimit: false,
    features: []
  });
  assert.equal(explicitFalse.truncated, false);
});

test('the parser fails on an HTTP-200 ArcGIS error envelope', () => {
  assert.throws(
    () =>
      parsePerimeterFeatureCollection({
        error: { code: 400, message: 'Invalid query parameters.' }
      }),
    /ArcGIS error 400: Invalid query parameters\./
  );
});

test('the parser rejects a non-FeatureCollection and an invalid feature', () => {
  assert.throws(
    () => parsePerimeterFeatureCollection({ count: 3 }),
    /not a valid FeatureCollection/
  );
  assert.throws(
    () => parsePerimeterFeatureCollection(null),
    /not a valid FeatureCollection/
  );
  assert.throws(
    () =>
      parsePerimeterFeatureCollection({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: 'nope' }]
      }),
    /invalid feature/
  );
  assert.throws(
    () =>
      parsePerimeterFeatureCollection({
        type: 'FeatureCollection',
        exceededTransferLimit: 'yes',
        features: []
      }),
    /not a valid FeatureCollection/
  );
});

test('type summarization follows the shared WF/CX/RX classification', () => {
  assert.deepEqual(
    summarizePerimeterTypes(['WF', 'cx', 'RX', 'EX', null, undefined]),
    { wildfire: 2, prescribed: 1, other: 3 }
  );
});

test('claim wording: singular intersection', () => {
  assert.equal(
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 1,
      truncated: false,
      breakdown: { wildfire: 1, prescribed: 0, other: 0 }
    }),
    '1 current mapped NIFC fire perimeter intersects Washington right now: 1 wildfire perimeter.'
  );
});

test('claim wording: plural with wildfire and prescribed breakdown', () => {
  assert.equal(
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 3,
      truncated: false,
      breakdown: { wildfire: 2, prescribed: 1, other: 0 }
    }),
    "3 current mapped NIFC fire perimeters intersect Washington right now: 2 wildfire and 1 Prescribed fire perimeter."
  );
});

test('claim wording: all three categories', () => {
  assert.equal(
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 4,
      truncated: false,
      breakdown: { wildfire: 2, prescribed: 1, other: 1 }
    }),
    '4 current mapped NIFC fire perimeters intersect Washington right now: 2 wildfire, 1 Prescribed fire and 1 other or unclassified fire perimeter.'
  );
});

test('claim wording: a verified zero is never an all-clear', () => {
  assert.equal(
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 0,
      truncated: false,
      breakdown: { wildfire: 0, prescribed: 0, other: 0 }
    }),
    'No current mapped NIFC fire perimeters intersect Washington right now. This is a verified zero for mapped perimeters, not an all-clear: an active incident without a mapped perimeter yet would not appear in this count.'
  );
});

test('claim wording: a truncated result is an at-least lower bound', () => {
  assert.equal(
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 2000,
      truncated: true,
      breakdown: { wildfire: 1800, prescribed: 150, other: 50 }
    }),
    "At least 2,000 current mapped NIFC fire perimeters intersect Washington right now (the query reached the service's 2,000-record result limit, so the true count may be higher)."
  );
});

test('claim wording preserves Tribal capitalization in the title', () => {
  const text = buildPerimeterEvidenceClaim({
    title: 'the Spokane Tribal land area',
    count: 1,
    truncated: false,
    breakdown: { wildfire: 1, prescribed: 0, other: 0 }
  });
  assert.ok(text.includes('the Spokane Tribal land area'));
  assert.ok(!text.includes('tribal'));
});

test('no claim wording ever carries an em dash', () => {
  const samples = [
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 0,
      truncated: false,
      breakdown: { wildfire: 0, prescribed: 0, other: 0 }
    }),
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 3,
      truncated: false,
      breakdown: { wildfire: 2, prescribed: 1, other: 0 }
    }),
    buildPerimeterEvidenceClaim({
      title: 'Washington',
      count: 2000,
      truncated: true,
      breakdown: { wildfire: 2000, prescribed: 0, other: 0 }
    })
  ];
  for (const text of samples) {
    assert.ok(!text.includes(EM_DASH), `em dash found in: ${text}`);
  }
});

test('the national fire-capability table covers every canonical geography honestly', () => {
  const keys = Object.keys(NATIONAL_FIRE_SOURCE_CAPABILITY).sort();
  assert.deepEqual(keys, [...CANONICAL_GEOGRAPHY_KEYS].sort());
  const unavailableKeys = new Set(['canada', 'transboundary', 'unknown']);
  for (const key of CANONICAL_GEOGRAPHY_KEYS) {
    const cell = NATIONAL_FIRE_SOURCE_CAPABILITY[key].nifcPerimeterEvidence;
    assert.ok(cell, `missing cell for ${key}`);
    assert.equal(
      cell.state,
      unavailableKeys.has(key) ? 'unavailable' : 'available',
      key
    );
    assert.ok(typeof cell.note === 'string' && cell.note.length > 0, key);
    assert.ok(!cell.note.includes(EM_DASH), key);
  }
});
