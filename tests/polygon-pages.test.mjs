import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { fetchBufferedWithBudget } from '../src/util/fetch.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const proposed = () => import('../src/util/polygon-pages.ts');
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const feature = id => ({ type: 'Feature', properties: {
  OBJECTID: id, FIRE_YEAR: 2025, FIRE_NUMBER: 'K00001', VERSION_NUMBER: id,
  FIRE_STATUS: 'Being Held', TRACK_DATE: 1787295600000, LOAD_DATE: 1787382000000
}, geometry: { type: 'Polygon', coordinates: [[[-120,49],[-119,49],[-119,50],[-120,49]]] } });
const collection = (ids, truncated = false) => ({ type: 'FeatureCollection',
  properties: { exceededTransferLimit: truncated }, features: ids.map(feature) });
const options = overrides => ({
  urlForPage: (offset, count) => 'https://fixture.invalid/?offset=' + offset + '&count=' + count,
  sourceLabel: 'BCWS fixture', signal: new AbortController().signal,
  pageSize: 1000, pageLimit: 10, pageTimeoutMs: 100, totalTimeoutMs: 1000,
  maxPageBytes: 2000000, maxTotalBytes: 4000000, maxVertices: 50000, ...overrides
});
async function stub(fetcher, body) {
  const previous = globalThis.fetch; globalThis.fetch = fetcher;
  try { return await body(); } finally { globalThis.fetch = previous; }
}
const sequence = bodies => { let i = 0; return async () => new Response(encode(bodies[i++])); };

test('decoded byte cap rejects an overflowing chunk despite a small Content-Length', async () => {
  let cancelled = false;
  await stub(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { cancelled = true; }
  }), { headers: { 'Content-Length': '1' } }), async () => {
    await assert.rejects(fetchBufferedWithBudget('fixture', null, null, 100, 10), RangeError);
    assert.equal(cancelled, true);
  });
});
test('exact byte limit passes unchanged and invalid limits issue no request', async () => {
  let calls = 0;
  await stub(async () => { calls++; return new Response(new Uint8Array([1,2,3])); }, async () => {
    const response = await fetchBufferedWithBudget('fixture', null, null, 100, 3);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1,2,3]);
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(fetchBufferedWithBudget('fixture', null, null, 100, invalid), RangeError);
    assert.equal(calls, 1);
  });
});
test('1000+237 paging preserves all raw versions, fiscal years, statuses and separate clocks', async () => {
  const { readPolygonPages } = await proposed(); const calls = [];
  const first = collection(Array.from({ length: 1000 }, (_, i) => i + 1), true);
  const last = collection(Array.from({ length: 237 }, (_, i) => i + 1001));
  last.features[0].properties.FIRE_STATUS = null;
  let i = 0;
  await stub(async url => { calls.push(url); return new Response(encode([first,last][i++])); }, async () => {
    const result = await readPolygonPages(options());
    assert.equal(result.complete, true); assert.equal(result.collection.features.length, 1237);
    assert.deepEqual(result.collection.features, [...first.features,...last.features]);
    assert.deepEqual(calls, ['https://fixture.invalid/?offset=0&count=1000','https://fixture.invalid/?offset=1000&count=1000']);
  });
});
test('complete empty and failed empty are different', async () => {
  const { readPolygonPages } = await proposed();
  await stub(sequence([collection([])]), async () => assert.equal((await readPolygonPages(options())).complete, true));
  await stub(sequence([{ error: { code: 500 } }]), async () => {
    const result = await readPolygonPages(options()); assert.equal(result.complete, false); assert.equal(result.reason, 'read-failed'); assert.equal(result.collection.features.length, 0);
  });
});
test('full page follows even false flag; top false does not override nested true', async () => {
  const { readPolygonPages } = await proposed();
  for (const first of [collection([1,2]), { ...collection([1], true), exceededTransferLimit: false }]) {
    await stub(sequence([first,collection([3])]), async () => {
      const result = await readPolygonPages(options({ pageSize: 2 }));
      assert.equal(result.complete, true); assert.equal(result.pages, 2);
    });
  }
});
for (const [name, last] of [
  ['ArcGIS error', { error: { code: 500 } }],
  ['malformed nested flag', { ...collection([2]), properties: { exceededTransferLimit: 'true' } }],
  ['malformed geometry', { ...collection([2]), features: [{ ...feature(2), geometry: null }] }]
]) test(name + ' retains valid earlier page as partial', async () => {
  const { readPolygonPages } = await proposed();
  await stub(sequence([collection([1], true), last]), async () => {
    const result = await readPolygonPages(options());
    assert.equal(result.complete, false); assert.equal(result.reason, 'read-failed');
    assert.deepEqual(result.collection.features, [feature(1)]);
  });
});
test('HTTP second-page failure is partial', async () => {
  const { readPolygonPages } = await proposed(); let i = 0;
  await stub(async () => i++ ? new Response('', { status: 503 }) : new Response(encode(collection([1], true))), async () => {
    const result = await readPolygonPages(options()); assert.equal(result.reason, 'read-failed'); assert.equal(result.collection.features.length, 1);
  });
});
test('duplicate ID is deduplicated but a repeated final page is never complete', async () => {
  const { readPolygonPages } = await proposed();
  await stub(sequence([collection([1], true), collection([1,2])]), async () => {
    const result = await readPolygonPages(options()); assert.equal(result.complete, true); assert.equal(result.collection.features.length, 2);
  });
  await stub(sequence([collection([1], true), collection([1])]), async () => {
    const result = await readPolygonPages(options()); assert.equal(result.reason, 'repeated-page'); assert.equal(result.collection.features.length, 1);
  });
});
test('changed old ID and missing new ID reject the whole incoming page', async () => {
  const { readPolygonPages } = await proposed();
  const changed = collection([2,1]); changed.features[1].properties.VERSION_NUMBER = 10;
  const missing = collection([2,3]); delete missing.features[1].properties.OBJECTID;
  for (const [last,reason] of [[changed,'changed-record'],[missing,'invalid-id']]) {
    await stub(sequence([collection([1], true),last]), async () => {
      const result = await readPolygonPages(options()); assert.equal(result.reason, reason); assert.deepEqual(result.collection.features, [feature(1)]);
    });
  }
});
test('page, aggregate byte and vertex limits preserve only already accepted data', async () => {
  const { readPolygonPages } = await proposed();
  for (const [overrides,reason] of [
    [{pageLimit:1},'page-limit'],
    [{maxTotalBytes:encode(collection([1],true)).length + 1},'byte-limit'],
    [{maxVertices:4},'vertex-limit']
  ]) await stub(sequence([collection([1],true),collection([2])]), async () => {
    const result = await readPolygonPages(options(overrides)); assert.equal(result.reason, reason); assert.deepEqual(result.collection.features, [feature(1)]);
    assert.equal(result.retainedVertices, 4);
    if (reason === 'vertex-limit') assert.equal(result.inspectedVertices, 8);
    assert.equal(result.retainedVertices, 4);
    if (reason === 'vertex-limit') assert.equal(result.inspectedVertices, 8);
  });
});
test('aggregate deadline cancels a stalled body and cannot become complete', async () => {
  const { readPolygonPages } = await proposed(); let cancelled = false;
  await stub(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), async () => {
    const result = await readPolygonPages(options({ totalTimeoutMs: 25, pageTimeoutMs: 1000 }));
    assert.equal(result.reason, 'deadline'); assert.equal(cancelled, true); assert.equal(result.complete, false);
  });
});
test('owner abort after an accepted page rejects rather than publishing partial data', async () => {
  const { readPolygonPages } = await proposed(); const controller = new AbortController(); let i = 0;
  let noteSecond; const second = new Promise(resolve => { noteSecond = resolve; }); let cancelled = false;
  await stub(async () => i++ ? (noteSecond(), new Response(new ReadableStream({ cancel() { cancelled = true; } }))) :
    new Response(encode(collection([1], true))), async () => {
    const pending = readPolygonPages(options({ signal: controller.signal }));
    await second; controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(cancelled, true);
  });
});
test('invalid caller limits and pre-aborted owner do not start requests', async () => {
  const { readPolygonPages } = await proposed(); let requests = 0;
  await stub(async () => { requests++; return new Response(encode(collection([]))); }, async () => {
    await assert.rejects(readPolygonPages(options({ maxTotalBytes: 0 })), RangeError);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readPolygonPages(options({ signal: controller.signal })), error => error.name === 'AbortError');
    assert.equal(requests, 0);
  });
});


