import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D P3-CANCEL (REGISTER found-117; plan rule 5): turning HeatRisk or the
 * NWS alerts off while their `activate` is in flight aborts the requests that
 * activation holds at that moment, through the controller-owned
 * `LayerActivation.signal`, instead of letting them run out their network
 * budget behind the serialized teardown.
 *
 * The REAL `createLayerController` drives the REAL `src/layers/heatrisk.ts`
 * and `src/layers/nws-alerts.ts`; only the controller's peripheral modules
 * (the DOM overlay, the legend, the time bar, the URL writer, the map
 * ordering and fade helpers, the click coordinator, the popup builder, the
 * raster tile watcher) are replaced by recorders, and `fetch` is stubbed (no
 * network decides a result). The fetch stub rejects when the request's signal
 * aborts, the way a real fetch does, except in the "late answer" cases where
 * it deliberately answers AFTER the abort to model a response that raced past
 * it.
 *
 * Red on the untouched code (7210c72): the held request's signal is still
 * live at `deactivate`, a second request follows the release, and the late
 * path draws a source, a legend and the "Loading HeatRisk..." indicator
 * before the controller undoes it.
 */

// The product modules import each other without extensions, which the
// bundler resolves and Node's type stripping does not (the same hook as
// tests/briefing-truth.test.mjs and tests/popup-frame.test.mjs).
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

const actualLayers = await import('../src/config/layers.ts');
const { LAYER_DEFS } = actualLayers;
const { registry } = await import('../src/state/registry.ts');

// What the recorders saw: every indicator, legend, source and layer the two
// modules put on the page, in order.
const seen = {
  loading: [],
  legends: [],
  timeBars: [],
  sources: [],
  layers: [],
  urlWrites: []
};
globalThis.cancelSeen = seen;
globalThis.cancelDefs = LAYER_DEFS;
globalThis.cancelLayerExports = actualLayers;
globalThis.cancelModules = new Map();

