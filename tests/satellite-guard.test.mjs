import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

/**
 * The guard against NOAA GeoColor's placeholder image (src/map/satellite-guard.ts):
 * the pixel check on real decodes of a synthetic two-level image and of a natural
 * image, and the per-tile answer of the `satellite-guard://` protocol across the
 * shared status and cancellation matrix.
 */

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new globalThis.URL(specifier + '.ts', context.parentURL)))) {
    return nextResolve(specifier + '.ts', context);
  }
  return nextResolve(specifier, context);
} });
const { isPlaceholderImage, satelliteTileAction, SATELLITE_TILE_SCHEME } = await import('../src/map/satellite-guard.ts');

/** A 256 px image of black and white blocks, the two levels the service's placeholder shows. */
function twoLevelPng(block = 16) {
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4;
      const value = (Math.floor(x / block) + Math.floor(y / block)) % 2 === 0 ? 8 : 246;
      png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = value;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const decodePng = (bytes) => {
  const { width, height, data } = PNG.sync.read(Buffer.from(bytes));
  return { width, height, data };
};
const decodeJpeg = (bytes) => jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
/** The decoder the protocol is given in Node: the real PNG and JPEG decoders, chosen by type. */
const decodeByType = async (bytes, contentType) =>
  contentType.startsWith('image/png') ? decodePng(bytes) : decodeJpeg(bytes);

/** 256 px windows of a real picture: the map area of the project's preview screenshot (terrain, snow, lava, fire, water). */
function naturalWindows() {
  const picture = decodeJpeg(readFileSync(new URL('../public/social/ddm-test-preview.jpg', import.meta.url)));
  const windows = [];
  for (let top = 0; top + 256 <= picture.height; top += 128) {
    for (let left = 320; left + 256 <= 1180; left += 128) {
      const data = new Uint8Array(256 * 256 * 4);
      for (let row = 0; row < 256; row++) {
        const from = ((top + row) * picture.width + left) * 4;
        data.set(picture.data.subarray(from, from + 256 * 4), row * 256 * 4);
      }
      windows.push({ width: 256, height: 256, data, where: `${left},${top}` });
    }
  }
  return windows;
}

function encodePng({ width, height, data }) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data);
  return PNG.sync.write(png);
}

test('a two-level black and white image is a placeholder, as PNG and through JPEG compression', () => {
  const png = twoLevelPng();
  const decoded = decodePng(png);
  assert.equal(isPlaceholderImage(decoded), true);
  for (const block of [4, 8, 32, 64]) assert.equal(isPlaceholderImage(decodePng(twoLevelPng(block))), true, `block ${block}`);
  const jpg = jpeg.encode({ width: 256, height: 256, data: Buffer.from(decoded.data) }, 75).data;
  assert.equal(isPlaceholderImage(decodeJpeg(jpg)), true, 'JPEG edges stay within the between-tone allowance');
});

test('a natural image is never a placeholder', () => {
  const windows = naturalWindows();
  assert.equal(windows.length, 35);
  for (const window of windows) assert.equal(isPlaceholderImage(window), false, window.where);
});

/** Recorded answers of the service (tests/fixtures/satellite/README.md). */
const recorded = (name) => readFileSync(new URL(`./fixtures/satellite/${name}`, import.meta.url));

test("the service's recorded placeholder is caught and its recorded imagery is kept", () => {
  for (const name of ['placeholder-probe.jpg', 'placeholder-tile.jpg']) {
    assert.equal(isPlaceholderImage(decodeJpeg(recorded(name))), true, name);
  }
  for (const name of ['night-ocean.jpg', 'night-convection.jpg', 'day-probe.jpg']) {
    assert.equal(isPlaceholderImage(decodeJpeg(recorded(name))), false, name);
  }
});

test('transparent, uniform, one-level and two-colour tiles are not placeholders', () => {
  const solid = (r, g, b, a) => {
    const data = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
    return { width: 256, height: 256, data };
  };
  assert.equal(isPlaceholderImage(solid(0, 0, 0, 0)), false, 'off the GOES disks');
  assert.equal(isPlaceholderImage(solid(0, 0, 0, 255)), false);
  assert.equal(isPlaceholderImage(solid(255, 255, 255, 255)), false);
  // The browser stubs' probe tile (tests/satellite-fixture.ts): two colours, neither black nor white.
  const twoColour = solid(34, 91, 132, 255);
  for (let i = 0; i < twoColour.data.length; i += 8) twoColour.data.set([174, 126, 57, 255], i);
  assert.equal(isPlaceholderImage(twoColour), false);
  // A sharp cloud edge over black night ocean: two grey levels, nothing between, but one change a row.
  const edge = solid(4, 4, 4, 255);
  for (let i = 0; i < edge.data.length; i += 4) if ((i / 4) % 256 < 128) edge.data.set([250, 250, 250, 255], i);
  assert.equal(isPlaceholderImage(edge), false, 'one edge');
  // Three bands of cloud: two changes a row, still not the grid.
  const bands = solid(4, 4, 4, 255);
  for (let i = 0; i < bands.data.length; i += 4) if (Math.floor(((i / 4) % 256) / 86) === 1) bands.data.set([250, 250, 250, 255], i);
  assert.equal(isPlaceholderImage(bands), false, 'bands');
});

