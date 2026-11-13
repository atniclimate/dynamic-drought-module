import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

/**
 * The REAL src/map/satellite.ts frame logic, with MapLibre, the toast, the
 * tile watcher and the page decoder replaced by recorders and `fetch`
 * stubbed per request. The placeholder guard is the real one.
 *
 * 1. Turning imagery back on installs the frame the module already holds,
 *    without a catalog query standing between the press and the imagery,
 *    and a failed refresh keeps it.
 * 2. A catalog query that fails is asked once more before imagery reads
 *    unavailable; a verified absence and a cancellation are not.
 * 3. A placeholder met at tile time walks back to an older frame, the frame
 *    is skipped for the session, and the walk ends on the plain map.
 * 4. The Impact Briefing's Technical information follows what the map holds.
 */

const pathOf = (url) => (typeof url === 'string' && url.startsWith('file:') ? new URL(url).pathname : '');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && pathOf(context.parentURL).endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  }
});

const GUARD_URL = new URL('../src/map/satellite-guard.ts', import.meta.url).href;
const seen = { protocol: null, watches: [], toasts: [], decode: null };
globalThis.satelliteSeen = seen;
const stubs = {
  'maplibre-gl': 'export function addProtocol(scheme, action) { globalThis.satelliteSeen.protocol = action; }',
  '../ui/overlay': 'export function showToast(text) { globalThis.satelliteSeen.toasts.push(text); }',
  '../util/raster-status':
    'export function watchRasterTiles(map, id, report) { const watch = { report, detached: false, detach() { watch.detached = true; } }; globalThis.satelliteSeen.watches.push(watch); return watch; }',
  './layer-order': "export const BOTTOM_STACK_IDS = ['background', 'basemap-satellite']; export function firstLayerIdAbove() { return undefined; }",
  // The real guard, with the page decoder swapped for Node's PNG and JPEG decoders.
  './satellite-guard': `import * as real from ${JSON.stringify(GUARD_URL)};
export const { isPlaceholderImage, isSupportedRaster, SATELLITE_TILE_SCHEME, MAX_SATELLITE_IMAGE_BYTES } = real;
export const decodeImage = (bytes, type, signal) => globalThis.satelliteSeen.decode(bytes, type, signal);
export const satelliteTileAction = (onTile, decode = decodeImage, timeoutMs) => real.satelliteTileAction(onTile, decode, timeoutMs);`
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (pathOf(context.parentURL).endsWith('/src/map/satellite.ts') && Object.hasOwn(stubs, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

globalThis.window = new EventTarget();
globalThis.document = { getElementById: () => null, documentElement: { dataset: {} } };
const stamp = () => globalThis.document.documentElement.dataset.ddmSatellite;

seen.decode = async (bytes, type) =>
  type.startsWith('image/png')
    ? PNG.sync.read(Buffer.from(bytes))
    : jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });

const technical = await import('../src/ui/map-technical-information.ts');
const store = await import('../src/state/basemap-store.ts');
let instance = 0;
/** A fresh module per case: the held frame and the placeholder memory last a session, not a test file. */
const fresh = () => import(`../src/map/satellite.ts?case=${++instance}`);

/** The browser stub's imagery tile (tests/satellite-fixture.ts): two colours, a passing probe. */
function realPng() {
  const png = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < png.data.length; i += 4) {
    const west = (i / 4) % 256 < 128;
    png.data.set(west ? [34, 91, 132, 255] : [174, 126, 57, 255], i);
  }
  return PNG.sync.write(png);
}
const REAL = realPng();
const PLACEHOLDER = readFileSync(new URL('./fixtures/satellite/placeholder-tile.jpg', import.meta.url));

