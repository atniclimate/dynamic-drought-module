/**
 * Bake a server-rendered classified raster into a PNG PMTiles archive
 * (build-time only).
 *
 * Unlike raster-dem-to-pmtiles.mjs (which reads Float32 elevation windows
 * and re-encodes them as terrarium PNGs), this builder asks an ArcGIS
 * ImageServer to render each Web Mercator tile itself via `exportImage`
 * with `format=png` and NO renderingRule, so the ISSUER'S OWN default
 * raster function paints the issuer's published class colors server-side.
 * The returned PNG bytes are stored verbatim; DDM chooses no colors and
 * computes no values. `interpolation=RSP_NearestNeighbor` keeps class
 * boundaries crisp instead of blending neighboring classes into colors
 * that exist in no legend.
 *
 * Two-step fallback: the lfps host has intermittently rejected direct
 * `f=image` exports while accepting the identical request with `f=json`
 * (the rendered file's href is then fetched separately); see
 * scripts/landscape/adapters/landcover_fuels.py for the prior evidence.
 * Every tile request tries `f=image` first and falls back to the two-step
 * shape before counting as a failure.
 *
 * Honesty guards baked in:
 *   - A tile whose pixels are ALL fully transparent is skipped (no tile
 *     entry), which is the correct encoding for "outside the source's
 *     coverage" rather than shipping an opaque black lie.
 *   - A tile whose pixels are ALL opaque black is a hard failure: that is
 *     the signature of an unpopulated mosaic GeoArea (observed live on
 *     LF2025 CONUS south-east, 2026-08-18) and must never be committed.
 *   - The caller supplies a canary point that must decode to at least one
 *     opaque pixel matching the issuer's palette, proving the render path
 *     actually painted issuer classes.
 */

import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { zxyToTileId, writePmtiles } from './pmtiles-writer.mjs';
import { tileRangeForBounds, lonToTileX, latToTileY } from './raster-dem-to-pmtiles.mjs';

const TILETYPE_PNG = 2;
const COMPRESSION_NONE = 1;
const WEB_MERCATOR_RADIUS = 6378137;
const WEB_MERCATOR_HALF_WORLD = Math.PI * WEB_MERCATOR_RADIUS;

function tileBoundsMercator(z, x, y) {
  const n = 2 ** z;
  const span = (2 * WEB_MERCATOR_HALF_WORLD) / n;
  const minX = -WEB_MERCATOR_HALF_WORLD + x * span;
  const maxX = minX + span;
  const maxY = WEB_MERCATOR_HALF_WORLD - y * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY];
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(label, fn, attempts = 6) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      console.warn(`  retry ${attempt}/${attempts - 1} for ${label}: ${err.message}`);
      await delay(1000 * attempt);
    }
  }
  throw lastErr;
}

