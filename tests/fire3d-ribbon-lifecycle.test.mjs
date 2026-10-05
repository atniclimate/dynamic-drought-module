import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D P3-RIBBON (REGISTER found-116): the Fire 3D perimeter ribbon never
 * outlives its perimeter layer or its scene, whatever order the ribbon's
 * read, the layer toggle, the scene exit and the reconcile resolve in.
 *
 * Drives the REAL orchestrator (src/map/fire3d.ts), the REAL ribbon module
 * (src/layers/nifc-perimeter-ribbon.ts) and the REAL layer registry
 * (src/state/registry.ts) through the controller's own seams: the 3D
 * preference, the registry's `change` and `status-change` events. Only the
 * renderer, the network and the other scene companions are stubbed, so no
 * browser and no network are needed (the audit proof of 2026-10-04,
 * finding 12, used the same shape).
 *
 * The one test seam is the perimeter source's `getData()`. MapLibre 6.6
 * resolves it with the object the source holds at the moment it is asked
 * (`_data.geojson`), so the fake captures the data at call time and, while
 * `held` is set, resolves only when the case releases it. That makes each
 * bad ordering deterministic instead of a matter of runner speed.
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
globalThis.__ribbonLifecycleEnv = env;

const STUBS = {
  '/config/urls': 'export const URLS = { terrainPmtilesDeep: "unused-deep-archive" };',
  '/layers/hillshade':
    'export async function resolveHillshadeArchive() { throw new Error("unused"); }',
  '/util/pmtiles-probe':
    'export async function probeArchiveHeader() { return { maxZoom: 10 }; }',
  './gl-capability':
    'export function watchContextLoss() { return () => {}; } export function webGl2Capability() { return { webgl2: true }; }',
  '/state/cluster-service':
    'export function getCommittedSnapshot() { return { cluster: globalThis.__ribbonLifecycleEnv.cluster }; } export function onCommittedSnapshotChange() { return () => {}; }',
  '/state/fire3d-store':
    'const env = globalThis.__ribbonLifecycleEnv; export function getFire3DPreference() { return env.preference; } export function onFire3DPreferenceChange(fn) { env.preferenceListeners.push(fn); return () => {}; } export function setFire3DPreference(next) { env.preference = next; }',
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
    'const env = globalThis.__ribbonLifecycleEnv; export const LEGEND_ORDER = { event: 1 }; export function showLegend(key) { env.legends.add(key); return null; } export function hideLegend(key) { env.legends.delete(key); } export function renderSwatchLegend() {}'
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

const sources = new Map();
const layers = new Map();
const map = {
  getSource: (id) => sources.get(id),
  addSource: (id, spec) => {
    sources.set(id, spec);
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
  on() {},
  off() {},
  isSourceLoaded: () => true
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

// ---------------------------------------------------------------------------
// The scene's own ribbon read
// ---------------------------------------------------------------------------

test('an exit during the scene\'s own ribbon read leaves no ribbon, and a re-entry builds it afresh', async () => {
  perimetersOn();
  reads.held = true;
  setPreference(true);
  await until(() => reads.pending.length === 1, 'the scene asked for the perimeters');

  setPreference(false);
  assert.equal(getFire3DStatus().state, 'inactive');
  releaseOldestRead();
  await settle();

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'the late read raised no ribbon over the flat map');
  assert.equal(getFire3DStatus().perimeterRibbon, false);
  assert.equal(dataset.ddmFire3dRibbon, undefined);

  reads.held = false;
  await enterScene();
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON, 'the re-entry built the ribbon afresh');
  assert.equal(getFire3DStatus().perimeterRibbon, true);
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

// ---------------------------------------------------------------------------
// The reconcile read (the perimeter layer's own seams)
// ---------------------------------------------------------------------------

test('the perimeter layer going off during a ribbon read leaves no ribbon, and the stamp reads off', async () => {
  await enterScene();
  assert.equal(dataset.ddmFire3dRibbon, 'off');

  reads.held = true;
  perimetersOn();
  await until(() => reads.pending.length >= 1, 'the reconcile asked for the perimeters');
  perimetersOff();
  while (reads.pending.length > 0) releaseOldestRead();
  await settle();

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'no ribbon stands over a perimeter layer that is off');
  assert.equal(getFire3DStatus().state, 'active');
  assert.equal(getFire3DStatus().perimeterRibbon, false);
  assert.equal(dataset.ddmFire3dRibbon, 'off');
});

test('a second ribbon read still in flight when the layer goes off never re-adds the ribbon the removal took down', async () => {
  await enterScene();
  reads.held = true;
  perimetersOn();
  await until(() => reads.pending.length >= 1, 'the first read was asked');
  // A refresh of the perimeter layer lands while the first read is out: its
  // status seam asks again.
  registry.setStatus(PERIMETER_KEY, 'live');
  await settle();
  // The first read answers; then the person turns the layer off; then the
  // second read answers.
  releaseOldestRead();
  await settle();
  perimetersOff();
  while (reads.pending.length > 0) releaseOldestRead();
  await settle();

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'the later read raised no ribbon after the layer went off');
  assert.equal(getFire3DStatus().perimeterRibbon, false);
  assert.equal(dataset.ddmFire3dRibbon, 'off');
});

test('a scene exit during a reconcile read leaves no ribbon on the flat map', async () => {
  await enterScene();
  reads.held = true;
  perimetersOn();
  await until(() => reads.pending.length >= 1, 'the reconcile asked for the perimeters');

  setPreference(false);
  assert.equal(getFire3DStatus().state, 'inactive');
  while (reads.pending.length > 0) releaseOldestRead();
  await settle();

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'the late read raised no ribbon after the exit');
  assert.equal(dataset.ddmFire3dRibbon, undefined);
});

