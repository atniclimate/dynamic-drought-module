// Live fuel moisture: the byte-range raster reader (src/util/cog.ts), the
// publisher's list and the area and tile reads built on it
// (src/util/live-fuel-moisture-read.ts), the briefing's sentences
// (src/impact/live-fuel-moisture.ts) and the console's ground choice
// (src/state/fire3d-ground-layers.ts). Every network answer is a stand-in
// built by tests/lfmc-fixture.mjs; nothing here reaches the publisher.

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { LFMC_NO_DATA, buildLfmcCog, lfmcFetch, lfmcList, lfmcListRow } from './lfmc-fixture.mjs';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new globalThis.URL(specifier + '.ts', context.parentURL)))) {
    return nextResolve(specifier + '.ts', context);
  }
  return nextResolve(specifier, context);
} });

const cog = await import('../src/util/cog.ts');
const read = await import('../src/util/live-fuel-moisture-read.ts');
const impact = await import('../src/impact/live-fuel-moisture.ts');
const config = await import('../src/config/live-fuel-moisture.ts');

const BASE = 'https://valpamp.github.io/eosial-lfmc-data/';
const LIMITS = { timeoutMs: 2_000, maxHeaderBytes: 65_536, maxTileBytes: 65_536 };

// A 64 x 48 cell map with its north-west corner at 120 W, 48 N and 0.01 degree
// cells, and two coarser copies that keep every second and every fourth cell
// (nearest neighbour, as the publisher builds them). Each cell's value is
// 50 + column + row, except an empty 8 x 8 block in the north-west corner.
const WEST = -120;
const NORTH = 48;
const PIXEL = 0.01;
const full = (col, row) => (col < 8 && row < 8 ? LFMC_NO_DATA : 50 + col + row);
const LEVELS = [
  { width: 64, height: 48, value: full },
  { width: 32, height: 24, value: (col, row) => full(col * 2, row * 2) },
  { width: 16, height: 12, value: (col, row) => full(col * 4, row * 4) }
];
const raster = (overrides = {}) => buildLfmcCog({ west: WEST, north: NORTH, pixel: PIXEL, levels: LEVELS, ...overrides });
const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  read.clearLfmcCaches();
  try { await run(); } finally { globalThis.fetch = original; read.clearLfmcCaches(); }
}

test('the header gives the grid, every level and the no-data value', () => {
  const grid = cog.parseCogHeader(arrayBuffer(raster()));
  assert.deepEqual(grid.levels.map((l) => [l.width, l.height, l.tileWidth, l.tileOffsets.length]), [[64, 48, 16, 12], [32, 24, 16, 4], [16, 12, 16, 1]]);
  assert.equal(grid.noData, LFMC_NO_DATA);
  const [west, south, east, north] = cog.cogBounds(grid);
  assert.deepEqual([west, north], [WEST, NORTH]);
  assert.ok(Math.abs(east - (WEST + 0.64)) < 1e-9 && Math.abs(south - (NORTH - 0.48)) < 1e-9);
  // The coarsest level with at least one source cell per requested cell.
  assert.equal(cog.cogLevelFor(grid, 0.01, 0.01), 0);
  assert.equal(cog.cogLevelFor(grid, 0.025, 0.025), 1);
  assert.equal(cog.cogLevelFor(grid, 1, 1), 2);
});

test('a prefix that stops short says how many bytes it needs instead of guessing', () => {
  const bytes = raster();
  const short = cog.parseCogHeader(arrayBuffer(bytes.subarray(0, 100)));
  assert.ok(!('levels' in short) && short.needBytes > 100 && short.needBytes <= bytes.length);
});

