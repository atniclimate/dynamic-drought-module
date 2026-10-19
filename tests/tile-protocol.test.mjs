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
const { readDrynessTile, createDrynessMasks, isDrynessSourceFault, DrynessLocalError } = await import('../src/layers/dryness-grey-protocol.ts');
const { default: drynessPngJs } = await import('pngjs');
const DRYNESS_LIMITS = { timeoutMs: 500, maxDecodedBytes: 4096, maxPixels: 4 };
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
  // `outputs` are the shaded bitmaps made from ImageData; `closed` counts every bitmap closed, source or output.
  const events = { closed: 0, outputs: [], fetched: 0, canvases: [], bitmapOptions: [] };
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
  set('createImageBitmap', (input, settings) => {
    if (!(input instanceof Blob)) {
      const output = { width: input.width, height: input.height, pixels: input.data,
        close() { events.closed++; options.closed?.resolve(); } };
      events.outputs.push(output);
      return options.output ? options.output(output) : Promise.resolve(output);
    }
    events.bitmapOptions.push(settings);
    return makeBitmap(input).then(bitmap => {
      if (options.dimensionMismatch) bitmap.width++;
      return options.decode ? options.decode(bitmap) : bitmap;
    });
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
          getImageData() { return { data: pixels, width: canvas.width, height: canvas.height }; }
        };
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

test('dryness PNG operation uses real bounded reader and exact transform before returning a decoded white-alpha bitmap', async () => {
  for (const [product, source] of [
    ['star-vhi', drynessSource()],
    ['relative-greenness', drynessSource([115, 38, 0, 255, 255, 255, 255, 255])]
  ]) await withDrynessBrowser({ source }, async events => {
    const owner = new AbortController();
    const bitmap = await readDrynessTile('https://example.test/vhi.png', product, owner, DRYNESS_LIMITS);
    // The most stressed class is 40% white; no value is fully transparent (DR-199).
    assert.equal(bitmap, events.outputs[0]);
    assert.deepEqual([...bitmap.pixels], [255, 255, 255, 102, 0, 0, 0, 0]);
    assert.deepEqual(events.bitmapOptions, [{ colorSpaceConversion: 'none', premultiplyAlpha: 'none' }]);
    // Only the source bitmap is closed; the returned one is the caller's.
    assert.equal(events.closed, 1); assert.equal(events.outputs.length, 1);
    assert.equal(owner.signal.aborted, false);
    assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

/**
 * Answers a plant-health URL (most stressed class, then healthiest) and a land-cover URL with their own PNGs.
 * `mask` is the land-cover tile's RGBA, or null for a failed land-cover read.
 */
function drynessMaskedFetch(mask, requested = []) {
  return async url => {
    requested.push(String(url));
    if (!String(url).includes('landcover')) return new Response(drynessSource([255, 0, 160, 255, 0, 0, 170, 255]), { headers: { 'content-type': 'image/png' } });
    if (!mask) return new Response('failed', { status: 500 });
    return new Response(drynessPngJs.PNG.sync.write({ width: mask.length / 4, height: 1, data: Buffer.from(mask) }),
      { headers: { 'content-type': 'image/png' } });
  };
}

test('dryness land-cover tile rides the same bounded reader: bare ground is knocked out, a drawn class keeps its plant stress', async () => {
  const requested = [];
  // Bare ground (class 16) over the most stressed class; evergreen needleleaf forest (class 1) over the healthiest.
  await withDrynessBrowser({ fetch: drynessMaskedFetch([128, 128, 128, 255, 0, 128, 0, 255], requested) }, async events => {
    const bitmap = await readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), DRYNESS_LIMITS,
      'https://example.test/landcover.png');
    assert.deepEqual([...bitmap.pixels], [0, 0, 0, 0, 255, 255, 255, 10]);
    assert.deepEqual(requested.sort(), ['https://example.test/landcover.png', 'https://example.test/vhi.png']);
    assert.equal(events.bitmapOptions.length, 2); assert.equal(events.closed, 2); assert.equal(events.outputs.length, 1);
    assert.ok(events.canvases.length === 2 && events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

test('dryness land-cover tile fails closed: a failed read, an unknown colour or another size draws nothing', async () => {
  for (const [mask, expected] of [
    [null, error => !/land-cover/.test(error.message)],
    [[128, 128, 128, 255, 18, 52, 86, 255], /Unrecognized land-cover class/],
    [[128, 128, 128, 255], /Invalid dryness land-cover mask/]
  ]) await withDrynessBrowser({ fetch: drynessMaskedFetch(mask) }, async events => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), DRYNESS_LIMITS,
      'https://example.test/landcover.png'), expected);
    assert.equal(events.outputs.length, 0);
    // Both tiles decoded before the pure check refused them: both bitmaps are closed.
    if (mask) assert.equal(events.closed, 2);
    assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

test('dryness land-cover tiles are shared and kept an hour: one read for two tiles, an aborted tile leaves the other\'s read alone, an expired or invalid mask is read again', async () => {
  let now = 0; const reads = new Map(), signals = new Map(); const gate = drynessDeferred();
  const png = pixels => drynessPngJs.PNG.sync.write({ width: 2, height: 1, data: Buffer.from(pixels) });
  const fetch = async (url, init) => {
    url = String(url);
    if (!url.includes('landcover')) return new Response(drynessSource([255, 0, 160, 255, 0, 0, 170, 255]), { headers: { 'content-type': 'image/png' } });
    reads.set(url, (reads.get(url) ?? 0) + 1); signals.set(url, init.signal);
    if (url.includes('held')) await gate.promise;
    const mask = url.includes('bad') ? [128, 128, 128, 255, 18, 52, 86, 255] : [128, 128, 128, 255, 0, 128, 0, 255];
    return new Response(png(mask), { headers: { 'content-type': 'image/png' } });
  };
  await withDrynessBrowser({ fetch }, async () => {
    const masks = createDrynessMasks(() => now);
    const read = (owner, mask, name = 'a') => readDrynessTile(`https://example.test/${name}.png`, 'star-vhi', owner, DRYNESS_LIMITS,
      `https://example.test/${mask}.png`, masks);
    const settled = () => new Promise(resolve => setTimeout(resolve, 20));
    const held = 'landcover-held', url = name => `https://example.test/${name}.png`;
    // Two tiles, one read; the first tile's abort does not reach the shared read.
    const a = new AbortController(), first = read(a, held), second = read(new AbortController(), held, 'b');
    const aborted = assert.rejects(first, error => error.name === 'AbortError');
    await settled(); a.abort(); await aborted;
    assert.equal(reads.get(url(held)), 1); assert.equal(signals.get(url(held)).aborted, false);
    gate.resolve();
    assert.deepEqual([...(await second).pixels], [0, 0, 0, 0, 255, 255, 255, 10]);
    // Kept: a later tile reads no mask. Expired after an hour: read again.
    await read(new AbortController(), held, 'c'); assert.equal(reads.get(url(held)), 1);
    now = 3_600_001; await read(new AbortController(), held, 'd'); assert.equal(reads.get(url(held)), 2);
    // A mask that failed validation is not kept.
    for (let tries = 1; tries <= 2; tries++) {
      await assert.rejects(read(new AbortController(), 'landcover-bad'), /Unrecognized land-cover class/);
      assert.equal(reads.get(url('landcover-bad')), tries);
    }
    // The shared read is abandoned when its last tile leaves.
    gate.promise = new Promise(() => {});
    const last = new AbortController(), only = read(last, 'landcover-held-2');
    const gone = assert.rejects(only, error => error.name === 'AbortError');
    await settled(); last.abort(); await gone; await settled();
    assert.equal(signals.get(url('landcover-held-2')).aborted, true);
  });
});

test('dryness unknown visible class fails atomically before any output bitmap and releases bitmap/canvas', async () => {
  await withDrynessBrowser({ source: drynessSource([255, 0, 160, 255, 18, 52, 86, 255]) }, async events => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), DRYNESS_LIMITS), /Unrecognized dryness class/);
    assert.equal(events.outputs.length, 0); assert.equal(events.closed, 1);
    assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });
});

test('dryness full deadline includes held decode and closes its eventual bitmap without a late output', { timeout: 1500 }, async () => {
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
    assert.equal(events.closed, 1); assert.equal(events.outputs.length, 0);
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
    assert.equal(events.closed, 1); assert.equal(events.outputs.length, 0);
  });
});

test('dryness output bitmap stage remains owner-cancellable and deadline-bounded, and a late bitmap is closed', { timeout: 3000 }, async () => {
  for (const reason of ['owner', 'deadline']) {
    const entered = drynessDeferred(), held = drynessDeferred(); const owner = new AbortController();
    await withDrynessBrowser({ output(bitmap) { entered.resolve(); return held.promise.then(() => bitmap); } }, async events => {
      const work = readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner,
        { ...DRYNESS_LIMITS, timeoutMs: reason === 'deadline' ? 40 : 500 });
      const rejected = assert.rejects(work, error => error.name === (reason === 'deadline' ? 'TimeoutError' : 'AbortError'));
      await entered.promise;
      if (reason === 'owner') owner.abort();
      await rejected;
      assert.equal(events.closed, 1);
      held.resolve();
      await new Promise(setImmediate);
      assert.equal(events.closed, 2); assert.equal(events.outputs.length, 1);
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

test('dryness allocation guards and browser failures reject without an untransformed fallback', async () => {
  for (const [options, overrides, expected] of [
    [{ dimensionMismatch: true }, {}, /dimensions mismatch/],
    [{ noContext: true }, {}, /canvas unavailable/],
    [{}, { maxPixels: 1 }, /pixel limit/],
    [{}, { maxDecodedBytes: 8 }, /limit|budget|byte/i]
  ]) await withDrynessBrowser(options, async () => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, ...overrides }), expected);
  });
  await withDrynessBrowser({}, async events => {
    const owner = new AbortController(); owner.abort();
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner, DRYNESS_LIMITS), error => error.name === 'AbortError');
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, maxPixels: 0 }), RangeError);
    assert.equal(events.fetched, 0);
  });
});

