import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new globalThis.URL(specifier + '.ts', context.parentURL)))) {
    return nextResolve(specifier + '.ts', context);
  }
  return nextResolve(specifier, context);
} });
const { createPmtilesTransport, readPngTile } = await import('../src/map/tile-protocol.ts');

const URL = 'https://example.test/archive.pmtiles';

const PNG_FIXTURE = Buffer.from(readFileSync(new globalThis.URL('./fixtures/vhi/lb5-palette.png.base64', import.meta.url), 'utf8').trim(), 'base64');
// Synthetic test limits, not an adopted production payload or allocation budget.
const PNG_LIMITS = { timeoutMs: 100, maxDecodedBytes: 10_000, maxPixels: 1024 };
async function withPngFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}
const pngResponse = (body = PNG_FIXTURE, init = {}) =>
  new Response(body, { headers: { 'content-type': 'image/png' }, ...init });

test('PNG body reader preserves source bytes and reports bounded IHDR dimensions without class inference', async () => {
  await withPngFetch(async () => pngResponse(), async () => {
    const result = await readPngTile('https://example.test/vhi.png', new AbortController().signal, PNG_LIMITS);
    assert.equal(result.width, 102);
    assert.equal(result.height, 1);
    assert.deepEqual(Buffer.from(result.data), PNG_FIXTURE);
  });
});
test('PNG reader rejects HTTP, service exceptions, wrong MIME and malformed signature/IHDR', async () => {
  const badSignature = Buffer.from(PNG_FIXTURE); badSignature[0] = 0;
  const badHeader = Buffer.from(PNG_FIXTURE); badHeader.writeUInt32BE(12, 8);
  for (const makeResponse of [
    () => pngResponse('error', { status: 500 }),
    () => pngResponse('<ServiceException>missing TIME</ServiceException>', { headers: { 'content-type': 'text/xml' } }),
    () => pngResponse(PNG_FIXTURE, { headers: { 'content-type': 'image/jpeg' } }),
    () => pngResponse(badSignature), () => pngResponse(badHeader),
    () => pngResponse(new Uint8Array(8))
  ]) {
    await withPngFetch(async () => makeResponse(), async () => {
      await assert.rejects(readPngTile('https://example.test/rg.png', new AbortController().signal, PNG_LIMITS));
    });
  }
});
test('PNG body deadline becomes TimeoutError and cancels the stalled body without awaiting cancel completion',
  { timeout: 1000 }, async () => {
    let canceled = 0;
    await withPngFetch(async () => pngResponse(new ReadableStream({
      cancel() { canceled++; return new Promise(() => {}); }
    })), async () => {
      await assert.rejects(readPngTile('https://example.test/held.png', new AbortController().signal,
        { ...PNG_LIMITS, timeoutMs: 25 }), error => error.name === 'TimeoutError');
      assert.equal(canceled, 1);
    });
  });
test('PNG owner cancellation stays AbortError and aborts held headers and stalled body', { timeout: 1000 }, async () => {
  for (const stage of ['headers', 'body']) {
    const owner = new AbortController();
    let entered, signal, canceled = 0;
    const started = new Promise(resolve => { entered = resolve; });
    await withPngFetch(async (_url, options) => {
      signal = options.signal;
      if (stage === 'headers') return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        entered();
      });
      return pngResponse(new ReadableStream({
        start() { entered(); },
        cancel() { canceled++; return new Promise(() => {}); }
      }));
    }, async () => {
      const pending = readPngTile('https://example.test/cancel.png', owner.signal, PNG_LIMITS);
      await started;
      owner.abort();
      await assert.rejects(pending, error => error.name === 'AbortError');
      assert.equal(signal.aborted, true);
      if (stage === 'body') assert.equal(canceled, 1);
    });
  }
});
test('PNG decoded byte ceiling cancels overflow and IHDR allocation limits reject oversized images', async () => {
  let canceled = false;
  await withPngFetch(async () => pngResponse(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(101)); },
    cancel() { canceled = true; }
  })), async () => {
    await assert.rejects(readPngTile('https://example.test/overflow.png', new AbortController().signal,
      { ...PNG_LIMITS, maxDecodedBytes: 100 }), RangeError);
    assert.equal(canceled, true);
  });
  for (const [width, height, maxPixels] of [[0, 1, 1024], [1, 0, 1024], [102, 1, 101],
    [0xffffffff, 0xffffffff, Number.MAX_SAFE_INTEGER]]) {
    const bytes = Buffer.from(PNG_FIXTURE);
    bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    await withPngFetch(async () => pngResponse(bytes), async () => {
      await assert.rejects(readPngTile('https://example.test/pixels.png', new AbortController().signal,
        { ...PNG_LIMITS, maxPixels }), RangeError);
    });
  }
});
test('PNG limits and preaborted owner reject before egress', async () => {
  await withPngFetch(async () => assert.fail('Unexpected egress'), async () => {
    for (const delta of [{ timeoutMs: 15_001 }, { maxDecodedBytes: undefined }, { maxPixels: 0 }, { maxPixels: NaN }]) {
      await assert.rejects(readPngTile('https://example.test/no-fetch.png', new AbortController().signal,
        { ...PNG_LIMITS, ...delta }), RangeError);
    }
    const owner = new AbortController(); owner.abort();
    await assert.rejects(readPngTile('https://example.test/no-fetch.png', owner.signal, PNG_LIMITS),
      error => error.name === 'AbortError');
  });
});
const json = { url: 'pmtiles://' + URL, type: 'json' };
const tile = { url: 'pmtiles://' + URL + '/0/0/0', type: 'arrayBuffer' };

