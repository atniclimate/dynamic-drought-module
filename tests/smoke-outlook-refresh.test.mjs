import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit finding 14: the HMS smoke layer and the SPC Day 1 fire-weather
 * outlook refresh while they stay on, instead of sitting at 'ready' on
 * yesterday's answer. Drives the REAL layer modules with a fake map, a fake
 * window timer, a fake document and a stubbed fetch; no browser, no network.
 *
 * Smoke: every refresh updates the existing source with setData (Wildfire 3D
 * reads that source), never removes and re-adds it; a failed refresh clears
 * the plumes and reports 'error'; the timer pauses while the tab is hidden and
 * ends with deactivate.
 * Outlook: a refresh replaces the data in place; an outlook past its own
 * expire time is not drawn and reports the no-data status.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

const env = { legends: new Set(), timeBars: new Set() };
globalThis.__refreshEnv = env;

const STUBS = {
  '/map/interaction-coordinator': 'export function registerClickTarget() {}',
  '/ui/popups': 'export function buildSpcFireWeatherPopupModel() { return {}; }',
  '/ui/time-bar':
    'const env = globalThis.__refreshEnv; export function setTimeBar(key) { env.timeBars.add(key); } export function clearTimeBar(key) { env.timeBars.delete(key); }',
  '/ui/legend-registry':
    'const env = globalThis.__refreshEnv; export const LEGEND_ORDER = { event: 1 }; export function showLegend(key) { env.legends.add(key); return null; } export function hideLegend(key) { env.legends.delete(key); } export function renderSwatchLegend() {}'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(STUBS).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
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

// A window whose timers the case fires by hand; the document's listeners are kept.
const timers = [];
let nextTimerId = 1;
globalThis.window = {
  setTimeout(fn, ms) {
    const id = nextTimerId++;
    timers.push({ id, fn, ms });
    return id;
  },
  clearTimeout(id) {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  }
};
const listeners = new Set();
globalThis.document = {
  hidden: false,
  addEventListener: (type, fn) => type === 'visibilitychange' && listeners.add(fn),
  removeEventListener: (type, fn) => listeners.delete(fn)
};

const { registry } = await import('../src/state/registry.ts');
const hms = await import('../src/layers/hms-smoke.ts');
const spc = await import('../src/layers/spc-fire-weather.ts');

const polygon = { type: 'Polygon', coordinates: [[[-120, 46], [-119, 46], [-119, 47], [-120, 46]]] };
const collection = (n, properties = {}) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, () => ({ type: 'Feature', geometry: polygon, properties }))
});

const fakeMap = () => {
  const sources = new Map();
  const layers = new Map();
  const map = {
    adds: 0,
    layerAdds: 0,
    setDatas: [],
    getSource: (id) => sources.get(id),
    addSource(id, spec) {
      map.adds++;
      sources.set(id, { setData: (data) => map.setDatas.push(data) });
      map.setDatas.push(spec.data);
    },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.get(id),
    addLayer(layer) {
      map.layerAdds++;
      layers.set(layer.id, layer);
    },
    removeLayer: (id) => layers.delete(id),
    setLayoutProperty() {},
    on() {}
  };
  return map;
};

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Fire the one pending refresh timer and let its read settle. */
const fireRefresh = async () => {
  assert.equal(timers.length, 1, 'one refresh is pending');
  const [{ fn }] = timers.splice(0, 1);
  fn();
  await flush();
};

function stubFetch() {
  const previous = globalThis.fetch;
  const state = { calls: 0, body: collection(1), status: 200 };
  globalThis.fetch = async () => {
    state.calls++;
    return new Response(JSON.stringify(state.body), { status: state.status });
  };
  return { state, restore: () => { globalThis.fetch = previous; } };
}

test('HMS smoke refreshes in place, pauses while hidden, and stops on deactivate', async () => {
  const { state, restore } = stubFetch();
  const map = fakeMap();
  try {
    state.body = collection(1);
    await hms.activate(map);
    assert.equal(registry.getStatus('hms-smoke'), 'ready');
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms > 290_000 && timers[0].ms <= 300_000, 'about five minutes');

    state.body = collection(2);
    await fireRefresh();
    assert.equal(state.calls, 2);
    assert.equal(map.adds, 1, 'the source was never re-added');
    assert.equal(map.layerAdds, 1, 'the fill was never re-added');
    assert.equal(map.setDatas.at(-1).features.length, 2, 'setData carried the new plumes');
    assert.equal(registry.getStatus('hms-smoke'), 'ready');

    state.body = collection(0);
    await fireRefresh();
    assert.equal(map.setDatas.at(-1).features.length, 0);
    assert.equal(registry.getStatus('hms-smoke'), 'no-data');
    assert.equal(env.legends.has('hms-smoke'), false, 'no plumes, no legend');

    state.body = collection(1);
    await fireRefresh();
    assert.equal(registry.getStatus('hms-smoke'), 'ready');
    assert.equal(env.legends.has('hms-smoke'), true);
    assert.equal(map.layerAdds, 1);

    state.status = 500;
    await fireRefresh();
    assert.equal(registry.getStatus('hms-smoke'), 'error');
    assert.equal(map.setDatas.at(-1).features.length, 0, 'the last good plumes are not left up');
    assert.equal(timers.length, 1, 'it keeps trying');
    state.status = 200;

    document.hidden = true;
    listeners.forEach((fn) => fn());
    assert.equal(timers.length, 0, 'a hidden tab does not poll');
    document.hidden = false;
    listeners.forEach((fn) => fn());
    assert.equal(timers.length, 1, 'visible again, it resumes');

    hms.deactivate(map);
    assert.equal(timers.length, 0);
    assert.equal(listeners.size, 0);
    assert.equal(map.getSource('hms-smoke'), undefined);
  } finally {
    hms.deactivate(map);
    restore();
  }
});

test('SPC outlook refreshes in place and does not draw an outlook past its expire time', async () => {
  const { state, restore } = stubFetch();
  const map = fakeMap();
  const outlook = (expire) => collection(1, { dn: 5, valid: '209901010000', expire });
  try {
    state.body = outlook('209912312359');
    await spc.activate(map);
    assert.equal(registry.getStatus('spc-fire-weather'), 'ready');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30 * 60 * 1000);

    state.body = outlook('202001010000');
    await fireRefresh();
    assert.equal(map.adds, 1, 'the source was never re-added');
    assert.equal(map.setDatas.at(-1).features.length, 0, 'an expired outlook is not drawn');
    assert.equal(registry.getStatus('spc-fire-weather'), 'no-data');
    assert.equal(env.timeBars.has('spc-fire-weather'), true, 'its stamp still states the period');

    state.body = outlook('209912312359');
    await fireRefresh();
    assert.equal(map.setDatas.at(-1).features.length, 1);
    assert.equal(registry.getStatus('spc-fire-weather'), 'ready');
    assert.equal(map.layerAdds, 2, 'fill and outline were added once');

    spc.deactivate(map);
    assert.equal(timers.length, 0);
  } finally {
    spc.deactivate(map);
    restore();
  }
});