test('dryness synchronous work cannot publish after owner cancellation between canvas stages', async () => {
  const owner = new AbortController();
  await withDrynessBrowser({ draw() { owner.abort(); } }, async events => {
    await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', owner, DRYNESS_LIMITS), error => error.name === 'AbortError');
    assert.equal(events.closed, 1); assert.equal(events.outputs.length, 0);
  });
});

test('a frozen main thread is not a dryness source failure: the clock jumping past the limit mid-read still publishes', async () => {
  // A heavy 3D frame or a backgrounded tab moves the clock without the page
  // listening; the tick deadline (the timeoutMs cases above) is the limit.
  let now = 0;
  await withDrynessBrowser({ clock: () => now, draw() { now = DRYNESS_LIMITS.timeoutMs + 1; } }, async events => {
    const bitmap = await readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), DRYNESS_LIMITS);
    assert.ok(bitmap.width > 0);
    assert.equal(events.closed, 1); assert.equal(events.outputs.length, 1);
  });
});

test('the shared reader\'s wall-clock timeout is read again while listening time remains, and at most twice', async () => {
  let fetched = 0;
  const hang = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  // The first read hangs past the 300 ms wall-clock timer; the listening limit is two 250 ms ticks.
  await withDrynessBrowser({ fetch: (url, init) => ++fetched === 1 ? hang(url, init)
    : Promise.resolve(new Response(drynessSource(), { headers: { 'content-type': 'image/png' } })) }, async events => {
    const bitmap = await readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, timeoutMs: 300 });
    assert.ok(bitmap.width > 0);
    assert.equal(fetched, 2); assert.equal(events.outputs.length, 1);
  });
  // A hidden tab: ticks all but stop, the source hangs. One read and two re-reads, then a timeout.
  fetched = 0;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await withDrynessBrowser({ fetch: (url, init) => { fetched++; return hang(url, init); } }, async events => {
      await assert.rejects(readDrynessTile('https://example.test/vhi.png', 'star-vhi', new AbortController(), { ...DRYNESS_LIMITS, timeoutMs: 30 }),
        error => error.name === 'TimeoutError');
      assert.equal(fetched, 3); assert.equal(events.outputs.length, 0);
    });
  } finally { globalThis.setInterval = realSetInterval; }
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
    // The probe's source and output bitmaps are both closed: its result is thrown away.
    assert.equal(events.outputs.length, 1); assert.equal(events.closed, 2);
    assert.equal(snapshots.at(-1).state, 'loading');
    map.event('sourcedata', drynessTileProof(snapshots.at(-1).sourceId));
    assert.equal(snapshots.at(-1).state, 'live');
    assert.equal(snapshots.at(-1).selected.frame, '2026001');
    const tile = await adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, new AbortController());
    assert.deepEqual([...tile.data.pixels.subarray(0, 4)], [255, 255, 255, 102]);
    assert.equal(events.fetched, 2);
    // A tile handed to MapLibre stays open (only its source bitmap closed).
    assert.equal(events.closed, 3);
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
test('a tile that finishes just after its owner aborted is closed, never handed to MapLibre', async () => {
  // A flag that flips without firing an event: the reader sees no abort and
  // only the protocol handler's own check can catch it.
  const flag = { aborted: false, addEventListener() {}, removeEventListener() {} }, tileOwner = { signal: flag };
  let armed = false;
  await withDrynessBrowser({ output(bitmap) {
    if (!armed) return Promise.resolve(bitmap);
    flag.aborted = true;
    return Promise.resolve(bitmap);
  } }, async events => {
    const map = drynessMap(), snapshots = [], adapter = createDrynessGround(drynessOptions(map, snapshots));
    await adapter.activate(map, new AbortController().signal);
    armed = true;
    const before = events.closed;
    await assert.rejects(adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, tileOwner), { name: 'AbortError' });
    assert.equal(events.closed, before + 2);
    adapter.deactivate();
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
test('dryness failed land-cover tile fails its STAR frame like a failed tile, and a mounted frame reads both tiles at the same z/x/y', async () => {
  const requested = [];
  await withDrynessBrowser({ fetch: async url => {
    requested.push(String(url));
    if (String(url).includes('landcover-2026001')) return new Response('failed', { status: 500 });
    // Evergreen needleleaf forest (class 1), then bare ground (class 16).
    return new Response(drynessSource(String(url).includes('landcover') ? [0, 128, 0, 255, 128, 128, 128, 255] : undefined),
      { headers: { 'content-type': 'image/png' } });
  } }, async () => {
    const map = drynessMap(), snapshots = [], options = drynessOptions(map, snapshots);
    options.star = options.star.map(frame => ({ ...frame,
      maskTileUrl: (z, x, y) => `https://fixture.invalid/landcover-${frame.frame}/${z}/${x}/${y}.png` }));
    const adapter = createDrynessGround(options);
    await adapter.activate(map, new AbortController().signal);
    assert.equal(snapshots.at(-1).selected.frame, '2025052');
    assert.deepEqual(snapshots.at(-1).failures, [{ productKey: 'star-vhi', frame: '2026001', reason: 'source-failed' }]);
    const tile = await adapter.protocol({ url: 'dryness-test://1/1/6/10/22' }, new AbortController());
    assert.deepEqual([...tile.data.pixels], [255, 255, 255, 102, 0, 0, 0, 0]);
    for (const path of ['2025052', 'landcover-2025052']) assert.ok(requested.includes(`https://fixture.invalid/${path}/6/10/22.png`), path);
    adapter.deactivate();
  });
});
test('the Plant stress switch removes the ground and restores it with fresh dryness reads; the shipped STAR frame reads NOAA STAR land cover beside each tile', async () => {
  const { activateWildfireDryness, getDrynessSourceId } = await import('../src/layers/wildfire-dryness.ts');
  const { setFire3DGroundLayer } = await import('../src/state/fire3d-ground-layers.ts');
  const requested = [];
  const LAYER = 'wildfire-dryness-ground';
  await withDrynessBrowser({ fetch: async url => {
    requested.push(String(url));
    // Land cover: evergreen needleleaf forest (class 1) under both pixels.
    return new Response(drynessSource(String(url).includes('IGBPlandtype') ? [0, 128, 0, 255, 0, 128, 0, 255] : undefined),
      { headers: { 'content-type': 'image/png' } });
  } }, async () => {
    document.documentElement = { dataset: {} };
    const map = Object.assign(drynessMap(), { getStyle: () => ({ layers: [{ id: 'background' }, { id: 'hillshade' }] }) });
    const mounted = async () => { for (let turn = 0; turn < 200 && !map.layers.has(LAYER); turn++) await new Promise(setImmediate); };
    const scene = new AbortController();
    try {
      // Off before the scene opens: nothing is read and nothing is mounted.
      setFire3DGroundLayer('plantStress', false);
      await activateWildfireDryness(map, scene.signal);
      assert.equal(requested.length, 0); assert.equal(map.layers.size, 0);
      setFire3DGroundLayer('plantStress', true);
      await mounted();
      assert.equal(map.layers.get(LAYER).source, getDrynessSourceId());
      const star = 'https://www.star.nesdis.noaa.gov/smcd/emb/vci/VH/image_mapTile.php?type=';
      assert.deepEqual(requested.map(url => url.replace(/\d{7}/, 'WEEK')).sort(),
        [`${star}/j01_500m_VHI/WEEK&Z=5&X=5&Y=11`, `${star}ancillary//IGBPlandtype&Z=5&X=5&Y=11`]);
      // The other switch leaves this layer alone.
      setFire3DGroundLayer('fuelRisk', false);
      assert.equal(map.layers.size, 1);
      setFire3DGroundLayer('plantStress', false);
      assert.equal(map.layers.size, 0); assert.equal(map.sources.size, 0); assert.equal(getDrynessSourceId(), null);
      assert.equal(document.documentElement.dataset.ddmDryness, undefined);
      // Back on: the dryness tile is read again; only the week-free land cover was kept.
      setFire3DGroundLayer('plantStress', true);
      await mounted();
      assert.equal(requested.length, 3); assert.ok(!requested[2].includes('IGBPlandtype'));
      // Leaving the scene releases the switch: a later change reads nothing.
      scene.abort();
      assert.equal(map.layers.size, 0);
      setFire3DGroundLayer('plantStress', false); setFire3DGroundLayer('plantStress', true);
      await new Promise(setImmediate);
      assert.equal(requested.length, 3);
    } finally {
      scene.abort();
      setFire3DGroundLayer('plantStress', true); setFire3DGroundLayer('fuelRisk', true);
    }
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
    assert.equal(events.outputs.length, 0); assert.equal(map.sources.size, 0);
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
test('only a source fault steps the week back: a stall, a local failure or a cancellation does not', async () => {
  const { PngTileResponseError } = await import('../src/map/tile-protocol.ts');
  const dom = name => new DOMException('x', name);
  for (const error of [dom('TimeoutError'), dom('AbortError'), new DrynessLocalError('canvas')]) assert.equal(isDrynessSourceFault(error), false);
  for (const error of [new PngTileResponseError('HTTP 500', 500, '', new ArrayBuffer(0)), new RangeError('Decoded dryness dimensions mismatch'),
    new Error('Unrecognized dryness class'), new Error('Unsupported dryness alpha'), new Error('Unrecognized land-cover class'), new TypeError('fetch failed')]) {
    assert.equal(isDrynessSourceFault(error), true);
  }
});
test('dryness local tile failure rejects that tile and keeps the selected week; a source failure still steps back', async () => {
  const options = { noContext: false }; let failSource = false;
  options.fetch = async () => failSource ? new Response('failed', { status: 500 })
    : new Response(drynessSource(), { headers: { 'content-type': 'image/png' } });
  await withDrynessBrowser(options, async () => {
    const map = drynessMap(), snapshots = [], adapter = createDrynessGround(drynessOptions(map, snapshots));
    await adapter.activate(map, new AbortController().signal);
    const mounted = snapshots.at(-1);
    assert.equal(mounted.selected.frame, '2026001');
    options.noContext = true;
    const local = await adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, new AbortController()).catch(error => error);
    assert.match(local.message, /canvas unavailable/);
    // MapLibre re-announces the rejected tile as a source error; it must not step the week back either.
    map.event('error', { sourceId: mounted.sourceId, error: local });
    await new Promise(setImmediate);
    assert.equal(snapshots.at(-1), mounted); assert.deepEqual(mounted.failures, []);
    options.noContext = false; failSource = true;
    await assert.rejects(adapter.protocol({ url: 'dryness-test://1/0/5/5/11' }, new AbortController()), /HTTP 500/);
    for (let turn = 0; turn < 50 && snapshots.at(-1).selected?.frame !== '2025052'; turn++) await new Promise(setImmediate);
    assert.equal(snapshots.at(-1).failures[0]?.frame, '2026001');
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

// Wildfire 3D: fuel risk is cleared inside a fire perimeter (owner, 2026-10-11), each pixel by the share of it inside (owner, 2026-10-12).
const { tilePolygonMask } = await import('../src/util/tile-polygon-mask.ts');
const { pointInPolygonGeometry } = await import('../src/util/point-in-polygon.ts');
const { latOf, lonOf, mercX, mercY } = await import('../src/layers/flow/field.ts');
/** The mask tests' tile: 32 pixels square. */
const MASK_TILE = [8, 41, 92], MASK_SIZE = 32;
/** A closed ring from points in the tile's own pixels (0,0 is its north-west corner; outside 0..32 lies beyond it). */
const maskRing = (...points) => {
  const [z, x, y] = MASK_TILE;
  const open = points.map(([px, py]) => [lonOf((x + px / MASK_SIZE) / 2 ** z), latOf((y + py / MASK_SIZE) / 2 ** z)]);
  return [...open, open[0]];
};
/** A box is its west, north, east and south edges in tile pixels. */
const maskBox = ([west, north, east, south]) => maskRing([west, north], [east, north], [east, south], [west, south]);
/** The share of one pixel inside a box, exactly. */
const boxShare = ([west, north, east, south], column, row) =>
  Math.max(0, Math.min(east, column + 1) - Math.max(west, column)) * Math.max(0, Math.min(south, row + 1) - Math.max(north, row));
const maskOf = polygons => tilePolygonMask(polygons, MASK_TILE, MASK_SIZE);
const maskSum = mask => mask.reduce((sum, value) => sum + value, 0);
/** Every pixel's byte against `share(column, row)` (1 is all of the pixel, and more than 1 is still all of it), within `bytes`. */
function assertMask(mask, share, bytes, name) {
  assert.ok(mask instanceof Uint8ClampedArray, name);
  for (let index = 0; index < MASK_SIZE ** 2; index++) {
    const expected = 255 * Math.min(1, share(index % MASK_SIZE, Math.floor(index / MASK_SIZE)));
    assert.ok(Math.abs(mask[index] - expected) <= bytes, `${name}: pixel ${index} is ${mask[index]}, expected ${expected.toFixed(2)}`);
  }
}

test('the perimeter mask is the share of each pixel inside: exact across a row, to an eighth of a pixel down it, 255 inside and 0 outside', () => {
  // North and south edges that fall between a row's four sample lines: exact both ways, to the byte.
  const box = [5.3, 10.25, 20.75, 20.5];
  const mask = maskOf([[maskBox(box)]]);
  assertMask(mask, (column, row) => boxShare(box, column, row), 1, 'a box');
  assert.equal(mask[15 * MASK_SIZE + 10], 255);
  assert.equal(mask[15 * MASK_SIZE + 20], 191);
  assert.equal(mask[10 * MASK_SIZE + 5], 134);
  assert.equal(mask[2 * MASK_SIZE + 2], 0);
  // Any other height: an edge that crosses a pixel is placed to within half a sample line, an eighth of the pixel.
  const offTheLines = [5.3, 10.3, 20.75, 20.6];
  assertMask(maskOf([[maskBox(offTheLines)]]), (column, row) => boxShare(offTheLines, column, row), 255 / 8 + 1, 'a box off the sample lines');
});

test('the perimeter mask: a hole is outside whichever way it is wound, overlapping perimeters add up to full and no further, a fire under one pixel clears a little', () => {
  const fire = [4.5, 4.25, 27.5, 27.75], unburnedIsland = [10.25, 10.5, 20.5, 20.25];
  const aroundTheIsland = (column, row) => boxShare(fire, column, row) - boxShare(unburnedIsland, column, row);
  assertMask(maskOf([[maskBox(fire), maskBox(unburnedIsland)]]), aroundTheIsland, 1, 'a hole');
  assertMask(maskOf([[maskBox(fire), maskBox(unburnedIsland).toReversed()]]), aroundTheIsland, 1, 'a hole wound the other way');
  assert.equal(maskOf([[maskBox(fire), maskBox(unburnedIsland)]])[15 * MASK_SIZE + 15], 0);

  const secondFire = [10.25, 10.5, 30.5, 30.25];
  const both = maskOf([[maskBox(fire)], [maskBox(secondFire)]]);
  assertMask(both, (column, row) => boxShare(fire, column, row) + boxShare(secondFire, column, row), 1, 'two overlapping perimeters');
  // Inside both: all of it, not outside by parity. Half inside each: the halves add.
  assert.equal(both[15 * MASK_SIZE + 15], 255);
  assert.equal(both[10 * MASK_SIZE + 27], 255);

  // 0.3 of a pixel wide over one sample line, missing the pixel's centre: 0.3 x 0.25 of the pixel, and nothing anywhere else.
  const small = maskOf([[maskBox([12.6, 7.5, 12.9, 7.75])]]);
  assert.equal(small[7 * MASK_SIZE + 12], 19);
  assert.equal(maskSum(small), 19);
});

test('the perimeter mask against the product\'s own point test and against true area: slanted rings, a hole, a ring across the tile edge, a tile outside', () => {
  const [z, x, y] = MASK_TILE, size = MASK_SIZE, n = 2 ** z;
  const fire = maskRing([6.4, 6.72], [22.72, 4.16], [26.56, 19.84], [14.08, 27.84], [4.16, 17.6]);
  const unburnedIsland = maskRing([12.8, 11.2], [19.52, 13.12], [14.4, 19.2]);
  const acrossTheEdge = maskRing([19.84, -9.6], [44.8, 16.64], [22.4, 29.76]);
  const elsewhere = maskRing([99.2, 102.4], [124.8, 105.6], [112, 121.6]);
  /** The product's even-odd point test at 16 x 16 points in each pixel, in the tile's pixel space: the share of them inside, polygons added. */
  const sampled = polygons => {
    const toPixels = ([lon, lat]) => [(mercX(lon) * n - x) * size, (mercY(lat) * n - y) * size];
    const geometries = polygons.map(polygon => ({ type: 'Polygon', coordinates: polygon.map(points => points.map(toPixels)) }));
    return (column, row) => {
      let inside = 0;
      for (const geometry of geometries) {
        for (let point = 0; point < 256; point++) {
          if (pointInPolygonGeometry(column + ((point % 16) + 0.5) / 16, row + (Math.floor(point / 16) + 0.5) / 16, geometry)) inside++;
        }
      }
      return inside / 256;
    };
  };
  const masks = {};
  for (const [name, polygons] of Object.entries({ 'one perimeter': [[fire]], 'a hole': [[fire, unburnedIsland]],
    'across the tile edge': [[acrossTheEdge]], 'two overlapping perimeters': [[fire], [acrossTheEdge]] })) {
    masks[name] = maskOf(polygons);
    // Within the sample lines' eighth of a pixel; the worst pixel of these shapes measures a twentieth.
    assertMask(masks[name], sampled(polygons), 255 / 8, name);
  }
  const at = (px, py) => Math.floor(py) * size + Math.floor(px);
  // Inside and outside.
  assert.equal(masks['one perimeter'][at(14.4, 14.4)], 255);
  assert.equal(masks['one perimeter'][at(1.6, 1.6)], 0);
  // The hole is outside; the burned ground around it is still inside.
  assert.equal(masks['one perimeter'][at(15.36, 14.4)], 255);
  assert.equal(masks['a hole'][at(15.36, 14.4)], 0);
  assert.equal(masks['a hole'][at(9.6, 16)], 255);
  // A ring that leaves the tile fills up to its edge, and nothing wraps to the far side.
  assert.equal(masks['across the tile edge'][at(31.68, 9.6)], 255);
  assert.equal(masks['across the tile edge'][at(0.32, 9.6)], 0);
  // Ground inside two perimeters is inside, not outside by parity.
  assert.equal(masks['two overlapping perimeters'][at(23.68, 16)], 255);
  // Nothing inside this tile: no mask at all.
  assert.equal(maskOf([[elsewhere]]), null);
  assert.equal(tilePolygonMask([[fire]], [z, x + 2, y], size), null);
  assert.equal(maskOf([]), null);

  // Twenty seeded 24-sided rings well inside the tile: the pixels cleared add up to the ring's area (shoelace), within 0.5%.
  let seed = 20261012;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let trial = 0; trial < 20; trial++) {
    const points = Array.from({ length: 24 }, (_, index) => {
      const radius = 4 + 10 * random();
      return [16 + radius * Math.cos(index * Math.PI / 12), 16 + radius * Math.sin(index * Math.PI / 12)];
    });
    const area = Math.abs(points.reduce((sum, [px, py], index) => {
      const [qx, qy] = points[(index + 1) % 24];
      return sum + px * qy - qx * py;
    }, 0)) / 2;
    const cleared = maskSum(maskOf([[maskRing(...points)]])) / 255;
    assert.ok(Math.abs(cleared - area) <= area / 200, `ring ${trial}: cleared ${cleared.toFixed(2)} of ${area.toFixed(2)} pixels`);
  }
});

/** Canvas, bitmap, window and archive stand-ins for the drape. Its one tile, 0/0/0, is the whole world: 4 x 4 pixels of Very High. */
async function withWhpBrowser(task) {
  const names = ['fetch', 'createImageBitmap', 'document', 'window'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  // The one-tile archive answers the header probe and the protocol's own range reads.
  set('fetch', async (_url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range'));
    return new Response(archive().bytes.slice(Number(start), Number(end) + 1), { status: 206,
      headers: { ETag: 'whp', 'Content-Range': `bytes ${start}-${end}/16393` } });
  });
  set('createImageBitmap', async input => input instanceof Blob ? { width: 4, height: 4, close() {} } : input);
  set('document', { getElementById: () => null, createElement: () => ({ getContext: () => ({ drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray(Array(16).fill([237, 30, 0, 255]).flat()) }) }) }) });
  set('window', { dispatchEvent() {} });
  // The one-tile stand-in is the whole world, so it is drawn with the whole world as the archive's box.
  whpShade.setWhpShadeBounds({ west: -180, south: -90, east: 180, north: 90 });
  try { return await task(); }
  finally {
    whpShade.setWhpShadeBounds(FIRE3D_TERRAIN_COVERAGE);
    for (const name of names) {
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}
const whpShade = await import('../src/layers/whp-shade-protocol.ts');
const { FIRE3D_TERRAIN_COVERAGE } = await import('../src/config/terrain-coverage.ts');
const whpAlphas = image => [...image.data].filter((_, index) => index % 4 === 3);
/** The drape's tile through the real protocol: its sixteen alpha bytes, row by row. */
async function drapeTileAlphas() {
  const tile = await whpShade.loadWhpShade({ url: 'whp-shade://https://example.test/whp.pmtiles/0/0/0', type: 'image' }, new AbortController());
  return whpAlphas(tile.data);
}
/** Very High is 80% white in Wildfire 3D. */
const WHP_WHOLE = Array(16).fill(204);
/** Perimeters over exactly the north-west and the south-east quarter of the world, whole pixels of the tile, and the tile each leaves. */
const NW_QUARTER = [[[[-180, 0], [0, 0], [0, 89], [-180, 89], [-180, 0]]]];
const NW_CLEARED = WHP_WHOLE.map((alpha, index) => [0, 1, 4, 5].includes(index) ? 0 : alpha);
const SE_QUARTER = [[[[0, -89], [180, -89], [180, 0], [0, 0], [0, -89]]]];
const SE_CLEARED = WHP_WHOLE.map((alpha, index) => [10, 11, 14, 15].includes(index) ? 0 : alpha);

test('the Wildfire 3D drape protocol clears fuel risk by the share of each pixel inside the perimeters; the flat view\'s shading never reads them', async () => {
  await withWhpBrowser(async () => {
    try {
      // No perimeters: the drape is the picture it was.
      assert.deepEqual(await drapeTileAlphas(), WHP_WHOLE);
      whpShade.setWhpShadePerimeters(NW_QUARTER);
      assert.deepEqual(await drapeTileAlphas(), NW_CLEARED);
      // An edge a quarter of the way into the next column of pixels: a quarter of their fuel risk goes, 204 to 153.
      whpShade.setWhpShadePerimeters([[[[-180, 0], [22.5, 0], [22.5, 89], [-180, 89], [-180, 0]]]]);
      assert.deepEqual(await drapeTileAlphas(), NW_CLEARED.map((alpha, index) => [2, 6].includes(index) ? 153 : alpha));
      // The flat Wildfire view's own call (src/layers/whp-image-shade-protocol.ts): no tile, so no mask, and its own table.
      assert.deepEqual(whpAlphas(await whpShade.shadeImage(new Blob([]), new AbortController().signal)), Array(16).fill(255));
    } finally { whpShade.setWhpShadePerimeters([]); }
  });
  // All of a pixel inside, none of it, a quarter of it, and a pixel with no fuel risk; a cleared pixel is still checked against the issuer's classes.
  const pixels = new Uint8ClampedArray([237, 30, 0, 255, 237, 30, 0, 255, 237, 30, 0, 255, 0, 0, 0, 0]);
  whpShade.shadeWhpPixels(pixels, whpShade.WHP_3D_SHADE_ALPHA_BY_RGB, Uint8ClampedArray.of(255, 0, 64, 255));
  assert.deepEqual([...pixels], [255, 255, 255, 0, 255, 255, 255, 204, 255, 255, 255, 153, 0, 0, 0, 0]);
  assert.throws(() => whpShade.shadeWhpPixels(new Uint8ClampedArray([255, 0, 0, 255]), whpShade.WHP_3D_SHADE_ALPHA_BY_RGB, Uint8ClampedArray.of(255)),
    /Unrecognized WHP class/);
  // Live tile z6/10/21 (2026-10-19): the issuer's NoData is opaque black, not its tRNS colour; it clears, the classes beside it shade, and a near-black still fails.
  const edge = new Uint8ClampedArray([0, 0, 0, 255, 237, 30, 0, 255, 0, 112, 225, 255]);
  whpShade.shadeWhpPixels(edge);
  assert.deepEqual([...edge], [0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0]);
  assert.throws(() => whpShade.shadeWhpPixels(new Uint8ClampedArray([1, 0, 0, 255])), /Unrecognized WHP class/);
});

test('the issuer-colours row clears only the issuer\'s opaque-black NoData and keeps every other colour as drawn', async () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 255, 237, 30, 0, 255, 1, 0, 0, 255, 0, 112, 225, 255]);
  whpShade.clearWhpNoData(pixels);
  assert.deepEqual([...pixels], [0, 0, 0, 0, 237, 30, 0, 255, 1, 0, 0, 255, 0, 112, 225, 255]);
  // Through the image path: a pixel function in place of a shade table leaves the issuer's Very High as it came.
  await withWhpBrowser(async () => {
    const image = await whpShade.shadeImage(new Blob([]), new AbortController().signal, whpShade.clearWhpNoData);
    assert.deepEqual([...image.data].slice(0, 4), [237, 30, 0, 255]);
  });
});

test('the Wildfire 3D drape clears the pixels outside the archive box: an edge tile at z8 keeps its north of 41.5 N, an interior tile is unchanged', () => {
  const tileRow = lat => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 256);
  const size = 8, x = Math.floor((-120 + 180) / 360 * 256);
  const rowLat = (y, py) => Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (py + 0.5) / size) / 256))) * 180 / Math.PI;
  const whole = () => new Uint8ClampedArray(Array(size * size).fill([255, 255, 255, 204]).flat());
  const alphaRows = pixels => Array.from({ length: size }, (_, py) => pixels[py * size * 4 + 3]);
  const edgeY = tileRow(41.5);
  const edge = whole();
  whpShade.clearWhpOutsideBounds(edge, [8, x, edgeY], size, FIRE3D_TERRAIN_COVERAGE);
  const expected = Array.from({ length: size }, (_, py) => rowLat(edgeY, py) >= 41.5 ? 204 : 0);
  assert.deepEqual(alphaRows(edge), expected);
  assert.ok(expected.includes(0) && expected.includes(204), 'the tile straddles the line');
  // Only alpha moves: the colours stay the issuer's.
  assert.ok([...edge].every((value, index) => index % 4 === 3 || value === 255));
  const interior = whole();
  whpShade.clearWhpOutsideBounds(interior, [8, x, tileRow(45)], size, FIRE3D_TERRAIN_COVERAGE);
  assert.deepEqual([...interior], [...whole()]);
  // A tile east of the box loses every pixel.
  const east = whole();
  whpShade.clearWhpOutsideBounds(east, [8, Math.floor((-100 + 180) / 360 * 256), tileRow(45)], size, FIRE3D_TERRAIN_COVERAGE);
  assert.ok(alphaRows(east).every(alpha => alpha === 0));
});

test('the Wildfire 3D drape takes the published perimeters before its source exists, reloads its tiles only when the snapshot changes, and lets go on teardown', async () => {
  const { activateWhpDrape, deactivateWhpDrape } = await import('../src/layers/whp-3d.ts');
  const { registry } = await import('../src/state/registry.ts');
  const { setPerimeterSnapshot } = await import('../src/state/fire-perimeter-snapshot.ts');
  const events = [], mounted = [], sources = new Map(), layers = new Map();
  const map = {
    getSource: id => sources.get(id), removeSource: id => sources.delete(id),
    addSource(id, spec) { events.push(`${id} added`); sources.set(id, spec); },
    getLayer: id => layers.get(id), addLayer(layer) { layers.set(layer.id, layer); }, removeLayer: id => layers.delete(id),
    moveLayer() {}, setLayoutProperty() {}, getStyle: () => ({ layers: [...layers.keys()].map(id => ({ id })) }),
    refreshTiles(id, tiles) { events.push(`${id} reloaded`); lastTiles = tiles; }
  };
  let lastTiles;
  const reloads = () => events.filter(event => event === 'whp-2023 reloaded').length;
  const fires = polygons => ({ type: 'FeatureCollection',
    features: polygons.map(coordinates => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } })) });
  await withWhpBrowser(async () => {
    const scene = new AbortController();
    const nw = fires(NW_QUARTER);
    try {
      // The perimeter layer has already published its collection when the scene opens.
      setPerimeterSnapshot(nw);
      // The console offers its Fuel risk switch only while the drape says it is mounted.
      window.dispatchEvent = event => { if (event.type === 'ddm:whp-shade') mounted.push(event.detail.mounted); };
      assert.equal(await activateWhpDrape(map, scene.signal), true);
      assert.deepEqual(mounted, [true]);
      // Taken first: the drape's first tile is already cut, and entering reloads nothing.
      assert.deepEqual(events, ['whp-2023 added']);
      assert.deepEqual(await drapeTileAlphas(), NW_CLEARED);

      // The same collection published again (a pan inside the fetched envelope does that) and a change to
      // another layer: no reload.
      setPerimeterSnapshot(nw);
      registry.activate('unrelated'); registry.deactivate('unrelated');
      assert.equal(reloads(), 0);

      // A fresh response over the same geometry changes no tile: no reload, the same tile.
      setPerimeterSnapshot(fires(structuredClone(NW_QUARTER)));
      assert.equal(reloads(), 0);
      assert.deepEqual(await drapeTileAlphas(), NW_CLEARED);

      // Different perimeters: one reload of the whole source (a tile list would leave stale tiles in
      // MapLibre's out-of-view cache), and the tile is cut to the new set.
      setPerimeterSnapshot(fires(SE_QUARTER));
      assert.equal(reloads(), 1);
      assert.equal(lastTiles, undefined);
      assert.deepEqual(await drapeTileAlphas(), SE_CLEARED);

      // The perimeter layer goes off (it publishes nothing): whole again.
      setPerimeterSnapshot(null);
      assert.equal(reloads(), 2);
      assert.deepEqual(await drapeTileAlphas(), WHP_WHOLE);

      // Leaving the scene: later perimeter news is not followed.
      deactivateWhpDrape(map);
      assert.equal(sources.has('whp-2023'), false);
      assert.equal(mounted.at(-1), false);
      setPerimeterSnapshot(fires(NW_QUARTER));
      assert.equal(reloads(), 2);
      assert.deepEqual(await drapeTileAlphas(), WHP_WHOLE);
    } finally {
      scene.abort(); deactivateWhpDrape(map); setPerimeterSnapshot(null); whpShade.setWhpShadePerimeters([]);
    }
  });
});

