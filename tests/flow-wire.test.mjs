import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Block E2 unit E2-1 (FLOW-WIRE), the view controller of the ENSO flowing
 * paths (src/layers/flow/index.ts) against synthetic fields and a fake map:
 * - coverage of a view zoomed in between grid nodes (the Tier 2 review's P1,
 *   its three cases kept as written: a global grid never reads "outside");
 * - the past-grid node arrows at the nearest nodes;
 * - the motion loop runs only while the moving form draws (review lead 2);
 * - teardown while the ribbon is out of the style (lead 1), a mount that
 *   throws part way (lead 5), and a ribbon whose programs fail at the first
 *   mount (lead 7).
 * No network, no GL: the fake WebGL2 context records calls, as in
 * tests/flow-advect.test.mjs. Runs under plain `node --test`.
 */

globalThis.fetch = () => {
  throw new Error('unexpected network call from a node test');
};

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

// The motion loop's browser surface, minimal and recording.
const frames = { requested: 0, pending: new Map(), next: 1 };
const windowEvents = new EventTarget();
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (callback) => {
    frames.requested++;
    const id = frames.next++;
    frames.pending.set(id, callback);
    return id;
  },
  cancelAnimationFrame: (id) => frames.pending.delete(id),
  // Window events really dispatch (the map key's Pause request reaches the loop).
  addEventListener: (type, fn) => windowEvents.addEventListener(type, fn),
  removeEventListener: (type, fn) => windowEvents.removeEventListener(type, fn),
  dispatchEvent: (event) => windowEvents.dispatchEvent(event),
  // Blocked site data: reading sessionStorage throws, as in a private window
  // with storage blocked (the Tier 2 block review's P2).
  get sessionStorage() {
    throw new DOMException('blocked', 'SecurityError');
  }
};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const { createFlowField, mercX, mercY, lonOf, latOf } = await import('../src/layers/flow/field.ts');
const { viewQuadFromCorners, planForm } = await import('../src/layers/flow/advect.ts');
const { viewCoverage, mountFlowView, FLOW_PATHS_ID } = await import('../src/layers/flow/index.ts');
const { MOTION_REQUEST_EVENT } = await import('../src/layers/flow/motion-loop.ts');
// The panel's words and its form-note choice (src/layers/enso-flow-data.ts), read as a namespace.
const ensoFlowData = await import('../src/layers/enso-flow-data.ts');
const { FLOW_WORDS } = ensoFlowData;
const flowFormNote = (state) =>
  typeof ensoFlowData.flowFormNote === 'function' ? ensoFlowData.flowFormNote(state) : '(enso-flow-data.ts exports no flowFormNote)';

const META = Object.freeze({
  issuer: 'test', model: 'synthetic', transport: 'none', cycle: 0, forecastHour: 6,
  validTime: Date.UTC(2026, 9, 5, 12), staleAfter: null, level: '10 m above ground',
  units: 'm s-1', sourceUrl: 'about:blank', productKey: 'synthetic'
});

function uniform(kind, grid, valid = 1) {
  const n = grid.nx * grid.ny;
  return createFlowField({
    kind, grid,
    u: new Float32Array(n).fill(5), v: new Float32Array(n).fill(1),
    magnitude: new Float32Array(n).fill(2), mask: new Uint8Array(n).fill(valid), meta: META
  });
}
const GLOBAL_1P00 = { lon0: 0, lat0: 90, dlon: 1, dlat: 1, nx: 360, ny: 181, wrapsLon: true };
const WAVE_CROP = { lon0: 165, lat0: 62, dlon: 0.25, dlat: 0.25, nx: 381, ny: 289, wrapsLon: false };

/** An unrotated view centred on lon/lat at `zoom`, w x h CSS px (MapLibre's Mercator). */
function view(lon, lat, zoom, w, h) {
  const ws = 512 * 2 ** zoom;
  const cx = mercX(lon);
  const cy = mercY(lat);
  const dx = w / 2 / ws;
  const dy = h / 2 / ws;
  const ll = (x, y) => [lonOf(x), latOf(y)];
  return viewQuadFromCorners([ll(cx - dx, cy - dy), ll(cx + dx, cy - dy), ll(cx + dx, cy + dy), ll(cx - dx, cy + dy)], zoom, w, h, cx);
}