test('a file of any other kind is refused, never half-read', () => {
  const refused = [
    ['big-endian', raster({ byteOrder: 0x4d4d })],
    ['BigTIFF', raster({ magic: 43 })],
    ['LZW compression', raster({ overrides: { 259: [5] } })],
    ['8-bit samples', raster({ overrides: { 258: [8] } })],
    ['a predictor', raster({ overrides: { 317: [2], 259: [8] } })],
    ['a projected grid', raster({ overrides: { 34735: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32610] } })],
    ['a tiepoint off the corner', raster({ overrides: { 33922: [5, 0, 0, WEST, NORTH, 0] } })],
    ['tile tables that do not match', raster({ overrides: { 325: [1, 2, 3] } })]
  ];
  for (const [name, bytes] of refused) {
    assert.throws(() => cog.parseCogHeader(arrayBuffer(bytes)), cog.CogFormatError, name);
  }
  // No predictor (1) is the plain case and parses.
  assert.ok('levels' in cog.parseCogHeader(arrayBuffer(raster({ overrides: { 317: [1] } }))));
});

test('a place costs one header read and one tile read, by exact byte range', async () => {
  const bytes = raster();
  const log = [];
  await withFetch(lfmcFetch(BASE, { 'map.tif': bytes }, log), async () => {
    const grid = await cog.openCog(`${BASE}map.tif`, null, LIMITS);
    assert.equal(log.length, 1);
    assert.match(log[0][1], /^bytes=0-\d+$/);
    // Cell (20, 10): 119.795 W, 47.895 N.
    assert.equal(await cog.readCogPoint(`${BASE}map.tif`, grid, -119.795, 47.895, null, LIMITS), 80);
    assert.equal(log.length, 2);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(log[1][1]).map(Number);
    assert.equal(start, grid.levels[0].tileOffsets[1]);
    assert.equal(end - start + 1, grid.levels[0].tileByteCounts[1]);
    // The empty corner block is "no value", and a place off the map asks nothing.
    assert.equal(await cog.readCogPoint(`${BASE}map.tif`, grid, -119.995, 47.995, null, LIMITS), null);
    const before = log.length;
    assert.equal(await cog.readCogPoint(`${BASE}map.tif`, grid, -110, 47.9, null, LIMITS), null);
    assert.equal(log.length, before);
  });
});

test('a server that ignores the range, or a damaged tile, is a failure and not a value', async () => {
  const bytes = raster();
  const grid = cog.parseCogHeader(arrayBuffer(bytes));
  await withFetch(async () => new Response(bytes.subarray(0, 4000), { status: 200 }), async () => {
    await assert.rejects(cog.openCog(`${BASE}map.tif`, null, LIMITS), cog.CogTransportError);
  });
  // The right byte count, but not a Deflate stream.
  await withFetch(async (url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range')).map(Number);
    return new Response(Buffer.alloc(end - start + 1, 7), { status: 206 });
  }, async () => {
    await assert.rejects(cog.readCogTile(`${BASE}map.tif`, grid, 0, 1, 1, null, LIMITS), cog.CogFormatError);
  });
});

test('the publisher\'s list: unusable rows are skipped, addresses stay in its folder, oldest first', () => {
  const rows = [
    lfmcListRow('2026-10-08', '2026-10-16', 90),
    lfmcListRow('2026-09-30', '2026-10-08', 100),
    { ...lfmcListRow('2026-10-16', '2026-10-24'), encoding: 'float32-v2' },
    { ...lfmcListRow('2026-10-24', '2026-11-01'), raster: 'cogs/2026/10/../../../elsewhere.tif' },
    { ...lfmcListRow('2026-11-01', '2026-11-09'), raster: 'https://example.test/cogs/2026/11/x.tif' },
    { ...lfmcListRow('2026-11-09', '2026-11-09') },
    'not a row'
  ];
  const maps = read.parseLfmcManifest(lfmcList(rows), `${BASE}manifest.json`);
  assert.deepEqual(maps.map((m) => m.start), ['2026-09-30', '2026-10-08']);
  assert.ok(maps.every((m) => m.url.startsWith(`${BASE}cogs/`)));
  assert.deepEqual(maps.map((m) => m.validCells), [100, 90]);
  assert.throws(() => read.parseLfmcManifest({ schema: 'something-else', composites: rows }, `${BASE}manifest.json`));
  assert.throws(() => read.parseLfmcManifest(lfmcList([rows[2]]), `${BASE}manifest.json`));
});