const stubs = {
  // The controller imports MapLibre as a namespace but only for types, and the
  // real bundle needs a DOM at load.
  'maplibre-gl': 'export const stub = true;',
  '/config/layers': `export const LAYER_DEFS=globalThis.cancelDefs;
    export const DEFAULT_ON_KEYS=globalThis.cancelLayerExports.DEFAULT_ON_KEYS;
    export const resolveExclusiveSurface=globalThis.cancelLayerExports.resolveExclusiveSurface;
    export const getLayerDef=key=>LAYER_DEFS.find(d=>d.key===key);
    export const getLoadedLayerModule=key=>globalThis.cancelModules.get(key);
    export const loadLayerModule=async def=>getLoadedLayerModule(def.key);`,
  './cluster-service': 'export function isCommittedCompositionKey(){ return false; }',
  '/state/url': `export function parseHeatRiskDayParam(){return null;}
    export function syncHeatRiskDayParam(day){globalThis.cancelSeen.urlWrites.push(day);}`,
  '/map/layer-order': 'export function reassertLabelOrder(){} export function reassertThematicOrder(){}',
  '/util/layer-fade': 'export function fadeInLayers(){} export async function fadeOutLayers(){}',
  '/ui/overlay': `let n=0;
    export function showLoading(text){ globalThis.cancelSeen.loading.push(text); return ++n; }
    export function hideLoading(){}`,
  '/ui/legend-registry': `export const LEGEND_ORDER={surface:1,event:2};
    export function showLegend(key){ globalThis.cancelSeen.legends.push(key); return null; }
    export function hideLegend(){}
    export function renderSwatchLegend(){}`,
  '/ui/time-bar': `export function setTimeBar(key){ globalThis.cancelSeen.timeBars.push(key); }
    export function clearTimeBar(){}`,
  '/map/interaction-coordinator': 'export function registerClickTarget(){}',
  '/ui/popups': 'export function buildNwsAlertPopupHtml(){ return ""; }',
  '/util/raster-status': 'export function watchRasterTiles(){ return { detach(){} }; }'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stub[1])}`,
        shortCircuit: true
      };
    }
    return nextResolve(specifier, context);
  }
});

globalThis.window = globalThis;
// The alerts' refresh and expiry timers are minutes long; the fetch budgets
// (10 s, 15 s) are shorter. Count the long ones still pending so "zero
// pending work after cancel" is an observation, not an assumption.
const longTimers = new Set();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const handle = realSetTimeout(
    (...args) => {
      longTimers.delete(handle);
      fn(...args);
    },
    ms,
    ...rest
  );
  if (typeof ms === 'number' && ms >= 60_000) longTimers.add(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  longTimers.delete(handle);
  realClearTimeout(handle);
};
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {}
};

const { createLayerController } = await import('../src/state/layer-controller.ts');
const heat = await import('../src/layers/heatrisk.ts');
const alerts = await import('../src/layers/nws-alerts.ts');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_TIME = 1_785_153_600_000;
const TIMES = Array.from({ length: 7 }, (_, index) => FIRST_TIME + index * DAY_MS);

const METADATA_BODY = JSON.stringify({
  timeInfo: { timeExtent: [TIMES[0], TIMES[6]] }
});
const CATALOG_BODY = JSON.stringify({
  features: TIMES.map((validTime, index) => ({
    attributes: { name: `HeatRisk_${index + 1}_Mercator`, idp_validtime: validTime }
  }))
});
const WWA_BODY = JSON.stringify({ type: 'FeatureCollection', features: [] });

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    on() {},
    off() {},
    getCenter: () => ({ lng: -121, lat: 46 }),
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource(id, spec) {
      seen.sources.push(id);
      sources.set(id, { setData() {}, spec });
    },
    addLayer(spec) {
      seen.layers.push(spec.id);
      layers.set(spec.id, spec);
    },
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id)
  };
}

function resetSeen() {
  for (const list of Object.values(seen)) list.length = 0;
  for (const key of registry.getActiveKeys()) registry.deactivate(key);
}

function harness(map, initial) {
  const checked = new Set(initial);
  const view = {
    setCheckbox(key, on) {
      if (on) checked.add(key);
      else checked.delete(key);
    },
    isCheckboxChecked: (key) => checked.has(key),
    clearLayerStatus() {},
    announce() {}
  };
  return createLayerController(map, view);
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A `fetch` that holds the requests listed in `holdIndexes` (0-based, in issue
 * order) until `release()` and answers every other request at once. A held
 * request rejects with an AbortError when its signal aborts, as a real fetch
 * does, unless `ignoreAbort` models a response that raced past the abort.
 */
function installFetch(bodyFor, { holdIndexes = [0], ignoreAbort = false } = {}) {
  const calls = [];
  const held = [];
  globalThis.fetch = (url, options) => {
    const index = calls.length;
    const signal = options?.signal ?? null;
    calls.push({ url: String(url), signal });
    const body = bodyFor(String(url));
    if (!holdIndexes.includes(index)) {
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return new Promise((resolve, reject) => {
      held.push(() => resolve(new Response(body, { status: 200 })));
      if (!ignoreAbort) {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      }
    });
  };
  return {
    calls,
    release() {
      for (const release of held.splice(0, held.length)) release();
    }
  };
}

const heatBody = (url) => (url.includes('/query') ? CATALOG_BODY : METADATA_BODY);
const wwaBody = () => WWA_BODY;

const noDraw = () => {
  assert.deepEqual(seen.sources, [], 'no source was added');
  assert.deepEqual(seen.layers, [], 'no layer was added');
  // The controller's own indicator reads "Loading HeatRisk (Experimental)...";
  // the module's frame indicator is the bare "Loading HeatRisk...".
  assert.deepEqual(
    seen.loading.filter((text) => text === 'Loading HeatRisk...'),
    [],
    'no frame indicator'
  );
  assert.deepEqual(seen.legends, [], 'no legend or key row was shown');
  assert.deepEqual(seen.timeBars, [], 'no time bar was installed');
};

test('HeatRisk: off while the metadata read is held aborts it at once, issues no catalog read and draws nothing', async (t) => {
  resetSeen();
  const net = installFetch(heatBody, { holdIndexes: [0] });
  const map = fakeMap();
  t.after(() => {
    net.release();
    heat.deactivate(map);
  });
  globalThis.cancelModules.set('heatrisk', heat);
  const controller = harness(map, ['heatrisk']);
  const activation = controller.activate('heatrisk');
  await settle();
  assert.equal(net.calls.length, 1, 'the metadata read is the only request so far');
  assert.equal(net.calls[0].signal.aborted, false);

  controller.deactivate('heatrisk');
  assert.equal(net.calls[0].signal.aborted, true, 'the held metadata request aborts at the moment of off');

  net.release();
  await activation;
  await settle();
  assert.equal(net.calls.length, 1, 'no catalog request follows the release');
  noDraw();
  assert.equal(registry.getActiveKeys().has('heatrisk'), false);
});

test('HeatRisk: off while the catalog read is held aborts it at once and draws nothing', async (t) => {
  resetSeen();
  const net = installFetch(heatBody, { holdIndexes: [1] });
  const map = fakeMap();
  t.after(() => {
    net.release();
    heat.deactivate(map);
  });
  globalThis.cancelModules.set('heatrisk', heat);
  const controller = harness(map, ['heatrisk']);
  const activation = controller.activate('heatrisk');
  await settle();
  assert.equal(net.calls.length, 2, 'metadata answered, catalog held');
  assert.equal(net.calls[1].signal.aborted, false);

  controller.deactivate('heatrisk');
  assert.equal(net.calls[1].signal.aborted, true, 'the held catalog request aborts at the moment of off');

  net.release();
  await activation;
  await settle();
  assert.equal(net.calls.length, 2, 'no third request');
  noDraw();
});

test('HeatRisk: a metadata answer that lands after the abort is dropped, with no catalog read and nothing drawn', async (t) => {
  resetSeen();
  const net = installFetch(heatBody, { holdIndexes: [0], ignoreAbort: true });
  const map = fakeMap();
  t.after(() => {
    net.release();
    heat.deactivate(map);
  });
  globalThis.cancelModules.set('heatrisk', heat);
  const controller = harness(map, ['heatrisk']);
  const activation = controller.activate('heatrisk');
  await settle();
  controller.deactivate('heatrisk');
  assert.equal(net.calls[0].signal.aborted, true);

  net.release();
  await activation;
  await settle();
  assert.equal(net.calls.length, 1, 'the late answer starts no catalog read');
  noDraw();
});

test('HeatRisk: a normal activation is unchanged (metadata, then catalog, then one frame and its indicator)', async (t) => {
  resetSeen();
  const net = installFetch(heatBody, { holdIndexes: [] });
  const map = fakeMap();
  t.after(() => {
    net.release();
    heat.deactivate(map);
  });
  globalThis.cancelModules.set('heatrisk', heat);
  const controller = harness(map, ['heatrisk']);
  await controller.activate('heatrisk');
  await settle();
  assert.deepEqual(
    net.calls.map((call) => (call.url.includes('/query') ? 'catalog' : 'metadata')),
    ['metadata', 'catalog']
  );
  assert.equal(net.calls[0].signal.aborted, false);
  assert.equal(net.calls[1].signal.aborted, false);
  assert.deepEqual(seen.sources, ['heatrisk-frame-1']);
  assert.deepEqual(seen.layers, ['heatrisk']);
  assert.ok(seen.loading.includes('Loading HeatRisk...'), 'the frame indicator opens');
  assert.ok(seen.legends.includes('heatrisk'));
});

test('HeatRisk: a later off, after a settled activation, does not disturb a re-activation', async (t) => {
  resetSeen();
  const net = installFetch(heatBody, { holdIndexes: [] });
  const map = fakeMap();
  t.after(() => {
    net.release();
    heat.deactivate(map);
  });
  globalThis.cancelModules.set('heatrisk', heat);
  const controller = harness(map, ['heatrisk']);
  await controller.activate('heatrisk');
  controller.deactivate('heatrisk');
  await settle();
  const before = net.calls.length;
  await controller.activate('heatrisk');
  await settle();
  assert.equal(net.calls.length, before + 2, 'the second activation reads metadata and catalog afresh');
  assert.equal(net.calls[before].signal.aborted, false);
  assert.equal(net.calls[before + 1].signal.aborted, false);
  assert.ok(seen.sources.length >= 2, 'the re-activation drew its frame');
});

test('NWS alerts: off while the WWA read is held aborts it at once and draws nothing', async (t) => {
  resetSeen();
  const net = installFetch(wwaBody, { holdIndexes: [0] });
  const map = fakeMap();
  t.after(() => {
    net.release();
    alerts.deactivate(map);
  });
  globalThis.cancelModules.set('nws-alerts', alerts);
  const controller = harness(map, ['nws-alerts']);
  const activation = controller.activate('nws-alerts');
  await settle();
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].signal.aborted, false);

  controller.deactivate('nws-alerts');
  assert.equal(net.calls[0].signal.aborted, true, 'the held WWA request aborts at the moment of off');

  net.release();
  await activation;
  await settle();
  assert.equal(net.calls.length, 1, 'no refresh request follows');
  assert.equal(longTimers.size, 0, 'no refresh or expiry timer is left pending');
  assert.deepEqual(seen.sources, []);
  assert.deepEqual(seen.layers, []);
  assert.deepEqual(seen.legends, []);
  assert.equal(registry.getActiveKeys().has('nws-alerts'), false);
});

test('NWS alerts: an answer that lands after the abort is dropped and draws nothing', async (t) => {
  resetSeen();
  const net = installFetch(wwaBody, { holdIndexes: [0], ignoreAbort: true });
  const map = fakeMap();
  t.after(() => {
    net.release();
    alerts.deactivate(map);
  });
  globalThis.cancelModules.set('nws-alerts', alerts);
  const controller = harness(map, ['nws-alerts']);
  const activation = controller.activate('nws-alerts');
  await settle();
  controller.deactivate('nws-alerts');
  assert.equal(net.calls[0].signal.aborted, true);

  net.release();
  await activation;
  await settle();
  assert.equal(net.calls.length, 1);
  assert.deepEqual(seen.sources, []);
  assert.deepEqual(seen.layers, []);
  assert.deepEqual(seen.legends, []);
});

test('NWS alerts: a normal activation is unchanged (one read, then the source, layers and legend)', async (t) => {
  resetSeen();
  const net = installFetch(wwaBody, { holdIndexes: [] });
  const map = fakeMap();
  t.after(() => {
    net.release();
    alerts.deactivate(map);
  });
  globalThis.cancelModules.set('nws-alerts', alerts);
  const controller = harness(map, ['nws-alerts']);
  await controller.activate('nws-alerts');
  await settle();
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].signal.aborted, false);
  assert.deepEqual(seen.sources, ['nws-alerts']);
  assert.deepEqual(seen.layers, ['nws-alerts-fill', 'nws-alerts-outline']);
  assert.ok(seen.legends.includes('nws-alerts'));
  assert.equal(longTimers.size, 1, 'the five-minute refresh is scheduled as before');
});

for (const variable of ['precipitation', 'temperature']) {
  for (const held of [false, true]) {
    test(`CPC ${variable}: real controller Off ${held ? 'aborts held headers and suppresses late drawing' : 'cleans its completed source and registry'}`, async (t) => {
      const { createCpcSeasonalAdapter } = await import('../src/layers/cpc-seasonal-outlook.ts');
      const { cpcSeasonalBody } = await import('./cpc-seasonal-polygon-fixtures.mjs');
      const key = variable === 'precipitation' ? 'cpc-seasonal-precip' : 'cpc-seasonal-temp';
      // Test-only catalogue registration: no public entry or admitted allowance.
      const module = createCpcSeasonalAdapter({ variable, fillOpacity: 0.75,
        limits: { timeoutMs: 1_000, maxDecodedBytes: 100_000, maxFeatures: 20, maxAllowableOffset: 0.01 } });
      const definition = { ...LAYER_DEFS.find(row => row.key === 'heatrisk'), key,
        defaultOn: false, load: async () => module };
      LAYER_DEFS.push(definition);
      globalThis.cancelModules.set(key, module);
      resetSeen();
      const originalFetch = globalThis.fetch;
      const net = installFetch(() => JSON.stringify(cpcSeasonalBody('polygons')),
        { holdIndexes: held ? [0] : [], ignoreAbort: held });
      const map = fakeMap();
      t.after(() => {
        net.release();
        module.deactivate(map);
        registry.deactivate(key);
        globalThis.cancelModules.delete(key);
        LAYER_DEFS.splice(LAYER_DEFS.indexOf(definition), 1);
        globalThis.fetch = originalFetch;
      });
      const controller = harness(map, [key]);
      const pending = controller.activate(key);
      if (held) await settle();
      else await pending;
      assert.equal(net.calls.length, 1);
      assert.equal(net.calls[0].signal.aborted, false);
      if (!held) {
        assert.ok(map.getSource(key));
        assert.equal(registry.getActiveKeys().has(key), true);
      }
      controller.deactivate(key);
      // Completed transport listeners are detached; a held transport must abort now.
      if (held) assert.equal(net.calls[0].signal.aborted, true);
      net.release();
      await pending;
      await settle();
      assert.equal(map.getSource(key), undefined);
      assert.equal(map.getLayer(key + '-fill'), undefined);
      assert.equal(map.getLayer(key + '-line'), undefined);
      assert.equal(module.getSnapshot(), null);
      assert.equal(registry.getActiveKeys().has(key), false);
      assert.equal(registry.getStatus(key), undefined);
      assert.equal(net.calls.length, 1);
      if (held) {
        assert.deepEqual(seen.sources, []);
        assert.deepEqual(seen.layers, []);
      }
    });
  }
}
