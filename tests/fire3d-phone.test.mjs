import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 3D on phones (owner direction 2026-11-09 (sprint), DR-pending): the gate
 * that admits a phone, the decision of what stands where its 3D cell would
 * be, the camera pad's arithmetic, and the constants and sentences that
 * must stay equal across files.
 *
 * Three kinds of proof, all browser-free:
 *   - the pure decisions (`fire3dPhoneOffer`, the pad's targets and compass);
 *   - the REAL orchestrator (src/map/fire3d.ts) driven through a fake phone:
 *     a window whose media queries answer from a width and a height, and an
 *     `#app` whose attributes the test sets, so "no card, no scene" and the
 *     per-shell height floor are proven at the gate itself;
 *   - text mirrors, read from source, for values the bundler keeps in
 *     different chunks and therefore cannot share by import.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

globalThis.fetch = () => {
  throw new Error('unexpected network call from a node test');
};

const env = {
  preference: false,
  preferenceListeners: [],
  cluster: 'wildfire',
  width: 1280,
  height: 800,
  attributes: new Set(),
  observers: []
};
globalThis.__fire3dPhoneEnv = env;

const STUBS = {
  '/config/urls': 'export const URLS = { terrainPmtilesDeep: "unused-deep-archive" };',
  '/layers/hillshade':
    'export async function resolveHillshadeArchive() { throw new Error("unused"); }',
  '/util/pmtiles-probe':
    'export async function probeArchiveHeader() { return { maxZoom: 10, minZoom: 0, west: -125, south: 41.5, east: -110.5, north: 49.5 }; }',
  './gl-capability':
    'export function watchContextLoss() { return () => {}; } export function webGl2Capability() { return { webgl2: true }; }',
  '/state/cluster-service':
    'const env = globalThis.__fire3dPhoneEnv; export function getCommittedSnapshot() { return { cluster: env.cluster, horizon: "current", intendedKeys: new Set() }; } export function onCommittedSnapshotChange() { return () => {}; } export function requestCluster() {}',
  '/state/fire3d-store':
    'const env = globalThis.__fire3dPhoneEnv; export function getFire3DPreference() { return env.preference; } export function onFire3DPreferenceChange(fn) { env.preferenceListeners.push(fn); return () => {}; } export function setFire3DPreference(next) { env.preference = next; }',
  '/ui/overlay': 'export function showToast() {}',
  '/util/motion': 'export function prefersReducedMotion() { return true; }',
  '/util/raster-error-watch':
    'export function watchRasterTiles() { return { detach() {} }; }',
  '/layers/hms-smoke-volume':
    'export function activateSmokeVolume() { return false; } export function deactivateSmokeVolume() {} export function cleanupOrphanedSmokeSource() {}',
  '/layers/nifc-perimeter-ribbon':
    'export function activatePerimeterRibbon() { return false; } export function deactivatePerimeterRibbon() {}',
  '/layers/wildfire-dryness':
    'export async function activateWildfireDryness() {} export function getDrynessSourceId() { return null; }',
  './fire3d-context':
    'export async function activateContextLayers() { return { keys: [], embedLines: [] }; } export function deactivateContextLayers() {}',
  '/map/layer-order':
    'export function reassertLabelOrder() {} export function reassertThematicOrder() {}'
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

// A window whose media queries answer from the fake viewport, and an #app
// whose attributes the test sets. MutationObserver callbacks are kept so a
// test can deliver the change the browser would.
const mediaListeners = [];
globalThis.window = {
  get innerHeight() {
    return env.height;
  },
  matchMedia: (query) => {
    const width = /min-width:\s*(\d+)px/.exec(query);
    const height = /min-height:\s*(\d+)px/.exec(query);
    return {
      get matches() {
        return (
          (!width || env.width >= Number(width[1])) && (!height || env.height >= Number(height[1]))
        );
      },
      addEventListener: (_type, fn) => {
        mediaListeners.push(fn);
      },
      removeEventListener() {}
    };
  }
};
const app = { hasAttribute: (name) => env.attributes.has(name) };
globalThis.document = {
  documentElement: { dataset: {} },
  querySelector: () => null,
  getElementById: (id) => (id === 'app' ? app : null)
};
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe(_node, options) {
    env.observers.push({ callback: this.callback, filter: options.attributeFilter ?? [] });
  }
};

const gate = await import('../src/config/fire3d-phone.ts');
const camera = await import('../src/config/fire3d-camera.ts');
const presentation = await import('../src/config/fire3d-presentation.ts');
const { initFire3DController, getFire3DStatus, onFire3DStatusChange, shouldFire3DBeActive } =
  await import('../src/map/fire3d.ts');

// ---------------------------------------------------------------------------
// Values that must stay equal across chunks
// ---------------------------------------------------------------------------

test('the two width constants moved together, to the phone floor', () => {
  const store = /FIRE3D_CHUNK_WIDTH_QUERY = '([^']+)'/.exec(read('src/state/fire3d-store.ts'));
  assert.ok(store, 'the store declares FIRE3D_CHUNK_WIDTH_QUERY as a literal');
  assert.equal(store[1], presentation.FIRE3D_MIN_WIDTH_QUERY);
  assert.equal(store[1], `(min-width: ${gate.FIRE3D_PHONE_MIN_WIDTH_PX}px)`);
});