test('a list longer than the cap keeps its newest maps, whatever order it is written in', () => {
  const day = (n) => new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  const long = Array.from({ length: 450 }, (_, i) => lfmcListRow(day(i * 8), day(i * 8 + 8), 100));
  const cap = config.LFMC_LIMITS.maxComposites;
  for (const list of [long, [...long].reverse()]) {
    const maps = read.parseLfmcManifest(lfmcList(list), `${BASE}manifest.json`);
    assert.equal(maps.length, cap);
    assert.equal(maps[maps.length - 1].start, day(449 * 8));
    assert.equal(maps[0].start, day((450 - cap) * 8));
  }
});

test('the layer draws the newest map that is at least half as full as the fullest', () => {
  const maps = (cells) => read.parseLfmcManifest(lfmcList(cells.map((n, i) =>
    lfmcListRow(`2026-10-0${i + 1}`, `2026-10-0${i + 2}`, n))), `${BASE}manifest.json`);
  assert.equal(read.chooseLayerComposite(maps([100, 90, 14])).start, '2026-10-02');
  assert.equal(read.chooseLayerComposite(maps([100, 90, 50])).start, '2026-10-03');
  assert.equal(read.chooseLayerComposite(maps([10, 0, 0])).start, '2026-10-01');
  const uncounted = maps([100, 90, 14]).map((m) => ({ ...m, validCells: null }));
  assert.equal(read.chooseLayerComposite(uncounted).start, '2026-10-03');
});

test('dates, quantiles and the box read for a place', () => {
  assert.equal(read.lfmcDateSpan('2026-10-16', '2026-10-24'), 'Oct 16 to 23, 2026');
  assert.equal(read.lfmcDateSpan('2026-09-30', '2026-10-08'), 'Sep 30 to Oct 7, 2026');
  assert.equal(read.lfmcDateSpan('2026-12-27', '2027-01-04'), 'Dec 27, 2026 to Jan 3, 2027');
  assert.equal(read.quantile([10, 20, 30, 40], 0.5), 25);
  assert.equal(read.quantile([10, 20, 30, 40, 50], 0.25), 20);
  assert.equal(read.quantile([7], 0.75), 7);
  // An outline's own box is used as it is; a bare point gets a square about ten kilometres across.
  assert.deepEqual(read.lfmcBoxFor({ lng: -119, lat: 47 }, [-119.5, 46.5, -118.5, 47.5]), [-119.5, 46.5, -118.5, 47.5]);
  const [w, s, e, n] = read.lfmcBoxFor({ lng: -119, lat: 47 }, undefined);
  assert.ok(Math.abs((n - s) * 111.32 - 10) < 0.01);
  assert.ok(Math.abs((e - w) * 111.32 * Math.cos((47 * Math.PI) / 180) - 10) < 0.01);
});

