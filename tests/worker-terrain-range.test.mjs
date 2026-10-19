import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRange } from '../workers/terrain/src/index.ts';

const SIZE = 1000;

test('a normal range returns its offset and length', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { offset: 0, length: 100 });
  assert.deepEqual(parseRange('bytes=900-5000', SIZE), { offset: 900, length: 100 });
});

test('a suffix range returns the last n bytes, clamped to the object', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { offset: 900, length: 100 });
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { offset: 0, length: SIZE });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=250-', SIZE), { offset: 250, length: 750 });
});

test('a missing header is no range', () => {
  assert.equal(parseRange(null, SIZE), null);
});

test('an unsatisfiable range is reported as such', () => {
  for (const header of ['bytes=1000-', 'bytes=2000-3000', 'bytes=50-10', 'bytes=-0']) {
    assert.equal(parseRange(header, SIZE), 'unsatisfiable', header);
  }
});

test('garbage and multi-range headers are unsatisfiable', () => {
  for (const header of ['', 'bytes=-', 'bytes=a-b', 'items=0-9', 'bytes=0-9,20-29', '0-9']) {
    assert.equal(parseRange(header, SIZE), 'unsatisfiable', header);
  }
});

// A stand-in bucket of SIZE bytes that counts its reads and, like R2, refuses a range past the end.
function fakeBucket() {
  const calls = { head: 0, get: 0 };
  const meta = { size: SIZE, httpEtag: '"t"' };
  return {
    calls,
    env: {
      ddm_terrain: {
        async head() { calls.head += 1; return meta; },
        async get(_key, options) {
          calls.get += 1;
          if (options?.range && options.range.offset >= SIZE) throw new Error('range not satisfiable');
          return { ...meta, body: new Blob(['x']).stream() };
        }
      }
    }
  };
}

const ARCHIVE = 'https://terrain.test/pnw-z10-2026-09-10.pmtiles';

test('unsupported methods name the methods accepted without reading storage', async () => {
  const { default: worker } = await import('../workers/terrain/src/index.ts');
  const bucket = fakeBucket();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await worker.fetch(new Request(ARCHIVE, { method }), bucket.env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
  assert.deepEqual(bucket.calls, { head: 0, get: 0 });
});

test("the reader's exact range costs one storage read", async () => {
  const { default: worker } = await import('../workers/terrain/src/index.ts');
  const bucket = fakeBucket();
  const response = await worker.fetch(new Request(ARCHIVE, { headers: { Range: 'bytes=0-99' } }), bucket.env);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-99/${SIZE}`);
  assert.deepEqual(bucket.calls, { head: 0, get: 1 });
});

test('a range past the end still answers 416 with the size', async () => {
  const { default: worker } = await import('../workers/terrain/src/index.ts');
  const bucket = fakeBucket();
  const response = await worker.fetch(new Request(ARCHIVE, { headers: { Range: 'bytes=2000-3000' } }), bucket.env);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${SIZE}`);
});
