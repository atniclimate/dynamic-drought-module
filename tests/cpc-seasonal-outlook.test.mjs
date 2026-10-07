import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CPC_SEASONAL_CLASSES, CPC_RENDERER_COLORS, cpcSeasonalBody } from './cpc-seasonal-polygon-fixtures.mjs';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { createCpcSeasonalAdapter } = await import('../src/layers/cpc-seasonal-outlook.ts');
const { CPC_SEASONAL_COLORS } = await import('../src/config/palette.ts');
const { registry } = await import('../src/state/registry.ts');
// Test-only allowances and opacity, not a proposed production declaration.
const limits = { timeoutMs: 100, maxDecodedBytes: 100_000, maxFeatures: 20, maxAllowableOffset: 0.01 };
const key = variable => variable === 'precipitation' ? 'cpc-seasonal-precip' : 'cpc-seasonal-temp';
const make = variable => createCpcSeasonalAdapter({ variable, limits, fillOpacity: 0.75 });
const response = value => new Response(JSON.stringify(value));
function fakeMap() {
  const sources = new Map(), layers = new Map(), removed = [];
  return { sources, layers, removed,
    getSource: id => sources.get(id), getLayer: id => layers.get(id),
    addSource(id, source) {
      assert.equal(sources.has(id), false);
      sources.set(id, { ...source, setData(data) { this.data = data; } });
    },
    addLayer(layer) { assert.equal(layers.has(layer.id), false); layers.set(layer.id, layer); },
    removeLayer(id) { removed.push(id); layers.delete(id); },
    removeSource(id) {
      assert.equal([...layers.values()].some(layer => layer.source === id), false);
      removed.push(id); sources.delete(id);
    }
  };
}
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally {
    globalThis.fetch = original;
    registry.deactivate(key('precipitation'));
    registry.deactivate(key('temperature'));
  }
}
test('both adapters draw exact issuer cat/prob colors including EC and preserve raw clocks', async () => {
  await withFetch(async () => response(cpcSeasonalBody('polygons')), async () => {
    const map = fakeMap();
    for (const [variable, fixtureKey] of [['precipitation', 'precip'], ['temperature', 'temp']]) {
      const adapter = make(variable), id = key(variable);
      await adapter.activate(map);
      assert.equal(registry.getStatus(id), 'ready');
      assert.equal(registry.getActiveKeys().has(id), false, 'membership remains controller-owned');
      assert.deepEqual(adapter.getSnapshot().collection, cpcSeasonalBody('polygons'));
      assert.deepEqual(CPC_SEASONAL_COLORS[variable].map(row => ({ cat: row.cat, prob: row.prob, label: row.label })), CPC_SEASONAL_CLASSES);
      assert.deepEqual(CPC_SEASONAL_COLORS[variable].map(row => [...row.color]), CPC_RENDERER_COLORS[fixtureKey]);
      const fill = map.layers.get(id + '-fill'), line = map.layers.get(id + '-line');
      assert.equal(fill.paint['fill-opacity'], 0.75);
      const match = fill.paint['fill-color'];
      for (let i = 0; i < 17; i++) {
        const row = CPC_SEASONAL_CLASSES[i], rgba = CPC_RENDERER_COLORS[fixtureKey][i];
        assert.equal(match[2 + 2 * i], row.cat + ',' + row.prob);
        assert.equal(match[3 + 2 * i], `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`);
      }
      assert.deepEqual(line.paint, { 'line-color': 'rgb(110,110,110)', 'line-width': 1 });
      assert.equal(map.sources.get(id).data.features.length, 17, 'transparent EC still has an outline');
      adapter.deactivate(map);
      assert.deepEqual(map.removed.slice(-3), [id + '-line', id + '-fill', id]);
      assert.equal(adapter.getSnapshot(), null);
    }
  });
});
test('unknown pairs remain raw, never receive EC geometry, and downgrade source completeness', async () => {
  const body = cpcSeasonalBody('polygons');
  body.features[0].properties = { cat: 'Future', prob: 90, valid_seas: null, fcst_date: null };
  await withFetch(async () => response(body), async () => {
    const map = fakeMap(), adapter = make('precipitation');
    await adapter.activate(map);
    assert.equal(registry.getStatus(key('precipitation')), 'degraded');
    assert.equal(adapter.getSnapshot().unknownFeatures, 1);
    assert.deepEqual(adapter.getSnapshot().collection.features[0].properties, body.features[0].properties);
    assert.equal(map.sources.get(key('precipitation')).data.features.length, 16);
    adapter.deactivate(map);
  });
  for (const properties of [{ cat: 'EC', prob: '33' }, { cat: 'Future', prob: 33 }, null]) {
    const unknown = cpcSeasonalBody('polygons');
    unknown.features = [{ ...unknown.features[0], properties }];
    await withFetch(async () => response(unknown), async () => {
      const map = fakeMap(), adapter = make('temperature');
      await adapter.activate(map);
      assert.equal(registry.getStatus(key('temperature')), 'error');
      assert.equal(map.sources.size, 0);
      adapter.deactivate(map);
    });
  }
});
test('refresh cannot retain old geometry or clock on empty, partial-empty, error, or timeout', { timeout: 2_000 }, async () => {
  for (const [arm, expected] of [['emptyCollection', 'no-data'], ['partialEmpty', 'degraded'], ['arcgisError', 'error'], ['hold', 'error']]) {
    let count = 0;
    await withFetch(async () => ++count === 1 ? response(cpcSeasonalBody('polygons')) :
      arm === 'hold' ? new Response(new ReadableStream()) : response(cpcSeasonalBody(arm)), async () => {
      const map = fakeMap(), adapter = make('precipitation');
      await adapter.activate(map);
      assert.equal(map.sources.size, 1);
      await adapter.activate(map);
      assert.equal(registry.getStatus(key('precipitation')), expected);
      assert.equal(map.sources.size, 0);
      assert.equal(adapter.getSnapshot().collection.features.length, 0);
      adapter.deactivate(map);
    });
  }
});
test('native owner abort cancels one variable without cancelling the other or drawing late', async () => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let signal;
  await withFetch(async (url, options) => {
    if (url.includes('precip')) { signal = options.signal; started(); return held; }
    return response(cpcSeasonalBody('polygons'));
  }, async () => {
    const map = fakeMap(), precip = make('precipitation'), temp = make('temperature');
    const owner = new AbortController();
    const pending = precip.activate(map, { signal: owner.signal, generation: 1 });
    await entered;
    await temp.activate(map);
    owner.abort();
    assert.equal(signal.aborted, true);
    precip.deactivate(map);
    release(response(cpcSeasonalBody('polygons')));
    await pending;
    assert.equal(map.sources.has(key('precipitation')), false);
    assert.equal(map.sources.has(key('temperature')), true);
    assert.equal(registry.getStatus(key('temperature')), 'ready');
    assert.equal(precip.getSnapshot(), null);
    temp.deactivate(map);
  });
});
test('same-variable supersession and old-map teardown cannot replace the newer map', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let count = 0;
  await withFetch(async () => ++count === 1 ? held : response(cpcSeasonalBody('polygons')), async () => {
    const first = fakeMap(), second = fakeMap(), adapter = make('temperature');
    const pending = adapter.activate(first);
    await adapter.activate(second);
    adapter.deactivate(first);
    release(response(cpcSeasonalBody('emptyCollection')));
    await pending;
    assert.equal(second.sources.size, 1);
    assert.equal(first.sources.size, 0);
    assert.equal(registry.getStatus(key('temperature')), 'ready');
    adapter.deactivate(second);
  });
});
test('already-aborted activation performs no request and map insertion failure is unavailable', async () => {
  await withFetch(async () => assert.fail('Unexpected request'), async () => {
    const owner = new AbortController(); owner.abort();
    await make('precipitation').activate(fakeMap(), { signal: owner.signal, generation: 1 });
  });
  let reads = 0;
  await withFetch(async () => { reads++; return response(cpcSeasonalBody('polygons')); }, async () => {
    const map = fakeMap(), adapter = make('precipitation');
    await adapter.activate(map);
    const prior = adapter.getSnapshot();
    const owner = new AbortController(); owner.abort();
    await adapter.activate(map, { signal: owner.signal, generation: 2 });
    assert.equal(reads, 1);
    assert.equal(adapter.getSnapshot(), prior, 'rejected attempt must not mutate a prior snapshot');
    assert.equal(map.sources.size, 1);
    assert.equal(registry.getStatus(key('precipitation')), 'ready');
    adapter.deactivate(map);
    assert.equal(map.sources.size, 0);
  });
  await withFetch(async () => response(cpcSeasonalBody('polygons')), async () => {
    const map = fakeMap();
    map.addLayer = () => { throw new Error('Style failure'); };
    const adapter = make('precipitation');
    await adapter.activate(map);
    assert.equal(registry.getStatus(key('precipitation')), 'error');
    assert.equal(map.sources.size, 0);
    adapter.deactivate(map);
  });
});