// --- the review's P1 cases, as written -------------------------------------

test('wind (global 1.0 deg, every node valid): a z10 view of 45.4 N 120.4 W at 1440x900 is covered, never outside', () => {
  const field = uniform('wind', GLOBAL_1P00);
  const v = view(-120.4, 45.4, 10, 1440, 900);
  assert.equal(planForm(field, v, { motionAllowed: true, playPressed: true }).form, 'arrows');
  assert.notEqual(viewCoverage(field, v), 'outside', 'a global wind field with every node valid must never read outside the field');
  assert.equal(viewCoverage(field, v), 'covered');
});

test('wind on a phone (390x844) at z9 over Portland is covered', () => {
  const field = uniform('wind', GLOBAL_1P00);
  assert.equal(viewCoverage(field, view(-122.6, 45.5, 9, 390, 844)), 'covered');
});

test('waves (crop, every node valid): a z12 view inside the crop at 20 N 150 W is covered', () => {
  const field = uniform('waves', WAVE_CROP);
  assert.equal(viewCoverage(field, view(-150.1, 20.1, 12, 1440, 900)), 'covered');
});

// --- outside is the wave crop's alone ---------------------------------------

test('a grid that wraps in longitude never reads outside, even with every node masked; a crop does, only where the view leaves it', () => {
  const masked = uniform('wind', GLOBAL_1P00, 0);
  for (const [lon, lat, z] of [[-120.4, 45.4, 10], [-40, 30, 3], [170, -60, 2]]) {
    assert.equal(viewCoverage(masked, view(lon, lat, z, 1440, 900)), 'masked', `${lon}, ${lat}, z${z}`);
  }
  const crop = uniform('waves', WAVE_CROP);
  assert.equal(viewCoverage(crop, view(-40, 30, 4, 1440, 900)), 'outside', 'the Atlantic lies outside the wave crop');
  const landCrop = uniform('waves', WAVE_CROP, 0);
  assert.equal(viewCoverage(landCrop, view(-150, 20, 8, 1440, 900)), 'masked', 'inside the crop, all masked, reads masked');
  // A view straddling the crop's east edge (100 W) with valid nodes inside it is partial.
  assert.equal(viewCoverage(crop, view(-100, 30, 6, 1440, 900)), 'partial');
});

// --- a fake MapLibre map ------------------------------------------------------

function fakeGl({ failPrograms = false, failCalls = {} } = {}) {
  let id = 0;
  const calls = new Map();
  const created = [];
  const deleted = [];
  return new Proxy({ drawingBufferWidth: 1440, drawingBufferHeight: 900, created, deleted }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'isContextLost') return () => false;
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return prop;
      return (...args) => {
        const count = (calls.get(prop) ?? 0) + 1;
        calls.set(prop, count);
        const fails = failCalls[prop]?.includes(count);
        if (prop === 'createProgram' && failPrograms) return null;
        if (typeof prop === 'string' && prop.startsWith('create')) {
          if (fails) return null;
          const handle = { kind: prop.slice(6), id: ++id };
          created.push(handle);
          return handle;
        }
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return !fails;
        if (fails) throw new Error(`injected ${prop} failure`);
        if (typeof prop === 'string' && prop.startsWith('delete')) deleted.push(args[0]);
        if (prop === 'getAttribLocation') return 0;
        if (prop === 'getUniformLocation') return { uniform: args[1] };
        return undefined;
      };
    }
  });
}