/** Valid v3 archive with a root -> leaf -> tile path, without compression. */
function archive(etag = 'one') {
  const bytes = new Uint8Array(16400);
  const v = new DataView(bytes.buffer);
  bytes.set([80, 77, 84, 105, 108, 101, 115, 3]);
  const u64 = (offset, value) => v.setBigUint64(offset, BigInt(value), true);
  u64(8, 127); u64(16, 5); u64(24, 132); u64(32, 2);
  u64(40, 16384); u64(48, 5); u64(56, 16389); u64(64, 4);
  u64(72, 1); u64(80, 1); u64(88, 1);
  bytes[96] = 1; bytes[97] = 1; bytes[98] = 1; bytes[99] = 1;
  bytes[100] = 0; bytes[101] = 0;
  v.setInt32(102, -1800000000, true); v.setInt32(106, -850000000, true);
  v.setInt32(110, 1800000000, true); v.setInt32(114, 850000000, true);
  bytes.set([1, 0, 0, 5, 1], 127);
  bytes.set([123, 125], 132);
  bytes.set([1, 0, 1, 4, 1], 16384);
  bytes.set([10, 20, 30, 40], 16389);
  return { bytes, etag };
}

function fixture(choose) {
  const previous = globalThis.fetch;
  const reads = [];
  let active = 0;
  globalThis.fetch = async (_url, init) => {
    const range = new Headers(init.headers).get('range');
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
    const offset = Number(start);
    const length = Number(end) - offset + 1;
    reads.push({ offset, length, cache: init.cache });
    const result = choose(offset, reads.length);
    if (result === 'stall') {
      active++;
      return new Response(new ReadableStream({
        start(controller) {
          // Match native Fetch: abort rejects the body reader after headers.
          const abort = () => { active--; controller.error(new DOMException('Aborted', 'AbortError')); };
          init.signal.addEventListener('abort', abort, { once: true });
          if (init.signal.aborted) abort();
        }
      }), { status: 206 });
    }
    return new Response(result.bytes.slice(offset, offset + length), {
      status: 206, headers: { ETag: result.etag, 'Cache-Control': 'max-age=60' }
    });
  };
  return { reads, active: () => active, restore: () => { globalThis.fetch = previous; } };
}

test('valid leaf lookup preserves bytes, cache metadata and resolved header/directory reuse', async () => {
  const f = fixture(() => archive());
  try {
    const p = createPmtilesTransport();
    const first = await p.tilev4(tile, new AbortController());
    assert.deepEqual([...first.data], [10, 20, 30, 40]);
    assert.equal(first.cacheControl, 'max-age=60');
    await p.tilev4(tile, new AbortController());
    assert.deepEqual(f.reads.map(r => r.offset), [0, 16384, 16389, 16389]);
  } finally { f.restore(); }
});

for (const stalledOffset of [0, 16384, 16389]) {
  test('deadline aborts body at header/leaf/tile offset ' + stalledOffset + ' and permits retry', async () => {
    let stall = true;
    const f = fixture(offset => stall && offset === stalledOffset ? 'stall' : archive());
    try {
      const p = createPmtilesTransport(30);
      await assert.rejects(p.tilev4(tile, new AbortController()), { name: 'TimeoutError' });
      assert.equal(f.active(), 0);
      stall = false;
      assert.deepEqual([...(await p.tilev4(tile, new AbortController())).data], [10, 20, 30, 40]);
    } finally { f.restore(); }
  });
}