test('an area reading is the median and middle half of the cells inside it', async () => {
  const log = [];
  await withFetch(lfmcFetch(BASE, { 'map.tif': raster() }, log), async () => {
    const url = `${BASE}map.tif`;
    // Columns 20 to 29, rows 10 to 19: one hundred cells, all with a value.
    const box = [WEST + 0.2, NORTH - 0.2, WEST + 0.3, NORTH - 0.1];
    const values = [];
    for (let row = 10; row < 20; row += 1) for (let col = 20; col < 30; col += 1) values.push(full(col, row));
    values.sort((a, b) => a - b);
    const reading = await read.readLfmcArea(url, box, null, null);
    assert.equal(reading.cells, 100);
    assert.equal(reading.cellsWithValue, 100);
    assert.deepEqual([reading.q25, reading.median, reading.q75],
      [read.quantile(values, 0.25), read.quantile(values, 0.5), read.quantile(values, 0.75)]);

    // The same box with a triangular outline keeps only the cells whose centre is inside it.
    const triangle = { type: 'Polygon', coordinates: [[[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[0], box[1]]]] };
    const inside = await read.readLfmcArea(url, box, triangle, null);
    assert.ok(inside.cells > 30 && inside.cells < 60, `cells ${inside.cells}`);

    // The empty corner: the map reaches the place and has nothing to say there.
    const empty = await read.readLfmcArea(url, [WEST, NORTH - 0.08, WEST + 0.08, NORTH], null, null);
    assert.equal(empty.cells, 64);
    assert.equal(empty.cellsWithValue, 0);

    // Off the map entirely: null, and no request made for it.
    const before = log.length;
    assert.equal(await read.readLfmcArea(url, [-100, 30, -99, 31], null, null), null);
    assert.equal(log.length, before);
  });
});

test('a large area is read from a coarser copy of the map', async () => {
  // A wider stand-in: 512 x 384 cells, so a box across all of it exceeds the read's width at full resolution.
  const wide = (col, row) => 60 + ((col + row) % 40);
  const bytes = buildLfmcCog({
    west: WEST, north: NORTH, pixel: PIXEL, tile: 64,
    levels: [0, 1, 2].map((level) => ({
      width: 512 >> level, height: 384 >> level, value: (col, row) => wide(col << level, row << level)
    }))
  });
  const log = [];
  await withFetch(lfmcFetch(BASE, { 'wide.tif': bytes }, log), async () => {
    const reading = await read.readLfmcArea(`${BASE}wide.tif`, [WEST, NORTH - 3.84, WEST + 5.12, NORTH], null, null);
    // 512 cells across is more than the 128 the read allows, so it steps to the copy with every fourth cell.
    assert.equal(reading.cells, 128 * 96);
    assert.ok(Math.abs(reading.cellKm - 0.04 * 111.32 * Math.cos((46.08 * Math.PI) / 180)) < 1e-6);
    // One header read, then only tiles of that copy (128 x 96 cells in 64-cell tiles: four).
    assert.equal(log.length, 1 + 4);
  });
});

const row = (start, end, cellsWithValue, median, cells = 100) => ({
  map: { start, endExclusive: end, modelVersion: 'v01', url: `${BASE}${start}.tif`, validCells: null },
  reading: cellsWithValue === null ? null
    : { median, q25: median - 10, q75: median + 5, cells, cellsWithValue, cellKm: 0.41 }
});

test('only maps that cover a like share of the place are compared', () => {
  const rows = [
    row('2026-09-30', '2026-10-08', 100, 96),
    row('2026-10-08', '2026-10-16', 100, 91),
    row('2026-10-16', '2026-10-24', 98, 92),
    row('2026-10-24', '2026-11-01', 45, 60),
    row('2026-11-01', '2026-11-09', 0, Number.NaN)
  ];
  assert.deepEqual(impact.comparableReadings(rows).map((r) => r.map.start), ['2026-09-30', '2026-10-08', '2026-10-16']);
  // Fewer cells than the floor never make a statement, however complete they are relative to each other.
  assert.deepEqual(impact.comparableReadings([row('2026-10-16', '2026-10-24', 4, 80, 4)]), []);
});

