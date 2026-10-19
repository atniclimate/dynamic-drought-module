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
 * The one test seam is the perimeter snapshot
 * (src/state/fire-perimeter-snapshot.ts), which the flat layer publishes and
 * the ribbon reads synchronously, so there is no read to hold: each bad
 * ordering is driven by changing the snapshot, the layer toggle or the scene
 * preference in the same turn.
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
  horizon: 'current',
  intended: new Set(),
  requested: [],
  onRequest: null,
  layersOn: [],
  probeFails: false,
  legends: new Set()
};
globalThis.__ribbonLifecycleEnv = env;

const STUBS = {
  '/config/urls': 'export const URLS = { terrainPmtilesDeep: "unused-deep-archive" };',
  '/layers/hillshade':
    'export async function resolveHillshadeArchive() { throw new Error("unused"); }',
  '/util/pmtiles-probe':
    'export async function probeArchiveHeader() { if (globalThis.__ribbonLifecycleEnv.probeFails) throw new Error("unreachable"); return { maxZoom: 10 }; }',
  '/ui/layer-toggle-command':
    'const env = globalThis.__ribbonLifecycleEnv; export function requestLayerOn(key) { env.layersOn.push(key); env.intended.add(key); }',
  './gl-capability':
    'export function watchContextLoss() { return () => {}; } export function webGl2Capability() { return { webgl2: true }; }',
  '/state/cluster-service':
    'const env = globalThis.__ribbonLifecycleEnv; export function getCommittedSnapshot() { return { cluster: env.cluster, horizon: env.horizon, intendedKeys: env.intended }; } export function onCommittedSnapshotChange() { return () => {}; } export function requestCluster(key) { env.onRequest?.(); env.requested.push(key); env.intended.delete("usfs-whp"); }',
  '/state/fire3d-store':
    'const env = globalThis.__ribbonLifecycleEnv; export function getFire3DPreference() { return env.preference; } export function onFire3DPreferenceChange(fn) { env.preferenceListeners.push(fn); return () => {}; } export function setFire3DPreference(next) { env.preference = next; }',
  '/ui/overlay': 'export function showToast() {}',
  '/util/motion': 'export function prefersReducedMotion() { return true; }',
  '/util/raster-error-watch':
    'export function watchRasterTiles() { return { detach() {} }; }',
  '/layers/hms-smoke-volume':
    'export function activateSmokeVolume() { globalThis.__ribbonLifecycleEnv.onSmoke?.(); return false; } export function deactivateSmokeVolume() {} export function cleanupOrphanedSmokeSource() {}',
  '/layers/wildfire-dryness':
    'export async function activateWildfireDryness() {} export function getDrynessSourceId() { return null; }',
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
const { setPerimeterSnapshot } = await import('../src/state/fire-perimeter-snapshot.ts');

// ---------------------------------------------------------------------------
// The fake map
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

const sources = new Map();
const layers = new Map();
const mapListeners = {};
const map = {
  getSource: (id) => sources.get(id),
  addSource: (id, spec) => {
    spec.setData ??= (data) => {
      spec.data = data;
    };
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
  on: (type, fn) => {
    (mapListeners[type] ??= []).push(fn);
  },
  off: (type, fn) => {
    mapListeners[type] = (mapListeners[type] ?? []).filter((held) => held !== fn);
  },
  isSourceLoaded: () => true
};

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

/** The layer controller's own order: loading, the module publishes its
 * collection and reports live, then the key registers active. */
function perimetersOn(data = LIVE_PERIMETERS) {
  registry.setStatus(PERIMETER_KEY, 'loading');
  setPerimeterSnapshot(data);
  registry.setStatus(PERIMETER_KEY, 'live');
  registry.activate(PERIMETER_KEY);
}

/** The controller's teardown order: the module withdraws its collection,
 * then the key leaves the registry. */
function perimetersOff() {
  setPerimeterSnapshot(null);
  registry.deactivate(PERIMETER_KEY);
}

/** A refresh: the layer puts another collection on the map and reports it. */
function perimetersRefresh(data) {
  registry.setStatus(PERIMETER_KEY, 'loading');
  setPerimeterSnapshot(data);
  registry.setStatus(PERIMETER_KEY, 'live');
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
 * no published collection, and nothing on the map. */
async function reset() {
  env.onSmoke = null;
  env.onRequest = null;
  env.horizon = 'current';
  env.probeFails = false;
  env.cluster = 'wildfire';
  setPreference(false);
  registry.deactivate('hms-smoke');
  if (registry.getActiveKeys().has(PERIMETER_KEY)) perimetersOff();
  setPerimeterSnapshot(null);
  await settle();
  env.intended = new Set();
  env.requested = [];
  env.layersOn = [];
  sources.clear();
  layers.clear();
  env.legends.clear();
}

initFire3DController(map);

test.afterEach(reset);

// ---------------------------------------------------------------------------
// The scene's own ribbon read
// ---------------------------------------------------------------------------

test('an exit while the scene is still opening leaves no ribbon, and a re-entry builds it afresh', async () => {
  perimetersOn();
  // The exit lands in the smoke step, after the scene's own checks and before
  // the ribbon is raised: only the check after the ribbon import stops it.
  env.onSmoke = () => {
    env.onSmoke = null;
    setPreference(false);
  };
  setPreference(true);
  await settle();
  assert.equal(env.onSmoke, null, 'the exit landed in the smoke step');
  assert.equal(getFire3DStatus().state, 'inactive');

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'the late activation raised no ribbon over the flat map');
  assert.equal(getFire3DStatus().perimeterRibbon, false);
  assert.equal(dataset.ddmFire3dRibbon, undefined);

  await enterScene();
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON, 'the re-entry built the ribbon afresh');
  assert.equal(getFire3DStatus().perimeterRibbon, true);
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

// ---------------------------------------------------------------------------
// The reconcile read (the perimeter layer's own seams)
// ---------------------------------------------------------------------------

test('the perimeter layer going off right after it reported leaves no ribbon, and the stamp reads off', async () => {
  await enterScene();
  assert.equal(dataset.ddmFire3dRibbon, 'off');

  perimetersOn();
  // A refresh of the layer lands, then the person turns the layer off.
  registry.setStatus(PERIMETER_KEY, 'live');
  perimetersOff();
  await settle();

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'no ribbon stands over a perimeter layer that is off');
  assert.equal(getFire3DStatus().state, 'active');
  assert.equal(getFire3DStatus().perimeterRibbon, false);
  assert.equal(dataset.ddmFire3dRibbon, 'off');
});

test('a scene exit right after the perimeters landed leaves no ribbon on the flat map', async () => {
  await enterScene();
  perimetersOn();

  setPreference(false);
  assert.equal(getFire3DStatus().state, 'inactive');
  await settle();

  assert.deepEqual(ribbonOnMap(), NO_RIBBON, 'the late answer raised no ribbon after the exit');
  assert.equal(dataset.ddmFire3dRibbon, undefined);
});

test('smoke whose source lands after the layer registered gets its volume on the status report', async () => {
  await enterScene();
  let attempts = 0;
  env.onSmoke = () => {
    attempts += 1;
  };
  // The smoke layer registers before its fetch returns: no source yet.
  registry.activate('hms-smoke');
  const early = attempts;

  // The fetch lands, the source is added, then the layer reports.
  registry.setStatus('hms-smoke', 'ready');
  assert.ok(attempts > early, 'the status report retried the volume');
});

// ---------------------------------------------------------------------------
// The terrain source's own failures
// ---------------------------------------------------------------------------

test('a terrain archive failure with no tile rolls the scene back, and a tile error alone does not', async () => {
  await enterScene();
  const emitError = (event) => {
    for (const fn of [...(mapListeners.error ?? [])]) fn(event);
  };

  // A failed tile is the three-tile watch's evidence, not this listener's.
  emitError({ sourceId: 'fire3d-terrain-dem', tile: {}, error: new Error('one tile') });
  assert.equal(getFire3DStatus().state, 'active');

  // Another source's header failure is not the scene's.
  emitError({ sourceId: 'hillshade', error: new Error('other source') });
  assert.equal(getFire3DStatus().state, 'active');

  // A header or directory read failed: one source-level error, no tile.
  emitError({ sourceId: 'fire3d-terrain-dem', error: new Error('PMTiles read timed out') });
  assert.equal(getFire3DStatus().state, 'unavailable');
  assert.equal(sources.has('fire3d-terrain-dem'), false);
  assert.equal(mapListeners.error?.length ?? 0, 0, 'the listener left with the scene');
});

// ---------------------------------------------------------------------------
// 3D never changes the layer choices (a shared link, a widened window or the
// 3D button)
// ---------------------------------------------------------------------------

test('entering, failing or leaving the scene with flat Fuel risk on never changes the mode or the layers', async () => {
  const WITH_FUEL = ['nifc-fires', 'hms-smoke', 'usfs-whp'];

  // The terrain archive is unreachable: the scene never opens.
  env.probeFails = true;
  env.intended = new Set(WITH_FUEL);
  setPreference(true);
  await until(() => getFire3DStatus().state === 'unavailable', 'the probe failed');
  env.probeFails = false;

  // The terrain source fails after the scene opened.
  await enterScene();
  for (const fn of [...(mapListeners.error ?? [])]) {
    fn({ sourceId: 'fire3d-terrain-dem', error: new Error('PMTiles read timed out') });
  }
  assert.equal(getFire3DStatus().state, 'unavailable');

  // The scene opens and the person turns 3D off.
  await enterScene();
  setPreference(false);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive');

  assert.deepEqual(env.requested, [], 'no mode was requested');
  assert.deepEqual(env.layersOn, [], 'no layer was turned on');
  assert.deepEqual([...env.intended], WITH_FUEL, 'the layer choices stand');
});

// ---------------------------------------------------------------------------
// What must not change
// ---------------------------------------------------------------------------

test('the layer off and on again ends with exactly the ribbon the layer now holds', async () => {
  await enterScene();
  perimetersOn();
  perimetersOff();
  perimetersOn();
  await settle();

  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(getFire3DStatus().perimeterRibbon, true);
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('perimeters that land after an earlier empty answer still raise the ribbon', async () => {
  // The flat layer is on but its first answer held no wildfire perimeter.
  setPerimeterSnapshot(NO_PERIMETERS);
  registry.setStatus(PERIMETER_KEY, 'live');
  registry.activate(PERIMETER_KEY);
  await enterScene();
  assert.equal(dataset.ddmFire3dRibbon, 'off');

  perimetersRefresh(LIVE_PERIMETERS);
  await settle();

  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('when two answers land back to back, the ribbon stands over the newer one', async () => {
  const ONE_PERIMETER = { type: 'FeatureCollection', features: [LIVE_PERIMETERS.features[0]] };
  await enterScene();
  perimetersOn(ONE_PERIMETER);
  perimetersRefresh(LIVE_PERIMETERS);
  await settle();

  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(
    sources.get(RIBBON_SOURCE_ID).data.features.length,
    LIVE_PERIMETERS.features.length,
    'the ribbon raised every perimeter of the newer answer'
  );
  assert.equal(dataset.ddmFire3dRibbon, 'on');
});

test('a refresh that lands different perimeters rebuilds the standing ribbon over them', async () => {
  perimetersOn({ type: 'FeatureCollection', features: [LIVE_PERIMETERS.features[0]] });
  await enterScene();
  assert.equal(sources.get(RIBBON_SOURCE_ID).data.features.length, 1);

  // A pan to other fires: the layer swaps new perimeters into its source.
  perimetersRefresh(LIVE_PERIMETERS);
  await settle();
  assert.deepEqual(ribbonOnMap(), FULL_RIBBON);
  assert.equal(
    sources.get(RIBBON_SOURCE_ID).data.features.length,
    LIVE_PERIMETERS.features.length,
    'the ribbon follows the perimeters the layer holds now'
  );

  // The same collection reported again changes nothing: the standing ribbon's data is the same object.
  const standing = sources.get(RIBBON_SOURCE_ID).data;
  perimetersRefresh(LIVE_PERIMETERS);
  await settle();
  assert.equal(sources.get(RIBBON_SOURCE_ID).data, standing);

  // A pan to a view with no wildfire perimeter takes the ribbon down.
  perimetersRefresh(NO_PERIMETERS);
  await settle();
  assert.deepEqual(ribbonOnMap(), NO_RIBBON);
  assert.equal(dataset.ddmFire3dRibbon, 'off');
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
