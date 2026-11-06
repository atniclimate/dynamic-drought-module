import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit round 5 (R5-6, R5-7, R5-8): the US Drought Monitor rail and its
 * change map, driven through the real src/layers/usdm.ts by the time bar's
 * own callbacks. The time bar is captured, the crossfade is a gate the test
 * opens, and the map double keeps each layer's visibility and opacity, so a
 * case can ask what is drawn and what is still queryable.
 */

const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/map/interaction-coordinator': 'export function registerClickTarget(){}',
  '/ui/time-bar': 'export function setTimeBar(key, spec){ globalThis.__bar = spec; } export function clearTimeBar(){}',
  '/ui/legend-registry': `export const LEGEND_ORDER={surface:1};
    export function showLegend(){ return null; } export function hideLegend(){}
    export function renderSwatchLegend(){}`,
  // The real cache uses a TypeScript parameter property, which type stripping refuses.
  '/util/frame-stepper': `export class FrameCache { m = new Map();
      peek(k){ return this.m.get(k); }
      async get(k, load){ if (this.m.has(k)) return this.m.get(k);
        const f = await load(k); this.m.set(k, f); return f; }
      prefetch(){} }
    export function primeForFadeIn(map, targets){ for (const t of targets) map.setPaintProperty(t.layerId, t.prop, 0); }
    export async function crossfadeFrames(map, out, inc){
      for (const t of inc) map.setPaintProperty(t.layerId, t.prop, t.target);
      for (const t of out) map.setPaintProperty(t.layerId, t.prop, 0);
      await globalThis.__fade?.(); }`
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
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

globalThis.window = globalThis;
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const usdm = await import('../src/layers/usdm.ts');
const { timeline } = await import('../src/state/timeline.ts');

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    layers,
    on() {},
    off() {},
    getSource: (id) => sources.get(id),
    addSource(id) { sources.set(id, { setData() {} }); },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.get(id),
    addLayer(spec) {
      const paint = spec.paint ?? {};
      layers.set(spec.id, { visibility: spec.layout?.visibility ?? 'visible', opacity: paint['fill-opacity'] ?? paint['line-opacity'] ?? 1 });
    },
    removeLayer: (id) => layers.delete(id),
    setLayoutProperty(id, prop, value) { if (prop === 'visibility' && layers.has(id)) layers.get(id).visibility = value; },
    setPaintProperty(id, prop, value) { if (prop.endsWith('opacity') && layers.has(id)) layers.get(id).opacity = value; },
    getPaintProperty: (id) => layers.get(id)?.opacity
  };
}

/** Fills a reader can query (layout visible, whatever the opacity). */
const queryable = (map) => [...map.layers].filter(([id, l]) => id.endsWith('-fill') && l.visibility === 'visible').map(([id]) => id);
/** Fills a person can see: queryable and not faded to nothing. */
const drawn = (map) => queryable(map).filter((id) => map.layers.get(id).opacity > 0);

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const busy = () => new Response('busy', { status: 503, statusText: 'Service Unavailable' });
const week = (dm) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { DM: dm }, geometry: null }] });

/**
 * Activate on a rail whose newest week is `latestMs` (each case its own year,
 * so the module's session caches never carry one case's weeks into another).
 * The current week answers; archive weeks and change maps ask the case.
 */
