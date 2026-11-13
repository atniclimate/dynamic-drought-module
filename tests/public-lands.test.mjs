import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Public Lands (src/layers/public-lands.ts), the live PAD-US read: the status
 * and cancellation matrix, driven against the REAL module with a stand-in map
 * and a stubbed `fetch` (no network decides a result).
 *
 * The two cases the code review named: turning the layer off during its first
 * read aborts that read through the controller's activation signal (nothing
 * draws after the user said off), and below the zoom floor the layer reads as
 * "zoom in to load", not live.
 */

// The product modules import each other without extensions (the same hook as
// tests/layer-activation-cancel.test.mjs).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const lands = await import('../src/layers/public-lands.ts');
const { registry } = await import('../src/state/registry.ts');
const KEY = 'public-lands';

const AREA = {
  type: 'Feature',
  properties: { Mang_Type: 'FED', Unit_Nm: 'Stand-in Forest' },
  geometry: { type: 'Polygon', coordinates: [[[-120.5, 47.4], [-120.4, 47.4], [-120.4, 47.5], [-120.5, 47.4]]] }
};
const COLLECTION = { type: 'FeatureCollection', features: [AREA] };

/** A stand-in map: one GeoJSON source whose every setData is recorded. */
function fakeMap(zoom = 11) {
  const draws = [];
  const sources = new Map();
  const layers = new Set();
  const handlers = new Map();
  return {
    draws,
    handlers,
    getZoom: () => zoom,
    getBounds: () => ({ getWest: () => -120.6, getSouth: () => 47.3, getEast: () => -120.3, getNorth: () => 47.6 }),
    getSource: (id) => sources.get(id),
    addSource: (id) => sources.set(id, { setData: (data) => draws.push(data) }),
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => (layers.has(id) ? { id } : undefined),
    addLayer: (spec) => layers.add(spec.id),
    removeLayer: (id) => layers.delete(id),
    on: (type, fn) => handlers.set(type, fn),
    off: (type) => handlers.delete(type)
  };
}

const drewFeatures = (map) => map.draws.some((d) => d.features.length > 0);

/** fetch answers per call; `held` keeps the request open until its signal aborts. */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, signal: init.signal });
    return answer(init.signal, calls.length);
  };
  return calls;
}
const held = (signal) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
const json = (body) => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }));
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function activation() {
  const ctrl = new AbortController();
  return { ctrl, activation: { signal: ctrl.signal, generation: 1 } };
}

async function settle(map) {
  lands.deactivate(map);
  registry.setStatus(KEY, 'loading');
  await turn();
}

test('off during the first read aborts it through the activation signal; nothing draws and no work stays pending', async () => {
  const map = fakeMap(11);
  const calls = stubFetch((signal) => held(signal));
  const { ctrl, activation: act } = activation();
  const done = lands.activate(map, act);
  await turn();
  assert.equal(calls.length, 1, 'the first read is in flight');
  ctrl.abort();
  await turn();
  assert.equal(calls[0].signal.aborted, true, 'the held PAD-US read aborts the instant the controller says off');
  await done;
  assert.equal(drewFeatures(map), false, 'no lands drawn after off');
  assert.notEqual(registry.getStatus(KEY), 'ready');
  assert.equal(calls.length, 1, 'no second read follows the cancel');
  await settle(map);
});

test('a late answer that raced past the off is not drawn', async () => {
  const map = fakeMap(11);
  stubFetch(() => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(COLLECTION), { status: 200 })), 5)));
  const { ctrl, activation: act } = activation();
  const done = lands.activate(map, act);
  await turn();
  ctrl.abort();
  await done;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(drewFeatures(map), false);
  await settle(map);
});

test('off while the body is still arriving aborts the body read', async () => {
  const map = fakeMap(11);
  let bodySignal = null;
  stubFetch((signal) => {
    bodySignal = signal;
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"FeatureCollection","features":[')); } });
    return Promise.resolve(new Response(stream, { status: 200 }));
  });
  const { ctrl, activation: act } = activation();
  const done = lands.activate(map, act);
  await turn();
  ctrl.abort();
  await done;
  assert.equal(bodySignal.aborted, true);
  assert.equal(drewFeatures(map), false);
  assert.notEqual(registry.getStatus(KEY), 'error', 'a cancel is not a failure');
  await settle(map);
});

test('below the zoom floor the layer reads as zoom in to load and sends no read', async () => {
  const map = fakeMap(lands.PUBLIC_LANDS_MIN_ZOOM - 2);
  const calls = stubFetch(() => json(COLLECTION));
  await lands.activate(map, activation().activation);
  assert.equal(registry.getStatus(KEY), 'zoom-in');
  assert.equal(calls.length, 0);
  assert.equal(drewFeatures(map), false);
  await settle(map);
});

test('a whole answer draws and reads live; one cut at the record limit reads live (partial)', async () => {
  const map = fakeMap(11);
  stubFetch(() => json(COLLECTION));
  await lands.activate(map, activation().activation);
  assert.equal(registry.getStatus(KEY), 'ready');
  assert.equal(drewFeatures(map), true);
  await settle(map);

  const cut = fakeMap(11);
  stubFetch(() => json({ ...COLLECTION, properties: { exceededTransferLimit: true } }));
  await lands.activate(cut, activation().activation);
  assert.equal(registry.getStatus(KEY), 'degraded');
  assert.equal(drewFeatures(cut), true, 'what came is drawn');
  await settle(cut);
});

for (const [name, body] of [
  ['a blank HTTP 200', ''],
  ['a corrupt body', '{"type":"FeatureColl'],
  ['an ArcGIS error envelope in an HTTP 200', { error: { code: 500, message: 'Error performing query operation' } }]
]) {
  test(`${name} reads unavailable and draws nothing`, async () => {
    const map = fakeMap(11);
    stubFetch(() => json(body));
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await lands.activate(map, activation().activation);
    } finally {
      console.warn = warn;
    }
    assert.equal(registry.getStatus(KEY), 'error');
    assert.equal(drewFeatures(map), false);
    await settle(map);
  });
}

test('an empty answer (a view off PAD-US coverage) draws nothing and is not a failure', async () => {
  const map = fakeMap(11);
  stubFetch(() => json({ type: 'FeatureCollection', features: [] }));
  await lands.activate(map, activation().activation);
  assert.notEqual(registry.getStatus(KEY), 'error');
  assert.equal(drewFeatures(map), false);
  await settle(map);
});

test('a newer view supersedes the read in flight, and its late answer is not drawn', async () => {
  const map = fakeMap(11);
  const calls = stubFetch((signal, n) =>
    n === 1 ? held(signal).catch(() => new Response(JSON.stringify({ ...COLLECTION, stale: true }), { status: 200 })) : json(COLLECTION)
  );
  const first = lands.activate(map, activation().activation);
  await turn();
  // A second activate stands in for the next view's refresh (the moveend path is debounced).
  await lands.activate(map, activation().activation);
  await first;
  assert.equal(calls[0].signal.aborted, true, 'the first read was superseded');
  assert.equal(map.draws.some((d) => d.stale), false, 'the superseded answer never draws');
  assert.equal(registry.getStatus(KEY), 'ready');
  await settle(map);
});
