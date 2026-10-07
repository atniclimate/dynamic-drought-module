import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cpcSeasonalBody } from './cpc-seasonal-polygon-fixtures.mjs';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') && existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { createCpcSeasonalReader } = await import('../src/layers/cpc-seasonal-read.ts');
// Synthetic test limits only, not adopted source/activation allowances.
const limits = { timeoutMs: 100, maxDecodedBytes: 100_000, maxFeatures: 20, maxAllowableOffset: 0.01 };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}
test('both REST Lead 1 requests retain all 17 raw classes and both source clocks', async () => {
  const urls = [], states = [];
  await withFetch(async url => { urls.push(new URL(url)); return json(cpcSeasonalBody('polygons')); }, async () => {
    const reader = createCpcSeasonalReader(s => states.push(s));
    await reader.read('precipitation', limits);
    await reader.read('temperature', limits);
  });
  assert.deepEqual(urls.map(u => u.pathname), ['/vector/rest/services/outlooks/cpc_sea_precip_outlk/MapServer/0/query', '/vector/rest/services/outlooks/cpc_sea_temp_outlk/MapServer/0/query']);
  for (const url of urls) {
    assert.equal(url.searchParams.get('outFields'), 'cat,prob,valid_seas,fcst_date');
    assert.equal(url.searchParams.get('returnGeometry'), 'true');
    assert.equal(url.searchParams.get('maxAllowableOffset'), '0.01');
    assert.equal(url.searchParams.get('resultRecordCount'), '20');
    assert.equal(url.searchParams.get('f'), 'geojson');
  }
  assert.deepEqual(states.map(s => s.status), ['loading', 'ready', 'loading', 'ready']);
  assert.deepEqual(states[1].collection, cpcSeasonalBody('polygons'));
  assert.equal(states[3].variable, 'temperature');
});
for (const [arm, status] of [['emptyCollection','no-data'], ['partial','degraded'], ['partialEmpty','degraded'], ['arcgisError','error'], ['lbEnvelope','error'], ['attributeOnly','error']]) {
  test(`runtime state ${arm} is ${status}`, async () => {
    const states = [];
    await withFetch(async () => json(cpcSeasonalBody(arm)), () => createCpcSeasonalReader(s => states.push(s)).read('precipitation', limits));
    assert.deepEqual(states.map(s => s.status), ['loading', status]);
    if (status === 'error') assert.deepEqual(states[1].collection.features, []);
  });
}
test('HTTP and invalid JSON cannot become no-data', async () => {
  for (const response of [new Response('bad', { status: 503 }), new Response('<html>bad</html>')]) {
    const states = [];
    await withFetch(async () => response, () => createCpcSeasonalReader(s => states.push(s)).read('temperature', limits));
    assert.equal(states.at(-1).status, 'error');
  }
});
test('deadline consumes and cancels a stalled body, then publishes unavailable', { timeout: 1_000 }, async () => {
  let canceled = false;
  const states = [];
  await withFetch(async () => new Response(new ReadableStream({ cancel() { canceled = true; } })), () => createCpcSeasonalReader(s => states.push(s)).read('precipitation', { ...limits, timeoutMs: 25 }));
  assert.equal(canceled, true);
  assert.deepEqual(states.map(s => s.status), ['loading', 'error']);
});
test('cancel owns a stalled body and emits no late terminal state', async () => {
  let started, canceled = false;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const states = [];
  await withFetch(async () => new Response(new ReadableStream({ start() { started(); }, cancel() { canceled = true; } })), async () => {
    const reader = createCpcSeasonalReader(s => states.push(s));
    const pending = reader.read('precipitation', limits);
    await bodyStarted;
    reader.cancel();
    await pending;
  });
  assert.equal(canceled, true);
  assert.deepEqual(states.map(s => s.status), ['loading']);
});
test('superseded header response cannot replace newer variable or publish error', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const states = [];
  await withFetch(async url => url.includes('precip') ? held : json(cpcSeasonalBody('polygons')), async () => {
    const reader = createCpcSeasonalReader(s => states.push(s));
    const prior = reader.read('precipitation', limits);
    await reader.read('temperature', limits);
    release(json(cpcSeasonalBody('polygons')));
    await prior;
  });
  assert.deepEqual(states.map(s => [s.variable, s.status]), [['precipitation','loading'], ['temperature','loading'], ['temperature','ready']]);
});
test('decoded byte ceiling cancels overflow and feature ceiling rejects oversized answer', async () => {
  let canceled = false;
  const states = [];
  await withFetch(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(101)); }, cancel() { canceled = true; } })), () => createCpcSeasonalReader(s => states.push(s)).read('precipitation', { ...limits, maxDecodedBytes: 100 }));
  assert.equal(canceled, true);
  assert.equal(states.at(-1).status, 'error');
  await withFetch(async () => json(cpcSeasonalBody('polygons')), () => createCpcSeasonalReader(s => states.push(s)).read('temperature', { ...limits, maxFeatures: 16 }));
  assert.equal(states.at(-1).status, 'error');
});
test('invalid or absent limits reject before egress; no implicit allowance', async () => {
  await withFetch(async () => { throw new Error('Unexpected egress'); }, async () => {
    const reader = createCpcSeasonalReader(() => assert.fail('Unexpected publish'));
    for (const patch of [{ timeoutMs: 10_001 }, { maxDecodedBytes: undefined }, { maxFeatures: 0 }, { maxAllowableOffset: NaN }]) {
      await assert.rejects(reader.read('temperature', { ...limits, ...patch }), RangeError);
    }
  });
});