function frame(objectId, minutesAgo) {
  const endTime = Date.now() - minutesAgo * 60_000;
  return { objectId, name: `MERGEDGC.10-minute.case_${objectId}.color`, startTime: endTime - 9 * 60_000, endTime };
}
const catalogOf = (frames) => () =>
  new Response(JSON.stringify({
    features: frames.map((f) => ({ attributes: { objectid: f.objectId, name: f.name, start_time: f.startTime, end_time: f.endTime } }))
  }), { headers: { 'content-type': 'application/json' } });
const envelope = () => () =>
  new Response(JSON.stringify({ error: { code: 500, message: 'Error performing query operation' } }), { headers: { 'content-type': 'application/json' } });
const httpError = () => () => new Response('busy', { status: 503 });

/** Answer catalog queries in order and image requests by frame; returns the request log. */
function serve({ catalog, placeholderProbe = [], placeholderTiles = [], oversizedProbe = [] }) {
  const log = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/query')) {
      log.push('catalog');
      const answer = catalog.shift();
      assert.ok(answer, `unexpected catalog query ${log.length}`);
      return answer();
    }
    const objectId = Number(JSON.parse(parsed.searchParams.get('mosaicRule')).lockRasterIds[0]);
    const probe = parsed.searchParams.get('bbox') === sat.SATELLITE_PROBE_BBOX;
    log.push(`${probe ? 'probe' : 'tile'}:${objectId}`);
    if (probe && oversizedProbe.includes(objectId)) {
      return new Response(Buffer.concat([REAL, Buffer.alloc(1024 * 1024)]), { headers: { 'content-type': 'image/png' } });
    }
    const placeholder = (probe ? placeholderProbe : placeholderTiles).includes(objectId);
    return new Response(placeholder ? PLACEHOLDER : REAL, { headers: { 'content-type': placeholder ? 'image/jpeg' : 'image/png' } });
  };
  return log;
}

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource: (id, spec) => sources.set(id, spec),
    addLayer: (spec) => layers.set(spec.id, spec),
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id)
  };
}

/** One map tile of `f` through the guard protocol, as MapLibre would ask for it. */
async function tile(f) {
  const url = sat.satelliteTileTemplate(f).replace('{bbox-epsg-3857}', '1,2,3,4');
  return seen.protocol({ url: `satellite-guard://${url}`, type: 'image' }, new AbortController());
}
/** The installed frame's tiles reported loaded. */
const tilesLoaded = () => seen.watches.at(-1).report('ready');

