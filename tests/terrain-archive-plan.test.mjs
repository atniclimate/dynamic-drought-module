import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { tileIdToZxy } from 'pmtiles';
import {
  NATIONAL_TERRAIN_BOXES, S3_PREFIX, parseListing, selectCells, cellBounds, cellName, cellsForTile, rectangleIds,
  assemblyIds, planJobs, overviewJobs, modificationsSentence, pointInTile, readPoint, parseArgs, runCommand, unionOf, transport,
  tileSeamShare, cellSeamRatios, receiptPicks
} from '../scripts/build-terrain-archive.mjs';
import { Readable } from 'node:stream';
import { tileRangeForBounds, tileBounds, terrariumPng, decodeTerrariumTile } from '../scripts/lib/raster-dem-to-pmtiles.mjs';
import { zxyToTileId } from '../scripts/lib/pmtiles-writer.mjs';
import { terrainExpectations } from '../scripts/lib/terrain-archive-receipts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });

// The real n45w122 listing (2026-11-06), with the ChecksumAlgorithm CRC64NVME tags that broke a naive regex.
const contents = (key, etag, size) => `<Contents><Key>${key}</Key><LastModified>2026-02-02T23:00:15.000Z</LastModified>` +
  `<ETag>&quot;${etag}&quot;</ETag><ChecksumAlgorithm>CRC64NVME</ChecksumAlgorithm><ChecksumType>FULL_OBJECT</ChecksumType>` +
  `<Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
const LISTING = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
  `<Name>prd-tnm</Name><Prefix>${S3_PREFIX}</Prefix><KeyCount>5</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated>` +
  contents(S3_PREFIX + 'n45w122/USGS_1_n45w122.gpkg', '9930c92c76c6a89b8437f52d504eb7dc', 3780608) +
  contents(S3_PREFIX + 'n45w122/USGS_1_n45w122.jpg', '7cb78848f1acdb67f6cdf0324255096a', 8237) +
  contents(S3_PREFIX + 'n45w122/USGS_1_n45w122.tif', '446d1fa9a7c97c7dcebc5dbd9dc261e0', 52084241) +
  contents(S3_PREFIX + 'n45w122/USGS_1_n45w122.xml', '4e2b9818bcaacf4084756367372273d3', 13547) +
  contents(S3_PREFIX + 'n10w010/USGS_1_n10w010.tif', '00000000000000000000000000000000', 5) +
  '<NextContinuationToken>1abc/def==</NextContinuationToken></ListBucketResult>';

test('listing parse reads each field apart from the checksum tags, keeps only box-meeting cell DEMs', () => {
  const page = parseListing(LISTING);
  assert.equal(page.rows.length, 5);
  assert.equal(page.truncated, true);
  assert.equal(page.next, '1abc/def==');
  assert.deepEqual(page.rows[2], { key: S3_PREFIX + 'n45w122/USGS_1_n45w122.tif', size: 52084241,
    etag: '446d1fa9a7c97c7dcebc5dbd9dc261e0', lastModified: '2026-02-02T23:00:15.000Z' });
  const cells = selectCells(page.rows, NATIONAL_TERRAIN_BOXES);
  assert.deepEqual(cells.map(c => c.cell), ['n45w122']);
  assert.equal(cells[0].url, 'https://prd-tnm.s3.amazonaws.com/' + S3_PREFIX + 'n45w122/USGS_1_n45w122.tif');
});

test('cell names are north-west corners, both hemispheres', () => {
  assert.deepEqual(cellBounds('n45w122'), [-122, 44, -121, 45]);
  assert.deepEqual(cellBounds('s14w171'), [-171, -15, -170, -14]);
  assert.equal(cellName(-122, 45), 'n45w122');
  assert.equal(cellName(-171, -14), 's14w171');
  assert.throws(() => cellBounds('n45w12'), /Invalid cell/);
});

test('tile to cells: four at a cell corner, one where a tile only touches the next cell', () => {
  const all = { get: name => ({ name }) };
  const corner = pointInTile(-122, 45, 10);
  assert.deepEqual(cellsForTile(10, corner.x, corner.y, all).map(c => c.name).sort(), ['n45w122', 'n45w123', 'n46w122', 'n46w123']);
  // z10 x 127 ends exactly on -135: without the inset it would also claim the w135 cells.
  const [, s, e, n] = tileBounds(10, 127, 200);
  assert.equal(e, -135);
  assert.ok(Math.floor(n) === Math.floor(s), 'fixture tile stays inside one latitude band');
  assert.deepEqual(cellsForTile(10, 127, 200, all).map(c => c.name), [cellName(-136, Math.floor(n) + 1)]);
  const only = new Map([['n45w122', { name: 'n45w122' }]]);
  assert.deepEqual(cellsForTile(10, corner.x, corner.y, only).map(c => c.name), ['n45w122']);
});

test('rectangle ids match tileRangeForBounds and ascend; assembly covers every zoom', () => {
  const union = unionOf(NATIONAL_TERRAIN_BOXES);
  assert.deepEqual(union, [-179.3, -14.7, -64.4, 71.5]);
  for (const z of [0, 3, 7]) {
    const r = tileRangeForBounds(union, z), ids = rectangleIds(union, z);
    assert.equal(ids.length, (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1));
    assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]));
    assert.ok(ids.every(id => { const [zz, x, y] = tileIdToZxy(id); return zz === z && x >= r.xMin && x <= r.xMax && y >= r.yMin && y <= r.yMax; }));
  }
  const ids = assemblyIds(NATIONAL_TERRAIN_BOXES, 0, 7);
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]));
  assert.equal(ids.length, [0, 1, 2, 3, 4, 5, 6, 7].reduce((a, z) => a + rectangleIds(union, z).length, 0));
});

test('plan: land jobs only where a cell lies, strictly sorted, exactly one ocean job', () => {
  const boxes = [{ west: -122.5, south: 44.2, east: -120.5, north: 44.8 }];
  const index = new Map([['n45w122', { path: 'C:/m/a.tif', sha256: 'a'.repeat(64) }]]);
  const jobs = planJobs(boxes, [10], index);
  const ids = jobs.map(j => zxyToTileId(j.z, j.x, j.y));
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]));
  assert.equal(jobs.filter(j => j.kind === 'ocean').length, 1);
  const land = jobs.filter(j => j.kind === 'land');
  assert.ok(land.length > 0);
  for (const job of land) {
    const [w, , e] = tileBounds(job.z, job.x, job.y);
    assert.ok(w < -121 && e > -122, 'every land tile meets the one mirrored cell');
    assert.deepEqual(job.sources, [{ path: 'C:/m/a.tif', sha256: 'a'.repeat(64) }]);
  }
  const ocean = jobs.find(j => j.kind === 'ocean');
  assert.deepEqual(cellsForTile(ocean.z, ocean.x, ocean.y, index), []);
});

test('overview: parents of non-zero children only, four sources NW NE SW SE, zero-padded', () => {
  const zero = { tileId: 1, path: 'C:/s/zero.png', sha256: '0'.repeat(64) };
  const rec = (x, y, s) => [zxyToTileId(10, x, y), { tileId: zxyToTileId(10, x, y), path: `C:/s/${x}-${y}.png`, sha256: s.repeat(64) }];
  const children = new Map([rec(10, 20, 'a'), rec(11, 21, 'b'), rec(40, 40, '0')]);
  const jobs = overviewJobs(9, children, zero);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].z, jobs[0].x, jobs[0].y, jobs[0].kind], [9, 5, 10, 'overview']);
  assert.deepEqual(jobs[0].sources.map(s => s.sha256[0]), ['a', '0', '0', 'b']);
  assert.deepEqual(jobs[0].sources[1], { path: zero.path, sha256: zero.sha256 });
  assert.throws(() => overviewJobs(8, children, zero), /outside level/);
});

test('metadata states which zooms are averaged and which are sampled, per archive', () => {
  assert.match(modificationsSentence(10), /z0 to z9 are 2x2 means of z10; z10 is sampled from the source;/);
  assert.match(modificationsSentence(11), /z0 to z9 are 2x2 means of z10; z10 to z11 are sampled from the source;/);
  // v2 samples at pixel centres; the v1 window method must not be named in the shipped metadata.
  assert.match(modificationsSentence(10), /by bilinear sampling at Web Mercator pixel centres,/);
  assert.doesNotMatch(modificationsSentence(11), /window/);
});

test('receipt picks: the zero-tile read and every deepest-zoom box survive the 20-sample cap nationally', () => {
  const present = new Set();
  for (let z = 0; z <= 11; z++) for (const box of NATIONAL_TERRAIN_BOXES) {
    const p = pointInTile((box.west + box.east) / 2, (box.south + box.north) / 2, z);
    present.add(zxyToTileId(z, p.x, p.y));
  }
  const sorted = [...present].sort((a, b) => a - b), picks = receiptPicks(sorted, NATIONAL_TERRAIN_BOXES, 11);
  assert.ok(picks.length > 20, 'the cap binds: ' + picks.length + ' picks');
  const kept = picks.slice(0, 20);
  assert.ok(!present.has(kept[0]), 'first read is a zero-filled id');
  for (let z = 0; z <= 11; z++) assert.ok(kept.some(id => tileIdToZxy(id)[0] === z), 'a sample at z' + z);
  for (const box of NATIONAL_TERRAIN_BOXES) assert.ok(kept.some(id => {
    const [z, x, y] = tileIdToZxy(id), [w, s, e, n] = tileBounds(z, x, y);
    return z === 11 && w < box.east && e > box.west && s < box.north && n > box.south;
  }), 'a z11 sample in box ' + JSON.stringify(box));
});

test('camera-independent point read: nearest is the containing pixel, bilinear uses pixel centres', () => {
  const values = new Float32Array(512 * 512);
  for (let r = 0; r < 512; r++) for (let c = 0; c < 512; c++) values[r * 512 + c] = c + 1000 * (r % 2);
  const decoded = decodeTerrariumTile(terrariumPng(values, 512, 512).data);
  assert.deepEqual(readPoint(decoded, 10.5, 4.5), { nearest: 10, bilinear: 10, max3: 1011 });
  assert.deepEqual(readPoint(decoded, 11.0, 4.5), { nearest: 11, bilinear: 10.5, max3: 1012 });
  assert.deepEqual(readPoint(decoded, 10.5, 5.0), { nearest: 1010, bilinear: 510, max3: 1011 });
  const p = pointInTile(-121.7996, 44.6743, 10);
  assert.deepEqual([p.x, p.y], [165, 369], 'Mount Jefferson sits in the z10 tile the dossier measured');
});

test('seam (b) flags a land step between tiles and ignores coast and no-data edges', () => {
  const tile = fill => decodeTerrariumTile(terrariumPng(Float32Array.from({ length: 512 * 512 }, (_, i) => fill(i % 512, Math.floor(i / 512))), 512, 512).data);
  const left = tile(c => 1000 + c), smooth = tile(c => 1512 + c), stepped = tile(c => 1900 + c), coast = tile(() => 0);
  assert.equal(tileSeamShare(left, smooth).share, 0);
  assert.equal(tileSeamShare(left, stepped).share, 1);
  assert.deepEqual(tileSeamShare(left, coast), { p99: 1, share: 0, rows: 0 });
});

test('seam (a) finds a step on the whole-degree column and nothing on smooth ground', () => {
  const [w, , e] = tileBounds(10, 164, 360);
  const at = c => w + (c + 0.5) / 512 * (e - w);
  const tile = jump => decodeTerrariumTile(terrariumPng(Float32Array.from({ length: 512 * 512 }, (_, i) =>
    1000 + (i % 512) + (at(i % 512) > -122 ? jump : 0)), 512, 512).data);
  const [stepped] = cellSeamRatios(tile(400), 10, 164, 360).filter(row => row.at === 'lon -122');
  assert.ok(stepped.ratio > 100, 'ratio ' + stepped.ratio);
  const [smooth] = cellSeamRatios(tile(0), 10, 164, 360).filter(row => row.at === 'lon -122');
  assert.equal(smooth.ratio, 1);
});

test('paths must be absolute and outside the checkout', () => {
  assert.throws(() => parseArgs(['render', '--root', 'relative/dir'], ROOT), /absolute/);
  assert.throws(() => parseArgs(['render', '--root', join(ROOT, 'out')], ROOT), /outside the checkout/);
  const opts = parseArgs(['render', '--root', join(tmpdir(), 'bake'), '--zooms', '10', '--cells', 'n45w122,n47w122'], ROOT);
  assert.deepEqual([opts.zooms, opts.cells, opts.run], [[10], ['n45w122', 'n47w122'], opts.root]);
  assert.equal(opts.decode, true, 'decoded checks are on by default');
  assert.equal(parseArgs(['verify-local', '--root', join(tmpdir(), 'bake'), '--decode', 'false'], ROOT).decode, false);
});

test('the driver boxes are the client boxes', async () => {
  const { NATIONAL_TERRAIN_BOXES: client } = await import('../src/config/terrain-coverage.ts');
  assert.deepEqual(client, NATIONAL_TERRAIN_BOXES);
});

/** Two synthetic 1 degree cells (NAD83 geographic, 60 px), the shape of a mirrored 3DEP cell. */
function syntheticCell(west, north, base) {
  const values = new Float32Array(60 * 60);
  for (let r = 0; r < 60; r++) for (let c = 0; c < 60; c++) values[r * 60 + c] = base + 10 * c + r;
  return Buffer.from(writeArrayBuffer(values, { width: 60, height: 60, BitsPerSample: [32], SampleFormat: [3],
    ModelPixelScale: [1 / 60, 1 / 60, 0], ModelTiepoint: [0, 0, 0, west, north, 0], GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4269 }));
}
test('end to end: fetch checks MD5, refuses a partial mirror, then render, pyramid, assemble, receipt and verify-local agree', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ddm-terrain-plan-'));
  const realOpen = transport.open, exitCode = process.exitCode;
  t.after(async () => { transport.open = realOpen; process.exitCode = exitCode; await rm(root, { recursive: true, force: true }); });
  const bodies = new Map(), cells = [];
  for (const [west, north, base] of [[-122, 45, 1000], [-121, 45, 1600]]) {
    const name = cellName(west, north), bytes = syntheticCell(west, north, base);
    const key = `${S3_PREFIX}${name}/USGS_1_${name}.tif`, url = 'https://prd-tnm.s3.amazonaws.com/' + key;
    bodies.set(url, bytes);
    cells.push({ cell: name, key, size: bytes.length, etag: createHash('md5').update(bytes).digest('hex'), lastModified: '2026-01-01T00:00:00.000Z', url });
  }
  transport.open = async url => Readable.from([bodies.get(url)]);
  // East of -120 no cell is mirrored, so the rectangle needs the zero tile there.
  const boxes = [{ west: -121.6, south: 44.3, east: -119.4, north: 44.7 }];
  const manifest = { retrieved: '2026-11-06T00:00:00.000Z', cells: [{ ...cells[0], etag: 'f'.repeat(32) }, cells[1]], lastModified: '2026-01-01T00:00:00.000Z' };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const base = { root, run: root, boxes, zooms: [10], workers: 2, streams: 2, maxZoom: 10, key: 'test-z10.pmtiles', decode: true };
  await runCommand({ ...base, command: 'fetch' });
  assert.equal(process.exitCode, 1, 'an MD5 mismatch fails the fetch');
  process.exitCode = exitCode;
  await assert.rejects(runCommand({ ...base, command: 'render' }), /Mirror incomplete/);
  manifest.cells[0] = cells[0];
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await runCommand({ ...base, command: 'fetch' });
  const receiptRow = JSON.parse(await readFile(join(root, 'src', 'n45w122', 'USGS_1_n45w122.tif.receipt.json'), 'utf8'));
  assert.equal(receiptRow.sha256, sha(bodies.get(cells[0].url)));
  assert.equal(receiptRow.md5Checked, true);
  for (const command of ['render', 'pyramid', 'assemble', 'receipt', 'verify-local']) await runCommand({ ...base, command });
  const report = JSON.parse(await readFile(join(root, 'logs', 'verify-test-z10.json'), 'utf8'));
  assert.deepEqual(report.failures, []);
  assert.equal(report.readBack.missing, 0);
  assert.equal(report.readBack.planned, assemblyIds(boxes, 0, 10).length);
  assert.equal(report.readBack.zeroTileLengths.length, 1, 'one zero tile everywhere');
  assert.equal(report.leafCount, 0);
  assert.ok(report.pyramidCheck.parents > 0 && report.pyramidCheck.failures === 0);
  const expected = JSON.parse(await readFile(join(root, 'out', 'test-z10.expected.json'), 'utf8'));
  const checked = terrainExpectations(expected, { maxSamples: 20, maxRangeBytes: 1048576, maxTotalBytes: 16777216 });
  assert.deepEqual(checked.bounds, unionOf(boxes));
  assert.equal(checked.maxZoom, 10);
  // Resume: every phase again reuses the store and leaves the archive alone.
  await runCommand({ ...base, command: 'render' });
  const phases = (await readFile(join(root, 'logs', 'phases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(phases.at(-1).rendered, 0);
  await runCommand({ ...base, command: 'assemble' });
  assert.ok((await readdir(join(root, 'out'))).includes('test-z10.pmtiles'));
});

test('verify-local fails below -100 m and on skipped decoded checks; assemble refuses a partial archive', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ddm-terrain-low-'));
  const realOpen = transport.open, exitCode = process.exitCode;
  t.after(async () => { transport.open = realOpen; process.exitCode = exitCode; await rm(root, { recursive: true, force: true }); });
  const bytes = syntheticCell(-122, 45, -300), key = `${S3_PREFIX}n45w122/USGS_1_n45w122.tif`; // -300 to +349 m
  const cell = { cell: 'n45w122', key, size: bytes.length, etag: createHash('md5').update(bytes).digest('hex'),
    lastModified: '2026-01-01T00:00:00.000Z', url: 'https://prd-tnm.s3.amazonaws.com/' + key };
  transport.open = async () => Readable.from([bytes]);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ retrieved: '2026-11-06T00:00:00.000Z', cells: [cell], lastModified: cell.lastModified }));
  const base = { root, run: root, boxes: [{ west: -121.9, south: 44.3, east: -120.6, north: 44.7 }], zooms: [10], workers: 2, streams: 1,
    maxZoom: 10, key: 'low-z10.pmtiles', decode: true };
  for (const command of ['fetch', 'render', 'pyramid']) await runCommand({ ...base, command });
  // A hard kill mid-assemble leaves the final path without its summary: resume must refuse, not skip.
  await writeFile(join(root, 'out', 'low-z10.pmtiles'), 'partial');
  await assert.rejects(runCommand({ ...base, command: 'assemble' }), /Partial archive present/);
  await rm(join(root, 'out', 'low-z10.pmtiles'));
  for (const command of ['assemble', 'receipt', 'verify-local']) await runCommand({ ...base, command });
  const reportPath = join(root, 'logs', 'verify-low-z10.json');
  let report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.readBack.missing + report.readBack.mismatched, 0);
  assert.ok(report.failures.some(f => /below -100 m: .*z10 \d+/.test(f)), JSON.stringify(report.failures));
  assert.equal(process.exitCode, 1);
  process.exitCode = exitCode;
  await runCommand({ ...base, command: 'verify-local', decode: false });
  report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.decoded, false);
  assert.ok(report.failures.some(f => /decoded checks skipped/.test(f)), JSON.stringify(report.failures));
  assert.equal(report.pyramidCheck, undefined);
});
