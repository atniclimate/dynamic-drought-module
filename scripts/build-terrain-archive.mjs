#!/usr/bin/env node
/**
 * National terrain archive driver: USGS 3DEP 1 arc-second, mirrored once, baked
 * once (elevation does not change on the product's time scale, so there is no
 * schedule and no refresh job). Every phase is resumable and idempotent, and
 * every path is explicit and absolute, outside the checkout.
 *
 *   manifest     anonymous S3 listing, pinned by ETag and LastModified
 *   fetch        mirror cells (MD5 against the single-part ETag, SHA-256 kept)
 *   render       native zooms through the receipt-keyed tile pool
 *   pyramid      z9 to z0 as 2x2 means of the level below
 *   assemble     one PMTiles archive from the store (zero tile fills the rectangle)
 *   receipt      expected.json in the format verify:terrain reads
 *   verify-local container, read-back, bounds, pyramid, seams, summit table
 *
 * This file is NOT in the tile receipt key (terrain-local-pool.mjs), so fixing it
 * mid-bake never invalidates tiles; the RECIPE string below is in the key.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, readdir, open, appendFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PMTiles, bytesToHeader, tileIdToZxy } from 'pmtiles';
import { tileRangeForBounds, tileBounds, buildRasterDemTileStore, decodeTerrariumTile } from './lib/raster-dem-to-pmtiles.mjs';
import { zxyToTileId } from './lib/pmtiles-writer.mjs';
import { writeTerrainPmtiles } from './lib/pmtiles-stream-writer.mjs';

/** The five claim boxes (brief section 5); must equal src/config/terrain-coverage.ts (tested). */
export const NATIONAL_TERRAIN_BOXES = [
  { west: -125.0, south: 24.4, east: -66.9, north: 49.5 },
  { west: -179.3, south: 51.1, east: -129.8, north: 71.5 },
  { west: -160.4, south: 18.8, east: -154.7, north: 22.4 },
  { west: -68.0, south: 17.7, east: -64.4, north: 18.7 },
  { west: -171.3, south: -14.7, east: -169.3, north: -10.9 }
];
export const S3_HOST = 'https://prd-tnm.s3.amazonaws.com';
export const S3_PREFIX = 'StagedProducts/Elevation/1/TIFF/current/';
export const RECIPE = 'USGS 3DEP 1 arc-second seamless DEM, current/ prefix mirrored and SHA-256 pinned; ' +
  'bilinear at Web Mercator pixel centres (source pixel centres at i + 0.5), source no-data to 0 m; ' +
  'whole-metre Terrarium PNG RGBA 512 px, deflate level 9 strategy 0 filter Up; overview = 2x2 mean of four decoded ' +
  'children in NW NE SW SE order, a missing child is the shared zero tile; v2';
export const ISSUER = 'USGS 3D Elevation Program';
const INSET = 0.0005;
const MiB = 1048576;
export const POOL_LIMITS = { jobTimeoutMs: 180000, maxJobs: 130000, maxSourcesPerTile: 4, maxSourceBytes: 96 * MiB,
  sourceReadBufferBytes: MiB, maxSourcePixels: 13100000, maxTileBytes: 600000, maxReceiptBytes: 4096 };

export const unionOf = boxes => [Math.min(...boxes.map(b => b.west)), Math.min(...boxes.map(b => b.south)),
  Math.max(...boxes.map(b => b.east)), Math.max(...boxes.map(b => b.north))];

/** `n45w122` -> [-122, 44, -121, 45]: the name is the north-west corner. */
export function cellBounds(name) {
  const m = /^([ns])(\d{2})([ew])(\d{3})$/.exec(name);
  if (!m) throw Error('Invalid cell name ' + name);
  const north = (m[1] === 'n' ? 1 : -1) * Number(m[2]), west = (m[3] === 'e' ? 1 : -1) * Number(m[4]);
  return [west, north - 1, west + 1, north];
}
export function cellName(west, north) {
  return (north >= 0 ? 'n' : 's') + String(Math.abs(north)).padStart(2, '0') +
    (west >= 0 ? 'e' : 'w') + String(Math.abs(west)).padStart(3, '0');
}
const meets = (a, b) => a[0] < b.east && a[2] > b.west && a[1] < b.north && a[3] > b.south;