test('the console keeps the desktop breakpoint and its own floor', () => {
  // The console's width is the shell's breakpoint, typed in each module that needs it.
  const shell = /DESKTOP_SHELL_QUERY = '([^']+)'/.exec(read('src/ui/island/shell.tsx'));
  const sidebar = /SIDEBAR_DESKTOP_QUERY = '([^']+)'/.exec(read('src/state/url.ts'));
  assert.equal(presentation.FIRE3D_CONSOLE_WIDTH_QUERY, shell?.[1]);
  assert.equal(presentation.FIRE3D_CONSOLE_WIDTH_QUERY, sidebar?.[1]);
  assert.equal(presentation.FIRE3D_MIN_HEIGHT_PX, 520);
  assert.ok(gate.FIRE3D_PHONE_MIN_HEIGHT_PX > presentation.FIRE3D_MIN_HEIGHT_PX);
  assert.equal(gate.FIRE3D_PHONE_MIN_HEIGHT_QUERY, `(min-height: ${gate.FIRE3D_PHONE_MIN_HEIGHT_PX}px)`);
});

test('the console control asks the console width, never the scene floor', () => {
  const control = read('src/ui/island/fire3d-control.tsx');
  assert.match(control, /matchMedia\(FIRE3D_CONSOLE_WIDTH_QUERY\)/);
  assert.doesNotMatch(control, /FIRE3D_MIN_WIDTH_QUERY/);
});

test('the phone card speaks the console control\'s own status sentences', () => {
  const control = read('src/ui/island/fire3d-control.tsx');
  const scene = read('src/ui/fire3d-phone-scene.ts');
  for (const sentence of [
    'Live: terrain relief with the smoke volume.',
    'Live (partial): terrain relief; smoke is unavailable.',
    'Live (partial): terrain relief; smoke stays in the flat veil.',
    'No current smoke plumes in view; the issuer returned none for this area.'
  ]) {
    assert.ok(control.includes(`'${sentence}'`), `the console says: ${sentence}`);
    assert.ok(scene.includes(`'${sentence}'`), `the phone card says: ${sentence}`);
  }
  // The two statements and the coverage answers are the config's constants, never retyped.
  for (const name of [
    'FIRE3D_NON_PREDICTION_NOTE',
    'FIRE3D_COVERAGE_NOTE',
    'fire3dCoverageNote',
    'FIRE3D_OUT_OF_COVERAGE_STATUS',
    'FIRE3D_PARTIAL_COVERAGE_STATUS'
  ]) {
    assert.ok(scene.includes(name), `the phone card reads ${name}`);
  }
  assert.doesNotMatch(scene, /computes no fire behavior/, 'the disclosure is not retyped');
});

test('the failure sentence said before the scene loads is the failure ladder\'s own', () => {
  const sentence = '3D Fire view unavailable; the flat map remains accurate.';
  assert.ok(read('src/map/fire3d.ts').includes(`'${sentence}'`));
  assert.ok(read('src/ui/fire3d-phone.ts').includes(`'${sentence}'`));
});