test('one cancelled header waiter settles promptly while a coalesced survivor succeeds', async () => {
  const previous = globalThis.fetch;
  let release;
  let calls = 0;
  let underlyingAborted = false;
  globalThis.fetch = async (_url, init) => {
    calls++;
    init.signal.addEventListener('abort', () => { underlyingAborted = true; });
    return new Response(new ReadableStream({ start(controller) {
      release = () => { controller.enqueue(archive().bytes.slice(0, 16384)); controller.close(); };
    } }), { status: 206, headers: { ETag: 'one' } });
  };
  try {
    const p = createPmtilesTransport();
    const a = new AbortController(), b = new AbortController();
    const first = p.tilev4(json, a);
    const second = p.tilev4(json, b);
    a.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(underlyingAborted, false);
    release();
    const response = await second;
    assert.equal(response.data.minzoom, 0);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('last waiter cancellation stops a shared body; superseding request gets a fresh read', async () => {
  let stall = true;
  const f = fixture(() => stall ? 'stall' : archive());
  try {
    const p = createPmtilesTransport();
    const a = new AbortController(), b = new AbortController();
    const first = p.tilev4(json, a), second = p.tilev4(json, b);
    a.abort(); b.abort();
    await Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    assert.equal(f.active(), 0);
    stall = false;
    const response = await p.tilev4(json, new AbortController());
    assert.equal(response.data.maxzoom, 0);
    assert.equal(f.reads.length, 2);
  } finally { f.restore(); }
});

test('ETag mismatch reloads header and retries with the new archive generation', async () => {
  const f = fixture((_offset, ordinal) => archive(ordinal === 1 ? 'one' : 'two'));
  try {
    const result = await createPmtilesTransport().tilev4(tile, new AbortController());
    assert.deepEqual([...result.data], [10, 20, 30, 40]);
    assert.deepEqual(f.reads.map(r => r.offset), [0, 16384, 0, 16384, 16389]);
    assert.equal(f.reads[2].cache, 'reload');
  } finally { f.restore(); }
});

test('already cancelled owners issue no request', async () => {
  const f = fixture(() => archive());
  try {
    const owner = new AbortController(); owner.abort();
    await assert.rejects(createPmtilesTransport().tilev4(tile, owner), { name: 'AbortError' });
    assert.equal(f.reads.length, 0);
  } finally { f.restore(); }
});

function heldBody(offsetToHold) {
  const previous = globalThis.fetch;
  const reads = [];
  let release, enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  let bodyAborted = false;
  globalThis.fetch = async (_url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range'));
    const offset = Number(start), length = Number(end) - offset + 1;
    reads.push(offset);
    const data = archive().bytes.slice(offset, offset + length);
    if (offset !== offsetToHold) return new Response(data, { status: 206, headers: { ETag: 'one' } });
    return new Response(new ReadableStream({ start(controller) {
      let finished = false;
      init.signal.addEventListener('abort', () => {
        if (!finished) { finished = true; bodyAborted = true; controller.error(new DOMException('Aborted', 'AbortError')); }
      }, { once: true });
      release = () => { if (!finished) { finished = true; controller.enqueue(data); controller.close(); } };
      enteredResolve();
    } }), { status: 206, headers: { ETag: 'one' } });
  };
  return { entered, reads, release: () => release(), aborted: () => bodyAborted, restore: () => { globalThis.fetch = previous; } };
}

test('one leaf waiter cancels independently and a survivor retains the shared read', async () => {
  const f = heldBody(16384);
  try {
    const p = createPmtilesTransport();
    const a = new AbortController(), b = new AbortController();
    const first = p.tilev4(tile, a), second = p.tilev4(tile, b);
    await f.entered;
    a.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(f.aborted(), false);
    assert.equal(f.reads.filter(n => n === 16384).length, 1);
    f.release();
    assert.deepEqual([...(await second).data], [10, 20, 30, 40]);
  } finally { f.restore(); }
});

test('last leaf waiter cancellation releases body and superseding request succeeds', async () => {
  const f = heldBody(16384);
  const p = createPmtilesTransport();
  try {
    const a = new AbortController(), b = new AbortController();
    const first = p.tilev4(tile, a), second = p.tilev4(tile, b);
    await f.entered;
    a.abort(); b.abort();
    await Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    assert.equal(f.aborted(), true);
  } finally { f.restore(); }
  const retry = fixture(() => archive());
  try { assert.deepEqual([...(await p.tilev4(tile, new AbortController())).data], [10, 20, 30, 40]); }
  finally { retry.restore(); }
});

test('small archive 416 retries exact advertised size and yields valid TileJSON', async () => {
  const previous = globalThis.fetch;
  const reads = [];
  const data = archive().bytes.slice(0, 134);
  globalThis.fetch = async (_url, init) => {
    const range = new Headers(init.headers).get('range'); reads.push(range);
    if (reads.length === 1) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */134' } });
    return new Response(data, { status: 206, headers: { ETag: 'small' } });
  };
  try {
    assert.equal((await createPmtilesTransport().tilev4(json, new AbortController())).data.maxzoom, 0);
    assert.deepEqual(reads, ['bytes=0-16383', 'bytes=0-133']);
  } finally { globalThis.fetch = previous; }
});

test('416 fallback body retains the deadline after headers', async () => {
  const previous = globalThis.fetch;
  let reads = 0, aborted = false;
  globalThis.fetch = async (_url, init) => {
    reads++;
    if (reads === 1) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */134' } });
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => {
        aborted = true; controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    } }), { status: 206 });
  };
  try {
    await assert.rejects(createPmtilesTransport(30).tilev4(json, new AbortController()), { name: 'TimeoutError' });
    assert.equal(reads, 2); assert.equal(aborted, true);
  } finally { globalThis.fetch = previous; }
});