test('the briefing states the newest comparable map, an earlier one beside it, and their dates', () => {
  const rows = [
    row('2026-09-30', '2026-10-08', 100, 96),
    row('2026-10-08', '2026-10-16', 100, 91),
    row('2026-10-16', '2026-10-24', 98, 92),
    row('2026-10-24', '2026-11-01', 45, 60),
    row('2026-11-01', '2026-11-09', 0, Number.NaN)
  ];
  const [claim, ...rest] = impact.buildLfmcClaims(rows, 'across Example Reservation', 'Example Reservation', '2026-11-21');
  assert.equal(rest.length, 0);
  assert.equal(claim.text,
    'Live fuel moisture across Example Reservation: about 92 percent of dry mass, with the middle half of the area ' +
    'between 82 and 97, in the satellite-based estimate for Oct 16 to 23, 2026. In the estimate for Sep 30 to Oct 7, 2026 ' +
    'it was about 96. Lower values mean drier living plants.');
  assert.equal(claim.evidence, 'modeled-analysis');
  assert.equal(claim.product, 'live-fuel-moisture');
  assert.deepEqual(claim.dates, { valid: '2026-10-23', retrieved: '2026-11-21' });
  assert.match(claim.support.effective, /^median of the 98 cells with a value, of 100 read, each about 400 m wide; computed by DDM from EOSIAL Laboratory maps$/);
  assert.match(claim.chartSvg, /Live fuel moisture across Example Reservation, median percent of dry mass, Sep 30 to Oct 23, 2026/);
  assert.equal(claim.uncertainty.kind, 'not-quantified');
  assert.equal(claim.method.basis, config.LFMC_TEXT.modelNote);
  assert.match(claim.chartSvg, /<svg/);
  // No trend word, danger level or threshold is ever stated.
  assert.doesNotMatch(claim.text, /critical|danger|extreme|rising|falling|trend/i);
});