test('a phone refusal reuses the console\'s sentences and adds only the narrow one', () => {
  assert.equal(
    presentation.FIRE3D_PHONE_REFUSAL_TEXT['short-window'],
    presentation.FIRE3D_REFUSAL_TEXT['short-window']
  );
  assert.equal(
    presentation.FIRE3D_PHONE_REFUSAL_TEXT['no-webgl2'],
    presentation.FIRE3D_REFUSAL_TEXT['no-webgl2']
  );
  assert.match(presentation.FIRE3D_PHONE_REFUSAL_TEXT['narrow-window'], /too narrow for the 3D Fire view/);
});

// ---------------------------------------------------------------------------
// What stands where the 3D cell would be
// ---------------------------------------------------------------------------

const capable = {
  phoneShell: true,
  fireView: true,
  webgl2: true,
  wideEnough: true,
  tallEnough: true
};

test('the cell is offered only in the Fire view on a phone that can hold the scene', () => {
  assert.equal(gate.fire3dPhoneOffer(capable), 'cell');
  // Another hazard view, a desktop or an embed: 3D is not the subject, so nothing is said.
  assert.equal(gate.fire3dPhoneOffer({ ...capable, fireView: false }), 'silent');
  assert.equal(gate.fire3dPhoneOffer({ ...capable, phoneShell: false }), 'silent');
  assert.equal(
    gate.fire3dPhoneOffer({ ...capable, phoneShell: false, webgl2: false, tallEnough: false }),
    'silent'
  );
});

test('a refusal names what was observed, the deeper one first', () => {
  assert.equal(gate.fire3dPhoneOffer({ ...capable, webgl2: false }), 'no-webgl2');
  assert.equal(gate.fire3dPhoneOffer({ ...capable, wideEnough: false }), 'narrow-window');
  assert.equal(gate.fire3dPhoneOffer({ ...capable, tallEnough: false }), 'short-window');
  assert.equal(
    gate.fire3dPhoneOffer({ ...capable, webgl2: false, wideEnough: false, tallEnough: false }),
    'no-webgl2'
  );
  assert.equal(
    gate.fire3dPhoneOffer({ ...capable, wideEnough: false, tallEnough: false }),
    'narrow-window'
  );
  for (const refusal of ['no-webgl2', 'narrow-window', 'short-window']) {
    assert.ok(presentation.FIRE3D_PHONE_REFUSAL_TEXT[refusal].length > 0);
  }
});

// ---------------------------------------------------------------------------
// The camera pad
// ---------------------------------------------------------------------------

const limits = { maxPitch: 85, homePitch: 60 };

test('tilting stops at the ground and at the map\'s ceiling', () => {
  const start = { pitch: 60, bearing: 0 };
  assert.deepEqual(camera.fire3dPadTarget('tilt-up', start, limits), { pitch: 70, bearing: 0 });
  assert.deepEqual(camera.fire3dPadTarget('tilt-down', start, limits), { pitch: 50, bearing: 0 });
  assert.equal(camera.fire3dPadTarget('tilt-up', { pitch: 80, bearing: 0 }, limits).pitch, 85);
  assert.equal(camera.fire3dPadTarget('tilt-down', { pitch: 4, bearing: 0 }, limits).pitch, 0);
  assert.equal(camera.fire3dPadAtStop('tilt-up', { pitch: 85, bearing: 0 }, limits), true);
  assert.equal(camera.fire3dPadAtStop('tilt-down', { pitch: 0, bearing: 0 }, limits), true);
  assert.equal(camera.fire3dPadAtStop('tilt-up', start, limits), false);
});

