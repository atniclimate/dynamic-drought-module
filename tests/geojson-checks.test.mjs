import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

/**
 * The shared GeoJSON checks (src/util/geojson-checks.ts) and their readers.
 *
 * One polygon-coordinate check serves the NADM verdict, the minimap's NADM
 * polygon reader and the NWS alert reader, so a change to what counts as a
 * valid ring reaches all three at once. One FeatureCollection and truncation
 * check serves the two live Tribal boundary layers (BIA AIAN-LAR Reservation
 * Boundaries and Census AIANNH Tribal Lands), and the truncation flag is read
 * where ArcGIS may put it: top level or the collection's `properties`.
 * The BIA layer stamps its retrieval date as the viewer's local calendar day.
 *
 * Runs under plain `node --test` (Node 24 strips types). No network: every
 * request is answered by a stand-in shape.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { hasPolygonCoordinates, assertFeatureCollection, isTruncated } = await import('../src/util/geojson-checks.ts');
const { validateNadmCollection, NadmCollectionError } = await import('../src/util/nadm-collection.ts');
const { nadmPolygonsFromGeometry } = await import('../src/util/nadm.ts');
const { parseMapPayload } = await import('../src/layers/nws-alerts.ts');
const { registry } = await import('../src/state/registry.ts');
const LAYERS = {
  bia: await import('../src/layers/bia-reservations.ts'),
  aiannh: await import('../src/layers/aiannh.ts')
};

const RING = [[-120, 48], [-118, 48], [-118, 50], [-120, 50], [-120, 48]];
const GEOMETRIES = [
  ['a Polygon', { type: 'Polygon', coordinates: [RING] }, true],
  ['a MultiPolygon', { type: 'MultiPolygon', coordinates: [[RING], [RING]] }, true],
  ['an open ring of four finite positions (closure is not checked)', { type: 'Polygon', coordinates: [RING.slice(0, 4)] }, true],
  ['a ring of three positions', { type: 'Polygon', coordinates: [RING.slice(0, 3)] }, false],
  ['a non-finite position', { type: 'Polygon', coordinates: [[[-120, 48], [Number.NaN, 48], [-118, 50], [-120, 48]]] }, false],
  ['a position of text', { type: 'Polygon', coordinates: [[['-120', 48], [-118, 48], [-118, 50], [-120, 48]]] }, false],
  ['a Polygon with no rings', { type: 'Polygon', coordinates: [] }, false],
  ['an empty MultiPolygon', { type: 'MultiPolygon', coordinates: [] }, false],
  ['a MultiPolygon with one bad polygon', { type: 'MultiPolygon', coordinates: [[RING], []] }, false],
  ['a Point', { type: 'Point', coordinates: [-120, 48] }, false],
  ['no coordinates', { type: 'Polygon' }, false]
];

test('the NADM verdict, the minimap NADM reader and the NWS alert reader all read a geometry as the shared check does', () => {
  for (const [why, geometry, valid] of GEOMETRIES) {
    assert.equal(hasPolygonCoordinates(geometry), valid, why);

    const nadm = () =>
      validateNadmCollection({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { DROUGHTCAT: 'D1', YEAR_MONTH: '202610' }, geometry }]
      });
    if (valid) assert.equal(nadm().kind, 'ok', why);
    else assert.throws(nadm, NadmCollectionError, why);

    if (valid) {
      const polygons = nadmPolygonsFromGeometry(geometry);
      assert.deepEqual(polygons, geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates, why);
    } else {
      assert.throws(() => nadmPolygonsFromGeometry(geometry), /malformed polygon geometry/, why);
    }

    const alert = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { prod_type: 'Flood Warning', onset: null, ends: '2026-11-08T02:16:00-06:00', expiration: '2026-11-06T20:45:00-06:00', wfo: 'KDVN' },
        geometry
      }]
    };
    assert.equal(parseMapPayload(alert, ['Flood Warning']) !== null, valid, why);
  }
});

test('the FeatureCollection check names its source and rejects an ArcGIS error body', () => {
  const body = { type: 'FeatureCollection', features: [] };
  assert.equal(assertFeatureCollection(body, 'AIAN-LAR'), body);
  assert.throws(() => assertFeatureCollection({ error: { code: 400, message: 'Invalid query' } }, 'AIAN-LAR'), /^Error: ArcGIS error 400: Invalid query$/);
  assert.throws(() => assertFeatureCollection({ type: 'Feature' }, 'AIANNH'), /^Error: AIANNH response was not a GeoJSON FeatureCollection\.$/);
  assert.throws(() => assertFeatureCollection(null, 'AIAN-LAR'), /AIAN-LAR response was not a GeoJSON FeatureCollection/);
});

test('the truncation flag is read at the top level or in the collection properties', () => {
  assert.equal(isTruncated({ type: 'FeatureCollection', features: [] }), false);
  assert.equal(isTruncated({ exceededTransferLimit: true }), true);
  assert.equal(isTruncated({ properties: { exceededTransferLimit: true } }), true);
  assert.equal(isTruncated({ exceededTransferLimit: false, properties: { exceededTransferLimit: false } }), false);
  assert.equal(isTruncated({ properties: null }), false);
});

// ---- The two live Tribal boundary layers, driven through a stand-in map ----

const pendingTimers = new Map();
let nextTimerId = 1;
globalThis.window = {
  setTimeout: (fn) => {
    const id = nextTimerId++;
    pendingTimers.set(id, fn);
    return id;
  },
  clearTimeout: (id) => {
    pendingTimers.delete(id);
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeMap(view) {
  const sources = new Map();
  const layers = new Set();
  const handlers = new Map();
  return {
    sources,
    getBounds: () => ({ getWest: () => view.west, getSouth: () => view.south, getEast: () => view.east, getNorth: () => view.north }),
    getZoom: () => 4.3,
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => {
      sources.set(id, { data: spec.data, setData(data) { this.data = data; } });
    },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => (layers.has(id) ? { id } : undefined),
    addLayer: (layer) => layers.add(layer.id),
    removeLayer: (id) => layers.delete(id),
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event)
  };
}

/**
 * Activate a layer against one stand-in answer; return its status and the data it drew.
 * Each test asks for its own view, so none is served from another's session cache.
 */