test('one comparable map states no earlier value and draws no chart; none states the absence; no map, nothing', () => {
  const [single] = impact.buildLfmcClaims([row('2026-10-16', '2026-10-24', 98, 92)], 'within about 5 km of the selected point', 'a square', '2026-11-21');
  assert.doesNotMatch(single.text, /In the estimate for/);
  assert.equal(single.chartSvg, undefined);

  const [absent] = impact.buildLfmcClaims(
    [row('2026-10-24', '2026-11-01', 0, Number.NaN), row('2026-11-01', '2026-11-09', 0, Number.NaN)],
    'across Example Reservation', 'Example Reservation', '2026-11-21');
  assert.match(absent.text, /^No live fuel moisture estimate across Example Reservation in the 2 newest maps \(Oct 24 to Nov 8, 2026\)\./);
  assert.match(absent.text,
    /\(Oct 24 to Nov 8, 2026\)\. A cell has no value where the publisher's model made no estimate: land it does not treat as grass, shrub or tree, or satellite input that was missing or screened out\. No value is not zero\.$/);
  assert.deepEqual(absent.dates, { retrieved: '2026-11-21' });

  assert.deepEqual(impact.buildLfmcClaims([row('2026-11-01', '2026-11-09', null, 0)], 'x', 'x', '2026-11-21'), []);
  // Valued cells below the statement floor are not an absence: a small place, every cell valued,
  // and a large one with two valued cells both state nothing rather than "no estimate".
  assert.deepEqual(impact.buildLfmcClaims([row('2026-10-16', '2026-10-24', 4, 80, 4)], 'x', 'x', '2026-11-21'), []);
  assert.deepEqual(impact.buildLfmcClaims(
    [row('2026-10-24', '2026-11-01', 0, Number.NaN), row('2026-11-01', '2026-11-09', 2, 70)], 'x', 'x', '2026-11-21'), []);
  // A place too small to hold a cell centre was not read, so nothing is said about it.
  assert.deepEqual(impact.buildLfmcClaims([row('2026-10-16', '2026-10-24', 0, Number.NaN, 0)], 'x', 'x', '2026-11-21'), []);
});

test('a place reaching past the maps\' area is named as the part the maps cover', () => {
  const [west, south, , north] = config.LFMC_COVERAGE;
  assert.deepEqual(impact.lfmcPlaceWording('Washington', [-124.8, 45.5, -116.9, 49.0]),
    { where: 'across Washington', reporting: 'Washington' });
  // Oklahoma runs from about 103.0 W to 94.4 W: only its panhandle's west end is on the maps.
  assert.deepEqual(impact.lfmcPlaceWording('Oklahoma', [-103.0, 33.6, -94.4, 37.0]),
    { where: 'across the part of Oklahoma the maps cover', reporting: 'the part of Oklahoma inside the maps\' area' });
  for (const box of [[west - 1, 40, -120, 42], [-120, south - 1, -119, 40], [-120, 50, -119, north + 1]]) {
    assert.match(impact.lfmcPlaceWording('X', box).where, /^across the part of X the maps cover$/);
  }
  assert.match(impact.lfmcPlaceWording('X', null).where, /^within about 5 km of the selected point$/);
});

test('the briefing lane reads the list and the newest maps, and says nothing where the maps cannot reach', async () => {
  const files = { 'manifest.json': lfmcList([lfmcListRow('2026-10-16', '2026-10-24', 100, 'a.tif'), lfmcListRow('2026-10-24', '2026-11-01', 100, 'b.tif')]) };
  files['cogs/2026/10/a.tif'] = raster();
  files['cogs/2026/10/b.tif'] = raster();
  const log = [];
  const place = (lng, lat, bbox) => ({ title: 'Example Reservation', lngLat: { lng, lat }, ...(bbox ? { bbox } : {}) });
  await withFetch(lfmcFetch(BASE, files, log), async () => {
    const signal = new AbortController().signal;
    const result = await impact.fetchLiveFuelMoistureClaims(place(-119.7, 47.8, [WEST + 0.2, NORTH - 0.2, WEST + 0.3, NORTH - 0.1]), signal);
    assert.equal(result.ok, true);
    assert.equal(result.claims.length, 1);
    assert.match(result.claims[0].text, /^Live fuel moisture across Example Reservation: about \d+ percent of dry mass/);

    // Inside the publisher's box but off these two rasters: the maps do not reach it, so nothing is stated.
    const elsewhere = await impact.fetchLiveFuelMoistureClaims(place(-110, 40), signal);
    assert.deepEqual(elsewhere, { ok: true, claims: [] });

    // Outside the publisher's box altogether: no request at all.
    const before = log.length;
    assert.deepEqual(await impact.fetchLiveFuelMoistureClaims(place(-90, 40), signal), { claims: [], ok: true });
    assert.equal(log.length, before);
  });
  // A list that cannot be read is a note, never a missing-value sentence.
  await withFetch(async () => new Response('gone', { status: 503 }), async () => {
    const failed = await impact.fetchLiveFuelMoistureClaims(place(-119.7, 47.8), new AbortController().signal);
    assert.equal(failed.ok, false);
    assert.equal(failed.claims.length, 0);
    assert.equal(failed.note, 'The live fuel moisture maps did not respond.');
  });
});

test('a map tile takes each pixel from the cell under it and leaves an empty cell transparent', async () => {
  await withFetch(lfmcFetch(BASE, { 'map.tif': raster() }, []), async () => {
    const url = `${BASE}map.tif`;
    const z = 9;
    const size = 256;
    const tileOf = (lon, lat) => {
      const n = 2 ** z;
      const rad = (lat * Math.PI) / 180;
      return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)];
    };
    const pixelOf = (lon, lat, x, y) => {
      const n = 2 ** z;
      const rad = (lat * Math.PI) / 180;
      return [Math.floor((((lon + 180) / 360) * n - x) * size), Math.floor((((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n - y) * size)];
    };
    // The centre of cell (40, 30), which holds 120, and of the empty cell (3, 3).
    const filled = [WEST + 40.5 * PIXEL, NORTH - 30.5 * PIXEL];
    const [x, y] = tileOf(...filled);
    const pixels = await read.renderLfmcTile(url, z, x, y, size, 'issuer', null);
    const [px, py] = pixelOf(...filled, x, y);
    assert.deepEqual([...pixels.subarray((py * size + px) * 4, (py * size + px) * 4 + 4)], [...read.lfmcColor(120, 'issuer')]);

    const empty = [WEST + 3.5 * PIXEL, NORTH - 3.5 * PIXEL];
    const [ex, ey] = tileOf(...empty);
    const emptyPixels = await read.renderLfmcTile(url, z, ex, ey, size, 'ground', null);
    const [epx, epy] = pixelOf(...empty, ex, ey);
    assert.equal(emptyPixels[(epy * size + epx) * 4 + 3], 0);

    // A tile nowhere near the map is not drawn at all.
    assert.equal(await read.renderLfmcTile(url, z, 0, 0, size, 'issuer', null), null);
  });
});

test('colours: the publisher\'s scale end to end, and white that deepens as the value falls', () => {
  assert.deepEqual([...read.lfmcColor(30, 'issuer')], [0x64, 0x28, 0x09, 255]);
  assert.deepEqual([...read.lfmcColor(0, 'issuer')], [0x64, 0x28, 0x09, 255]);
  assert.deepEqual([...read.lfmcColor(100, 'issuer')], [0xa1, 0xd9, 0x9b, 255]);
  assert.deepEqual([...read.lfmcColor(250, 'issuer')], [0x00, 0x44, 0x1b, 255]);
  assert.deepEqual([...read.lfmcColor(900, 'issuer')], [0x00, 0x44, 0x1b, 255]);
  const alpha = (value) => read.lfmcColor(value, 'ground')[3];
  assert.deepEqual([30, 31, 60, 61, 100, 101, 150, 151, 200, 201].map(alpha), [102, 84, 84, 65, 65, 47, 47, 29, 29, 10]);
  assert.ok([...read.lfmcColor(75, 'ground')].slice(0, 3).every((c) => c === 255));
  // Every class is labelled, driest first, and the alphas only fall.
  const classes = config.LFMC_GROUND_CLASSES;
  assert.ok(classes.every((c, i) => i === 0 || (c.alpha < classes[i - 1].alpha && c.upTo > classes[i - 1].upTo)));
});

test('the publisher\'s coverage box decides, without the network, what can be covered', () => {
  assert.equal(config.lfmcCovers([-119.5, 47, -119.4, 47.1]), true);
  assert.equal(config.lfmcCovers([-150, 60, -149, 61]), false);
  assert.equal(config.lfmcCovers([-90, 40, -89, 41]), false);
  assert.equal(config.lfmcCovers([-102, 28, -100, 30]), true);
});

test('plant stress and live fuel moisture are a choice: turning one on turns the other off first', async () => {
  const ground = await import('../src/state/fire3d-ground-layers.ts');
  const state = () => ['plantStress', 'fuelRisk', 'liveFuelMoisture'].map(ground.getFire3DGroundLayer);
  assert.deepEqual(state(), [true, true, false]);
  const changes = [];
  const release = ground.onFire3DGroundLayerChange((layer) => changes.push([layer, ...state()]));
  ground.setFire3DGroundLayer('liveFuelMoisture', true);
  ground.setFire3DGroundLayer('fuelRisk', false);
  ground.setFire3DGroundLayer('plantStress', true);
  ground.setFire3DGroundLayer('plantStress', true);
  ground.setFire3DGroundLayer('liveFuelMoisture', false);
  release();
  // No listener ever sees both grounds on, and fuel risk moves only when asked.
  assert.deepEqual(changes, [
    ['plantStress', false, true, false],
    ['liveFuelMoisture', false, true, true],
    ['fuelRisk', false, false, true],
    ['liveFuelMoisture', false, false, false],
    ['plantStress', true, false, false]
  ]);
  ground.setFire3DGroundLayer('fuelRisk', true);
  assert.deepEqual(state(), [true, true, false]);
});