test('turning right raises the bearing by one compass point and never drifts off the sixteen', () => {
  let view = { pitch: 60, bearing: 0 };
  const seen = [];
  for (let i = 0; i < 16; i += 1) {
    view = camera.fire3dPadTarget('rotate-right', view, limits);
    seen.push(view.bearing);
    assert.ok(view.bearing > -180 && view.bearing <= 180, `bearing ${view.bearing} is in range`);
  }
  assert.equal(seen[0], 22.5);
  assert.equal(seen[7], 180);
  assert.equal(seen[8], -157.5);
  assert.equal(seen[15], 0, 'sixteen presses come back to north');
  assert.equal(camera.fire3dPadTarget('rotate-left', { pitch: 60, bearing: 0 }, limits).bearing, -22.5);
  // A gesture can leave the bearing anywhere; the next press lands on a point.
  assert.equal(camera.fire3dPadTarget('rotate-right', { pitch: 60, bearing: 10 }, limits).bearing, 22.5);
  assert.equal(camera.fire3dPadTarget('rotate-left', { pitch: 60, bearing: 10 }, limits).bearing, -22.5);
});

test('the compass resets to north up at the opening tilt, and says when it is already there', () => {
  assert.deepEqual(camera.fire3dPadTarget('reset', { pitch: 20, bearing: 135 }, limits), {
    pitch: 60,
    bearing: 0
  });
  assert.equal(camera.fire3dPadAtStop('reset', { pitch: 60, bearing: 0 }, limits), true);
  assert.equal(camera.fire3dPadAtStop('reset', { pitch: 60, bearing: 22.5 }, limits), false);
  assert.equal(camera.fire3dPadAtStop('reset', { pitch: 50, bearing: 0 }, limits), false);
});

test('the compass names the direction at the top of the screen', () => {
  assert.equal(camera.fire3dCompassPoint(0).short, 'N');
  assert.equal(camera.fire3dCompassPoint(22.5).short, 'NNE');
  assert.equal(camera.fire3dCompassPoint(90).long, 'east');
  assert.equal(camera.fire3dCompassPoint(180).short, 'S');
  assert.equal(camera.fire3dCompassPoint(-90).short, 'W');
  assert.equal(camera.fire3dCompassPoint(-22.5).short, 'NNW');
  assert.equal(camera.fire3dCompassPoint(359).short, 'N');
  assert.match(
    camera.fire3dCompassName({ pitch: 60, bearing: 45 }),
    /^Reset the 3D view: north up, opening tilt\. Now facing northeast, tilted 60 degrees\.$/
  );
  assert.equal(
    camera.fire3dCameraAnnouncement({ pitch: 49.6, bearing: -90 }),
    'Facing west, tilted 50 degrees.'
  );
});

