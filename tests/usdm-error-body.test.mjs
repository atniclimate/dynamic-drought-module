import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ArcGIS answers an outage as HTTP 200 with an `error` body. The drought
 * layer must read that as an error, draw nothing, and ask again on the next
 * activation, never report an empty "no-data" week it then keeps.
 * The real src/layers/usdm.ts; the DOM-bound peripheral modules are stubbed.
 */

const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/map/interaction-coordinator': 'export function registerClickTarget(){}',
  '/ui/time-bar': 'export function setTimeBar(){} export function clearTimeBar(){}',
  '/ui/legend-registry': `export const LEGEND_ORDER={surface:1};
    export function showLegend(){ return null; } export function hideLegend(){}
    export function renderSwatchLegend(){}`,
  // The real cache uses a TypeScript parameter property, which type stripping refuses.
  '/util/frame-stepper': `export class FrameCache { m = new Map();
      peek(k){ return this.m.get(k); }
      get(k, load){ if (!this.m.has(k)) this.m.set(k, load(k)); return this.m.get(k); }
      prefetch(){} }
    export async function crossfadeFrames(){} export function primeForFadeIn(){}`
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
const { registry } = await import('../src/state/registry.ts');

function fakeMap() {
  const sources = new Map();
  return {
    sources,
    on() {},
    off() {},
    getSource: (id) => sources.get(id),
    getLayer: () => undefined,
    addSource(id, spec) { sources.set(id, { spec, setData() {} }); },
    addLayer() {},
    removeLayer() {},
    removeSource: (id) => sources.delete(id),
    setLayoutProperty() {},
    setPaintProperty() {},
    getPaintProperty() { return 1; }
  };
}

test('an ArcGIS HTTP 200 error body is an error, draws nothing and is asked again', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const body = { error: { code: 500, message: 'Unable to complete operation.' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const map = fakeMap();
    await usdm.activate(map);
    assert.equal(registry.getStatus('usdm'), 'error', 'not "no-data"');
    assert.equal(map.sources.size, 0, 'the error object is never a map source');
    usdm.deactivate(map);
    await usdm.activate(map);
    assert.equal(calls, 2, 'the next activation reads the service again');
    usdm.deactivate(map);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('a FeatureCollection with an unclosed ring and a null geometry still activates', async () => {
  const originalFetch = globalThis.fetch;
  const mapDate = Date.UTC(2026, 9, 6);
  const body = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { DM: 1, MapDate: mapDate },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] }
      },
      { type: 'Feature', properties: { DM: 2, MapDate: mapDate }, geometry: null }
    ]
  };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    const map = fakeMap();
    await usdm.activate(map);
    assert.equal(registry.getStatus('usdm'), 'ready');
    assert.equal(map.sources.get('usdm-frame-a')?.spec.data.features.length, 2, 'features kept as served');
    usdm.deactivate(map);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