/** S3 ListObjectsV2 XML: split on <Contents>, read each field separately (extra checksum tags are ignored). */
export function parseListing(xml) {
  const field = (chunk, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(chunk)?.[1];
  const rows = xml.split('<Contents>').slice(1).map(chunk => ({
    key: field(chunk, 'Key'), size: Number(field(chunk, 'Size')),
    etag: field(chunk, 'ETag')?.replace(/&quot;|"/g, ''), lastModified: field(chunk, 'LastModified')
  }));
  // IsTruncated and NextContinuationToken occur only at the top level, never inside <Contents>.
  return { rows, truncated: field(xml, 'IsTruncated') === 'true', next: field(xml, 'NextContinuationToken') };
}
/** The cell DEM objects whose footprint meets a box. */
export function selectCells(rows, boxes) {
  const pattern = new RegExp('^' + S3_PREFIX + '([ns]\\d{2}[ew]\\d{3})/USGS_1_([ns]\\d{2}[ew]\\d{3})\\.tif$');
  return rows.flatMap(row => {
    const m = pattern.exec(row.key);
    if (!m || m[1] !== m[2] || !boxes.some(box => meets(cellBounds(m[1]), box))) return [];
    return [{ cell: m[1], key: row.key, size: row.size, etag: row.etag, lastModified: row.lastModified, url: S3_HOST + '/' + row.key }];
  }).sort((a, b) => a.cell < b.cell ? -1 : 1);
}

/** Up to four cells under a tile, by integer degree, inset so overedge slivers are ignored. */
export function cellsForTile(z, x, y, cellIndex) {
  const [w, s, e, n] = tileBounds(z, x, y), out = [];
  for (let north = Math.floor(n - INSET) + 1; north >= Math.floor(s + INSET) + 1; north--) {
    for (let west = Math.floor(w + INSET); west <= Math.floor(e - INSET); west++) {
      const cell = cellIndex.get(cellName(west, north));
      if (cell) out.push(cell);
    }
  }
  return out;
}
/** Every id of a zoom inside the union rectangle, ascending. */
export function rectangleIds(bounds, z) {
  const r = tileRangeForBounds(bounds, z), ids = [];
  for (let x = r.xMin; x <= r.xMax; x++) for (let y = r.yMin; y <= r.yMax; y++) ids.push(zxyToTileId(z, x, y));
  return ids.sort((a, b) => a - b);
}
export const assemblyIds = (boxes, minZoom, maxZoom) => {
  const ids = [];
  // A loop, not push(...ids): z11 alone is about 443,000 ids, past the argument stack.
  for (let z = minZoom; z <= maxZoom; z++) for (const id of rectangleIds(unionOf(boxes), z)) ids.push(id);
  return ids;
};
/** Land jobs for every box tile that has a cell, plus one ocean job for the shared zero tile. */
export function planJobs(boxes, zooms, cellIndex) {
  const jobs = new Map();
  for (const z of zooms) for (const box of boxes) {
    const r = tileRangeForBounds([box.west, box.south, box.east, box.north], z);
    for (let x = r.xMin; x <= r.xMax; x++) for (let y = r.yMin; y <= r.yMax; y++) {
      const id = zxyToTileId(z, x, y);
      if (jobs.has(id)) continue;
      const cells = cellsForTile(z, x, y, cellIndex);
      if (cells.length) jobs.set(id, { z, x, y, kind: 'land', sources: cells.map(c => ({ path: c.path, sha256: c.sha256 })) });
    }
  }
  const zMax = Math.max(...zooms), zeroId = rectangleIds(unionOf(boxes), zMax).find(id => !jobs.has(id));
  const [z, x, y] = tileIdToZxy(zeroId);
  jobs.set(zeroId, { z, x, y, kind: 'ocean', sources: [] });
  return [...jobs.entries()].sort((a, b) => a[0] - b[0]).map(([, job]) => job);
}
/** Parents of level z with at least one non-zero child; four sources in quadrant order, zero-padded. */
export function overviewJobs(z, childRecords, zeroRecord) {
  const parents = new Set();
  for (const [id, rec] of childRecords) {
    if (rec.sha256 === zeroRecord.sha256) continue;
    const [cz, cx, cy] = tileIdToZxy(id);
    if (cz !== z + 1) throw Error('Child record outside level ' + (z + 1));
    parents.add(zxyToTileId(z, cx >> 1, cy >> 1));
  }
  return [...parents].sort((a, b) => a - b).map(id => {
    const [, x, y] = tileIdToZxy(id);
    const sources = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => {
      const rec = childRecords.get(zxyToTileId(z + 1, 2 * x + dx, 2 * y + dy)) ?? zeroRecord;
      return { path: rec.path, sha256: rec.sha256 };
    });
    return { z, x, y, kind: 'overview', sources };
  });
}
/** Exact metadata sentence for an archive whose native zooms are 10..maxZoom. */
export function modificationsSentence(maxZoom) {
  // DRAFT wording
  return 'reprojected to Web Mercator by bilinear sampling at Web Mercator pixel centres, rounded to whole meters, Terrarium PNG; ' +
    (maxZoom > 10 ? `z0 to z9 are 2x2 means of z10; z10 to z${maxZoom} are sampled from the source; `
      : 'z0 to z9 are 2x2 means of z10; z10 is sampled from the source; ') +
    'no datum conversion; no-data and ocean 0 m';
}

/** Summit points (dossier 8.3; EPQS references fetched 2026-11-06; Lake Superior from the ImageServer). */
export const SUMMITS = [
  ['Mount Jefferson OR', -121.7996, 44.6743, 3200.9], ['Mount Rainier WA', -121.7603, 46.8523, 4387.1],
  ['Mount Whitney CA', -118.2923, 36.5785, 4416.2], ['Mount Elbert CO', -106.4454, 39.1178, 4399.6],
  ['Mount Mitchell NC', -82.2652, 35.7650, 2036.8], ['Mount Washington NH', -71.3033, 44.2706, 1912.4],
  ['Denali AK', -151.0074, 63.0695, 6147.0], ['Mauna Kea HI', -155.4681, 19.8207, 4207.2],
  ['Badwater Basin CA', -116.8258, 36.2503, -84.9], ['Mount Sunflower KS', -102.0372, 39.0222, 1231.5],
  ['Lake Superior middle', -87.5, 47.6, 183.0]
];
/** Camera-independent read: the tile and in-tile pixel position of a point at zoom z (512 px tiles). */
export function pointInTile(lon, lat, z) {
  const n = 2 ** z * 512, px = (lon + 180) / 360 * n;
  const py = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  const x = Math.floor(px / 512), y = Math.floor(py / 512);
  return { x, y, col: px - x * 512, row: py - y * 512 };
}
/** Nearest is the pixel that contains the point; bilinear treats pixel centres as samples (clamped inside the tile). */
export function readPoint(decoded, col, row) {
  const at = (c, r) => decoded.elevationAtIndex(Math.min(511, Math.max(0, r)) * 512 + Math.min(511, Math.max(0, c)));
  const fx = col - 0.5, fy = row - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx, bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  const c = Math.floor(col), r = Math.floor(row);
  // Highest pixel within one pixel of the point: separates a reference coordinate's own error from the data's.
  let max3 = -Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) max3 = Math.max(max3, at(c + dx, r + dy));
  return { nearest: at(c, r), bilinear: Math.round((top * (1 - ty) + bottom * ty) * 10) / 10, max3 };
}

