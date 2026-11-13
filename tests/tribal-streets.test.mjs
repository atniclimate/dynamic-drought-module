/**
 * The detail drawn inside Tribal areas from zoom 12 (src/layers/tribal-streets.ts)
 * and its handover from the Tribal Lands layer (src/layers/aiannh.ts): when the
 * four live reads run, when they do not run again, what a failed, blank, cut or
 * late answer leaves on the map, and what a cancel leaves pending.
 *
 * Every shape here is a stand-in rectangle and every name a stand-in label; no
 * answer from a live service is copied into this file. Tribal boundaries are
 * public data at T0 (CLAUDE.md); the stand-ins keep the test offline.
 *
 * Run: node --test tests/tribal-streets.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });

const streets = await import('../src/layers/tribal-streets.ts');
const aiannh = await import('../src/layers/aiannh.ts');
const { registry } = await import('../src/state/registry.ts');
// The Tribal Lands refresh debounces through window.setTimeout; set after the imports so no module boots as if in a browser.
globalThis.window = globalThis;

const DETAIL_SOURCES = ['tribal-streets', 'tribal-waterbodies', 'tribal-streams', 'tribal-communities'];
const DETAIL_URL = /MapServer\/(5|6|8|12)\/query/;
const AIANNH_URL = /AIANNHA\/MapServer\/47\/query/;
const VIEW = [-120.6, 46.4, -120.4, 46.6];
const AREA_BOX = [-121, 46, -120, 47];

const rect = ([w, s, e, n]) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const area = (ns, box) => ({ type: 'Feature', properties: { NAME: 'Stand-in Area', AIANNHCC: 'D1', AIANNHNS: ns }, geometry: rect(box) });
const collection = (...features) => ({ type: 'FeatureCollection', features });
/** One row every detail read can draw: a street, a named stream, a named lake and a community. */
const row = (label = 'Stand-in') => ({
  type: 'Feature',
  properties: { NAME: label, gnis_name: label, lengthkm: 2, GNIS_NAME: label, AREASQKM: 1, BASENAME: label, INTPTLAT: '+46.5', INTPTLON: '-120.5' },
  geometry: { type: 'LineString', coordinates: [[-120.5, 46.5], [-120.49, 46.5]] }
});
const answer = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** Every request this file's fetch stand-in saw, and the answers it gives. */
let calls = [];
let detailAnswer = () => answer(collection(row()));
let aiannhAnswer = () => answer(collection(area('90000001', AREA_BOX)));
globalThis.fetch = async (url, init) => {
  const call = { url: String(url), signal: init?.signal };
  calls.push(call);
  if (DETAIL_URL.test(call.url)) return detailAnswer(call);
  if (AIANNH_URL.test(call.url)) return aiannhAnswer(call);
  return answer({}); // the roster file: no label map
};
const detailReads = () => calls.filter((c) => DETAIL_URL.test(c.url));

/** The few map methods the two modules call, with what they left behind. */
function fakeMap(box, zoom) {
  const handlers = new Map();
  const sources = new Map();
  const layers = new Map();
  const filters = new Map();
  return {
    view: { box, zoom }, sources, layers, filters,
    on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    off(event, fn) { handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== fn)); },
    fire(event) { for (const fn of handlers.get(event) ?? []) fn(); },
    listeners: (event) => (handlers.get(event) ?? []).length,
    getBounds() { const [w, s, e, n] = this.view.box; return { getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n }; },
    getZoom() { return this.view.zoom; },
    getSource: (id) => sources.get(id),
    addSource(id, spec) { const source = { data: spec.data, setData(data) { source.data = data; } }; sources.set(id, source); },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.get(id),
    addLayer(spec) { layers.set(spec.id, spec); },
    removeLayer: (id) => layers.delete(id),
    setFilter(id, filter) { filters.set(id, filter); },
    getStyle: () => ({ layers: [...layers.values()] })
  };
}