test('the pad lists five actions, the compass in the middle', () => {
  assert.deepEqual(camera.FIRE3D_PAD_ACTIONS, [
    'tilt-up',
    'rotate-left',
    'reset',
    'rotate-right',
    'tilt-down'
  ]);
  assert.equal(camera.normalizeBearing(540), 180);
  assert.equal(camera.normalizeBearing(-180), 180);
  assert.equal(camera.normalizeBearing(-190), 170);
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

const gateBase = {
  preference: true,
  desktopViewport: true,
  committedCluster: 'wildfire',
  activeLayerKeys: new Set(),
  currentlyActive: false,
  webgl2: true
};

test('the pure gate keeps the console floor unless a shell names its own', () => {
  assert.equal(shouldFire3DBeActive({ ...gateBase, viewportHeight: 553 }), true);
  assert.equal(shouldFire3DBeActive({ ...gateBase, viewportHeight: 519 }), false);
  const phone = { ...gateBase, minViewportHeight: gate.FIRE3D_PHONE_MIN_HEIGHT_PX };
  assert.equal(shouldFire3DBeActive({ ...phone, viewportHeight: 553 }), false);
  assert.equal(
    shouldFire3DBeActive({ ...phone, viewportHeight: gate.FIRE3D_PHONE_MIN_HEIGHT_PX }),
    true
  );
  assert.equal(
    shouldFire3DBeActive({ ...phone, viewportHeight: gate.FIRE3D_PHONE_MIN_HEIGHT_PX - 1 }),
    false
  );
});

// The orchestrator, driven through the fake phone.

const sources = new Map();
const layers = new Map();
const listeners = {};
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
  getStyle: () => ({ layers: [] }),
  moveLayer() {},
  getPitch: () => 0,
  getBearing: () => 0,
  getCenter: () => ({ lng: -119, lat: 45.5 }),
  setTerrain() {},
  setSky() {},
  jumpTo() {},
  easeTo() {},
  on: (type, fn) => {
    (listeners[type] ??= []).push(fn);
  },
  off: (type, fn) => {
    listeners[type] = (listeners[type] ?? []).filter((held) => held !== fn);
  },
  isSourceLoaded: () => true
};

async function settle() {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setPreference(next) {
  env.preference = next;
  for (const fn of env.preferenceListeners) fn();
}

/** Set the fake viewport and deliver the media-query changes a resize would. */
function resize(width, height) {
  env.width = width;
  env.height = height;
  for (const fn of mediaListeners) fn();
}

/** Stamp or clear the phone chrome's attribute and deliver the mutation. */
function setChrome(mounted) {
  if (mounted) env.attributes.add(gate.FIRE3D_PHONE_CHROME_ATTRIBUTE);
  else env.attributes.delete(gate.FIRE3D_PHONE_CHROME_ATTRIBUTE);
  for (const observer of env.observers) {
    if (observer.filter.includes(gate.FIRE3D_PHONE_CHROME_ATTRIBUTE)) observer.callback();
  }
}

initFire3DController(map);
const seen = [];
onFire3DStatusChange(() => {
  const status = getFire3DStatus();
  seen.push(`${status.state}:${status.phase ?? '-'}`);
});

async function leave() {
  setPreference(false);
  setChrome(false);
  resize(1280, 800);
  await settle();
  seen.length = 0;
}

test('the orchestrator watches the phone chrome\'s attribute', () => {
  assert.ok(
    env.observers.some((observer) => observer.filter.includes(gate.FIRE3D_PHONE_CHROME_ATTRIBUTE)),
    'a MutationObserver is registered for the attribute'
  );
});

test('no card, no scene: a phone enters only once its 3D chrome is mounted, and leaves when it goes', async () => {
  resize(390, 844);
  setPreference(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive', 'asked for, but no card: no scene');
  assert.equal(sources.size, 0);

  setChrome(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'active', 'the card is mounted: the scene enters');
  assert.ok(sources.has('fire3d-terrain-dem'), 'the scene installed its terrain source');

  setChrome(false);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive', 'the card left: the scene left with it');
  assert.equal(sources.size, 0, 'no source is left behind');
  assert.equal(layers.size, 0, 'no layer is left behind');
  assert.equal((listeners['moveend'] ?? []).length, 0, 'no camera listener is left behind');
  await leave();
});

test('an entry publishes the steps it really waits on, in order, and none once it is live', async () => {
  resize(390, 844);
  setChrome(true);
  setPreference(true);
  await settle();
  assert.deepEqual(seen.filter((entry, index) => seen.indexOf(entry) === index), [
    'checking:probe',
    'checking:atmosphere',
    'checking:context',
    'active:-'
  ]);
  assert.equal(getFire3DStatus().phase, null);
  await leave();
  assert.equal(getFire3DStatus().phase, null);
});

test('each shell keeps its own height floor', async () => {
  // 375 by 553: under the phone floor, over the console's.
  resize(375, 553);
  setChrome(true);
  setPreference(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive', 'a phone under its floor stays flat');

  // The same height at the console's width is the console's to judge.
  setChrome(false);
  resize(1024, 553);
  await settle();
  assert.equal(getFire3DStatus().state, 'active', 'the console floor is unchanged at 520');

  // A phone on its side inside the desktop shell stays out, as before.
  resize(844, 390);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive');
  await leave();
});

test('a phone narrower than the floor, and a phone-width embed, stay flat', async () => {
  resize(320, 700);
  setChrome(true);
  setPreference(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive', 'narrower than the width floor');

  // An embed at phone width has no phone shell, so no chrome is ever mounted.
  setChrome(false);
  resize(390, 844);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive', 'no chrome, no scene');
  await leave();
});

test('growing past the floor lets a kept preference re-apply', async () => {
  resize(390, 560);
  setChrome(true);
  setPreference(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive');
  resize(390, 700);
  await settle();
  assert.equal(getFire3DStatus().state, 'active', 'the preference outlived the short window');
  await leave();
});