/**
 * Summit failures at the deepest zoom: a summit inside a box (and, for a --cells pilot, inside a baked
 * cell) with no row, or a row where both the bilinear read and the highest nearby pixel miss the
 * reference by over 100 m. The tolerance is an engineering call: the pilot v2 worst was 34 m (Whitney
 * z10); the defect it guards was 931 m (Jefferson).
 */
export function summitFailures(summits, boxes, maxZoom, cells) {
  const out = [];
  for (const [name, lon, lat] of SUMMITS) {
    if (!boxes.some(box => meets([lon, lat, lon, lat], box))) continue;
    if (cells && !cells.includes(cellName(Math.floor(lon), Math.floor(lat) + 1))) continue;
    const row = summits.find(s => s.name === name && s.z === maxZoom);
    if (!row) out.push(`summit ${name} has no row at z${maxZoom}`);
    else if (Math.abs(row.bilinearDelta) > 100 && Math.abs(row.max3 - row.ref) > 100) {
      out.push(`summit ${name} reads ${row.bilinear} m at z${maxZoom}, reference ${row.ref} m`);
    }
  }
  return out;
}

// ---- I/O phases -------------------------------------------------------------------------------

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);
async function writeJson(path, value) { await writeFile(path + '.tmp', JSON.stringify(value, null, 1) + '\n'); await rename(path + '.tmp', path); }

async function manifest({ root }) {
  const rows = [];
  let token;
  do {
    const url = `${S3_HOST}/?list-type=2&prefix=${encodeURIComponent(S3_PREFIX)}` + (token ? '&continuation-token=' + encodeURIComponent(token) : '');
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) throw Error('Listing HTTP ' + response.status);
    const page = parseListing(await response.text());
    rows.push(...page.rows);
    token = page.truncated ? page.next : undefined;
    if (page.truncated && !token) throw Error('Truncated listing without a continuation token');
  } while (token);
  const cells = selectCells(rows, NATIONAL_TERRAIN_BOXES);
  const doc = { retrieved: new Date().toISOString(), source: S3_HOST + '/' + S3_PREFIX, listed: rows.length,
    boxes: NATIONAL_TERRAIN_BOXES, cells, bytes: cells.reduce((a, c) => a + c.size, 0),
    lastModified: cells.map(c => c.lastModified).sort().at(-1) };
  await writeJson(join(root, 'manifest.json'), doc);
  log('manifest', JSON.stringify({ listed: rows.length, cells: cells.length, bytes: doc.bytes, lastModified: doc.lastModified }));
}

