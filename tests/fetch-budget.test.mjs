/**
 * The fetch budget spans the body (src/util/fetch.ts).
 *
 * Codex 2026-09-10 finding S2: `fetchWithBudget` clears its timer and drops
 * the master abort listener the moment headers arrive, so a caller that then
 * reads the body (`.json()`, `.text()`, `.arrayBuffer()`) against a server
 * that answered 200 and stalled hangs with no timeout and no cancel, and its
 * layer stays `loading` forever. `fetchBufferedWithBudget` and
 * `fetchJsonWithBudget` keep the controller armed until the body resolves.
 *
 * Two kinds of case. The behaviour cases pin the two helpers: a stalled body
 * is cut off by the budget and the stream is cancelled; an abort of the
 * owning signal after headers cancels the read; a fast body passes through
 * with the same status, headers and bytes, so a caller's `.ok` and `.status`
 * taxonomy is untouched by the migration. The inventory case is the
 * regression guard: no file under `src/` may pair `fetchWithBudget(` with a
 * body read, which is enforced by allowing no caller of `fetchWithBudget(` at
 * all (the two streaming readers, hydromet and the PMTiles probe, own their
 * controllers and never call it). Against the tree before the migration the
 * inventory case fails on 28 call sites in 20 files.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `*.test.mjs` files, wired into `check:all`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchBufferedWithBudget, fetchJsonWithBudget } from '../src/util/fetch.ts';

const encoder = new TextEncoder();

/**
 * A fetch stub whose response body is a stream the test controls. `chunks`
 * are enqueued at start; the stream closes only when `close` is true, so a
 * `close: false` body models a server that sent headers and then stalled.
 * `cancelled` resolves when the consumer cancels the stream.
 */
function stubFetch({ status = 200, headers = {}, chunks = [], close = true } = {}) {
  let noteCancelled;
  const cancelled = new Promise((resolve) => {
    noteCancelled = resolve;
  });
  let noteHeaders;
  const headersReturned = new Promise((resolve) => {
    noteHeaders = resolve;
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (close) controller.close();
      },
      cancel() {
        noteCancelled();
      }
    });
    const nullBody = status === 204 || status === 205 || status === 304;
    const response = new Response(nullBody ? null : body, { status, headers });
    noteHeaders();
    return response;
  };
  return { fetchImpl, cancelled, headersReturned, calls };
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub.fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function raced(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('fetchBufferedWithBudget: a stalled body is cut off by the budget and the stream is cancelled', async () => {
  const stub = stubFetch({ chunks: ['{"partial":'], close: false });
  await withFetch(stub, async () => {
    const request = fetchBufferedWithBudget('/stalled.json', null, null, 40);
    await assert.rejects(raced(request, 2000, 'the budgeted read'), { name: 'AbortError' });
    await raced(stub.cancelled, 2000, 'stream cancel');
  });
});

test('fetchJsonWithBudget: a stalled body is cut off by the budget and the stream is cancelled', async () => {
  const stub = stubFetch({ chunks: ['{"partial":'], close: false });
  await withFetch(stub, async () => {
    const request = fetchJsonWithBudget('/stalled.json', null, null, 40);
    await assert.rejects(raced(request, 2000, 'the budgeted read'), { name: 'AbortError' });
    await raced(stub.cancelled, 2000, 'stream cancel');
  });
});

test('fetchBufferedWithBudget: an abort of the owning signal after headers cancels the read', async () => {
  const stub = stubFetch({ chunks: ['{"partial":'], close: false });
  await withFetch(stub, async () => {
    const master = new AbortController();
    const request = fetchBufferedWithBudget('/stalled.json', null, master.signal, 10_000);
    await raced(stub.headersReturned, 2000, 'headers');
    master.abort();
    await assert.rejects(raced(request, 2000, 'the aborted read'), { name: 'AbortError' });
    await raced(stub.cancelled, 2000, 'stream cancel');
  });
});

test('fetchJsonWithBudget: an abort of the owning signal after headers cancels the read', async () => {
  const stub = stubFetch({ chunks: ['{"partial":'], close: false });
  await withFetch(stub, async () => {
    const master = new AbortController();
    const request = fetchJsonWithBudget('/stalled.json', null, master.signal, 10_000);
    await raced(stub.headersReturned, 2000, 'headers');
    master.abort();
    await assert.rejects(raced(request, 2000, 'the aborted read'), { name: 'AbortError' });
    await raced(stub.cancelled, 2000, 'stream cancel');
  });
});

test('an already-aborted owning signal never reaches fetch', async () => {
  const stub = stubFetch({ chunks: ['{}'] });
  await withFetch(stub, async () => {
    const master = new AbortController();
    master.abort();
    await assert.rejects(fetchBufferedWithBudget('/x.json', null, master.signal, 1000), {
      name: 'AbortError'
    });
    await assert.rejects(fetchJsonWithBudget('/x.json', null, master.signal, 1000), {
      name: 'AbortError'
    });
    assert.equal(stub.calls.length, 0);
  });
});

test('fetchBufferedWithBudget: a fast body passes through with the same status, headers and bytes', async () => {
  const stub = stubFetch({
    status: 206,
    headers: { 'content-type': 'application/json', 'x-probe': 'kept' },
    chunks: ['{"features":', '[1,2,3]}']
  });
  await withFetch(stub, async () => {
    const response = await raced(
      fetchBufferedWithBudget('/fast.json', { cache: 'no-store' }, null, 5000),
      2000,
      'the fast read'
    );
    assert.equal(response.status, 206);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get('x-probe'), 'kept');
    assert.deepEqual(await response.json(), { features: [1, 2, 3] });
    assert.equal(stub.calls[0].init.cache, 'no-store');
    assert.ok(stub.calls[0].init.signal instanceof AbortSignal);
  });
  const textStub = stubFetch({ chunks: ['agrimet_sites = ', "'a,b';"] });
  await withFetch(textStub, async () => {
    const response = await fetchBufferedWithBudget('/fast.js', null, null, 5000);
    assert.equal(await response.text(), "agrimet_sites = 'a,b';");
  });
  const bytesStub = stubFetch({ chunks: ['PMTiles'] });
  await withFetch(bytesStub, async () => {
    const response = await fetchBufferedWithBudget('/fast.bin', null, null, 5000);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), encoder.encode('PMTiles'));
  });
});

