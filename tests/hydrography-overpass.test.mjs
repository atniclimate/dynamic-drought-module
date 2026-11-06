import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { registry } = await import('../src/state/registry.ts');
const hydrography = await import('../src/layers/hydrography.ts');

const way = { type: 'way', tags: { name: 'Fixture River', waterway: 'river' },
  geometry: [{ lat: 46, lon: -120 }, { lat: 46.1, lon: -120.1 }] };
const fakeMap = () => {
  const sources = new Map(); const layers = new Map();
  return {
    sources,
    getZoom: () => 9,
    getBounds: () => ({ getSouth: () => 45.1, getWest: () => -120.9, getNorth: () => 46.4, getEast: () => -119.6 }),
    getSource: id => sources.get(id),
    addSource(id, spec) { sources.set(id, { data: spec.data, setData(data) { this.data = data; } }); },
    removeSource: id => sources.delete(id),
    getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, layer),
    removeLayer: id => layers.delete(id),
    on() {}, off() {}
  };
};

test('Overpass 200 with a remark or no elements array is a mirror failure and is not cached', async () => {
  const previous = globalThis.fetch;
  let calls = 0; let body;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(body)); };
  const map = fakeMap();
  try {
    for (body of [
      { elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 26 seconds.' },
      { version: 0.6 }
    ]) {
      calls = 0;
      await hydrography.activate(map);
      assert.equal(calls, 2, 'both public mirrors were tried');
      assert.equal(registry.getStatus('hydrography'), 'error');
      hydrography.deactivate(map);
    }
    body = { elements: [way] }; calls = 0;
    await hydrography.activate(map);
    assert.equal(calls, 1, 'the earlier failures left no cache entry');
    assert.equal(registry.getStatus('hydrography'), 'ready');
    assert.equal(map.getSource('hydrography').data.features.length, 1);
  } finally { hydrography.deactivate(map); globalThis.fetch = previous; }
});

test('every mirror failing reads error even when the view has drifted onto a cached cell', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 502 });
  const map = fakeMap();
  // The fetch reads an uncached cell; a pan still running then settles the
  // view back on the cell the case above cached.
  const cached = map.getBounds();
  let reads = 0;
  map.getBounds = () => (reads++ === 0
    ? { getSouth: () => 40.1, getWest: () => -110.9, getNorth: () => 41.4, getEast: () => -109.6 }
    : cached);
  try {
    await hydrography.activate(map);
    assert.equal(registry.getStatus('hydrography'), 'error');
  } finally { hydrography.deactivate(map); globalThis.fetch = previous; }
});