async function activateWith(layer, key, hostPattern, body, view) {
  const original = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (!hostPattern.test(url)) return Promise.reject(new Error(`unexpected egress from a node test: ${url}`));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/geo+json' } }));
  };
  const map = fakeMap(view);
  try {
    await layer.activate(map);
    await settle();
    return { status: registry.getStatus(key), data: map.sources.get(key)?.data };
  } finally {
    layer.deactivate(map);
    globalThis.fetch = original;
  }
}

const STAND_IN = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { LARID: 1, NAME: 'Stand-in', LARNAME: 'Stand-in' },
    geometry: { type: 'Polygon', coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]] }
  }]
};
const NESTED_TRUNCATION = { ...STAND_IN, properties: { exceededTransferLimit: true } };
const CONTIGUOUS = { west: -125, south: 24, east: -66, north: 50 };
const ALASKA = { west: -170, south: 55, east: -140, north: 70 };

test('BIA Reservation Boundaries: a truncation flag in the collection properties reads live (partial)', async () => {
  const read = await activateWith(LAYERS.bia, 'bia-reservations', /biamaps\.geoplatform\.gov/, NESTED_TRUNCATION, CONTIGUOUS);
  assert.equal(read.status, 'degraded');
});

test('Census AIANNH Tribal Lands: a truncation flag in the collection properties reads live (partial)', async () => {
  const read = await activateWith(LAYERS.aiannh, 'aiannh', /tigerweb\.geo\.census\.gov/, NESTED_TRUNCATION, CONTIGUOUS);
  assert.equal(read.status, 'degraded');
});

test('BIA Reservation Boundaries: the retrieval date is the viewer’s local day, not the UTC day', async () => {
  // 5:30 pm Pacific on Nov 6 is 01:30 UTC on Nov 7.
  const RealDate = Date;
  const fixed = RealDate.parse('2026-11-07T01:30:00Z');
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  };
  try {
    assert.equal(new Date().getDate(), 6, 'the stand-in clock reads Nov 6 in the Pacific zone');
    const read = await activateWith(LAYERS.bia, 'bia-reservations', /biamaps\.geoplatform\.gov/, STAND_IN, ALASKA);
    assert.equal(read.status, 'ready');
    assert.equal(read.data.features[0].properties.__DDM_RETRIEVED_ON, '2026-11-06');
  } finally {
    globalThis.Date = RealDate;
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
