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
  observers: [],
  // Reduced motion by default: the scene's camera changes are jumps unless a
  // test asks for the eases a person without that preference gets.
  reduced: true
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
  '/util/motion':
    'export function prefersReducedMotion() { return globalThis.__fire3dPhoneEnv.reduced; }',
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

test('the scene and the phone chrome stay behind dynamic imports', () => {
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const cell = strip(read('src/ui/fire3d-phone.ts'));
  // The entry cell reaches its chrome only through import(), and never the scene's own modules.
  assert.match(cell, /import\('\.\/fire3d-phone-scene'\)/);
  assert.doesNotMatch(cell, /import (?!type)[^;]*from '\.\/fire3d-phone-scene'/);
  assert.doesNotMatch(cell, /from '\.\.\/map\/fire3d'/);
  assert.doesNotMatch(cell, /fire3d-presentation|fire3d-camera/);
  // The boot path names the cell module and nothing lazier than it.
  const main = strip(read('src/main.ts'));
  assert.match(main, /import \{ initFire3DPhone \} from '\.\/ui\/fire3d-phone'/);
  assert.doesNotMatch(main, /fire3d-phone-scene|from '\.\/map\/fire3d'/);
  // A phone loads the scene when the URL names the mode; the committed view alone loads it only for the console.
  assert.match(
    main,
    /parseFire3dParam\(\) \|\|\s*\(fire3dConsole\.matches && getCommittedSnapshot\(\)\.cluster === 'wildfire'\)/
  );
});