const cellPath = (root, row) => join(root, 'src', row.cell, basename(row.key));
async function cellReceipt(root, row) {
  try {
    const receipt = await readJson(cellPath(root, row) + '.receipt.json'), info = await stat(cellPath(root, row));
    if (receipt.etag === row.etag && receipt.size === row.size && info.size === row.size && info.mtimeMs === receipt.mtimeMs) return receipt;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return null;
}
/**
 * Cell bodies come through node:https, not fetch: on 2026-11-06 undici's
 * `assert(!this.paused)` crashed the whole mirror process (uncatchable) when a
 * socket ended under backpressure. Replaceable by tests.
 */
export const transport = {
  open: url => new Promise((resolveBody, reject) => {
    const request = https.get(url, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('HTTP ' + response.statusCode)); return; }
      resolveBody(response);
    });
    request.setTimeout(60000, () => request.destroy(Error('Download idle for 60 s')));
    request.on('error', reject);
  })
};
/** One cell: stream to .part with MD5 and SHA-256, check size and the single-part ETag, then rename. */
async function fetchCell(root, row) {
  const path = cellPath(root, row), part = path + '.part';
  await mkdir(join(root, 'src', row.cell), { recursive: true });
  const body = await transport.open(row.url);
  const md5 = createHash('md5'), sha = createHash('sha256');
  let bytes = 0;
  await pipeline(body, async function* (source) {
    for await (const chunk of source) { md5.update(chunk); sha.update(chunk); bytes += chunk.length; yield chunk; }
  }, createWriteStream(part, { flush: true }));
  const md5Hex = md5.digest('hex'), md5Checked = /^[a-f0-9]{32}$/.test(row.etag);
  if (bytes !== row.size) throw Error(`${row.cell} size ${bytes} != ${row.size}`);
  if (md5Checked && md5Hex !== row.etag) throw Error(`${row.cell} MD5 mismatch`);
  await rename(part, path);
  const receipt = { cell: row.cell, key: row.key, etag: row.etag, lastModified: row.lastModified, size: bytes, md5: md5Hex,
    md5Checked, sha256: sha.digest('hex'), mtimeMs: (await stat(path)).mtimeMs, fetched: new Date().toISOString() };
  await writeJson(path + '.receipt.json', receipt);
  return receipt;
}
async function fetchPhase({ root, cells, streams = 4 }) {
  const doc = await readJson(join(root, 'manifest.json'));
  let rows = doc.cells;
  if (cells) { rows = cells.map(name => doc.cells.find(r => r.cell === name) ?? (() => { throw Error('Cell not in manifest: ' + name); })()); }
  const started = Date.now(), summary = { cells: rows.length, fetched: 0, skipped: 0, bytes: 0, md5Mismatch: 0, md5Unchecked: 0, failed: [] };
  let cursor = 0;
  async function lane() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (await cellReceipt(root, row)) { summary.skipped++; continue; }
      let attempt = 0;
      for (;;) {
        try {
          const t = Date.now(), r = await fetchCell(root, row);
          summary.fetched++; summary.bytes += r.size; if (!r.md5Checked) summary.md5Unchecked++;
          log('fetched', row.cell, r.size, (Date.now() - t) + 'ms', `${summary.fetched + summary.skipped}/${rows.length}`);
          break;
        } catch (error) {
          if (/MD5 mismatch/.test(error.message)) summary.md5Mismatch++;
          if (++attempt >= 3) { summary.failed.push({ cell: row.cell, error: error.message }); log('FAILED', row.cell, error.message); break; }
          log('retry', row.cell, attempt, error.message);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(streams, rows.length) }, lane));
  summary.wallSeconds = (Date.now() - started) / 1000;
  await writeJson(join(root, 'logs', `fetch-summary-${Date.now()}.json`), summary);
  log('fetch done', JSON.stringify(summary));
  if (summary.failed.length) process.exitCode = 1;
}