/** How many features each detail source holds (0 for a source never added). */
const drawn = (map) => DETAIL_SOURCES.map((id) => map.sources.get(id)?.data.features.length ?? 0);
const names = (map) => DETAIL_SOURCES.map((id) => Object.values(map.sources.get(id)?.data.features[0]?.properties ?? {})[0]);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** Fresh request log, mocked debounce clock, quiet expected warnings; returns the function that lets one debounce pass. */
function begin(t) {
  calls = [];
  detailAnswer = () => answer(collection(row()));
  aiannhAnswer = () => answer(collection(area('90000001', AREA_BOX)));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'debug', () => {});
  const settle = async () => { t.mock.timers.tick(400); await flush(); };
  return { settle, warn };
}

/** The street module alone, started on a street-zoom view inside one stand-in area. */
function startStreets(t, box = VIEW, zoom = 13) {
  const map = fakeMap(box, zoom);
  streets.startTribalStreets(map);
  t.after(() => streets.stopTribalStreets(map));
  return map;
}

test('an unchanged set of Tribal areas does not repeat the four detail reads', async (t) => {
  const { settle } = begin(t);
  const map = startStreets(t);
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  assert.equal(detailReads().length, 4, 'one read each for streets, lakes, streams and communities');
  assert.deepEqual(drawn(map), [1, 1, 1, 1]);

  // Tribal Lands read its view again and handed over the same areas in a new object.
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  assert.equal(detailReads().length, 4, 'the same view and the same areas read nothing again');

  // Another area inside the same view: the envelope is the same, so only the cut changes.
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX), area('90000002', [-120.55, 46.45, -120.5, 46.5])));
  await settle();
  assert.equal(detailReads().length, 4, 'a changed area set over the same envelope reads nothing again');
  assert.equal(map.filters.get('tribal-streets-line').at(-1)[1].features.length, 2, 'the streets are cut to the areas now held');
  assert.deepEqual(drawn(map), [1, 1, 1, 1], 'and what was drawn stays');

  // The area now ends inside the view: a new envelope, so a new read.
  streets.setTribalStreetAreas(collection(area('90000001', [-120.5, 46, -120, 47])));
  await settle();
  assert.equal(detailReads().length, 8, 'a changed envelope reads again');
});

test('with no Tribal area left, the detail is cleared at once and its reads in flight are cancelled', async (t) => {
  const { settle } = begin(t);
  const map = startStreets(t);
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  assert.deepEqual(drawn(map), [1, 1, 1, 1]);

  // A second view whose reads stall in the body.
  let cancelled = 0;
  detailAnswer = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"type":')); },
    cancel() { cancelled += 1; }
  }));
  map.view.box = [-120.7, 46.4, -120.5, 46.6];
  map.fire('moveend');
  await settle();
  assert.equal(detailReads().length, 8);

  streets.setTribalStreetAreas(collection());
  assert.deepEqual(drawn(map), [0, 0, 0, 0], 'cleared without waiting for the next move');
  await flush();
  assert.equal(cancelled, 4, 'every stalled body read is cancelled');
  assert.ok(detailReads().every((c) => c.signal.aborted || c.url.includes(encodeURIComponent(VIEW.join(',')))), 'no read is left pending');
  await settle();
  assert.equal(detailReads().length, 8, 'and nothing is read while no area is held');
  assert.deepEqual(drawn(map), [0, 0, 0, 0]);
});

test('a blank, corrupt or error-envelope answer leaves the detail off and is read again on the next move', async (t) => {
  for (const [label, body] of [
    ['a blank HTTP 200', ''],
    ['a body that is not JSON', '<html>stand-in</html>'],
    ['an ArcGIS error envelope under HTTP 200', { error: { code: 500, message: 'Stand-in error' } }]
  ]) {
    await t.test(label, async (t) => {
      const { settle, warn } = begin(t);
      const map = startStreets(t);
      detailAnswer = () => answer(body);
      streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
      await settle();
      assert.deepEqual(drawn(map), [0, 0, 0, 0], 'nothing is drawn from it');
      assert.equal(warn.mock.callCount(), 4, 'each failed read says so once');
      map.fire('moveend');
      await settle();
      assert.equal(detailReads().length, 8, 'the same view is read again after a failure');
    });
  }
});

