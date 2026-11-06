import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The REAL `src/layers/heatrisk.ts` with its DOM-facing peripherals replaced
 * by recorders (the same stubs as tests/layer-activation-cancel.test.mjs) and
 * `fetch` stubbed per request.
 *
 * 1. The service metadata read retries once for a transient failure (a lost
 *    network read, or an abort nobody asked for) and never for a caller's
 *    cancellation or an answer the service gave.
 * 2. The time bar stamp is re-read at the selected period's boundary, so a
 *    page left open does not keep an ended period in the outlook register.
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

const seen = { timeBars: [], tileReports: [] };
globalThis.retrySeen = seen;

const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/state/url': 'export function parseHeatRiskDayParam(){return null;} export function syncHeatRiskDayParam(){}',
  '/ui/overlay': 'let n=0; export function showLoading(){ return ++n; } export function hideLoading(){}',
  '/ui/legend-registry': 'export const LEGEND_ORDER={surface:1,event:2}; export function showLegend(){ return null; } export function hideLegend(){}',
  '/ui/time-bar': 'export function setTimeBar(key, spec){ globalThis.retrySeen.timeBars.push(spec); } export function clearTimeBar(){}',
  '/util/raster-status': 'export function watchRasterTiles(map, id, report){ globalThis.retrySeen.tileReports.push(report); return { detach(){} }; }'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

globalThis.window = globalThis;
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const { registry } = await import('../src/state/registry.ts');
const heat = await import('../src/layers/heatrisk.ts');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_TIME = 1_785_153_600_000;
const TIMES = Array.from({ length: 7 }, (_, index) => FIRST_TIME + index * DAY_MS);
const METADATA_BODY = JSON.stringify({ timeInfo: { timeExtent: [TIMES[0], TIMES[6]] } });
const CATALOG_BODY = JSON.stringify({
  features: TIMES.map((validTime, index) => ({
    attributes: { name: `HeatRisk_${index + 1}_Mercator`, idp_validtime: validTime }
  }))
});

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    on() {},
    off() {},
    getCenter: () => ({ lng: -121, lat: 46 }),
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource: (id, spec) => sources.set(id, { spec }),
    addLayer: (spec) => layers.set(spec.id, spec),
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id)
  };
}

const ok = (body) => () => Promise.resolve(new Response(body, { status: 200 }));
const lost = () => () => Promise.reject(new TypeError('Failed to fetch'));
const browserAbort = () => () => Promise.reject(new DOMException('Aborted', 'AbortError'));
const held = () => (signal) =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  );

/** Answer metadata requests from `metadata` in order; every catalog read succeeds. */
function installFetch(metadata, catalog = ok(CATALOG_BODY)) {
  const calls = [];
  let metadataIndex = 0;
  globalThis.fetch = (url, options) => {
    const isCatalog = String(url).includes('/query');
    calls.push(isCatalog ? 'catalog' : 'metadata');
    const answer = isCatalog ? catalog : metadata[metadataIndex++];
    assert.ok(answer, `unexpected request ${calls.length}: ${url}`);
    return answer(options.signal);
  };
  return calls;
}

function reset(t, map) {
  seen.timeBars.length = 0;
  seen.tileReports.length = 0;
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    heat.deactivate(map);
    console.warn = warn;
  });
}

test('a lost metadata read is retried once and the layer reads ready', async (t) => {
  const map = fakeMap();
  reset(t, map);
  const calls = installFetch([lost(), ok(METADATA_BODY)]);
  await heat.activate(map);
  assert.deepEqual(calls, ['metadata', 'metadata', 'catalog']);
  seen.tileReports.at(-1)('ready');
  assert.equal(registry.getStatus('heatrisk'), 'ready');
});

test('an abort the caller did not ask for (the recorded ERR_ABORTED) is retried once', async (t) => {
  const map = fakeMap();
  reset(t, map);
  const calls = installFetch([browserAbort(), ok(METADATA_BODY)]);
  await heat.activate(map);
  assert.deepEqual(calls, ['metadata', 'metadata', 'catalog']);
  seen.tileReports.at(-1)('ready');
  assert.equal(registry.getStatus('heatrisk'), 'ready');
});

test('two transient failures read unavailable, with no third request', async (t) => {
  const map = fakeMap();
  reset(t, map);
  const calls = installFetch([lost(), browserAbort()]);
  await heat.activate(map);
  assert.deepEqual(calls, ['metadata', 'metadata']);
  assert.equal(registry.getStatus('heatrisk'), 'error');
});

test('a cancellation the caller asked for is not retried', async (t) => {
  const map = fakeMap();
  reset(t, map);
  const calls = installFetch([held()]);
  const caller = new AbortController();
  const pending = heat.activate(map, { signal: caller.signal, generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  registry.setStatus('heatrisk', 'loading');
  caller.abort();
  await pending;
  assert.deepEqual(calls, ['metadata']);
  assert.equal(registry.getStatus('heatrisk'), 'loading', 'the cancelled read reports nothing');
});

test('a refused answer is not retried: unusable metadata, a rejected catalog, an HTTP error', async (t) => {
  const map = fakeMap();
  reset(t, map);
  let calls = installFetch([ok('{}')]);
  await heat.activate(map);
  assert.deepEqual(calls, ['metadata']);
  assert.equal(registry.getStatus('heatrisk'), 'error');

  heat.deactivate(map);
  calls = installFetch([ok(METADATA_BODY)], ok(JSON.stringify({ features: [] })));
  await heat.activate(map);
  assert.deepEqual(calls, ['metadata', 'catalog']);
  assert.equal(registry.getStatus('heatrisk'), 'error');

  heat.deactivate(map);
  calls = installFetch([() => Promise.resolve(new Response('busy', { status: 503 }))]);
  await heat.activate(map);
  assert.deepEqual(calls, ['metadata']);
  assert.equal(registry.getStatus('heatrisk'), 'error');
});

test('a page left open across the period end re-installs the stamp as ended; deactivation stops it', async (t) => {
  const map = fakeMap();
  reset(t, map);
  // Day 1's period is in progress with one second left.
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: TIMES[0] + DAY_MS - 1_000 });
  t.after(() => mock.timers.reset());
  installFetch([ok(METADATA_BODY)]);
  await heat.activate(map);
  const before = seen.timeBars.at(-1).stamp;
  assert.equal(before.register, 'outlook');
  assert.match(before.headline, /^Outlook valid /);

  mock.timers.tick(1_000);
  const after = seen.timeBars.at(-1).stamp;
  assert.equal(after.register, 'observed');
  assert.match(after.headline, /^Period ended /);

  // Step to day 2, now in progress, so its end boundary is pending; then off.
  seen.timeBars.at(-1).rail.onStep(1);
  assert.equal(seen.timeBars.at(-1).stamp.register, 'outlook');
  heat.deactivate(map);
  const installs = seen.timeBars.length;
  mock.timers.tick(7 * DAY_MS);
  assert.equal(seen.timeBars.length, installs, 'no stamp after deactivation');
});