/** Mirrored cells with valid receipts, keyed by name; refuses a partial national mirror. */
async function cellIndexFor(root, cells) {
  const doc = await readJson(join(root, 'manifest.json'));
  const rows = cells ? doc.cells.filter(r => cells.includes(r.cell)) : doc.cells;
  if (cells && rows.length !== cells.length) throw Error('Some --cells are not in the manifest');
  const index = new Map(), missing = [];
  for (const row of rows) {
    const receipt = await cellReceipt(root, row);
    if (!receipt) { missing.push(row.cell); continue; }
    index.set(row.cell, { name: row.cell, path: cellPath(root, row), sha256: receipt.sha256 });
  }
  if (missing.length) throw Error('Mirror incomplete: ' + missing.length + ' cells, first ' + missing.slice(0, 5).join(' '));
  return { index, doc };
}
async function render({ root, run, cells, zooms, workers, boxes }) {
  const { index } = await cellIndexFor(root, cells), jobs = planJobs(boxes, zooms, index);
  const started = Date.now();
  log('render', JSON.stringify({ zooms, jobs: jobs.length, cells: index.size, workers }));
  const result = await buildRasterDemTileStore({ storePath: join(run, 'store'), jobs, recipe: RECIPE, limits: { ...POOL_LIMITS, workers } });
  const zero = result.records[jobs.findIndex(j => j.kind === 'ocean')];
  await writeJson(join(run, 'zero.json'), zero);
  const perZoom = {};
  for (const job of jobs) perZoom[job.z] = (perZoom[job.z] ?? 0) + 1;
  const summary = { zooms, jobs: jobs.length, perZoom, rendered: result.rendered, reused: result.reused, workers: result.workers,
    wallSeconds: (Date.now() - started) / 1000, maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
  await appendFile(join(run, 'logs', 'phases.jsonl'), JSON.stringify({ phase: 'render', at: new Date().toISOString(), ...summary }) + '\n');
  log('render done', JSON.stringify(summary));
}

async function storeIds(store) {
  return new Set((await readdir(store)).filter(n => /^\d+\.png\.json$/.test(n)).map(n => Number(n.slice(0, -9))));
}
async function storeRecord(store, id) {
  const receipt = await readJson(join(store, id + '.png.json'));
  if (receipt.tileId !== id) throw Error('Store receipt id mismatch ' + id);
  return { tileId: id, path: join(store, id + '.png'), sha256: receipt.sha256 };
}
async function pyramid({ run, workers, from = 10 }) {
  const store = join(run, 'store'), zero = await readJson(join(run, 'zero.json'));
  for (let z = from - 1; z >= 0; z--) {
    const ids = [...await storeIds(store)].filter(id => tileIdToZxy(id)[0] === z + 1), children = new Map();
    for (const id of ids) children.set(id, await storeRecord(store, id));
    const jobs = overviewJobs(z, children, zero);
    if (!jobs.length) { log('pyramid z' + z, 'no parents'); continue; }
    const started = Date.now();
    const result = await buildRasterDemTileStore({ storePath: store, jobs, recipe: RECIPE, limits: { ...POOL_LIMITS, workers } });
    const summary = { z, jobs: jobs.length, rendered: result.rendered, reused: result.reused, wallSeconds: (Date.now() - started) / 1000 };
    await appendFile(join(run, 'logs', 'phases.jsonl'), JSON.stringify({ phase: 'pyramid', at: new Date().toISOString(), ...summary }) + '\n');
    log('pyramid', JSON.stringify(summary));
  }
}

const keyFor = (opts) => opts.key ?? `us-z${opts.maxZoom}-${opts.date}.pmtiles`;
async function assemble(opts) {
  const { root, run, maxZoom, boxes } = opts, key = keyFor(opts), outputPath = join(run, 'out', key);
  const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  // The summary is written (atomically) only after the archive is complete.
  if (await exists(outputPath + '.assemble.json')) { log('assemble', key, 'complete, skipped'); return; }
  // A hard kill leaves a partial archive at the final path, or (during the tile copy) only the writer's
  // scratch file; removing either is the operator's call, not the driver's.
  if (await exists(outputPath)) throw Error('Partial archive present (no .assemble.json): ' + outputPath);
  if (await exists(outputPath + '.tile-data.tmp')) throw Error('Partial scratch present (safe to delete after a kill): ' + outputPath + '.tile-data.tmp');
  const store = join(run, 'store'), zero = await readJson(join(run, 'zero.json')), present = await storeIds(store);
  const doc = await readJson(join(root, 'manifest.json')), planned = assemblyIds(boxes, 0, maxZoom);
  const union = unionOf(boxes), retrieved = doc.retrieved.slice(0, 10), started = Date.now();
  // DRAFT wording: attribution and modifications travel inside the published archive (dossier 7.1, brief 1.1).
  const metadata = { name: key.replace(/\.pmtiles$/, ''), format: 'png', type: 'raster-dem', encoding: 'terrarium', minzoom: 0, maxzoom: maxZoom,
    bounds: union, center: [(boxes[0].west + boxes[0].east) / 2, (boxes[0].south + boxes[0].north) / 2, Math.min(4, maxZoom)], tile_size: 512, quantization: 'whole-meter elevation before Terrarium encoding',
    attribution: `${ISSUER}, 1 arc-second seamless DEM (current), retrieved ${retrieved} from prd-tnm.s3.amazonaws.com; data last modified ${doc.lastModified}`,
    modifications: modificationsSentence(maxZoom), retrieved, missing_cells: [], claim_boxes: boxes, recipe: RECIPE,
    ...(opts.cells ? { pilot_cells: opts.cells } : {}) };
  const tiles = (async function* () {
    for (const id of planned) yield present.has(id) ? await storeRecord(store, id) : { tileId: id, path: zero.path, sha256: zero.sha256 };
  })();
  const result = await writeTerrainPmtiles({ outputPath, tiles, plannedTileIds: planned, minZoom: 0, maxZoom, bounds: union,
    center: metadata.center, metadata, maxTiles: planned.length, maxTileBytes: POOL_LIMITS.maxTileBytes, copyBufferBytes: 8 * MiB });
  const summary = { key, ...result, plannedIds: planned.length, wallSeconds: (Date.now() - started) / 1000 };
  await writeJson(outputPath + '.assemble.json', summary);
  await appendFile(join(run, 'logs', 'phases.jsonl'), JSON.stringify({ phase: 'assemble', at: new Date().toISOString(), ...summary }) + '\n');
  log('assemble', JSON.stringify(summary));
}

/**
 * Receipt sample ids in priority order: one shared zero-tile read first, then a median store tile per
 * zoom, then the first tile meeting each box at the deepest zoom and the one above. The receipt keeps
 * the first 20 distinct reads, so nationally (23 picks) only some of the second-deepest box hits drop.
 */
export function receiptPicks(present, boxes, maxZoom) {
  const presentSet = new Set(present), atZoom = z => present.filter(id => tileIdToZxy(id)[0] === z);
  const picks = [rectangleIds(unionOf(boxes), maxZoom).find(id => !presentSet.has(id))];
  for (let z = 0; z <= maxZoom; z++) { const ids = atZoom(z); if (ids.length) picks.push(ids[ids.length >> 1]); }
  for (const z of [maxZoom, maxZoom - 1]) {
    const ids = atZoom(z);
    for (const box of boxes) {
      const hit = ids.find(id => meets(tileBounds(...tileIdToZxy(id)), box));
      if (hit !== undefined) picks.push(hit);
    }
  }
  return [...new Set(picks)];
}
/** A PMTiles reader over a local file that also reports the byte range of each tile read. */
async function fileReader(path) {
  const handle = await open(path, 'r'), last = {};
  const reader = new PMTiles({ getKey: () => path, getBytes: async (offset, length) => {
    const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, offset);
    last.offset = offset; last.length = length;
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + length) };
  } });
  return { reader, last, close: () => handle.close() };
}
async function receipt(opts) {
  const key = keyFor(opts), path = join(opts.run, 'out', key), store = join(opts.run, 'store');
  const hash = createHash('sha256');
  let header;
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * MiB })) { header ??= Buffer.from(chunk.subarray(0, 127)); hash.update(chunk); }
  const bytes = (await stat(path)).size, present = [...await storeIds(store)].sort((a, b) => a - b);
  const { reader, last, close } = await fileReader(path), samples = [], seen = new Set();
  try {
    for (const id of receiptPicks(present, opts.boxes, opts.maxZoom)) {
      if (samples.length === 20) break; // verify:terrain reads at most 20 samples
      const [z, x, y] = tileIdToZxy(id), tile = await reader.getZxy(z, x, y);
      if (!tile || seen.has(last.offset)) continue;
      seen.add(last.offset);
      samples.push({ z, x, y, offset: last.offset, length: last.length, sha256: createHash('sha256').update(Buffer.from(tile.data)).digest('hex') });
    }
  } finally { await close(); }
  const expected = { key, issuer: ISSUER, bytes, sha256: hash.digest('hex'), headerHex: header.toString('hex'), samples };
  await writeJson(path.replace(/\.pmtiles$/, '.expected.json'), expected);
  log('receipt', JSON.stringify({ key, bytes, sha256: expected.sha256, samples: samples.length }));
}