test('fetchJsonWithBudget: a fast body parses to the same value', async () => {
  const stub = stubFetch({ chunks: ['{"retrieved":"2026-09-10",', '"oni":[]}'] });
  await withFetch(stub, async () => {
    const value = await raced(fetchJsonWithBudget('/fast.json', null, null, 5000), 2000, 'json');
    assert.deepEqual(value, { retrieved: '2026-09-10', oni: [] });
  });
});

test('fetchBufferedWithBudget: a non-OK status is returned, not thrown, so the caller taxonomy holds', async () => {
  const stub = stubFetch({ status: 404, chunks: ['not here'] });
  await withFetch(stub, async () => {
    const response = await fetchBufferedWithBudget('/missing.json', null, null, 5000);
    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.equal(await response.text(), 'not here');
  });
  const empty = stubFetch({ status: 204 });
  await withFetch(empty, async () => {
    const response = await fetchBufferedWithBudget('/empty', null, null, 5000);
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });
});

test('fetchJsonWithBudget: a non-OK status throws the HTTP error, as before', async () => {
  const stub = stubFetch({ status: 503, chunks: ['{}'] });
  await withFetch(stub, async () => {
    await assert.rejects(fetchJsonWithBudget('/down.json', null, null, 5000), /HTTP 503/);
  });
});

// ---- The inventory: no caller under src/ pairs fetchWithBudget with a body read.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\./.test(name)) out.push(path);
  }
  return out;
}

test('no file under src/ calls fetchWithBudget: body readers use the buffered or JSON helper', () => {
  const offenders = [];
  for (const path of walk(srcRoot)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      if (/\bfunction fetchWithBudget\(/.test(code)) return;
      if (/\bfetchWithBudget\(/.test(code)) {
        offenders.push(`${relative(srcRoot, path).replace(/\\/g, '/')}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'fetchWithBudget ends its budget at headers; read the body through fetchBufferedWithBudget or fetchJsonWithBudget'
  );
});