test('the phone press commits the Wildfire view and leaves the basemap to the scene\'s own hold', () => {
  const cell = read('src/ui/fire3d-phone.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.match(cell, /requestCluster\('wildfire'\)/);
  // DR-105 (src/map/basemap-switcher.ts, holdSatellite): the store keeps the
  // visitor's choice and releasing the hold brings the imagery back. A press
  // that reset the basemap would leave the phone's Fire view without the
  // imagery it opened on once the scene left.
  assert.doesNotMatch(cell, /requestBasemapMode|setBasemapMode|defaultBasemapFor|basemap-switcher|basemap-store/);
  const switcher = read('src/map/basemap-switcher.ts');
  assert.match(switcher, /export function holdSatellite\(/);
  assert.match(read('src/map/fire3d.ts'), /holdSatellite\(map, status\.state === 'checking' \|\| status\.state === 'active'\)/);
});

test('the phone stylesheet keeps the three design rules', () => {
  const css = read('src/styles/fire3d-phone.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // Colour belongs to the data: glass and ink come from the tokens, never a literal.
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour');
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/, 'no literal colour function');
  // Tight corners: every radius is a token, zero, or the 1 px of the bar.
  const radii = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(radii.length > 0);
  for (const value of radii) {
    for (const part of value.split(/\s+/)) {
      assert.match(part, /^(?:0|1px|var\(--(?:glass-radius|radius-md|radius-sm)\))$/, `radius ${value}`);
    }
  }
  // Even outlines: no side is given a border of its own.
  assert.doesNotMatch(css, /border-(?:top|right|bottom|left)(?:-width)?\s*:/);
  // Motion is transform and opacity only.
  const keyframes = [...css.matchAll(/@keyframes [\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
  assert.equal(keyframes.length, 3, 'the card, the pad and the band');
  for (const [, body] of keyframes) {
    const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
    assert.ok(properties.length > 0);
    for (const property of properties) {
      assert.ok(['transform', 'opacity'].includes(property), `keyframes animate ${property}`);
    }
  }
  // Every motion has its reduced twin.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // Phone chrome only: everything is keyed on the phone shell's attribute or sits inside the phone width.
  assert.match(css, /\.fire3d-card,\s*\.fire3d-pad\s*\{\s*display:\s*none;/);
});

test('Locate\'s card waits where it would meet the 3D card, and the pad waits for Locate\'s card', () => {
  // Locate's card rides the map dock above the sheet's furniture; this card
  // holds the top of the map. Where the two would meet, the Locate card is
  // hidden (never covered, never reachable under the 3D card) and keeps its
  // box, so the decision cannot flicker; the pad, a convenience the
  // gestures also give, steps aside for Locate's reading.
  const scene = read('src/ui/fire3d-phone-scene.ts');
  const css = read('src/styles/fire3d-phone.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const attribute = scene.match(/const LOCATE_WAITS_ATTRIBUTE = '([a-z0-9-]+)';/)?.[1];
  assert.ok(attribute, 'the scene names the attribute it sets');
  assert.match(scene, /const LOCATE_CARD_ID = 'locate-card';/);
  assert.match(read('src/ui/locate-card.ts'), /card\.id = 'locate-card';/, 'the id is Locate\'s own');
  assert.match(scene, /const LOCATE_CELL_ID = 'locate-btn';/);
  assert.match(read('src/ui/locate-control.ts'), /'locate-btn'/, 'focus goes back to the cell Locate itself uses');
  const rule = new RegExp(`#app\\[data-sheet-detent\\]\\[data-fire3d-card\\] \\.locate-card\\[${attribute}\\]\\s*\\{\\s*visibility:\\s*hidden;\\s*\\}`);
  assert.match(css, rule, 'waiting is hidden, not display:none, so the box stays');
  // The attribute is cleared when the 3D card leaves, so it never outlives the reason.
  assert.match(scene, /removeAttribute\(LOCATE_WAITS_ATTRIBUTE\)[\s\S]*app\.removeAttribute\(CARD_ATTRIBUTE\)/);
  // The pad's test against Locate's card uses the same clearance as against the 3D card.
  assert.match(scene, /show = !meets\(/);
  // Unfolded, Locate's plate scrolls under this card instead of growing into it.
  assert.match(css, /\[data-fire3d-card\] \.locate-card-plate\s*\{\s*max-height:/);
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

// The PLACE studio's clean display sets the Fire layers aside and puts them
// back (owner direction 2026-11-09 (sprint), DR-pending). Seen on the sprint
// camera before the hold: a PLACE round trip tore the scene down and entered
// it again from the start.
test('the PLACE studio hold keeps a running scene through its set-aside, and nothing more', () => {
  const setAside = { ...gateBase, committedCluster: 'custom', activeLayerKeys: new Set(['aiannh']) };
  assert.equal(shouldFire3DBeActive({ ...setAside, currentlyActive: true }), false, 'without the hold it exits');
  assert.equal(shouldFire3DBeActive({ ...setAside, currentlyActive: true, studioHold: true }), true, 'held, it stays');
  assert.equal(shouldFire3DBeActive({ ...setAside, studioHold: true }), false, 'the hold never enters a scene');
  assert.equal(
    shouldFire3DBeActive({ ...setAside, committedCluster: 'drought', currentlyActive: true, studioHold: true }),
    false,
    'a switch to another cluster still exits'
  );
  for (const refusal of [{ preference: false }, { desktopViewport: false }, { webgl2: false }, { viewportHeight: 400 }]) {
    assert.equal(
      shouldFire3DBeActive({ ...setAside, currentlyActive: true, studioHold: true, ...refusal }),
      false,
      `the hold never outlasts ${JSON.stringify(refusal)}`
    );
  }
});

test('the hold is on from the capture and off only after the restore has finished', async () => {
  const { readFile } = await import('node:fs/promises');
  const snap = await readFile(new URL('../src/state/display-snapshot.ts', import.meta.url), 'utf8');
  const begin = snap.slice(
    snap.indexOf('export function beginPlaceStudioDisplay'),
    snap.indexOf('export function setPlaceStudioDisplayKind')
  );
  const on = begin.indexOf('setPlaceDisplayHeld(true)');
  assert.ok(on > begin.indexOf('captureDisplaySnapshot()'), 'on after the capture');
  assert.ok(on < begin.indexOf('enforceCleanIntent()'), 'on before anything is set aside');
  const restore = snap.slice(snap.indexOf('export function restoreDisplaySnapshot'));
  const off = restore.indexOf('setPlaceDisplayHeld(false)');
  const cluster = restore.indexOf('restoreCommittedCluster(');
  assert.ok(cluster > 0 && off > cluster, 'off only after the cluster is back');
  assert.ok(restore.lastIndexOf('finally', off) > cluster, 'released in a finally');
  const runtime = await readFile(new URL('../src/map/fire3d.ts', import.meta.url), 'utf8');
  assert.match(runtime, /studioHold: isPlaceDisplayHeld\(\)/, 'the runtime gate reads the hold');
});

// Review finding R2-5, measured on the sprint camera: a phone link that opens
// inside the PLACE studio with 3D asked for, whose 3D chrome arrived after
// the studio's clean display, withdrew the ask (fire3d=true left the URL) and,
// after Back, blamed "the layers you added" on layers nobody added.
test('the phone chrome lets a 3D ask wait while the PLACE studio holds the display', async () => {
  const { readFile } = await import('node:fs/promises');
  const chrome = await readFile(new URL('../src/ui/fire3d-phone-scene.ts', import.meta.url), 'utf8');
  const set = chrome.slice(chrome.indexOf('set(offer: Fire3DPhoneOffer, asked: boolean): void {'));
  const wait = set.indexOf('if (isPlaceDisplayHeld()) return;');
  const refuse = set.indexOf('failure = CUSTOM_SET_UNAVAILABLE;');
  assert.ok(wait > 0 && refuse > wait, 'the hold is read before the custom-set refusal');
  assert.ok(set.indexOf('setFire3DPreference(false)') > wait, 'and before the ask is withdrawn');
  assert.match(chrome, /import \{ isPlaceDisplayHeld \} from '\.\.\/state\/place-display-hold';/);
});

// The orchestrator, driven through the fake phone.

const sources = new Map();
const layers = new Map();
const listeners = {};
/** The fake camera. `ease` is an ease in flight; `hand` is a person's gesture. */
const cam = { pitch: 0, bearing: 0, ease: null, hand: false, calls: [] };
const emit = (type) => {
  for (const fn of [...(listeners[type] ?? [])]) fn({});
};
const turn = (options) => {
  if (typeof options.pitch === 'number') cam.pitch = options.pitch;
  if (typeof options.bearing === 'number') cam.bearing = options.bearing;
};
/** Stop the ease in flight where it stands, the way any newer camera call does. */
function stopEase() {
  if (cam.ease === null) return;
  cam.ease = null;
  emit('moveend');
}
/** Move the ease in flight part of its way and leave it running. */
function easePartWay(fraction) {
  const { from, to } = cam.ease;
  if (typeof to.pitch === 'number') cam.pitch = from.pitch + (to.pitch - from.pitch) * fraction;
  if (typeof to.bearing === 'number') cam.bearing = from.bearing + (to.bearing - from.bearing) * fraction;
}
/** Let the ease in flight run its course. */
function finishEase() {
  const { to } = cam.ease;
  turn(to);
  cam.ease = null;
  emit('moveend');
}
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
  getPitch: () => cam.pitch,
  getBearing: () => cam.bearing,
  getCenter: () => ({ lng: -119, lat: 45.5 }),
  setTerrain() {},
  setSky() {},
  isMoving: () => cam.ease !== null || cam.hand,
  // MapLibre's order: a new camera call first stops the ease in flight, which
  // ends with that ease's own moveend, and only then does its own work.
  jumpTo(options) {
    cam.calls.push(['jumpTo', options]);
    stopEase();
    turn(options);
    emit('moveend');
  },
  easeTo(options) {
    cam.calls.push(['easeTo', options]);
    stopEase();
    cam.ease = { from: { pitch: cam.pitch, bearing: cam.bearing }, to: options };
  },
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

// ---------------------------------------------------------------------------
// Leaving hands the camera back, and finishes the job
// ---------------------------------------------------------------------------

/** Enter the scene on the fake phone with eases on, and let the opening tilt run its course. */
async function enterTilted() {
  env.reduced = false;
  cam.pitch = 0;
  cam.bearing = 0;
  cam.ease = null;
  cam.hand = false;
  resize(390, 844);
  setChrome(true);
  setPreference(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'active');
  finishEase();
  assert.equal(cam.pitch, presentation.FIRE3D_PITCH_DEGREES, 'the opening tilt');
  cam.calls.length = 0;
}

/** Leave whatever the test left behind, with the camera flat and eases off again. */
async function leaveFlat() {
  if (cam.ease !== null) finishEase();
  await leave();
  if (cam.ease !== null) finishEase();
  await settle();
  env.reduced = true;
  cam.pitch = 0;
  cam.bearing = 0;
  cam.hand = false;
  cam.calls.length = 0;
}

const watchers = () => (listeners['moveend'] ?? []).length;
const FLAT = { pitch: 0, bearing: 0 };

test('an exit that runs its course is the one ease it always was, and leaves nothing armed', async () => {
  await enterTilted();
  const before = watchers();
  setChrome(false);
  await settle();
  assert.equal(getFire3DStatus().state, 'inactive');
  assert.deepEqual(cam.calls, [
    ['easeTo', { ...FLAT, duration: presentation.FIRE3D_CAMERA_TRANSITION_MS }]
  ]);
  finishEase();
  await settle();
  assert.deepEqual({ pitch: cam.pitch, bearing: cam.bearing }, FLAT);
  assert.equal(cam.calls.length, 1, 'no second camera call');
  assert.ok(watchers() < before, 'the scene\'s own camera listener is gone and none was left in its place');
  assert.equal(watchers(), 0);
  await leaveFlat();
});

test('an exit cut short by another camera call still ends flat: the phone sheet\'s padding jump', async () => {
  await enterTilted();
  setChrome(false);
  await settle();
  easePartWay(0.3);
  assert.equal(cam.pitch, 42, 'the restore is part of the way down');
  // src/ui/mobile-sheet.ts `settle`: 150 ms after a viewport change.
  map.jumpTo({ padding: { top: 0, left: 0, right: 0, bottom: 0 } });
  await settle();
  assert.deepEqual({ pitch: cam.pitch, bearing: cam.bearing }, FLAT, 'the rest of the turn was paid');
  assert.deepEqual(cam.calls.at(-1), ['jumpTo', FLAT]);
  assert.equal(cam.calls.filter(([kind, options]) => kind === 'jumpTo' && options.pitch === 0).length, 1, 'paid once');
  assert.equal(watchers(), 0, 'nothing is left listening');
  await leaveFlat();
});

test('it waits for the movement that cut it short, then pays', async () => {
  await enterTilted();
  setChrome(false);
  await settle();
  easePartWay(0.5);
  // A region fit: an ease of its own that says nothing about pitch or bearing.
  map.easeTo({ center: [-120, 47], zoom: 6 });
  await settle();
  assert.equal(cam.pitch, 30, 'not while the map is still moving');
  finishEase();
  await settle();
  assert.deepEqual({ pitch: cam.pitch, bearing: cam.bearing }, FLAT);
  assert.equal(watchers(), 0);
  await leaveFlat();
});

test('it stands down when a person takes the tilt', async () => {
  await enterTilted();
  setChrome(false);
  await settle();
  easePartWay(0.3);
  // Two fingers on the glass: the gesture stops the ease, then moves the pitch itself.
  cam.hand = true;
  stopEase();
  await settle();
  cam.pitch = 25;
  cam.hand = false;
  emit('moveend');
  await settle();
  assert.equal(cam.pitch, 25, 'the person\'s tilt is theirs');
  assert.equal(cam.calls.filter(([kind]) => kind === 'jumpTo').length, 0);
  assert.equal(watchers(), 0);
  await leaveFlat();
});

test('a pan during the exit does not keep the scene\'s tilt', async () => {
  await enterTilted();
  setChrome(false);
  await settle();
  easePartWay(0.3);
  // One finger drags the map: the ease stops, the pitch is not touched.
  cam.hand = true;
  stopEase();
  await settle();
  assert.equal(cam.pitch, 42, 'not under the person\'s finger');
  cam.hand = false;
  emit('moveend');
  await settle();
  assert.deepEqual({ pitch: cam.pitch, bearing: cam.bearing }, FLAT);
  await leaveFlat();
});

test('a scene that starts again while the camera is still owed found the flat map, not the half-turned one', async () => {
  await enterTilted();
  setChrome(false);
  await settle();
  easePartWay(0.3);
  assert.equal(cam.pitch, 42);
  // Asked for again before the restore has finished.
  setChrome(true);
  await settle();
  assert.equal(getFire3DStatus().state, 'active');
  finishEase();
  assert.equal(cam.pitch, presentation.FIRE3D_PITCH_DEGREES);
  cam.calls.length = 0;
  setChrome(false);
  await settle();
  assert.deepEqual(cam.calls, [
    ['easeTo', { ...FLAT, duration: presentation.FIRE3D_CAMERA_TRANSITION_MS }]
  ], 'the second exit heads for the camera the first scene found');
  finishEase();
  await settle();
  assert.deepEqual({ pitch: cam.pitch, bearing: cam.bearing }, FLAT);
  assert.equal(watchers(), 0);
  await leaveFlat();
});

test('a reduced-motion exit is a jump and arms nothing', async () => {
  env.reduced = true;
  cam.pitch = 0;
  cam.bearing = 0;
  resize(390, 844);
  setChrome(true);
  setPreference(true);
  await settle();
  assert.equal(cam.pitch, presentation.FIRE3D_PITCH_DEGREES);
  cam.calls.length = 0;
  setChrome(false);
  await settle();
  assert.deepEqual(cam.calls, [['jumpTo', FLAT]]);
  assert.equal(watchers(), 0);
  await leaveFlat();
});