const TILE = 'https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer/exportImage?bbox=1,2,3,4&f=image';
const request = { url: `${SATELLITE_TILE_SCHEME}://${TILE}`, type: 'image' };

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}
const imageResponse = (body, type = 'image/png', init = {}) =>
  new Response(body, { headers: { 'content-type': type }, ...init });

function recorder() {
  const heard = [];
  return { heard, onTile: (url, placeholder) => heard.push({ url, placeholder }) };
}

test('a placeholder tile is answered transparent and counted; imagery passes through unchanged', async () => {
  const { heard, onTile } = recorder();
  const action = satelliteTileAction(onTile, decodeByType);
  const natural = encodePng(naturalWindows()[5]);
  await withFetch(async (url) => {
    assert.equal(url, TILE, 'the scheme is stripped and the pinned URL fetched as is');
    return imageResponse(twoLevelPng());
  }, async () => {
    const answer = await action(request, new AbortController());
    assert.ok(answer.data instanceof ArrayBuffer);
    assert.equal(answer.data.byteLength, 0);
  });
  await withFetch(async () => imageResponse(natural), async () => {
    const answer = await action(request, new AbortController());
    assert.deepEqual(Buffer.from(answer.data), natural);
  });
  assert.deepEqual(heard, [{ url: TILE, placeholder: true }, { url: TILE, placeholder: false }]);
});

test('the recorded placeholder tile is answered transparent; a recorded night tile passes unchanged', async () => {
  const { heard, onTile } = recorder();
  const action = satelliteTileAction(onTile, decodeByType);
  await withFetch(async () => imageResponse(recorded('placeholder-tile.jpg'), 'image/jpeg'), async () => {
    const answer = await action(request, new AbortController());
    assert.equal(answer.data.byteLength, 0);
  });
  const night = recorded('night-ocean.jpg');
  await withFetch(async () => imageResponse(night, 'image/jpeg'), async () => {
    const answer = await action(request, new AbortController());
    assert.deepEqual(Buffer.from(answer.data), night);
  });
  assert.deepEqual(heard, [{ url: TILE, placeholder: true }, { url: TILE, placeholder: false }]);
});

test('a transparent off-coverage tile passes as imagery (the plain map shows through, not a failure)', async () => {
  const { heard, onTile } = recorder();
  const png = new PNG({ width: 256, height: 256 });
  png.data.fill(0);
  const blank = PNG.sync.write(png);
  await withFetch(async () => imageResponse(blank), async () => {
    const answer = await satelliteTileAction(onTile, decodeByType)(request, new AbortController());
    assert.equal(answer.data.byteLength, blank.byteLength);
  });
  assert.deepEqual(heard, [{ url: TILE, placeholder: false }]);
});

test('HTTP errors, an ArcGIS error envelope at HTTP 200, a blank body and a corrupt image are tile errors, never empty tiles', async () => {
  const { heard, onTile } = recorder();
  const action = satelliteTileAction(onTile, decodeByType);
  const corrupt = Buffer.from(twoLevelPng()).subarray(0, 60);
  for (const make of [
    () => imageResponse('busy', 'text/plain', { status: 503 }),
    () => imageResponse(JSON.stringify({ error: { code: 500, message: 'Error exporting image' } }), 'application/json'),
    () => imageResponse('', 'image/png'),
    () => imageResponse(corrupt)
  ]) {
    await withFetch(async () => make(), async () => {
      await assert.rejects(action(request, new AbortController()));
    });
  }
  assert.deepEqual(heard, []);
});

test('an abort during the body read rejects as AbortError, cancels the body and reports nothing', { timeout: 1000 }, async () => {
  const { heard, onTile } = recorder();
  const owner = new AbortController();
  let canceled = 0;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  await withFetch(async () => imageResponse(new ReadableStream({
    start() { entered(); },
    cancel() { canceled++; }
  })), async () => {
    const pending = satelliteTileAction(onTile, decodeByType)(request, owner);
    await started;
    owner.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  });
  assert.equal(canceled, 1);
  assert.deepEqual(heard, []);
});

test('a response that lands after supersession is dropped: no tile, no report, nothing pending', async () => {
  const { heard, onTile } = recorder();
  const owner = new AbortController();
  let release;
  const decodeHeld = async (bytes, type) => {
    await new Promise((resolve) => { release = resolve; });
    return decodeByType(bytes, type);
  };
  await withFetch(async () => imageResponse(twoLevelPng()), async () => {
    const pending = satelliteTileAction(onTile, decodeHeld)(request, owner);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    owner.abort();
    release();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  });
  assert.deepEqual(heard, []);
});