test('a view off every Tribal area, or below street zoom, reads nothing', async (t) => {
  const { settle } = begin(t);
  const map = startStreets(t, [-100.6, 40.4, -100.4, 40.6]);
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  map.view = { box: VIEW, zoom: 11.9 };
  map.fire('moveend');
  await settle();
  assert.equal(detailReads().length, 0);
  assert.deepEqual(drawn(map), [0, 0, 0, 0]);
});

test('an answer cut at the record limit is drawn as the part that came, and said so', async (t) => {
  const { settle, warn } = begin(t);
  const map = startStreets(t);
  detailAnswer = () => answer({ ...collection(row()), exceededTransferLimit: true });
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  assert.deepEqual(drawn(map), [1, 1, 1, 1]);
  assert.equal(warn.mock.callCount(), 4);
});

test('a late answer for a view the map has left is never drawn', async (t) => {
  const { settle } = begin(t);
  const map = startStreets(t);
  const held = [];
  detailAnswer = () => new Promise((resolve) => held.push(resolve));
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  assert.equal(held.length, 4);

  detailAnswer = () => answer(collection(row('Newer view')));
  map.view.box = [-120.7, 46.4, -120.5, 46.6];
  map.fire('moveend');
  await settle();
  assert.ok(detailReads().slice(0, 4).every((c) => c.signal.aborted), 'the first view\'s reads are aborted');
  for (const resolve of held) resolve(answer(collection(row('Older view'))));
  await flush();
  assert.deepEqual(names(map), ['Newer view', 'Newer view', 'Newer view', 'Newer view']);
});

test('stopping leaves no layer, no source, no listener and no pending read', async (t) => {
  const { settle } = begin(t);
  const map = startStreets(t);
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX)));
  await settle();
  detailAnswer = () => new Promise(() => {});
  map.view.box = [-120.7, 46.4, -120.5, 46.6];
  map.fire('moveend');
  await settle();
  streets.setTribalStreetAreas(collection(area('90000001', AREA_BOX))); // a debounce pending as well

  streets.stopTribalStreets(map);
  assert.equal(map.layers.size + map.sources.size + map.listeners('moveend'), 0);
  assert.ok(detailReads().slice(4).every((c) => c.signal.aborted), 'the reads in flight are aborted');
  await settle();
  assert.equal(detailReads().length, 8, 'the pending debounce reads nothing after the stop');
});

test('a failed Tribal Lands refresh clears the street detail drawn inside its areas', async (t) => {
  const { settle } = begin(t);
  const map = fakeMap(VIEW, 13);
  await aiannh.activate(map);
  t.after(() => aiannh.deactivate(map));
  await settle();
  assert.equal(registry.getStatus('aiannh'), 'ready');
  assert.deepEqual(drawn(map), [1, 1, 1, 1]);

  // The fade list is everything the layer and its detail put on the map (review finding 9).
  assert.deepEqual([...map.layers.keys()].sort(), [...aiannh.fadeLayerIds].sort());

  // A closer zoom is a new Tribal Lands read; this one fails.
  aiannhAnswer = () => answer('', 500);
  map.view.zoom = 14;
  map.fire('moveend');
  await settle();
  assert.equal(registry.getStatus('aiannh'), 'error');
  assert.equal(map.sources.get('aiannh').data.features.length, 0, 'the boundaries are cleared');
  assert.deepEqual(drawn(map), [0, 0, 0, 0], 'and so is the detail that was drawn inside them');

  const before = detailReads().length;
  map.fire('moveend');
  await settle();
  assert.equal(detailReads().length, before, 'a later move reads no detail for areas the map no longer shows');
});