test('DR-134 status whitelist stays exact, including unseen and future values', async () => {
  const { bcwsStatusClass } = await import('../src/util/bcws-perimeter-read.ts');
  for (const value of ['Out of Control','Being Held','Under Control',' being held ']) assert.equal(bcwsStatusClass(value), 'active');
  assert.equal(bcwsStatusClass('Out'), 'inactive');
  for (const value of [null, undefined, '', 'Smouldering', 'Contained', 1]) assert.equal(bcwsStatusClass(value), 'unknown');
});
test('BCWS query uses adopted geometry/paging contract and preserves earlier-year current records', async () => {
  const { readBcwsPerimeters } = await import('../src/util/bcws-perimeter-read.ts');
  let requested;
  await stub(async url => { requested = new URL(url); return new Response(encode(collection([1]))); }, async () => {
    const result = await readBcwsPerimeters({ ...options(), endpoint: 'https://fixture.invalid/query', bounds: [-125,46,-116,50] });
    assert.equal(result.complete, true); assert.equal(result.collection.features[0].properties.FIRE_YEAR, 2025);
    for (const [key,value] of Object.entries({ where:'1=1',outSR:'4326',orderByFields:'OBJECTID ASC',resultOffset:'0',
      resultRecordCount:'1000',maxAllowableOffset:'0.0005',geometryPrecision:'5',geometry:'-125,46,-116,50',
      geometryType:'esriGeometryEnvelope',inSR:'4326',spatialRel:'esriSpatialRelIntersects' }))
      assert.equal(requested.searchParams.get(key), value);
    assert.equal(result.collection.features[0].properties.TRACK_DATE, 1787295600000);
    assert.equal(result.collection.features[0].properties.LOAD_DATE, 1787382000000);
  });
});


test('overflow settles even if the underlying cancellation promise stalls', { timeout: 500 }, async () => {
  // A cap crossing and an owner withdrawal must both settle without waiting
  // for the stream implementation's cancellation acknowledgement.
  let cancelled = false;
  await stub(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  })), async () => {
    await assert.rejects(fetchBufferedWithBudget('fixture', null, null, 100, 10), RangeError);
    assert.equal(cancelled, true);
  });
});

test('owner abort while headers resolve settles even when stream cancellation stalls', { timeout: 500 }, async () => {
  const owner = new AbortController();
  let cancelled = false;
  await stub(async () => {
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise(() => {}); }
    }));
    // The owner withdraws after fetch was entered but before its response
    // continuation starts body consumption. This reaches the already-aborted
    // reader branch, unlike cancellation of an already-pending reader.read().
    owner.abort();
    return response;
  }, async () => {
    await assert.rejects(
      fetchBufferedWithBudget('fixture', null, owner.signal, 100, 10),
      error => error.name === 'AbortError'
    );
    assert.equal(cancelled, true);
  });
});