test('in Wildfire 3D the issuer colours on and then off stand the drape down and back up; the flat white Fuel risk never draws in the scene', async () => {
  const { activateWhpDrape, deactivateWhpDrape } = await import('../src/layers/whp-3d.ts');
  const { registry } = await import('../src/state/registry.ts');
  const { setFire3DGroundLayer } = await import('../src/state/fire3d-ground-layers.ts');
  const visibility = new Map(), mounted = [], sources = new Map();
  const layers = new Map([['usfs-whp', { id: 'usfs-whp' }]]);
  const map = {
    getSource: id => sources.get(id), removeSource: id => sources.delete(id), addSource: (id, spec) => sources.set(id, spec),
    getLayer: id => layers.get(id), removeLayer: id => layers.delete(id),
    addLayer(layer) { layers.set(layer.id, layer); visibility.set(layer.id, layer.layout.visibility); },
    moveLayer() {}, setLayoutProperty: (id, name, value) => visibility.set(id, value),
    getStyle: () => ({ layers: [...layers.keys()].map(id => ({ id })) }), refreshTiles() {}
  };
  await withWhpBrowser(async () => {
    const scene = new AbortController();
    try {
      window.dispatchEvent = event => { if (event.type === 'ddm:whp-shade') mounted.push(event.detail.mounted); };
      assert.equal(await activateWhpDrape(map, scene.signal), true);
      assert.deepEqual([visibility.get('usfs-whp'), visibility.get('whp-2023')], ['none', 'visible']);

      // The issuer colours come on: the drape stands down without being torn down; the white copy stays hidden.
      registry.activate('usfs-whp-classes');
      assert.deepEqual([visibility.get('usfs-whp'), visibility.get('whp-2023')], ['none', 'none']);
      assert.equal(mounted.at(-1), false);
      // The console's switch has nothing to act on meanwhile, so a switch change shows nothing.
      setFire3DGroundLayer('fuelRisk', false); setFire3DGroundLayer('fuelRisk', true);
      assert.equal(visibility.get('whp-2023'), 'none');

      // Off again: the drape is back, still perimeter-masked, and the flat white layer never returns in the scene.
      registry.deactivate('usfs-whp-classes');
      assert.equal(sources.has('whp-2023'), true);
      assert.deepEqual([visibility.get('usfs-whp'), visibility.get('whp-2023')], ['none', 'visible']);
      assert.equal(mounted.at(-1), true);

      // Only the scene teardown gives the flat layer back.
      deactivateWhpDrape(map);
      assert.equal(visibility.get('usfs-whp'), 'visible');
      assert.equal(mounted.at(-1), false);
    } finally {
      scene.abort(); registry.deactivate('usfs-whp-classes'); deactivateWhpDrape(map); setFire3DGroundLayer('fuelRisk', true);
    }
  });
});