test('repeated ETag mismatch stops after one archive retry and permits a later clean request', async () => {
  let mismatch = true;
  const f = fixture((offset, ordinal) => archive(mismatch ? (offset === 0 ? 'header' + ordinal : 'changed' + ordinal) : 'stable'));
  try {
    const p = createPmtilesTransport();
    await assert.rejects(p.tilev4(tile, new AbortController()), /Etag|ETag/);
    assert.deepEqual(f.reads.map(r => r.offset), [0, 16384, 0, 16384]);
    mismatch = false;
    assert.deepEqual([...(await p.tilev4(tile, new AbortController())).data], [10, 20, 30, 40]);
    assert.ok(f.reads.length <= 9);
  } finally { f.restore(); }
});

test('repeated directory 416 is bounded to one archive retry', async () => {
  const previous = globalThis.fetch;
  const offsets = [];
  globalThis.fetch = async (_url, init) => {
    const [, start] = /^bytes=(\d+)-/.exec(new Headers(init.headers).get('range'));
    const offset = Number(start); offsets.push(offset);
    return offset === 0
      ? new Response(archive().bytes.slice(0, 16384), { status: 206, headers: { ETag: 'one' } })
      : new Response(null, { status: 416 });
  };
  try {
    await assert.rejects(createPmtilesTransport().tilev4(tile, new AbortController()), /Etag|ETag/);
    assert.deepEqual(offsets, [0, 16384, 0, 16384]);
  } finally { globalThis.fetch = previous; }
});

// D5 actual transport/transform orchestration with browser codec seams only.
const { readDrynessTile } = await import('../src/layers/dryness-grey-protocol.ts');
const { default: drynessPngJs } = await import('pngjs');
const DRYNESS_LIMITS = { timeoutMs: 500, maxDecodedBytes: 4096, maxPixels: 4, maxOutputBytes: 4096 };
function drynessDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function drynessSource(pixels = [255, 0, 160, 255, 18, 52, 86, 0]) {
  return drynessPngJs.PNG.sync.write({ width: 2, height: 1, data: Buffer.from(pixels) });
}
test('PNG wrong-content failures retain only the bounded response for source exception classification', async () => {
  const { readPngTile, PngTileResponseError } = await import('../src/map/tile-protocol.ts');
  const previousFetch = globalThis.fetch;
  const xml = '<ServiceExceptionReport><ServiceException>time</ServiceException></ServiceExceptionReport>';
  let reads = 0;
  try {
    globalThis.fetch = async () => { reads++; return new Response(xml, { status: 200, headers: { 'content-type': 'application/vnd.ogc.se_xml; charset=utf-8' } }); };
    await assert.rejects(readPngTile('https://fixture.invalid/rg', new AbortController().signal,
      { timeoutMs: 100, maxDecodedBytes: 1000, maxPixels: 1 }), error => {
      assert.ok(error instanceof PngTileResponseError);
      assert.equal(error.status, 200);
      assert.equal(error.contentType, 'application/vnd.ogc.se_xml');
      assert.equal(new TextDecoder().decode(error.body), xml);
      return true;
    });
    assert.equal(reads, 1);
    await assert.rejects(readPngTile('https://fixture.invalid/rg', new AbortController().signal,
      { timeoutMs: 100, maxDecodedBytes: 8, maxPixels: 1 }), error => {
      assert.equal(error instanceof PngTileResponseError, false);
      return error instanceof RangeError;
    });
  } finally { globalThis.fetch = previousFetch; }
});

