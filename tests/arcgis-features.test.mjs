import assert from 'node:assert/strict';
import test from 'node:test';

// Audit round 4: the ArcGIS rules the Place studio, the watershed reads and
// the Tribal land area search each carried their own copy of, now one module.
const { assertCompleteFeatureCollection, escapeSql, isArealGeometry, mergeArealGeometry } = await import(
  '../src/util/arcgis-features.ts'
);

const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
const feature = (geometry) => ({ type: 'Feature', properties: {}, geometry });

test('a single quote inside an ArcGIS where literal doubles', () => {
  assert.equal(escapeSql("Rocky Boy's"), "Rocky Boy''s");
  assert.equal(escapeSql('Yakama'), 'Yakama');
});

test('features merge into one areal geometry: none, one part, several parts', () => {
  assert.equal(mergeArealGeometry([feature({ type: 'Point', coordinates: [0, 0] }), feature(null)]), null);
  assert.deepEqual(mergeArealGeometry([feature({ type: 'Polygon', coordinates: [ring] })]), {
    type: 'Polygon',
    coordinates: [ring]
  });
  assert.deepEqual(
    mergeArealGeometry([
      feature({ type: 'Polygon', coordinates: [ring] }),
      feature({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })
    ]),
    { type: 'MultiPolygon', coordinates: [[ring], [ring], [ring]] }
  );
  assert.equal(isArealGeometry({ type: 'LineString', coordinates: [] }), false);
  assert.equal(isArealGeometry({ type: 'MultiPolygon', coordinates: [] }), true);
});

test('only a complete FeatureCollection passes', () => {
  const ok = { type: 'FeatureCollection', features: [] };
  assert.equal(assertCompleteFeatureCollection(ok), ok);
  assert.throws(() => assertCompleteFeatureCollection({ error: { code: 400 } }), /error response/);
  assert.throws(() => assertCompleteFeatureCollection({ type: 'Feature' }), /Expected a GeoJSON FeatureCollection/);
  assert.throws(
    () => assertCompleteFeatureCollection({ ...ok, exceededTransferLimit: true }),
    /partial FeatureCollection/
  );
});