async function until(check, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const briefing = () => technical.renderMapTechnicalInformation();
const UNAVAILABLE = technical.SATELLITE_UNAVAILABLE_NOTE;

let sat;
let map;
async function begin(t) {
  sat = await fresh();
  map = fakeMap();
  seen.watches.length = 0;
  seen.toasts.length = 0;
  store.setBasemapMode('satellite');
  const warn = console.warn;
  console.warn = () => {};
  t.after(async () => {
    await sat.setSatelliteActive(map, false);
    console.warn = warn;
  });
}

test('turning imagery back on installs the held frame at once and only asks whether a newer one exists', async (t) => {
  await begin(t);
  const held = frame(101, 5);
  let log = serve({ catalog: [catalogOf([held])] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog', 'probe:101']);
  tilesLoaded();
  await sat.setSatelliteActive(map, false);
  assert.equal(stamp(), undefined, 'no imagery layer is left mounted when SAT is off');
  assert.equal(map.getLayer('basemap-satellite'), undefined);

  log = serve({ catalog: [catalogOf([held])] });
  const pending = sat.setSatelliteActive(map, true, true);
  assert.equal(stamp(), '101', 'the held frame is on the map before any answer');
  await pending;
  assert.deepEqual(log, ['catalog'], 'the held frame is not probed again');
  assert.equal(stamp(), '101');
  assert.equal(store.isImageryUnavailable(), false);
});

test('a catalog failure while the held frame is shown keeps it, after asking once more', async (t) => {
  await begin(t);
  const held = frame(111, 5);
  serve({ catalog: [catalogOf([held])] });
  await sat.setSatelliteActive(map, true, true);
  tilesLoaded();
  await sat.setSatelliteActive(map, false);

  const log = serve({ catalog: [envelope(), envelope()] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog', 'catalog']);
  assert.equal(stamp(), '111', 'a failed refresh does not remove a frame that is still good');
  assert.ok(map.getLayer('basemap-satellite'));
  assert.equal(store.isImageryUnavailable(), false);
  assert.deepEqual(seen.toasts, []);
});

test('a held frame whose tiles fail asks the catalog again instead of going to the plain map', async (t) => {
  await begin(t);
  const held = frame(121, 5);
  serve({ catalog: [catalogOf([held])] });
  await sat.setSatelliteActive(map, true, true);
  tilesLoaded();
  await sat.setSatelliteActive(map, false);

  const newer = frame(122, 2);
  const log = serve({ catalog: [catalogOf([held]), catalogOf([newer])] });
  await sat.setSatelliteActive(map, true, true);
  assert.equal(stamp(), '121');
  seen.watches.at(-1).report('error');
  await until(() => stamp() === '122', 'the frame the catalog offers now');
  assert.deepEqual(log, ['catalog', 'catalog', 'probe:122']);
  assert.equal(store.isImageryUnavailable(), false);
  assert.deepEqual(seen.toasts, []);
});

test('a catalog error is asked once more before imagery reads unavailable', async (t) => {
  await begin(t);
  const log = serve({ catalog: [httpError(), catalogOf([frame(201, 5)])] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog', 'catalog', 'probe:201']);
  assert.equal(stamp(), '201');
  assert.equal(store.isImageryUnavailable(), false);
});

test('two catalog failures read unavailable with no third query; a verified absence is not asked again', async (t) => {
  await begin(t);
  let log = serve({ catalog: [envelope(), httpError()] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog', 'catalog']);
  assert.equal(store.isImageryUnavailable(), true);
  assert.equal(stamp(), undefined);

  store.setBasemapMode('satellite');
  log = serve({ catalog: [catalogOf([])] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog']);
  assert.equal(store.isImageryUnavailable(), true);
});

test('switching off while the catalog is waiting to be asked again ends quietly, with nothing pending', async (t) => {
  await begin(t);
  const log = serve({ catalog: [httpError()] });
  const pending = sat.setSatelliteActive(map, true, true);
  await until(() => log.length === 1, 'the first query');
  const off = Date.now();
  await sat.setSatelliteActive(map, false);
  await pending;
  assert.ok(Date.now() - off < 500, 'the wait ends with the switch-off, not after its delay');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(log, ['catalog'], 'no second query after cancel');
  assert.equal(store.isImageryUnavailable(), false);
});

test('a probe body larger than the image cap fails that frame and the next one is tried', async (t) => {
  await begin(t);
  const log = serve({ catalog: [catalogOf([frame(501, 5), frame(500, 15)])], oversizedProbe: [501] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog', 'probe:501', 'probe:500']);
  assert.equal(stamp(), '500');
});

test('a placeholder met at tile time walks back to the next frame and that frame is skipped for the session', async (t) => {
  await begin(t);
  const newest = frame(301, 5);
  const previous = frame(300, 15);
  let log = serve({ catalog: [catalogOf([newest, previous]), catalogOf([newest, previous])], placeholderTiles: [301] });
  await sat.setSatelliteActive(map, true, true);
  assert.equal(stamp(), '301', 'the probe passed, so the newest frame was installed');
  const answer = await tile(newest);
  assert.equal(answer.data.byteLength, 0, 'the placeholder tile is answered transparent');
  await until(() => stamp() === '300', 'the walk back to the previous frame');
  assert.deepEqual(log, ['catalog', 'probe:301', 'tile:301', 'catalog', 'probe:300']);
  assert.equal(store.isImageryUnavailable(), false);

  await sat.setSatelliteActive(map, false);
  log = serve({ catalog: [catalogOf([newest, previous])], placeholderTiles: [301] });
  await sat.setSatelliteActive(map, true, true);
  assert.deepEqual(log, ['catalog', 'probe:300'], 'the marked frame is not probed again');
  assert.equal(stamp(), '300');
});

test('two frames that serve the placeholder at tile time walk back two steps to the third', async (t) => {
  await begin(t);
  const newest = frame(311, 5);
  const middle = frame(310, 15);
  const oldest = frame(309, 25);
  const frames = [newest, middle, oldest];
  const log = serve({ catalog: [catalogOf(frames), catalogOf(frames), catalogOf(frames)], placeholderTiles: [311, 310] });
  await sat.setSatelliteActive(map, true, true);
  await tile(newest);
  await until(() => stamp() === '310', 'the first step back');
  await tile(middle);
  await until(() => stamp() === '309', 'the second step back');
  assert.deepEqual(log, ['catalog', 'probe:311', 'tile:311', 'catalog', 'probe:310', 'tile:310', 'catalog', 'probe:309']);
  assert.equal(store.isImageryUnavailable(), false);
});

test('the walk back ends on the plain map when every frame is marked or fails its probe', async (t) => {
  await begin(t);
  const newest = frame(401, 5);
  const previous = frame(400, 15);
  const log = serve({
    catalog: [catalogOf([newest, previous]), catalogOf([newest, previous])],
    placeholderTiles: [401],
    placeholderProbe: [400]
  });
  await sat.setSatelliteActive(map, true, true);
  tilesLoaded();
  assert.ok(briefing().includes(technical.SATELLITE_CAVEAT_NOTE), 'the caveats read while imagery is on');
  await tile(newest);
  await until(() => store.isImageryUnavailable(), 'the plain map');
  assert.deepEqual(log, ['catalog', 'probe:401', 'tile:401', 'catalog', 'probe:400']);
  assert.equal(stamp(), undefined, 'no imagery layer is left mounted');
  assert.equal(map.getLayer('basemap-satellite'), undefined);
  assert.equal(map.getSource('basemap-satellite'), undefined);
  const text = briefing();
  assert.ok(text.includes(UNAVAILABLE));
  assert.ok(!text.includes(technical.SATELLITE_CAVEAT_NOTE));
});

test('Technical information states the caveats while imagery is on and one plain sentence, with no time, when no real frame was found', () => {
  technical.setSatelliteImageryBriefing('on');
  const on = briefing();
  assert.ok(on.includes('<h4>Satellite imagery</h4>'));
  assert.ok(on.includes(`<p>${technical.SATELLITE_CAVEAT_NOTE}</p>`));
  assert.ok(on.includes(`<p>${technical.SATELLITE_COVERAGE_NOTE}</p>`));
  assert.ok(!on.includes(UNAVAILABLE));

  technical.setSatelliteImageryBriefing('unavailable');
  const off = briefing();
  const entry = off.slice(off.indexOf('<h4>Satellite imagery</h4>'), off.indexOf('<h4>Time horizon</h4>'));
  assert.ok(entry.includes(`<p>${UNAVAILABLE}</p>`));
  assert.ok(!entry.includes(technical.SATELLITE_CAVEAT_NOTE));
  assert.doesNotMatch(entry, /UTC|observed|\d{2}:\d{2}/, 'no observation time when no frame was found');

  technical.setSatelliteImageryBriefing(null);
  assert.ok(!briefing().includes('Satellite imagery'), 'nothing while the plain map is a choice');

  // The wording is the briefing's own; the lazy satellite chunk only says which state the map is in.
  const satelliteSource = readFileSync(new URL('../src/map/satellite.ts', import.meta.url), 'utf8');
  assert.ok(!satelliteSource.includes('Context only'));
  assert.doesNotMatch(satelliteSource, /from '\.\.\/ui\/map-technical-information'/);
});
