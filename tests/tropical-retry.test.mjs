import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Tropical cyclones: one retry, 30 s after an unavailable first read. The REAL
 * layer controller drives the REAL tropical-cyclones module over a stubbed
 * `fetch` (tests/tropical-fixtures.ts); only the controller's peripheral
 * modules are recorders, as in tests/tropical-read.test.mjs and
 * tests/layer-activation-cancel.test.mjs. The 30 s timer is controllable: the
 * test records it and fires it by hand.
 */

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

const BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
globalThis.tropicalTestBase = BASE;
const { LAYER_DEFS } = await import('../src/config/layers.ts');
globalThis.retryDefs = LAYER_DEFS;
globalThis.retryModules = new Map();
globalThis.retryCommitted = true;

const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/config/urls': 'export const URLS = { nhcTropicalMapServer: globalThis.tropicalTestBase };',
  '/config/layers': `export const LAYER_DEFS=globalThis.retryDefs;
    export const getLayerDef=key=>LAYER_DEFS.find(d=>d.key===key);
    export const getLoadedLayerModule=key=>globalThis.retryModules.get(key);
    export const loadLayerModule=async def=>getLoadedLayerModule(def.key);`,
  './cluster-service': 'export function isCommittedCompositionKey(){ return globalThis.retryCommitted; }',
  '/map/layer-order': 'export function reassertLabelOrder(){} export function reassertThematicOrder(){}',
  '/util/layer-fade': 'export function fadeInLayers(){} export async function fadeOutLayers(){}',
  '/ui/overlay': 'export function showLoading(){ return 1; } export function hideLoading(){}',
  '/map/interaction-coordinator': 'export function registerClickTarget(){}'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

// The 30 s retry timer is held here and fired by hand; every other timer is real.
const RETRY_MS = 30_000;
const retries = new Map();
let retryId = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (ms !== RETRY_MS) return realSetTimeout(fn, ms, ...rest);
  retryId += 1;
  retries.set(retryId, fn);
  return retryId;
};
globalThis.clearTimeout = (handle) => {
  if (typeof handle === 'number' && retries.has(handle)) retries.delete(handle);
  else realClearTimeout(handle);
};
globalThis.window = globalThis;
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const { tropicalAnswer, tropicalLayerId } = await import('./tropical-fixtures.ts');
const { registry } = await import('../src/state/registry.ts');
const { createLayerController } = await import('../src/state/layer-controller.ts');
const layer = await import('../src/layers/tropical-cyclones.ts');
globalThis.retryModules.set('tropical-cyclones', layer);

let arm = 'arcgisError';
let reads = 0;
globalThis.fetch = (url) => {
  reads += 1;
  const answer = tropicalAnswer(arm, tropicalLayerId(String(url)));
  return Promise.resolve(new Response(answer.body, { status: answer.status, headers: { 'Content-Type': answer.contentType } }));
};

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    on() {},
    off() {},
    getCanvas: () => ({ style: {} }),
    getStyle: () => ({ layers: [...layers.values()] }),
    moveLayer() {},
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource: (id, spec) => sources.set(id, { spec, setData() {} }),
    addLayer: (spec) => layers.set(spec.id, spec),
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id)
  };
}

function start() {
  const map = fakeMap();
  const checked = new Set(['tropical-cyclones']);
  const controller = createLayerController(map, {
    setCheckbox: (key, on) => (on ? checked.add(key) : checked.delete(key)),
    isCheckboxChecked: (key) => checked.has(key),
    clearLayerStatus() {},
    announce() {}
  });
  return { map, controller };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Each test starts past the layer's five-minute reuse of its last sweep.
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;

function reset(nextArm) {
  skew += 10 * 60 * 1000;
  arm = nextArm;
  reads = 0;
  retries.clear();
  globalThis.retryCommitted = true;
  registry.deactivate('tropical-cyclones');
}

const fire = () => {
  const [[id, fn]] = [...retries];
  retries.delete(id);
  fn();
};

test('an unavailable first read schedules one retry at 30 s; it fires once and succeeds', async (t) => {
  reset('arcgisError');
  const { map, controller } = start();
  t.after(() => layer.deactivate(map));
  await controller.activate('tropical-cyclones');
  await settle();
  assert.equal(registry.getStatus('tropical-cyclones'), 'error');
  assert.equal(registry.getActiveKeys().has('tropical-cyclones'), false);
  assert.equal(retries.size, 1, 'exactly one retry is waiting');
  const firstReads = reads;
  assert.equal(firstReads, 15, 'the fifteen presence reads, nothing more yet');

  arm = 'occupiedOne';
  fire();
  await settle();
  assert.equal(reads, firstReads + 18, 'the retry is one more sweep');
  assert.equal(registry.getStatus('tropical-cyclones'), 'ready');
  assert.equal(registry.getActiveKeys().has('tropical-cyclones'), true);
  assert.equal(retries.size, 0, 'no further retry after a success');
});

test('the retry is cancelled when the layer is turned off', async (t) => {
  reset('arcgisError');
  const { map, controller } = start();
  t.after(() => layer.deactivate(map));
  await controller.activate('tropical-cyclones');
  await settle();
  assert.equal(retries.size, 1);
  controller.deactivate('tropical-cyclones');
  await settle();
  assert.equal(retries.size, 0, 'off clears the pending retry');
  assert.equal(reads, 15, 'nothing is read after off');
});

test('a second unavailable result stays unavailable and schedules no third read', async (t) => {
  reset('arcgisError');
  const { map, controller } = start();
  t.after(() => layer.deactivate(map));
  await controller.activate('tropical-cyclones');
  await settle();
  assert.equal(retries.size, 1);
  fire();
  await settle();
  assert.equal(reads, 30, 'the retry ran its own fifteen presence reads');
  assert.equal(registry.getStatus('tropical-cyclones'), 'error');
  assert.equal(retries.size, 0, 'no third read is scheduled');
});

test('a layer whose checkbox the failure cleared (not a committed member) is not retried', async (t) => {
  reset('arcgisError');
  globalThis.retryCommitted = false;
  const { map, controller } = start();
  t.after(() => layer.deactivate(map));
  await controller.activate('tropical-cyclones');
  await settle();
  assert.equal(registry.getStatus('tropical-cyclones'), 'error');
  assert.equal(retries.size, 0);
});