function decodeDirectory(bytes) {
  let p = 0;
  const read = () => { let value = 0, m = 1; for (;;) { const b = bytes[p++]; value += (b & 127) * m; if (b < 128) return value; m *= 128; } };
  const count = read(), rows = [];
  let id = 0;
  for (let i = 0; i < count; i++) { id += read(); rows.push({ tileId: id }); }
  for (const row of rows) row.runLength = read();
  for (const row of rows) row.length = read();
  for (let i = 0; i < count; i++) { const v = read(); rows[i].offset = v === 0 && i > 0 ? rows[i - 1].offset + rows[i - 1].length : v - 1; }
  return rows;
}
/** Seam (a): mean absolute step across each whole-degree column/row inside a tile against its neighbours. */
export function cellSeamRatios(decoded, z, x, y) {
  const [w, s, e, n] = tileBounds(z, x, y), out = [], at = (c, r) => decoded.elevationAtIndex(r * 512 + c);
  // Steps touching a 0 m pixel are coast or no-data edges, not cell seams.
  const mean = pairs => { let sum = 0, n = 0; for (const [a, b] of pairs) if (a !== 0 && b !== 0) { sum += Math.abs(b - a); n++; } return n ? sum / n : 0; };
  const colStep = c => mean(Array.from({ length: 512 }, (_, r) => [at(c, r), at(c + 1, r)]));
  const rowStep = r => mean(Array.from({ length: 512 }, (_, c) => [at(c, r), at(c, r + 1)]));
  const ratio = (step, i) => {
    const near = []; for (let d = 2; d <= 6; d++) for (const j of [i - d, i + d]) if (j >= 0 && j < 511) near.push(step(j));
    near.sort((a, b) => a - b); const median = near[near.length >> 1];
    return median > 0 ? step(i) / median : null; // null: too little land beside the line to judge
  };
  for (let lon = Math.ceil(w); lon < e; lon++) {
    const c = Math.floor((lon - w) / (e - w) * 512 - 0.5); // pixel centres at i + 0.5: the degree line falls between c and c + 1
    if (c >= 1 && c < 510) out.push({ at: 'lon ' + lon, ratio: ratio(colStep, c) });
  }
  const mercY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
  for (let lat = Math.ceil(s); lat < n; lat++) {
    const r = Math.floor((mercY(lat) - mercY(n)) / (mercY(s) - mercY(n)) * 512 - 0.5);
    if (r >= 1 && r < 510) out.push({ at: 'lat ' + lat, ratio: ratio(rowStep, r) });
  }
  return out.filter(row => row.ratio !== null);
}
/**
 * Seam (b): share of land rows where the step into the east neighbour exceeds the 99th percentile land
 * gradient of the two tiles pooled (one tile's own statistics flag every flat-to-rugged pair). Steps
 * touching a 0 m pixel are coast or no-data edges, not seams, and are left out.
 */
