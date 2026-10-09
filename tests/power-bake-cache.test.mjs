import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const features = Array.from({ length: 5000 }, () => ({
  type: 'Feature', properties: { VOLT_CLASS: 'NOT AVAILABLE' },
  geometry: { type: 'LineString', coordinates: [[-120, 47], [-121, 48]] }
}));
const state = { cached: null, writes: [], attribution: '' };
globalThis.__powerBakeTest = state;

// Exercise the whole bake with in-memory I/O; never replace a real cache or archive.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith('/scripts/build-power-tiles.mjs')) return nextResolve(specifier, context);
    const stubs = {
      'node:fs/promises': `
        const state = globalThis.__powerBakeTest;
        export async function mkdir() {}
        export async function readFile(path) {
          if (!path.endsWith('.geojson')) return '';
          if (state.cached === null) throw new Error('no cache');
          return JSON.stringify(state.cached);
        }
        export async function writeFile(path, data) { state.writes.push({ path, data }); }
      `,
      vite: `export async function transformWithOxc() {
        return { code: 'export const POWER_LINE_WIDTHS = [["NOT AVAILABLE", 1]];' };
      }`,
      pmtiles: `export class PMTiles {
        async getHeader() { return { minZoom: 0, maxZoom: 11, tileType: 1 }; }
        async getMetadata() { return { vector_layers: [{ id: 'power-lines' }], attribution: globalThis.__powerBakeTest.attribution }; }
      }`,
      './lib/geojson-to-pmtiles.mjs': `export function geojsonLayersToPmtiles(layers, options) {
        globalThis.__powerBakeTest.attribution = options.attribution;
        return { archive: new Uint8Array(1), tileCount: 1 };
      }`
    };
    if (specifier in stubs) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
const { main } = await import('../scripts/build-power-tiles.mjs');

test('power bakes preserve cache retrieval dates and never invent dates for legacy caches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('cached bakes must not fetch'); };
  try {
    for (const [retrieved, expected] of [['2026-08-19', '2026-08-19'], [undefined, 'unknown'], [123, 'unknown']]) {
      state.cached = { type: 'FeatureCollection', features, retrieved };
      state.writes = [];
      await main();
      assert.ok(state.attribution.includes(`retrieved ${expected};`));
      assert.equal(state.writes.some(({ path }) => path.endsWith('.geojson')), false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a fresh pull records its retrieval date in both the cache and archive attribution', async () => {
  const originalFetch = globalThis.fetch;
  state.cached = null;
  state.writes = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ features }));
  const before = new Date().toISOString().slice(0, 10);
  try {
    await main();
    const cached = JSON.parse(state.writes.find(({ path }) => path.endsWith('.geojson')).data);
    assert.ok([before, new Date().toISOString().slice(0, 10)].includes(cached.retrieved));
    assert.ok(state.attribution.includes(`retrieved ${cached.retrieved};`));
    assert.equal(cached.features.length, 5000);
  } finally { globalThis.fetch = originalFetch; }
});