async function withDrynessBrowser(options, task) {
  const names = ['fetch', 'createImageBitmap', 'document', 'performance'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events = { closed: 0, encoded: 0, fetched: 0, canvases: [], bitmapOptions: [] };
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  if (options.clock) set('performance', { now: options.clock });
  const makeBitmap = async blob => {
    const decoded = drynessPngJs.PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
    return { width: decoded.width, height: decoded.height, pixels: new Uint8ClampedArray(decoded.data),
      close() { events.closed++; options.closed?.resolve(); } };
  };
  set('fetch', options.fetch ?? (async () => {
    events.fetched++;
    return new Response(options.source ?? drynessSource(), { headers: { 'content-type': 'image/png' } });
  }));
  set('createImageBitmap', async (blob, settings) => {
    events.bitmapOptions.push(settings);
    const bitmap = await makeBitmap(blob);
    if (options.dimensionMismatch) bitmap.width++;
    if (options.decode) return options.decode(bitmap);
    return bitmap;
  });
  set('document', { createElement(tag) {
    assert.equal(tag, 'canvas');
    let pixels;
    const canvas = { width: 0, height: 0,
      getContext(kind, settings) {
        assert.equal(kind, '2d');
        assert.deepEqual(settings, { willReadFrequently: true, colorSpace: 'srgb' });
        if (options.noContext) return null;
        return {
          drawImage(bitmap) { pixels = bitmap.pixels.slice(); options.draw?.(); },
          getImageData() { return { data: pixels, width: canvas.width, height: canvas.height }; },
          putImageData(image) { pixels = image.data; }
        };
      },
      toBlob(callback, type) {
        events.encoded++;
        assert.equal(type, 'image/png');
        const bytes = drynessPngJs.PNG.sync.write({ width: canvas.width, height: canvas.height, data: Buffer.from(pixels) });
        const blob = new Blob([bytes], { type });
        if (options.encode) options.encode(callback, blob);
        else callback(blob);
      }
    };
    events.canvases.push(canvas);
    return canvas;
  } });
  try { return await task(events); }
  finally {
    for (const name of names) {
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('dryness PNG operation uses real bounded reader and exact transform before returning encoded opaque grey output', async () => {
  for (const [product, source] of [
    ['star-vhi', drynessSource()],
    ['relative-greenness', drynessSource([115, 38, 0, 255, 255, 255, 255, 255])]
  ]) await withDrynessBrowser({ source }, async events => {
    const owner = new AbortController();
    const bytes = await readDrynessTile('https://example.test/vhi.png', product, owner, DRYNESS_LIMITS);
    const output = drynessPngJs.PNG.sync.read(Buffer.from(bytes));
    assert.deepEqual([...output.data], [31, 31, 31, 255, 133, 133, 133, 255]);
    assert.deepEqual(events.bitmapOptions, [{ colorSpaceConversion: 'none', premultiplyAlpha: 'none' }]);
    assert.equal(events.closed, 1); assert.equal(events.encoded, 1);
    assert.equal(owner.signal.aborted, false);
    assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

test('dryness unknown visible class fails atomically before encoding and releases bitmap/canvas', async () => {
  await withDrynessBrowser({ source: drynessSource([255, 0, 160, 255, 18, 52, 86, 255]) }, async events => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), DRYNESS_LIMITS), /Unrecognized dryness class/);
    assert.equal(events.encoded, 0); assert.equal(events.closed, 1);
    assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

test('dryness full deadline includes held decode and closes its eventual bitmap without late encoding', { timeout: 1500 }, async () => {
  const held = drynessDeferred(), entered = drynessDeferred(), closed = drynessDeferred();
  let lateBitmap;
  await withDrynessBrowser({ closed, decode(bitmap) { lateBitmap = bitmap; entered.resolve(); return held.promise; } }, async events => {
    const work = readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, timeoutMs: 40 });
    const rejected = assert.rejects(work, error => error.name === 'TimeoutError');
    await entered.promise;
    await rejected;
    assert.equal(events.closed, 0);
    held.resolve(lateBitmap);
    await closed.promise;
    assert.equal(events.closed, 1); assert.equal(events.encoded, 0);
  });
});

test('dryness owner off during decode rejects promptly, closes late bitmap and cannot publish original source colors', { timeout: 1500 }, async () => {
  const held = drynessDeferred(), entered = drynessDeferred(), closed = drynessDeferred();
  const owner = new AbortController(); let lateBitmap;
  await withDrynessBrowser({ closed, decode(bitmap) { lateBitmap = bitmap; entered.resolve(); return held.promise; } }, async events => {
    const work = readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner, DRYNESS_LIMITS);
    const rejected = assert.rejects(work, error => error.name === 'AbortError');
    await entered.promise; owner.abort(); await rejected;
    held.resolve(lateBitmap); await closed.promise;
    assert.equal(events.closed, 1); assert.equal(events.encoded, 0);
  });
});

test('dryness encode and encoded-buffer stages remain owner-cancellable and deadline-bounded', { timeout: 3000 }, async () => {
  for (const stage of ['encode', 'buffer']) for (const reason of ['owner', 'deadline']) {
    const entered = drynessDeferred(), held = drynessDeferred(); const owner = new AbortController();
    let finish;
    await withDrynessBrowser({ encode(callback, blob) {
      if (stage === 'encode') { finish = () => callback(blob); entered.resolve(); }
      else callback({ type: 'image/png', size: blob.size, arrayBuffer() { entered.resolve(); return held.promise; } });
    } }, async events => {
      const work = readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner,
        { ...DRYNESS_LIMITS, timeoutMs: reason === 'deadline' ? 40 : 500 });
      const rejected = assert.rejects(work, error => error.name === (reason === 'deadline' ? 'TimeoutError' : 'AbortError'));
      await entered.promise;
      if (reason === 'owner') owner.abort();
      await rejected;
      assert.equal(events.closed, 1);
      if (stage === 'encode') finish(); else held.resolve(new ArrayBuffer(1));
      await Promise.resolve(); await Promise.resolve();
      assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    });
  }
});

test('dryness operation carries cancellation into real held fetch body and keeps deadline distinct', { timeout: 1500 }, async () => {
  for (const reason of ['owner', 'deadline']) {
    const entered = drynessDeferred(); const owner = new AbortController(); let canceled = 0;
    await withDrynessBrowser({ fetch: async () => {
      const body = new ReadableStream({ start() { entered.resolve(); }, cancel() { canceled++; return new Promise(() => {}); } });
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    } }, async events => {
      const work = readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner,
        { ...DRYNESS_LIMITS, timeoutMs: reason === 'deadline' ? 40 : 500 });
      const rejected = assert.rejects(work, error => error.name === (reason === 'deadline' ? 'TimeoutError' : 'AbortError'));
      await entered.promise; if (reason === 'owner') owner.abort(); await rejected;
      assert.equal(canceled, 1); assert.equal(events.bitmapOptions.length, 0);
    });
  }
});

test('dryness allocation/output guards and browser failures reject without an untransformed fallback', async () => {
  for (const [options, overrides, expected] of [
    [{ dimensionMismatch: true }, {}, /dimensions mismatch/],
    [{ noContext: true }, {}, /canvas unavailable/],
    [{ encode(callback) { callback(null); } }, {}, /encode failed/],
    [{}, { maxPixels: 1 }, /pixel limit/],
    [{}, { maxDecodedBytes: 8 }, /limit|budget|byte/i],
    [{}, { maxOutputBytes: 1 }, /Invalid dryness PNG output/]
  ]) await withDrynessBrowser(options, async () => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, ...overrides }), expected);
  });
  await withDrynessBrowser({}, async events => {
    const owner = new AbortController(); owner.abort();
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner, DRYNESS_LIMITS), error => error.name === 'AbortError');
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, maxOutputBytes: 0 }), RangeError);
    assert.equal(events.fetched, 0);
  });
});

