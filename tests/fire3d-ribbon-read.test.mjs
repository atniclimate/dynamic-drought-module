import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * P3-FIRE3D (REGISTER found-127, found-130), driving the real orchestrator
 * (src/map/fire3d.ts), ribbon module and registry like
 * fire3d-ribbon-lifecycle.test.mjs, with the same stubs.
 *
 * found-127: a registry change that does not concern the perimeter layer
 * leaves a ribbon read in flight alone.
 * found-130: the transport stamp settles within a bounded time after the
 * scene's sources finish loading, even when no sourcedata or idle event
 * follows (a frozen main thread coalesces them away).
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

// ---------------------------------------------------------------------------
// Environment: stubbed companions, a fake window and document
// ---------------------------------------------------------------------------

globalThis.fetch = () => {
  throw new Error('unexpected network call from a node test');
};

const env = {
  preference: false,
  preferenceListeners: [],
  cluster: 'wildfire',
  legends: new Set()
};
globalThis.__ribbonReadEnv = env;

const STUBS = {
  '/config/urls': 'export const URLS = { terrainPmtilesDeep: "unused-deep-archive" };',
  '/layers/hillshade':
    'export async function resolveHillshadeArchive() { throw new Error("unused"); }',
  '/util/pmtiles-probe':
    'export async function probeArchiveHeader() { return { maxZoom: 10 }; }',
  './gl-capability':
    'export function watchContextLoss() { return () => {}; } export function webGl2Capability() { return { webgl2: true }; }',
  '/state/cluster-service':
    'export function getCommittedSnapshot() { return { cluster: globalThis.__ribbonReadEnv.cluster }; } export function onCommittedSnapshotChange() { return () => {}; }',
  '/state/fire3d-store':
    'const env = globalThis.__ribbonReadEnv; export function getFire3DPreference() { return env.preference; } export function onFire3DPreferenceChange(fn) { env.preferenceListeners.push(fn); return () => {}; } export function setFire3DPreference(next) { env.preference = next; }',
  '/ui/overlay': 'export function showToast() {}',
  '/util/motion': 'export function prefersReducedMotion() { return true; }',
  '/util/raster-error-watch':
    'export function watchRasterTiles() { return { detach() {} }; }',
  '/layers/hms-smoke-volume':
    'export function activateSmokeVolume() { return false; } export function deactivateSmokeVolume() {} export function cleanupOrphanedSmokeSource() {}',
  './fire3d-context':
    'export async function activateContextLayers() { return { keys: [], embedLines: [] }; } export function deactivateContextLayers() {}',
  '/map/layer-order':
    'export function reassertLabelOrder() {} export function reassertThematicOrder() {}',
  '/ui/legend-registry':
    'const env = globalThis.__ribbonReadEnv; export const LEGEND_ORDER = { event: 1 }; export function showLegend(key) { env.legends.add(key); return null; } export function hideLegend(key) { env.legends.delete(key); } export function renderSwatchLegend() {}'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(STUBS).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stub[1])}`,
        shortCircuit: true
      };
    }
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

const dataset = {};
globalThis.window = {
  innerHeight: 900,
  matchMedia: () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {}
  })
};
globalThis.document = {
  documentElement: { dataset },
  querySelector: () => null,
  getElementById: () => null
};

const { initFire3DController, getFire3DStatus } = await import('../src/map/fire3d.ts');
const { PERIMETER_RIBBON_LAYER_IDS } = await import('../src/layers/nifc-perimeter-ribbon.ts');
const { registry } = await import('../src/state/registry.ts');

// ---------------------------------------------------------------------------
// The fake map and its held perimeter reads
// ---------------------------------------------------------------------------

const PERIMETER_KEY = 'nifc-fires';
const RIBBON_SOURCE_ID = 'nifc-perimeter-ribbon';
const RIBBON_LEGEND_KEY = 'nifc-perimeter-ribbon';

const square = (west, south) => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [west + 0.6, south],
      [west + 0.6, south + 0.45],
      [west, south + 0.45],
      [west, south]
    ]
  ]
});

/** Two wildfire perimeters: what the flat layer holds after a live read. */
const LIVE_PERIMETERS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Synthetic Ridge' },
      geometry: square(-121.4, 44.6)
    },
    {
      type: 'Feature',
      properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Synthetic Butte' },
      geometry: square(-119.9, 46.1)
    }
  ]
};
const NO_PERIMETERS = { type: 'FeatureCollection', features: [] };

const reads = {
  held: false,
  /** Every read asked while held, oldest first: { data, release }. */
  pending: []
};

const listeners = [];
/** Scene requests: while `held`, every source the scene adds has a request
 * in flight (MapLibre's isSourceLoaded reads false) until it is released. */
const requests = {
  held: false,
  /** Source ids with a request still in flight. */
  inFlight: new Set()
};
const sources = new Map();
const layers = new Map();
const map = {
  getSource: (id) => sources.get(id),
  addSource: (id, spec) => {
    sources.set(id, spec);
    if (requests.held) requests.inFlight.add(id);
  },
  removeSource: (id) => {
    sources.delete(id);
  },
  getLayer: (id) => layers.get(id),
  addLayer: (layer) => {
    layers.set(layer.id, layer);
  },
  removeLayer: (id) => {
    layers.delete(id);
  },
  getPitch: () => 0,
  getBearing: () => 0,
  getCenter: () => ({ lng: -119, lat: 45.5 }),
  setTerrain() {},
  setSky() {},
  jumpTo() {},
  easeTo() {},
  on(name, fn) {
    listeners.push([name, fn]);
  },
  off(name, fn) {
    const at = listeners.findIndex(([n, f]) => n === name && f === fn);
    if (at >= 0) listeners.splice(at, 1);
  },
  isSourceLoaded: (id) => !requests.inFlight.has(id)
};

/** The flat layer's GeoJSON source, with MapLibre's read-back seam. */
function perimeterSource(data) {
  const source = {
    type: 'geojson',
    data,
    getData() {
      const captured = source.data;
      if (!reads.held) return Promise.resolve(captured);
      return new Promise((resolve) => {
        reads.pending.push({ data: captured, release: () => resolve(captured) });
      });
    }
  };
  return source;
}

/** Let every queued continuation run (no timer: a macrotask turn). */
async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Wait, by turns of the event loop, until `predicate` holds. */
async function until(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`never reached: ${label}`);
}

function setPreference(next) {
  env.preference = next;
  for (const fn of env.preferenceListeners) fn();
}

/** The layer controller's own order: loading, the module adds its source
 * and reports live, then the key registers active. */
function perimetersOn(data = LIVE_PERIMETERS) {
  registry.setStatus(PERIMETER_KEY, 'loading');
  map.addSource(PERIMETER_KEY, perimeterSource(data));
  registry.setStatus(PERIMETER_KEY, 'live');
  registry.activate(PERIMETER_KEY);
}

/** The controller's teardown order: the module removes its source, then the
 * key leaves the registry. */
function perimetersOff() {
  map.removeSource(PERIMETER_KEY);
  registry.deactivate(PERIMETER_KEY);
}

function releaseOldestRead() {
  const next = reads.pending.shift();
  assert.ok(next, 'a ribbon read was pending');
  next.release();
}

function ribbonOnMap() {
  return {
    source: sources.has(RIBBON_SOURCE_ID),
    layers: PERIMETER_RIBBON_LAYER_IDS.filter((id) => layers.has(id)).length,
    legend: env.legends.has(RIBBON_LEGEND_KEY)
  };
}

const NO_RIBBON = { source: false, layers: 0, legend: false };
const FULL_RIBBON = {
  source: true,
  layers: PERIMETER_RIBBON_LAYER_IDS.length,
  legend: true
};

async function enterScene() {
  setPreference(true);
  await until(() => getFire3DStatus().state === 'active', 'the scene is active');
}

/** Leave every case as the next one expects: no scene, no perimeter layer,
 * no held read, and nothing on the map. */
async function reset() {
  reads.held = false;
  requests.held = false;
  requests.inFlight.clear();
  while (reads.pending.length > 0) releaseOldestRead();
  setPreference(false);
  if (registry.getActiveKeys().has(PERIMETER_KEY)) perimetersOff();
  await settle();
  sources.clear();
  layers.clear();
  env.legends.clear();
}

initFire3DController(map);

test.afterEach(reset);

test('a registry change that does not concern the perimeters leaves an in-flight ribbon read alone', async () => {
  await enterScene();
  reads.held = true;
  perimetersOn();
  await until(() => reads.pending.length === 1, 'the reconcile asked for the perimeters');

  // A stream of unrelated layer changes while the read is out.
  for (const key of ['unrelated-a', 'unrelated-b', 'unrelated-c']) {
    registry.activate(key);
    registry.deactivate(key);
  }
  await settle();
  assert.equal(reads.pending.length, 1, 'no new read was started by an unrelated change');

  releaseOldestRead();
  await settle();
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON, 'the one read landed and raised the ribbon');
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('the transport stamp settles within a bounded time after the last scene request is released with no further map event', async () => {
  requests.held = true;
  await enterScene();
  assert.ok(requests.inFlight.size > 0, 'the scene added sources whose requests are held');
  assert.equal(dataset.ddmFire3dTransport, 'streaming');

  // Release the requests one at a time; the map raises no sourcedata or idle
  // (a frozen main thread has coalesced them away).
  requests.held = false;
  const held = [...requests.inFlight];
  for (const id of held.slice(0, -1)) requests.inFlight.delete(id);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(dataset.ddmFire3dTransport, 'streaming', 'one request still out keeps it streaming');

  requests.inFlight.delete(held[held.length - 1]);
  const released = Date.now();
  while (dataset.ddmFire3dTransport !== 'settled' && Date.now() - released < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(dataset.ddmFire3dTransport, 'settled', 'settled within the 2 s bound');
});