function exportImageParams(bbox, tileSize) {
  return new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${tileSize},${tileSize}`,
    // png32 guarantees an alpha channel; plain png can silently select a
    // no-alpha variant that paints nodata as opaque black (observed live
    // on the LF2024 CONUS mosaic's coastal tiles, 2026-08-18).
    format: 'png32',
    transparent: 'true',
    interpolation: 'RSP_NearestNeighbor',
    f: 'image'
  });
}

/** Fetch one rendered PNG tile, trying f=image then the two-step f=json href. */
async function fetchRenderedTile(endpoint, bbox, tileSize) {
  const direct = `${endpoint}/exportImage?${exportImageParams(bbox, tileSize).toString()}`;
  const directRes = await fetch(direct);
  if (directRes.ok && (directRes.headers.get('content-type') ?? '').includes('image/png')) {
    return Buffer.from(await directRes.arrayBuffer());
  }
  // Two-step: ask for the rendered file's href, then fetch the href.
  const params = exportImageParams(bbox, tileSize);
  params.set('f', 'json');
  const jsonRes = await fetch(`${endpoint}/exportImage?${params.toString()}`);
  if (!jsonRes.ok) {
    throw new Error(`exportImage f=json HTTP ${jsonRes.status}`);
  }
  const body = await jsonRes.json();
  if (body.error || typeof body.href !== 'string') {
    throw new Error(`exportImage rejected: ${JSON.stringify(body.error ?? body).slice(0, 160)}`);
  }
  const hrefRes = await fetch(body.href);
  if (!hrefRes.ok) throw new Error(`rendered href HTTP ${hrefRes.status}`);
  const bytes = Buffer.from(await hrefRes.arrayBuffer());
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('rendered href did not return a PNG');
  }
  return bytes;
}

/** Classify a decoded PNG's pixels: fully transparent, all opaque black, or data. */
function classifyPixels(png) {
  let anyOpaque = false;
  let anyNonBlackOpaque = false;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] === 0) continue;
    anyOpaque = true;
    if (png.data[i] !== 0 || png.data[i + 1] !== 0 || png.data[i + 2] !== 0) {
      anyNonBlackOpaque = true;
      break;
    }
  }
  if (!anyOpaque) return 'transparent';
  if (!anyNonBlackOpaque) return 'opaque-black';
  return 'data';
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next;
      next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

/**
 * Bake the archive. Options:
 *   endpoint       ImageServer root (no trailing slash, no /exportImage)
 *   bounds         [minLon, minLat, maxLon, maxLat] bake box (WGS 84)
 *   minZoom, maxZoom, tileSize
 *   concurrency, requestDelayMs, progressEvery
 *   center         [lon, lat, zoom]
 *   metadata       PMTiles JSON metadata (name, attribution, ...)
 *   canary         { lon, lat, zoom, paletteHex: string[] } a point that must
 *                  decode to at least one opaque pixel whose color is in the
 *                  issuer palette
 *   archiveMaxZooms  zoom depths to emit archives for (size selection)
 *
 * Returns { archives: Map<maxZoom, Buffer>, tiles, counts, cumulativeSizes }.
 */
export async function buildRenderedRasterPmtiles(opts) {
  const started = performance.now();
  const work = [];
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const range = tileRangeForBounds(opts.bounds, z);
    for (let x = range.xMin; x <= range.xMax; x++) {
      for (let y = range.yMin; y <= range.yMax; y++) {
        work.push({ z, x, y });
      }
    }
  }
  console.log(`  output tiles requested: ${work.length}`);

  const counts = { data: 0, transparent: 0 };
  let completed = 0;
  const rendered = await runLimited(work, opts.concurrency, async ({ z, x, y }) => {
    const bbox = tileBoundsMercator(z, x, y);
    const bytes = await retry(`tile ${z}/${x}/${y}`, () =>
      fetchRenderedTile(opts.endpoint, bbox, opts.tileSize)
    );
    if (opts.requestDelayMs > 0) await delay(opts.requestDelayMs);
    const kind = classifyPixels(PNG.sync.read(bytes));
    completed++;
    if (completed === work.length || completed % opts.progressEvery === 0) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`  rendered ${completed}/${work.length} tiles in ${elapsed}s`);
    }
    if (kind === 'opaque-black') {
      // The unpopulated-mosaic signature: refuse to bake a black lie.
      throw new Error(
        `tile ${z}/${x}/${y} rendered ALL opaque black: the mosaic is unpopulated here; refusing to bake`
      );
    }
    if (kind === 'transparent') {
      counts.transparent++;
      return null;
    }
    counts.data++;
    return { z, x, y, tileId: zxyToTileId(z, x, y), data: bytes };
  });

  const tiles = rendered.filter(Boolean).sort((a, b) => a.tileId - b.tileId);

  // Canary: the named point must decode to issuer-palette pixels.
  const c = opts.canary;
  const canaryTile = tiles.find(
    (t) =>
      t.z === c.zoom &&
      t.x === lonToTileX(c.lon, c.zoom) &&
      t.y === latToTileY(c.lat, c.zoom)
  );
  if (!canaryTile) {
    throw new Error(`canary tile z${c.zoom} at ${c.lon},${c.lat} was not baked; coverage is broken`);
  }
  const canaryPng = PNG.sync.read(canaryTile.data);
  const palette = new Set(c.paletteHex.map((h) => h.toLowerCase()));
  let canaryHit = false;
  for (let i = 0; i < canaryPng.data.length; i += 4) {
    if (canaryPng.data[i + 3] === 0) continue;
    const hex = `#${[canaryPng.data[i], canaryPng.data[i + 1], canaryPng.data[i + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`;
    if (palette.has(hex)) {
      canaryHit = true;
      break;
    }
  }
  if (!canaryHit) {
    throw new Error(
      'canary tile contains no pixel matching the issuer palette; the server did not render issuer classes'
    );
  }

  const archiveFor = (maxZoom) => {
    const subset = tiles.filter((t) => t.z <= maxZoom).map((t) => ({ tileId: t.tileId, data: t.data }));
    return writePmtiles({
      tiles: subset,
      minZoom: opts.minZoom,
      maxZoom,
      bounds: opts.bounds,
      center: [opts.center[0], opts.center[1], Math.min(opts.center[2], maxZoom)],
      metadata: { ...opts.metadata, maxzoom: maxZoom },
      tileType: TILETYPE_PNG,
      tileCompression: COMPRESSION_NONE
    });
  };

  // The section-0 checkpoint instrumentation: real built size per zoom depth.
  const cumulativeSizes = [];
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const archive = archiveFor(z);
    cumulativeSizes.push({
      zoom: z,
      cumulativeBytes: archive.length,
      tileCount: tiles.filter((t) => t.z <= z).length
    });
  }

  const archives = new Map((opts.archiveMaxZooms ?? [opts.maxZoom]).map((z) => [z, archiveFor(z)]));
  return { archives, tiles, counts, cumulativeSizes, elapsedMs: performance.now() - started };
}