test('dryness synchronous work cannot publish after owner cancellation between canvas stages', async () => {
  const owner = new AbortController();
  await withDrynessBrowser({ draw() { owner.abort(); } }, async events => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner, DRYNESS_LIMITS), error => error.name === 'AbortError');
    assert.equal(events.closed, 1); assert.equal(events.encoded, 0);
  });
});

test('dryness elapsed deadline rejects synchronous stage overrun before a timer callback can run', async () => {
  let now = 0;
  await withDrynessBrowser({ clock: () => now, draw() { now = DRYNESS_LIMITS.timeoutMs + 1; } }, async events => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), DRYNESS_LIMITS), error => error.name === 'TimeoutError');
    assert.equal(events.closed, 1); assert.equal(events.encoded, 0);
  });
});

const { createDrynessGround } = await import('../src/layers/dryness-ground.ts');
const { parseRelativeGreennessTimes, readRelativeGreennessTimes } = await import('../src/layers/dryness-discovery.ts');
function drynessMap() {
  const sources = new Map(), layers = new Map(), listeners = new Map();
  return { sources, layers, listeners, loaded: true,
    addSource(id, source) { assert.equal(sources.has(id), false); sources.set(id, source); },
    getSource(id) { return sources.get(id); }, removeSource(id) { sources.delete(id); },
    addLayer(layer, before) { assert.equal(before, 'hillshade'); layers.set(layer.id, layer); },
    getLayer(id) { return layers.get(id); }, removeLayer(id) { layers.delete(id); },
    isSourceLoaded(id) { return sources.has(id) && this.loaded; },
    on(type, callback) { const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set); },
    off(type, callback) { listeners.get(type)?.delete(callback); },
    event(type, event) { for (const callback of [...(listeners.get(type) ?? [])]) callback(event); }
  };
}
/** One loaded tile of `sourceId`: the tile proof (DDM-P14-T04) the ground waits for before live. */
function drynessTileProof(sourceId) {
  return { sourceId, dataType: 'source', tile: { tileID: { key: 1 } }, isSourceLoaded: true };
}
function drynessOptions(map, snapshots, overrides = {}) {
  const frame = (value, productKey = 'star-vhi') => ({ productKey, frame: value,
    issuer: 'fixture issuer', legendRows: ['fixture class'], clockLabel: value,
    coverage: 'fixture coverage', qualification: 'fixture qualification', creditKey: 'fixture-credit',
    tileUrl: (z, x, y) => `https://fixture.invalid/${value}/${z}/${x}/${y}.png`, tileSize: 256,
    maxZoom: 7, bounds: [-180, -80, 180, 80] });
  return { protocolName: 'dryness-test', layerId: 'dryness-ground-test', beforeId: () => 'hillshade',
    allowedOrigins: ['https://fixture.invalid'], star: [frame('2026001'), frame('2025052')],
    rg: { capabilitiesUrl: 'https://fixture.invalid/capabilities', layerName: 'rg_conus_week_data',
      frame: time => frame(time, 'usgs-relative-greenness') },
    tileLimits: DRYNESS_LIMITS, metadataLimits: { timeoutMs: 100, maxDecodedBytes: 10000, maxTimes: 10 },
    selectionDeadlineMs: 1000, readyState: () => 'live',
    publish(snapshot) {
      // Every publication checks actual mounted identity rather than just final status.
      if (snapshot?.selected) {
        assert.ok(map.getSource(snapshot.sourceId));
        assert.equal(map.getLayer('dryness-ground-test').source, snapshot.sourceId);
        assert.equal(snapshot.selected.clockLabel, snapshot.selected.frame);
      } else assert.equal(map.sources.size, 0);
      snapshots.push(snapshot);
    }, ...overrides };
}
test('dryness selected STAR record is atomic, native owner cancellation does not trigger fallback, and Off cleans up', async () => {
  await withDrynessBrowser({}, async events => {
    const map = drynessMap(), snapshots = [], owner = new AbortController();
    const adapter = createDrynessGround(drynessOptions(map, snapshots));
    await adapter.activate(map, owner.signal);
    assert.equal(events.fetched, 1);
    assert.equal(snapshots.at(-1).state, 'loading');
    map.event('sourcedata', drynessTileProof(snapshots.at(-1).sourceId));
    assert.equal(snapshots.at(-1).state, 'live');
    assert.equal(snapshots.at(-1).selected.frame, '2026001');
    const tile = await adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, new AbortController());
    assert.equal(drynessPngJs.PNG.sync.read(Buffer.from(tile.data)).data[0], 31);
    assert.equal(events.fetched, 2);
    const tileOwner = new AbortController(); tileOwner.abort();
    await assert.rejects(adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, tileOwner), { name: 'AbortError' });
    assert.equal(events.fetched, 2);
    const old = snapshots.at(-1);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await adapter.activate(map, alreadyAborted.signal);
    assert.equal(snapshots.at(-1), old);
    assert.equal(map.sources.size, 1);
    owner.abort();
    assert.equal(map.sources.size, 0); assert.equal(map.layers.size, 0);
    assert.equal([...map.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
    assert.equal(snapshots.at(-1), null);
  });
});
test('dryness failed k reaches exact prior-year record through real PNG operation and retains source failure', async () => {
  const requested = [];
  await withDrynessBrowser({ fetch: async url => {
    requested.push(url);
    return String(url).includes('2026001') ? new Response('failed', { status: 500 }) :
      new Response(drynessSource(), { headers: { 'content-type': 'image/png' } });
  } }, async () => {
    const map = drynessMap(), snapshots = [], adapter = createDrynessGround(drynessOptions(map, snapshots));
    await adapter.activate(map, new AbortController().signal);
    assert.equal(requested.length, 2);
    assert.match(requested[1], /2025052/);
    assert.equal(snapshots.at(-1).selected.frame, '2025052');
    assert.deepEqual(snapshots.at(-1).failures, [{ productKey: 'star-vhi', frame: '2026001', reason: 'source-failed' }]);
    adapter.deactivate();
  });
});
test('dryness incomplete disclosure or wrong predecessor is rejected before any request or publication', async () => {
  await withDrynessBrowser({}, async events => {
    for (const broken of [{ issuer: '' }, { clockLabel: ' ' }, { coverage: '' }, { qualification: '' },
      { creditKey: '' }, { legendRows: [] }, { legendRows: [''] }]) {
      const map = drynessMap(), snapshots = [], options = drynessOptions(map, snapshots);
      options.star = [{ ...options.star[0], ...broken }, options.star[1]];
      assert.throws(() => createDrynessGround(options), /Invalid dryness frame/);
      assert.equal(snapshots.length, 0); assert.equal(map.sources.size, 0);
    }
    const map = drynessMap(), snapshots = [], options = drynessOptions(map, snapshots);
    options.star = [options.star[0], { ...options.star[1], frame: '2025053' }];
    assert.throws(() => createDrynessGround(options), /predecessor/);
    assert.equal(events.fetched, 0); assert.equal(snapshots.length, 0);
  });
});
test('dryness whole-selection deadline interrupts held decode and discards its late completion', { timeout: 1500 }, async () => {
  const entered = drynessDeferred(), held = drynessDeferred(), closed = drynessDeferred(); let bitmap;
  await withDrynessBrowser({ closed, decode(value) { bitmap = value; entered.resolve(); return held.promise; } }, async events => {
    const map = drynessMap(), snapshots = [], adapter = createDrynessGround(drynessOptions(map, snapshots, { selectionDeadlineMs: 35 }));
    const pending = adapter.activate(map, new AbortController().signal);
    await entered.promise;
    await pending;
    assert.equal(snapshots.at(-1).state, 'unavailable');
    assert.equal(map.sources.size, 0); assert.equal(events.fetched, 1);
    held.resolve(bitmap); await closed.promise;
    assert.equal(events.encoded, 0); assert.equal(map.sources.size, 0);
    adapter.deactivate();
  });
});
test('dryness restart owns a new generation and held old decode cannot install over it', async () => {
  const entered = drynessDeferred(), held = drynessDeferred(), closed = drynessDeferred(); let bitmap, first = true;
  await withDrynessBrowser({ closed, decode(value) {
    if (!first) return value;
    first = false; bitmap = value; entered.resolve(); return held.promise;
  } }, async () => {
    const map = drynessMap(), snapshots = [], adapter = createDrynessGround(drynessOptions(map, snapshots));
    const old = adapter.activate(map, new AbortController().signal);
    await entered.promise;
    await adapter.activate(map, new AbortController().signal);
    await old;
    const selected = snapshots.at(-1);
    assert.match(selected.sourceId, /-2-0$/);
    held.resolve(bitmap); await closed.promise;
    assert.equal(snapshots.at(-1), selected);
    assert.equal(map.sources.size, 1);
    adapter.deactivate();
  });
});
test('dryness setup failure removes partial source before retrying and source readiness remains separate from probe', async () => {
  await withDrynessBrowser({}, async () => {
    const map = drynessMap(), snapshots = []; map.loaded = false;
    const original = map.addLayer; let first = true;
    map.addLayer = function (...args) { if (first) { first = false; throw new Error('setup'); } original.apply(this, args); };
    const adapter = createDrynessGround(drynessOptions(map, snapshots));
    await adapter.activate(map, new AbortController().signal);
    assert.equal(map.sources.size, 1);
    assert.equal(snapshots.at(-1).selected.frame, '2025052');
    assert.equal(snapshots.at(-1).state, 'loading');
    map.loaded = true; map.event('sourcedata', { sourceId: snapshots.at(-1).sourceId });
    assert.equal(snapshots.at(-1).state, 'loading');
    map.event('sourcedata', drynessTileProof(snapshots.at(-1).sourceId));
    assert.equal(snapshots.at(-1).state, 'live');
    adapter.deactivate();
  });
});
test('RG discrete dates preserve exact strings and reject ambiguous domains', () => {
  assert.deepEqual(parseRelativeGreennessTimes('2026-09-21T00:00:00.000Z,2026-09-28T00:00:00.000Z', 2),
    ['2026-09-28T00:00:00.000Z', '2026-09-21T00:00:00.000Z']);
  for (const value of ['', 'current', '2026-09-01/2026-09-28/P1W', '2026-02-30T00:00:00.000Z',
    '2026-09-28T00:00:00.000Z,2026-09-28T00:00:00.000Z']) assert.throws(() => parseRelativeGreennessTimes(value, 2));
  assert.throws(() => parseRelativeGreennessTimes('2026-09-21T00:00:00.000Z,2026-09-28T00:00:00.000Z', 1));
});
test('dryness native source failure advances once and stale source events cannot demote the replacement', async () => {
  const entered = drynessDeferred(); let reads = 0, heldSignal;
  await withDrynessBrowser({ fetch: async (_url, init) => {
    reads++;
    if (reads === 2) { heldSignal = init.signal; entered.resolve(); return new Promise(() => {}); }
    return new Response(drynessSource(), { headers: { 'content-type': 'image/png' } });
  } }, async () => {
    const map = drynessMap(), snapshots = [], ready = drynessDeferred();
    const options = drynessOptions(map, snapshots);
    const publish = options.publish;
    options.publish = snapshot => {
      publish(snapshot);
      if (snapshot?.selected?.frame === '2025052' && snapshot.state === 'loading') {
        setTimeout(() => map.event('sourcedata', drynessTileProof(snapshot.sourceId)), 0);
      }
      if (snapshot?.selected?.frame === '2025052' && snapshot.state === 'live') ready.resolve();
    };
    const adapter = createDrynessGround(options);
    await adapter.activate(map, new AbortController().signal);
    const oldSource = snapshots.at(-1).sourceId;
    const pending = adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, new AbortController());
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await entered.promise;
    map.event('error', { sourceId: oldSource, error: new Error('native image failure') });
    await cancelled;
    await ready.promise;
    assert.equal(reads, 3);
    assert.equal(heldSignal.aborted, true);
    const replacement = snapshots.at(-1);
    map.event('error', { sourceId: oldSource, error: new Error('late native event') });
    assert.equal(snapshots.at(-1), replacement);
    assert.equal(map.sources.size, 1);
    adapter.deactivate();
  });
});
test('RG discovery whole deadline and owner cancellation bound held headers without invoking XML parser', { timeout: 1500 }, async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => new Promise(() => {});
    await assert.rejects(readRelativeGreennessTimes('https://fixture.invalid/capabilities', 'rg', new AbortController().signal,
      { timeoutMs: 25, maxDecodedBytes: 1000, maxTimes: 10 }), { name: 'TimeoutError' });
    const owner = new AbortController();
    const pending = readRelativeGreennessTimes('https://fixture.invalid/capabilities', 'rg', owner.signal,
      { timeoutMs: 1000, maxDecodedBytes: 1000, maxTimes: 10 });
    owner.abort(); await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
