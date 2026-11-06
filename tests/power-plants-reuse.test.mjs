import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Zooming out below the power gate and back in must not read the EIA plants
 * again while their source is still on the map: the body would never be
 * drawn, and its reporting period would reach the key over the old plants.
 * The real src/layers/power-3d.ts; the DOM-bound peripheral modules are stubbed.
 */

const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/map/layer-order': 'export function reassertLabelOrder(){} export function reassertThematicOrder(){}',
  '/map/interaction-coordinator': 'export function registerClickTarget(){}',
  '/ui/legend-registry': `export const LEGEND_ORDER={event:1};
    export function showLegend(){} export function hideLegend(){} export function renderSwatchLegend(){}`,
  '/ui/power-popups': 'export function buildPowerLinePopupModel(){} export function buildPowerPlantPopupModel(){}',
  '/util/pmtiles-probe': 'export async function probeArchiveHeader(){}'
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

const power = await import('../src/layers/power-3d.ts');
const { URLS } = await import('../src/config/urls.ts');
const { getPowerContextState } = await import('../src/state/power-context.ts');

function fakeMap() {
  const sources = new Map();
  const layers = new Set();
  const handlers = new Map();
  let zoom = 8;
  return {
    setZoom(z) { zoom = z; },
    moveEnd: () => handlers.get('moveend')?.(),
    getZoom: () => zoom,
    on(type, fn) { handlers.set(type, fn); },
    off(type) { handlers.delete(type); },
    getSource: (id) => sources.get(id),
    addSource(id, spec) { sources.set(id, spec); },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => (layers.has(id) ? { id } : undefined),
    addLayer(spec) { layers.add(spec.id); },
    removeLayer: (id) => layers.delete(id)
  };
}

const plants = (period) => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { Period: period }, geometry: { type: 'Point', coordinates: [-120, 47] } }]
});

test('a zoom back above the gate reuses the plants on the map and their period', async () => {
  const originalFetch = globalThis.fetch;
  const periods = ['202607', '202608'];
  let plantReads = 0;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    assert.ok(url.startsWith(URLS.eiaPowerPlantsFeatureLayer), `unexpected read ${url}`);
    return new Response(JSON.stringify(plants(periods[plantReads++])), { status: 200 });
  };
  const map = fakeMap();
  try {
    await power.activate(map);
    assert.equal(getPowerContextState()?.periodLabel, '2026-07');

    map.setZoom(3);
    map.moveEnd();
    assert.equal(getPowerContextState(), null, 'below the gate nothing is described');
    map.setZoom(8);
    map.moveEnd();
    // The moveend handler does not return its build: wait for it to settle.
    for (let i = 0; i < 100 && getPowerContextState() === null; i++) await new Promise(setImmediate);
    assert.equal(plantReads, 1, 'no second EIA read while the plants source stands');
    assert.equal(getPowerContextState()?.periodLabel, '2026-07', 'the key names the period drawn');

    power.deactivate(map);
    await power.activate(map);
    assert.equal(plantReads, 2, 'a fresh activation reads again');
  } finally {
    power.deactivate(map);
    globalThis.fetch = originalFetch;
  }
});