export function tileSeamShare(left, right) {
  const steps = [], at = (t, i) => t.elevationAtIndex(i);
  for (const tile of [left, right]) for (let r = 0; r < 512; r++) for (let c = 0; c < 511; c++) {
    const a = at(tile, r * 512 + c), b = at(tile, r * 512 + c + 1);
    if (a !== 0 && b !== 0) steps.push(Math.abs(b - a));
  }
  if (steps.length < 512) return { p99: null, share: 0, rows: 0 };
  steps.sort((a, b) => a - b);
  const p99 = steps[Math.floor(steps.length * 0.99)];
  let over = 0, rows = 0;
  for (let r = 0; r < 512; r++) {
    const a = at(left, r * 512 + 511), b = at(right, r * 512);
    if (a === 0 || b === 0) continue;
    rows++; if (Math.abs(b - a) > p99) over++;
  }
  return { p99, share: rows ? over / rows : 0, rows };
}
async function verifyLocal(opts) {
  const key = keyFor(opts), path = join(opts.run, 'out', key), store = join(opts.run, 'store'), report = { key, failures: [] };
  const fail = message => report.failures.push(message);
  const handle = await open(path, 'r'), size = (await handle.stat()).size, head = Buffer.alloc(16384);
  await handle.read(head, 0, 16384, 0);
  const header = bytesToHeader(head.buffer.slice(head.byteOffset, head.byteOffset + 127));
  try {
    const expectedPath = path.replace(/\.pmtiles$/, '.expected.json');
    try { if ((await readJson(expectedPath)).headerHex !== head.subarray(0, 127).toString('hex')) fail('header differs from expected.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; report.expected = 'absent'; }
    if (header.specVersion !== 3 || header.tileDataOffset + header.tileDataLength !== size) fail('tile data is not last or extent differs from size');
    if (header.rootDirectoryOffset !== 127 || header.jsonMetadataOffset + header.jsonMetadataLength > 16384) fail('root plus metadata exceed the first 16,384 bytes');
    const union = unionOf(opts.boxes), got = [header.minLon, header.minLat, header.maxLon, header.maxLat];
    if (got.some((v, i) => Math.abs(v - union[i]) > 1e-6)) fail('header bounds ' + got + ' differ from the box union');
    const root = decodeDirectory(gunzipSync(head.subarray(127, 127 + header.rootDirectoryLength)));
    const leafPointers = root.filter(r => r.runLength === 0);
    report.leafCount = leafPointers.length;
    for (const leaf of leafPointers) {
      const buffer = Buffer.alloc(leaf.length);
      await handle.read(buffer, 0, leaf.length, header.leafDirectoryOffset + leaf.offset);
      if (decodeDirectory(gunzipSync(buffer)).some(r => r.runLength === 0)) { fail('more than one leaf level'); break; }
    }
  } finally { await handle.close(); }
  report.header = { minZoom: header.minZoom, maxZoom: header.maxZoom, addressed: header.numAddressedTiles, contents: header.numTileContents, bytes: size };
  // Read-back: every planned id resolves and equals its store record by SHA-256.
  const zero = await readJson(join(opts.run, 'zero.json')), present = await storeIds(store);
  const planned = assemblyIds(opts.boxes, 0, header.maxZoom);
  const { reader, close } = await fileReader(path), decodedCache = new Map(), perZoom = {};
  let missing = 0, mismatched = 0;
  const zeroLengths = new Set();
  try {
    for (const id of planned) {
      const [z, x, y] = tileIdToZxy(id), tile = await reader.getZxy(z, x, y);
      if (!tile) { missing++; continue; }
      const bytes = Buffer.from(tile.data), sha = createHash('sha256').update(bytes).digest('hex');
      const want = present.has(id) ? (await storeRecord(store, id)).sha256 : zero.sha256;
      if (sha !== want) mismatched++;
      const row = perZoom[z] ??= { ids: 0, land: 0, landBytes: 0, minM: Infinity, maxM: -Infinity, below100: 0 };
      row.ids++;
      if (sha === zero.sha256) { zeroLengths.add(bytes.length); continue; }
      row.land++; row.landBytes += bytes.length;
      if (opts.decode) {
        const decoded = decodeTerrariumTile(bytes);
        for (let i = 0; i < 512 * 512; i++) {
          const v = decoded.elevationAtIndex(i);
          if (v < row.minM) row.minM = v; if (v > row.maxM) row.maxM = v; if (v < -100) row.below100++;
        }
        // shortcut: seams use the first 2,000 deepest tiles in Hilbert order (about 2 GB decoded); sample wider if the national run flags any.
        if (z === header.maxZoom && decodedCache.size < 2000) decodedCache.set(id, decoded);
      }
    }
  } finally { await close(); }
  report.readBack = { planned: planned.length, missing, mismatched, zeroTileLengths: [...zeroLengths] };
  if (missing || mismatched) fail(`read-back missing ${missing}, mismatched ${mismatched}`);
  for (const row of Object.values(perZoom)) row.meanLandBytes = row.land ? Math.round(row.landBytes / row.land) : 0;
  report.perZoom = perZoom;
  // Brief Step 6 item 5: nothing below -100 m (Badwater is -85 m; a leaked sentinel clamps to -32768).
  const deep = Object.entries(perZoom).filter(([, row]) => row.below100).map(([z, row]) => `z${z} ${row.below100}`);
  if (deep.length) fail('pixels below -100 m: ' + deep.join(', '));
  report.decoded = opts.decode === true;
  // A skipped decoded check must not read as a pass.
  if (!report.decoded) fail('decoded checks skipped: pyramid, seams, heights and below -100 m unchecked');
  if (opts.decode) {
    // Pyramid (c): each sampled parent equals the rounded 2x2 mean of its decoded children.
    const decodeId = async id => decodeTerrariumTile(await readFile(present.has(id) ? join(store, id + '.png') : zero.path));
    const parents = [...present].filter(id => { const z = tileIdToZxy(id)[0]; return z === 9 || z === 5; }).slice(0, 12);
    let parentFailures = 0;
    for (const id of parents) {
      const [z, x, y] = tileIdToZxy(id), parent = await decodeId(id);
      for (let q = 0; q < 4; q++) {
        const child = await decodeId(zxyToTileId(z + 1, 2 * x + (q & 1), 2 * y + (q >> 1)));
        for (let r = 0; r < 256; r += 17) for (let c = 0; c < 256; c += 13) {
          const i = 2 * r * 512 + 2 * c, a = child.elevationAtIndex;
          const want = Math.round((a(i) + a(i + 1) + a(i + 512) + a(i + 513)) / 4);
          if (parent.elevationAtIndex(((q >> 1) * 256 + r) * 512 + (q & 1) * 256 + c) !== (want === 0 ? 0 : want)) parentFailures++;
        }
      }
    }
    report.pyramidCheck = { parents: parents.length, failures: parentFailures };
    if (parentFailures) fail('pyramid parent differs from 2x2 mean');
    // Seams (a) cell edges and (b) east neighbours, on the deepest native zoom held.
    const seams = { decodedTiles: decodedCache.size, cellEdges: 0, cellFlagged: [], pairs: 0, pairFlagged: [] };
    for (const [id, decoded] of decodedCache) {
      const [z, x, y] = tileIdToZxy(id);
      if (z !== header.maxZoom) continue;
      for (const row of cellSeamRatios(decoded, z, x, y)) { seams.cellEdges++; if (row.ratio > 5) seams.cellFlagged.push({ z, x, y, ...row }); }
      const east = decodedCache.get(zxyToTileId(z, x + 1, y));
      // A seam offsets most rows (share near 1); rugged ground alone put 5 to 17 percent of rows past p99 in the pilot.
      if (east) {
        seams.pairs++; const s = tileSeamShare(decoded, east);
        seams.maxShare = Math.max(seams.maxShare ?? 0, s.share);
        if (s.share > 0.5) seams.pairFlagged.push({ z, x, y, ...s });
      }
    }
    report.seams = seams;
  }
  // Summit table, camera-independent: decode the archive tile that holds each point.
  const summits = [];
  const { reader: r2, close: close2 } = await fileReader(path);
  try {
    for (const [name, lon, lat, ref] of SUMMITS) for (let z = Math.max(8, header.maxZoom - 2); z <= header.maxZoom; z++) {
      const p = pointInTile(lon, lat, z), id = zxyToTileId(z, p.x, p.y);
      if (!present.has(id)) continue;
      const tile = await r2.getZxy(z, p.x, p.y), read = readPoint(decodeTerrariumTile(Buffer.from(tile.data)), p.col, p.row);
      summits.push({ name, z, ref, ...read, nearestDelta: Math.round((read.nearest - ref) * 10) / 10, bilinearDelta: Math.round((read.bilinear - ref) * 10) / 10 });
    }
  } finally { await close2(); }
  report.summits = summits;
  for (const message of summitFailures(summits, opts.boxes, header.maxZoom, opts.cells)) fail(message);
  await mkdir(join(opts.run, 'logs'), { recursive: true });
  await writeJson(join(opts.run, 'logs', `verify-${key.replace(/\.pmtiles$/, '')}.json`), report);
  log('verify-local', JSON.stringify({ key, failures: report.failures, readBack: report.readBack, leafCount: report.leafCount }));
  if (report.failures.length) process.exitCode = 1;
}

// ---- CLI --------------------------------------------------------------------------------------

export function parseArgs(argv, checkout) {
  const [command, ...rest] = argv, opts = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, ''), value = rest[i + 1];
    if (!rest[i]?.startsWith('--') || value === undefined) throw Error('Arguments are --name value pairs');
    opts[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const name of ['root', 'run']) if (opts[name] !== undefined) {
    if (!isAbsolute(opts[name])) throw Error(`--${name} must be absolute`);
    const rel = relative(checkout, resolve(opts[name]));
    if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw Error(`--${name} must be outside the checkout`);
    opts[name] = resolve(opts[name]);
  }
  if (!opts.root) throw Error('--root <absolute work folder> is required');
  opts.run ??= opts.root;
  if (opts.cells) opts.cells = opts.cells.split(',');
  opts.zooms = (opts.zooms ?? '10,11').split(',').map(Number);
  opts.workers = Number(opts.workers ?? 12);
  opts.streams = Number(opts.streams ?? 4);
  opts.maxZoom = Number(opts.maxZoom ?? 10);
  // No clock default: a resume after 00:00 UTC would name a new archive and start a second assemble.
  if (['assemble', 'receipt', 'verify-local'].includes(command) && !opts.date && !opts.key) throw Error('--date or --key is required');
  opts.decode = opts.decode !== 'false'; // decoded checks on unless explicitly refused
  return opts;
}
const PHASES = { manifest, fetch: fetchPhase, render, pyramid, assemble, receipt, 'verify-local': verifyLocal };
/** boxes is injectable for tests only; the CLI always bakes the five national boxes. */
export async function runCommand(opts) {
  if (!PHASES[opts.command]) throw Error('Command is one of ' + Object.keys(PHASES).join(', '));
  opts.boxes ??= NATIONAL_TERRAIN_BOXES;
  for (const dir of ['logs', 'out', 'store']) await mkdir(join(opts.run, dir), { recursive: true });
  await mkdir(join(opts.root, 'logs'), { recursive: true });
  await PHASES[opts.command](opts);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runCommand(parseArgs(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url))));
  } catch (error) { console.error(new Date().toISOString(), 'ERROR', error?.stack ?? error); process.exitCode = 2; }
}