function fakeMap(lon, lat, zoom, { w = 1440, h = 900, gl = fakeGl(), throwOnLayer = null } = {}) {
  const canvasListeners = new Map();
  const canvas = {
    clientWidth: w, clientHeight: h,
    addEventListener: (type, fn) => {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => canvasListeners.get(type)?.delete(fn)
  };
  const sources = new Map();
  let layers = [];
  const events = new Map();
  const map = {
    canvasListeners, sources, events, repaints: 0,
    layerIds: () => layers.map((l) => l.id),
    canvasListenerCount: () => [...canvasListeners.values()].reduce((n, set) => n + set.size, 0),
    eventCount: () => [...events.values()].reduce((n, set) => n + set.size, 0),
    /** MapLibre 6.6 on a lost context: the style goes, custom layers with it, onRemove never runs. */
    dropStyle: () => { layers = []; sources.clear(); },
    camera: () => ({ lon, lat, zoom, w, h }),
    /** Jump the camera and fire moveend, as MapLibre does after a move. */
    moveTo: (nextLon, nextLat, nextZoom) => {
      lon = nextLon;
      lat = nextLat;
      zoom = nextZoom;
      for (const fn of [...(events.get('moveend') ?? [])]) fn();
    },
    getCanvas: () => canvas,
    getContainer: () => ({}),
    getZoom: () => zoom,
    getCenter: () => ({ lng: lon, lat }),
    unproject: ([sx, sy]) => {
      const ws = 512 * 2 ** zoom;
      return { lng: lonOf(mercX(lon) + (sx - w / 2) / ws), lat: latOf(mercY(lat) + (sy - h / 2) / ws) };
    },
    triggerRepaint: () => { map.repaints++; },
    addSource: (id, spec) => {
      if (sources.has(id)) throw new Error(`source ${id} exists`);
      const source = { spec, data: spec.data, setData(d) { this.data = d; } };
      sources.set(id, source);
    },
    getSource: (id) => sources.get(id),
    removeSource: (id) => sources.delete(id),
    addLayer: (layer) => {
      if (layers.some((l) => l.id === layer.id)) throw new Error(`layer ${layer.id} exists`);
      if (throwOnLayer === layer.id) throw new Error(`addLayer ${layer.id} refused`);
      layers.push(layer);
      if (typeof layer.onAdd === 'function') layer.onAdd(map, gl);
    },
    getLayer: (id) => layers.find((l) => l.id === id),
    removeLayer: (id) => {
      const layer = layers.find((l) => l.id === id);
      layers = layers.filter((l) => l.id !== id);
      if (layer && typeof layer.onRemove === 'function') layer.onRemove(map, gl);
    },
    moveLayer: (id, before) => {
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      layers = layers.filter((l) => l.id !== id);
      const i = before ? layers.findIndex((l) => l.id === before) : -1;
      if (i < 0) layers.push(layer);
      else layers.splice(i, 0, layer);
    },
    getStyle: () => ({ layers }),
    setPaintProperty() {},
    on: (type, fn) => {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(fn);
    },
    once: (type, fn) => map.on(type, fn),
    off: (type, fn) => events.get(type)?.delete(fn)
  };
  return map;
}

function mount(map, field, onState = () => {}) {
  return mountFlowView(map, field, { ink: 'light', onState });
}

// --- past-grid arrows ---------------------------------------------------------

/** Still features with at least one vertex inside the fake map's visible lon/lat box. */
function featuresInView(map) {
  const { lon, lat, zoom, w, h } = map.camera();
  const ws = 512 * 2 ** zoom;
  const west = lonOf(mercX(lon) - w / 2 / ws);
  const east = lonOf(mercX(lon) + w / 2 / ws);
  const north = latOf(mercY(lat) - h / 2 / ws);
  const south = latOf(mercY(lat) + h / 2 / ws);
  return map.sources.get('flow-still').data.features
    .filter((f) => f.geometry.coordinates.some(([x, y]) => x >= west && x <= east && y >= south && y <= north)).length;
}

test('wind zoomed in onto a grid node draws that node\'s arrow in view, and says the arrows are the model\'s own points', () => {
  const map = fakeMap(-120, 45, 10);
  const flow = mount(map, uniform('wind', GLOBAL_1P00));
  assert.equal(flow.state.coverage, 'covered');
  assert.equal(flow.state.form, 'arrows');
  assert.equal(flow.state.nodesInView, true);
  assert.ok(featuresInView(map) > 0, 'the node in view has its arrow in view');
  assert.equal(flowFormNote(flow.state), FLOW_WORDS.pastGrid);
  flow.dispose();
});

// The block review's P1 case, as a passing assertion: past the grid with no
// model node inside the view, nothing is drawn and no string claims arrows.
test('past the grid with no model node inside the view, nothing draws and no flow string claims arrows are showing (z10 to z14, Portland, Pendleton, Anchorage)', () => {
  const empty = [];
  for (const [lon, lat] of [[-122.67, 45.52], [-120.4, 45.4], [-149.9, 61.2]]) {
    for (const z of [10, 11, 12, 13, 14]) {
      const map = fakeMap(lon, lat, z);
      const flow = mount(map, uniform('wind', GLOBAL_1P00));
      assert.equal(flow.state.coverage, 'covered', `${lon},${lat} z${z}: the frame covers the view (live, not no data)`);
      const inView = featuresInView(map);
      if (flow.state.form === 'arrows' && inView === 0) {
        if (flow.state.features !== 0) empty.push(`${lon},${lat} z${z}: ${flow.state.features} arrows drawn, all off screen`);
        if (flow.state.nodesInView !== false) empty.push(`${lon},${lat} z${z}: nodesInView is ${flow.state.nodesInView}`);
        const note = flowFormNote(flow.state);
        if (note !== FLOW_WORDS.noModelPoint) empty.push(`${lon},${lat} z${z}: the form note reads "${note}"`);
      }
      flow.dispose();
    }
  }
  assert.deepEqual(empty, [], 'no arrows claimed or drawn off screen while no model node is inside the view');
  assert.ok(typeof FLOW_WORDS.noModelPoint === 'string' && !/showing/i.test(FLOW_WORDS.noModelPoint), 'the no-point sentence claims nothing is showing');
});

// The block review's P2 case, as a passing assertion (WCAG 2.2.2).
test('Pause with blocked sessionStorage survives a zoom past the grid and back: only the viewer restarts the motion', async () => {
  const map = fakeMap(-145, 26, 3);
  const flow = mount(map, uniform('wind', GLOBAL_1P00));
  assert.equal(flow.state.motion, 'moving');
  window.dispatchEvent(new CustomEvent(MOTION_REQUEST_EVENT, { detail: { paused: true } }));
  assert.equal(flow.state.motion, 'paused');
  map.moveTo(-120.4, 45.4, 10); // past the grid: node arrows, the loop is disposed
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(flow.state.form, 'arrows');
  map.moveTo(-145, 26, 3); // back out: a new loop is created
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(flow.state.motion, 'paused', 'the viewer paused; nothing but the viewer may restart the motion');
  assert.equal(flow.state.form, 'still');
  // The viewer's own Play restarts it.
  window.dispatchEvent(new CustomEvent(MOTION_REQUEST_EVENT, { detail: { paused: false } }));
  assert.equal(flow.state.motion, 'moving');
  flow.dispose();
});

// --- review lead 2: the loop runs only while the moving form draws ------------

test('the motion loop requests no animation frame while the form is node arrows', () => {
  const before = frames.requested;
  const pendingBefore = frames.pending.size;
  const flow = mount(fakeMap(-120.4, 45.4, 10), uniform('wind', GLOBAL_1P00));
  assert.equal(flow.state.form, 'arrows');
  assert.equal(frames.requested - before, 0, 'no frame requested for a form that cannot move');
  assert.equal(frames.pending.size, pendingBefore);
  flow.dispose();
});

test('the motion loop runs for the moving form and stops when the view leaves it', async () => {
  const map = fakeMap(-145, 26, 3);
  const before = frames.requested;
  const pendingBefore = frames.pending.size;
  const flow = mount(map, uniform('wind', GLOBAL_1P00));
  assert.equal(flow.state.form, 'moving');
  assert.equal(flow.state.motion, 'moving');
  assert.ok(frames.requested - before > 0, 'the moving form asks for frames');
  // Zoom past the grid: node arrows, and the loop lets go of its frame.
  map.moveTo(-120.4, 45.4, 10);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(flow.state.form, 'arrows');
  assert.equal(flow.state.motion, 'none');
  assert.equal(frames.pending.size, pendingBefore, 'no frame pending while the form cannot move');
  const settled = frames.requested;
  // Back out: the loop runs again.
  map.moveTo(-145, 26, 3);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(flow.state.form, 'moving');
  assert.ok(frames.requested > settled, 'the moving form asks for frames again');
  flow.dispose();
  assert.equal(frames.pending.size, pendingBefore, 'no frame left pending after dispose');
});

// --- review lead 1: teardown while the ribbon is out of the style -------------

test('dispose while the ribbon is out of the style (a lost context) leaves no listener holding the field', () => {
  const map = fakeMap(-145, 26, 3);
  const flow = mount(map, uniform('wind', GLOBAL_1P00));
  assert.ok(map.getLayer(FLOW_PATHS_ID), 'the ribbon is in the style');
  map.dropStyle();
  flow.dispose();
  assert.equal(map.canvasListenerCount(), 0, 'no canvas listener left (the ribbon detached itself)');
  assert.equal(map.eventCount(), 0, 'no map listener left');
});

// --- review lead 5: a mount that throws part way ------------------------------

test('a mount that throws part way leaves nothing on the map and no listener', () => {
  const map = fakeMap(-145, 26, 3, { throwOnLayer: 'flow-still-marks' });
  const before = frames.pending.size;
  assert.throws(() => mount(map, uniform('wind', GLOBAL_1P00)), /refused/);
  assert.deepEqual(map.layerIds().filter((id) => id.startsWith('flow-')), [], 'no flow layer left');
  assert.equal(map.sources.has('flow-still'), false, 'no flow source left');
  assert.equal(map.canvasListenerCount(), 0);
  assert.equal(map.eventCount(), 0);
  assert.equal(frames.pending.size, before);
});

// --- review lead 7: the ribbon fails at the first mount -----------------------

test('a ribbon whose programs fail at the first mount leaves the still form with the rebuild-failed state', () => {
  const map = fakeMap(-145, 26, 3, { gl: fakeGl({ failPrograms: true }) });
  const flow = mount(map, uniform('wind', GLOBAL_1P00));
  assert.equal(map.getLayer(FLOW_PATHS_ID), undefined, 'no ribbon in the style');
  assert.equal(flow.state.form, 'still');
  assert.equal(flow.state.motion, 'none', 'Pause is not offered');
  assert.equal(flow.state.rebuildFailed, true, 'the panel gives the rebuild-failed note');
  assert.ok(flow.state.features > 0);
  flow.dispose();
});

// L1-GPU: allocation can fail after any earlier handle was successfully created.
function assertReleased(gl) {
  assert.deepEqual(
    gl.deleted.map((handle) => handle.id).sort((a, b) => a - b),
    gl.created.map((handle) => handle.id).sort((a, b) => a - b),
    'each created GPU handle is deleted exactly once'
  );
}

for (const [method, call] of [
  ['createShader', 1], ['createShader', 2],
  ['getShaderParameter', 1], ['getShaderParameter', 2],
  ['getProgramParameter', 1], ['createProgram', 2],
  ['getShaderParameter', 3], ['getProgramParameter', 2],
  ['createVertexArray', 1], ['createVertexArray', 2],
  ['createBuffer', 1], ['bufferData', 1]
]) {
  test(`partial ribbon build releases every handle when ${method} call ${call} fails`, () => {
    const gl = fakeGl({ failCalls: { [method]: [call] } });
    const map = fakeMap(-145, 26, 3, { gl });
    const flow = mount(map, uniform('wind', GLOBAL_1P00));
    assert.equal(flow.state.form, 'still', 'the still fallback remains available');
    assert.equal(flow.state.rebuildFailed, true);
    assert.equal(map.getLayer(FLOW_PATHS_ID), undefined);
    assertReleased(gl);
    flow.dispose();
    flow.dispose();
    assertReleased(gl);
    assert.equal(map.canvasListenerCount(), 0);
    assert.equal(map.eventCount(), 0);
  });
}

test('repeated shader failures in one context leave no accumulated GPU handles', () => {
  const gl = fakeGl({ failCalls: { getShaderParameter: [1, 2, 3] } });
  const map = fakeMap(-145, 26, 3, { gl });
  for (let i = 0; i < 3; i++) {
    const flow = mount(map, uniform('wind', GLOBAL_1P00));
    assert.equal(flow.state.rebuildFailed, true);
    flow.dispose();
    assertReleased(gl);
  }
  assert.equal(gl.created.filter((handle) => handle.kind === 'Program').length, 3);
  assert.equal(map.canvasListenerCount(), 0);
});

test('a successful ribbon retains its programs until removal and deletes each handle once', () => {
  const gl = fakeGl();
  const map = fakeMap(-145, 26, 3, { gl });
  const flow = mount(map, uniform('wind', GLOBAL_1P00));
  assert.equal(flow.state.form, 'moving');
  assert.equal(gl.created.filter((handle) => handle.kind === 'Program').length, 2);
  assert.equal(gl.deleted.filter((handle) => handle.kind !== 'Shader').length, 0);
  flow.dispose();
  flow.dispose();
  assertReleased(gl);
});