async function withRail(latestMs, run) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  const handlers = { archive: async () => busy(), change: async () => busy() };
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('where=1%3D1')) {
      return json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { DM: 1, MapDate: latestMs }, geometry: null }] });
    }
    return url.includes('where=MapDate') ? handlers.archive(url) : handlers.change(url);
  };
  const map = fakeMap();
  try {
    await usdm.activate(map);
    await run(map, handlers);
  } finally {
    globalThis.__fade = undefined;
    usdm.deactivate(map);
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

test('the change-map stamp is the change file\'s own date, not the rail\'s newest week (R5-8)', async () => {
  await withRail(Date.UTC(2026, 9, 6), async (map, handlers) => {
    // The session spans a Thursday release: the change file is a week newer than the rail.
    handlers.change = async () => json({ ...week(0), date: '20261013' });
    globalThis.__bar.modes.onSelect('chg1');
    await settle();
    assert.equal(timeline.usdmMode, 'chg1');
    assert.equal(globalThis.__bar.stamp.headline, 'Change through Oct 13, 2026');
  });
});

test('stepping off the newest week keeps the change map on screen until the week loads, and after it fails (R5-6)', async () => {
  await withRail(Date.UTC(2025, 9, 7), async (map, handlers) => {
    handlers.change = async () => json({ ...week(0), date: '20251007' });
    globalThis.__bar.modes.onSelect('chg4');
    await settle();
    assert.deepEqual(drawn(map), ['usdm-change-fill']);

    const archive = deferred();
    handlers.archive = () => archive.promise;
    globalThis.__bar.rail.onStep(globalThis.__bar.rail.index - 1);
    await settle();
    assert.deepEqual(drawn(map), ['usdm-change-fill'], 'the map is empty while the archive week loads');

    archive.resolve(busy());
    await settle();
    assert.deepEqual(drawn(map), ['usdm-change-fill'], 'a failed week leaves the map empty');
    assert.equal(timeline.usdmMode, 'chg4', 'the mode chip still describes what is drawn');
    assert.match(globalThis.__bar.stamp.headline, /^Change through /);

    // A week that loads replaces the change map with its categories.
    handlers.archive = async () => json(week(2));
    globalThis.__bar.rail.onStep(globalThis.__bar.rail.index - 1);
    await settle();
    assert.deepEqual(drawn(map), ['usdm-frame-b-fill']);
    assert.deepEqual(queryable(map), ['usdm-frame-b-fill']);
    assert.equal(timeline.usdmMode, 'absolute');
    assert.match(globalThis.__bar.stamp.headline, /^Valid /);
  });
});

test('stepping back to the newest week while an older one loads keeps only the change map (R5-6)', async () => {
  await withRail(Date.UTC(2023, 9, 10), async (map, handlers) => {
    handlers.change = async () => json({ ...week(0), date: '20231010' });
    globalThis.__bar.modes.onSelect('chg4');
    await settle();
    assert.deepEqual(drawn(map), ['usdm-change-fill']);

    const newest = globalThis.__bar.rail.index;
    const archive = deferred();
    handlers.archive = () => archive.promise;
    globalThis.__bar.rail.onStep(newest - 1);
    await settle();
    globalThis.__bar.rail.onStep(newest);
    await settle();
    assert.deepEqual(drawn(map), ['usdm-change-fill'], 'the newest week is drawn over the change map');
    assert.equal(timeline.usdmMode, 'chg4');

    // The superseded archive week arriving late changes nothing.
    archive.resolve(json(week(2)));
    await settle();
    assert.deepEqual(drawn(map), ['usdm-change-fill']);
    assert.equal(timeline.usdmMode, 'chg4');
    assert.equal(globalThis.__bar.rail.index, newest);
  });
});

test('two quick rail steps never leave the older week queryable under the drawn one (R5-7)', async () => {
  await withRail(Date.UTC(2024, 9, 8), async (map, handlers) => {
    const newest = globalThis.__bar.rail.index;
    handlers.archive = async () => json(week(3));
    globalThis.__bar.rail.onStep(newest - 1);
    await settle();
    assert.deepEqual(queryable(map), ['usdm-frame-b-fill']);

    // Back to the cached newest week; its crossfade is still running...
    const fade = deferred();
    globalThis.__fade = () => fade.promise;
    globalThis.__bar.rail.onStep(newest);
    await settle();
    // ...when a step to an uncached week begins.
    const archive = deferred();
    handlers.archive = () => archive.promise;
    globalThis.__bar.rail.onStep(newest - 2);
    await settle();
    fade.resolve();
    await settle();
    assert.deepEqual(queryable(map), ['usdm-frame-a-fill'], 'the faded-out week is still queryable while the next one loads');

    archive.resolve(busy());
    await settle();
    assert.deepEqual(queryable(map), ['usdm-frame-a-fill'], 'and stays queryable after that load fails');
  });
});