// ---------------------------------------------------------------------------
// What must not change
// ---------------------------------------------------------------------------

test('the layer off and on again during a read ends with exactly the ribbon the layer now holds', async () => {
  await enterScene();
  reads.held = true;
  perimetersOn();
  await until(() => reads.pending.length >= 1, 'the first read was asked');
  perimetersOff();
  perimetersOn();
  await until(() => reads.pending.length >= 2, 'the second read was asked');
  while (reads.pending.length > 0) {
    releaseOldestRead();
    await settle();
  }

  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(getFire3DStatus().perimeterRibbon, true);
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('perimeters that land while an earlier read is out still raise the ribbon', async () => {
  // The flat layer is on but its first answer held no wildfire perimeter.
  map.addSource(PERIMETER_KEY, perimeterSource(NO_PERIMETERS));
  registry.setStatus(PERIMETER_KEY, 'live');
  registry.activate(PERIMETER_KEY);
  await enterScene();
  assert.equal(dataset.ddmFire3dRibbon, 'off');

  reads.held = true;
  // A viewport refresh starts: the status seam asks while the source still
  // holds the empty answer; then the new perimeters land and it asks again.
  registry.setStatus(PERIMETER_KEY, 'loading');
  await until(() => reads.pending.length >= 1, 'a read of the empty answer was asked');
  map.getSource(PERIMETER_KEY).data = LIVE_PERIMETERS;
  registry.setStatus(PERIMETER_KEY, 'live');
  await until(() => reads.pending.length >= 2, 'a read of the new perimeters was asked');
  while (reads.pending.length > 0) {
    releaseOldestRead();
    await settle();
  }

  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('when two reads are out, the ribbon stands over the newer answer, not the earlier one', async () => {
  const ONE_PERIMETER = { type: 'FeatureCollection', features: [LIVE_PERIMETERS.features[0]] };
  await enterScene();
  reads.held = true;
  perimetersOn(ONE_PERIMETER);
  await until(() => reads.pending.length >= 1, 'a read of the first answer was asked');
  // A refresh lands a second perimeter before the first read answers.
  map.getSource(PERIMETER_KEY).data = LIVE_PERIMETERS;
  registry.setStatus(PERIMETER_KEY, 'live');
  await until(() => reads.pending.length >= 2, 'a read of the newer answer was asked');
  while (reads.pending.length > 0) {
    releaseOldestRead();
    await settle();
  }

  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(
    sources.get(RIBBON_SOURCE_ID).data.features.length,
    LIVE_PERIMETERS.features.length,
    'the ribbon raised every perimeter of the newer answer'
  );
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('a scene that stays up with its perimeter layer on keeps the ribbon, and the layer leads it off and on', async () => {
  perimetersOn();
  await enterScene();
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(getFire3DStatus().perimeterRibbon, true);
  assert.equal(dataset.ddmFire3dRibbon, 'on');

  // A refresh of the layer while the ribbon stands changes nothing.
  registry.setStatus(PERIMETER_KEY, 'loading');
  registry.setStatus(PERIMETER_KEY, 'live');
  await settle();
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(dataset.ddmFire3dRibbon, 'on');

  perimetersOff();
  await settle();
  assert.deepEqual(ribbonOnMap(), NO_RIBBON);
  assert.equal(dataset.ddmFire3dRibbon, 'off');
  assert.equal(getFire3DStatus().state, 'active');

  perimetersOn();
  await until(() => dataset.ddmFire3dRibbon === 'on', 'the ribbon came back with its layer');
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);

  setPreference(false);
  assert.deepEqual(ribbonOnMap(), NO_RIBBON);
  assert.equal(dataset.ddmFire3dRibbon, undefined);
});
