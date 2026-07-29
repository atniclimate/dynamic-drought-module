import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { fromArrayBuffer, fromUrl } from 'geotiff';
import { zxyToTileId, writePmtiles } from './pmtiles-writer.mjs';

const TILETYPE_PNG = 2;
const COMPRESSION_NONE = 1;
const WEB_MERCATOR_MAX_LAT = 85.0511287798066;
const DEM_NODATA_FLOOR = -100000;
const REMOTE_BLOCK_SIZE = 1024 * 1024;
const WEB_MERCATOR_RADIUS = 6378137;
const WEB_MERCATOR_HALF_WORLD = Math.PI * WEB_MERCATOR_RADIUS;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

function lonToGlobalPixel(lon, z, tileSize) {
  return ((lon + 180) / 360) * 2 ** z * tileSize;
}

function latToGlobalPixel(lat, z, tileSize) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z * tileSize;
}

function globalPixelToLon(px, z, tileSize) {
  return (px / (2 ** z * tileSize)) * 360 - 180;
}

function globalPixelToLat(py, z, tileSize) {
  const n = Math.PI - (2 * Math.PI * py) / (2 ** z * tileSize);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function lonToMercatorX(lon) {
  return (lon * Math.PI * WEB_MERCATOR_RADIUS) / 180;
}

function latToMercatorY(lat) {
  const clamped = clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const r = (clamped * Math.PI) / 180;
  return WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + r / 2));
}

function lonLatBoundsToMercator(bounds) {
  return [
    lonToMercatorX(bounds[0]),
    latToMercatorY(bounds[1]),
    lonToMercatorX(bounds[2]),
    latToMercatorY(bounds[3])
  ];
}

function tileBoundsMercator(z, x, y) {
  const n = 2 ** z;
  const span = (2 * WEB_MERCATOR_HALF_WORLD) / n;
  const minX = -WEB_MERCATOR_HALF_WORLD + x * span;
  const maxX = minX + span;
  const maxY = WEB_MERCATOR_HALF_WORLD - y * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY];
}

export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = globalPixelToLat(y * 256, z, 256);
  const south = globalPixelToLat((y + 1) * 256, z, 256);
  return [west, south, east, north];
}

export function tileRangeForBounds(bounds, z) {
  const n = 2 ** z - 1;
  const minLon = clamp(bounds[0], -180, 180);
  const minLat = clamp(bounds[1], -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const maxLon = clamp(bounds[2], -180, 180);
  const maxLat = clamp(bounds[3], -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  return {
    xMin: clamp(lonToTileX(minLon, z), 0, n),
    xMax: clamp(lonToTileX(maxLon, z), 0, n),
    yMin: clamp(latToTileY(maxLat, z), 0, n),
    yMax: clamp(latToTileY(minLat, z), 0, n)
  };
}

function intersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function sourceTileName(latDegree, lonDegree) {
  const latLabel = `n${String(latDegree + 1).padStart(2, '0')}`;
  const lonLabel = `w${String(Math.abs(lonDegree)).padStart(3, '0')}`;
  return `${latLabel}${lonLabel}`;
}

function sourceTileNames(bounds) {
  const names = [];
  for (let lat = Math.floor(bounds[1]); lat < Math.ceil(bounds[3]); lat++) {
    for (let lon = Math.floor(bounds[0]); lon < Math.ceil(bounds[2]); lon++) {
      names.push(sourceTileName(lat, lon));
    }
  }
  return names;
}

function terrariumPng(elevations, width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < elevations.length; i++) {
    const value = Number.isFinite(elevations[i]) ? Math.round(elevations[i]) : 0;
    const encoded = clamp(Math.round((value + 32768) * 256), 0, 16777215);
    const o = i * 4;
    png.data[o] = Math.floor(encoded / 65536);
    png.data[o + 1] = Math.floor(encoded / 256) & 255;
    png.data[o + 2] = encoded & 255;
    png.data[o + 3] = 255;
  }
  const candidates = [-1, 2, 4];
  let best = null;
  let bestFilterType = null;
  for (const filterType of candidates) {
    const data = PNG.sync.write(png, {
      colorType: 6,
      inputColorType: 6,
      deflateLevel: 9,
      deflateStrategy: 3,
      filterType
    });
    if (!best || data.length < best.length) {
      best = data;
      bestFilterType = filterType;
    }
  }
  return { data: best, filterType: bestFilterType };
}

function decodeTerrariumPixel(png, pixelIndex) {
  const o = pixelIndex * 4;
  return png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
}

function normalizeElevation(v) {
  if (!Number.isFinite(v) || v <= DEM_NODATA_FLOOR) return 0;
  return clamp(v, -32768, 32767);
}

class UsgsCogSource {
  constructor({ product, baseUrl }) {
    this.product = product;
    this.baseUrl = baseUrl;
    this.cache = new Map();
    this.missing = new Set();
  }

  urlFor(name) {
    return `${this.baseUrl}/current/${name}/USGS_${this.product}_${name}.tif`;
  }

  async imageFor(name) {
    if (this.missing.has(name)) return null;
    if (this.cache.has(name)) return this.cache.get(name);
    const loading = this.loadImage(name);
    this.cache.set(name, loading);
    return loading;
  }

  async loadImage(name) {
    const url = this.urlFor(name);
    try {
      const tiff = await retry(`open source tile ${name}`, () => fromUrl(url, { blockSize: REMOTE_BLOCK_SIZE, maxRanges: 0 }));
      const image = await retry(`read source header ${name}`, () => tiff.getImage());
      return { name, url, image, bounds: image.getBoundingBox(), nodata: image.getGDALNoData() };
    } catch (err) {
      this.cache.delete(name);
      this.missing.add(name);
      console.warn(`  missing source tile ${name}: ${err.message}`);
      return null;
    }
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(label, fn, attempts = 8) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const waitMs = 1000 * attempt;
      console.warn(`  retry ${attempt}/${attempts - 1} for ${label}: ${err.message}`);
      await delay(waitMs);
    }
  }
  throw lastErr;
}

async function fillFromSourceTile(out, { z, x, y, tileSize, bounds }, source) {
  if (!intersects(bounds, source.bounds)) return false;

  const west = Math.max(bounds[0], source.bounds[0]);
  const south = Math.max(bounds[1], source.bounds[1]);
  const east = Math.min(bounds[2], source.bounds[2]);
  const north = Math.min(bounds[3], source.bounds[3]);

  const tileOriginX = x * tileSize;
  const tileOriginY = y * tileSize;
  const colStart = clamp(Math.floor(lonToGlobalPixel(west, z, tileSize) - tileOriginX), 0, tileSize - 1);
  const colEnd = clamp(Math.ceil(lonToGlobalPixel(east, z, tileSize) - tileOriginX), colStart + 1, tileSize);
  const rowStart = clamp(Math.floor(latToGlobalPixel(north, z, tileSize) - tileOriginY), 0, tileSize - 1);
  const rowEnd = clamp(Math.ceil(latToGlobalPixel(south, z, tileSize) - tileOriginY), rowStart + 1, tileSize);
  const width = colEnd - colStart;
  const height = rowEnd - rowStart;
  if (width <= 0 || height <= 0) return false;

  const readWest = Math.max(globalPixelToLon(tileOriginX + colStart, z, tileSize), source.bounds[0]);
  const readEast = Math.min(globalPixelToLon(tileOriginX + colEnd, z, tileSize), source.bounds[2]);
  const readNorth = Math.min(globalPixelToLat(tileOriginY + rowStart, z, tileSize), source.bounds[3]);
  const readSouth = Math.max(globalPixelToLat(tileOriginY + rowEnd, z, tileSize), source.bounds[1]);
  if (readWest >= readEast || readSouth >= readNorth) return false;

  const rasters = await retry(`read window ${source.name}`, () => source.image.readRasters({
    bbox: [readWest, readSouth, readEast, readNorth],
    width,
    height,
    resampleMethod: 'bilinear'
  }));
  const band = rasters[0];
  for (let row = 0; row < height; row++) {
    const outOffset = (rowStart + row) * tileSize + colStart;
    const inOffset = row * width;
    for (let col = 0; col < width; col++) {
      out[outOffset + col] = normalizeElevation(band[inOffset + col]);
    }
  }
  return true;
}

function intersectionBounds(a, b) {
  return [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3])
  ];
}

async function renderTile({ z, x, y, tileSize, source, demBounds }) {
  const bounds = tileBounds(z, x, y);
  const sourceNames = intersects(bounds, demBounds) ? sourceTileNames(intersectionBounds(bounds, demBounds)) : [];
  const elevations = new Float32Array(tileSize * tileSize);
  let filledSources = 0;

  for (const name of sourceNames) {
    const image = await source.imageFor(name);
    if (!image) continue;
    if (await fillFromSourceTile(elevations, { z, x, y, tileSize, bounds }, image)) {
      filledSources++;
    }
  }

  return {
    z,
    x,
    y,
    tileId: zxyToTileId(z, x, y),
    data: terrariumPng(elevations, tileSize, tileSize).data,
    filledSources
  };
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

function cumulativeArchiveSizes(tiles, opts) {
  const sizes = [];
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const subset = tiles.filter((t) => t.z <= z).map((t) => ({ tileId: t.tileId, data: t.data }));
    const archive = writePmtiles({
      tiles: subset,
      minZoom: opts.minZoom,
      maxZoom: z,
      bounds: opts.bounds,
      center: [opts.center[0], opts.center[1], Math.min(opts.center[2], z)],
      metadata: { ...opts.metadata, maxzoom: z },
      tileType: TILETYPE_PNG,
      tileCompression: COMPRESSION_NONE
    });
    sizes.push({ zoom: z, cumulativeBytes: archive.length, tileCount: subset.length });
  }
  return sizes;
}

export function decodeTerrariumTile(buffer) {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { png, elevationAtIndex: (i) => decodeTerrariumPixel(png, i) };
}

export function pointPixel(lon, lat, z, x, y, tileSize) {
  const px = Math.floor(lonToGlobalPixel(lon, z, tileSize) - x * tileSize);
  const py = Math.floor(latToGlobalPixel(lat, z, tileSize) - y * tileSize);
  return {
    px: clamp(px, 0, tileSize - 1),
    py: clamp(py, 0, tileSize - 1)
  };
}

export async function buildRasterDemPmtiles(opts) {
  const started = performance.now();
  const source = new UsgsCogSource({
    product: opts.product,
    baseUrl: opts.baseUrl
  });
  const sourceNames = sourceTileNames(opts.bounds);
  const work = [];
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const range = tileRangeForBounds(opts.bounds, z);
    for (let x = range.xMin; x <= range.xMax; x++) {
      for (let y = range.yMin; y <= range.yMax; y++) {
        work.push({ z, x, y });
      }
    }
  }

  const byZoom = new Map();
  for (const item of work) byZoom.set(item.z, (byZoom.get(item.z) ?? 0) + 1);
  console.log(`  source degree tiles: ${sourceNames.length}`);
  console.log(`  output tiles: ${work.length}`);
  console.log(`  output by zoom: ${[...byZoom.entries()].map(([z, n]) => `z${z}=${n}`).join(', ')}`);

  let completed = 0;
  const tiles = await runLimited(work, opts.concurrency, async (item) => {
    const tile = await renderTile({ ...item, tileSize: opts.tileSize, source, demBounds: opts.bounds });
    completed++;
    if (completed === work.length || completed % opts.progressEvery === 0) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`  rendered ${completed}/${work.length} tiles in ${elapsed}s`);
    }
    return tile;
  });
  tiles.sort((a, b) => a.tileId - b.tileId);

  const archive = writePmtiles({
    tiles: tiles.map((t) => ({ tileId: t.tileId, data: t.data })),
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    bounds: opts.bounds,
    center: opts.center,
    metadata: opts.metadata,
    tileType: TILETYPE_PNG,
    tileCompression: COMPRESSION_NONE
  });

  const cumulativeSizes = cumulativeArchiveSizes(tiles, opts);
  const elapsedMs = performance.now() - started;
  return {
    archive,
    tiles,
    tileCount: tiles.length,
    sourceTileCount: sourceNames.length,
    missingSourceTiles: [...source.missing].sort(),
    cumulativeSizes,
    elapsedMs
  };
}

function imageServerUrl(endpoint, bbox, width, height) {
  const params = new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${width},${height}`,
    format: 'tiff',
    pixelType: 'F32',
    noData: '',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image'
  });
  return `${endpoint}?${params.toString()}`;
}

async function fetchImageServerTile(endpoint, bbox, width, height) {
  const url = imageServerUrl(endpoint, bbox, width, height);
  const res = await retry(`exportImage ${width}x${height}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
    }
    return response;
  }, 6);
  const buffer = await res.arrayBuffer();
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ width, height });
  return { band: rasters[0], width, height, nodata: image.getGDALNoData() };
}

async function renderImageServerTile({ z, x, y, tileSize, endpoint, demMercatorBounds, requestDelayMs, bufferPixels }) {
  const tileMercatorBounds = tileBoundsMercator(z, x, y);
  const elevations = new Float32Array(tileSize * tileSize);
  if (!intersects(tileMercatorBounds, demMercatorBounds)) {
    const png = terrariumPng(elevations, tileSize, tileSize);
    return { z, x, y, tileId: zxyToTileId(z, x, y), data: png.data, filledSources: 0, pngFilterType: png.filterType };
  }

  const spanX = tileMercatorBounds[2] - tileMercatorBounds[0];
  const spanY = tileMercatorBounds[3] - tileMercatorBounds[1];
  const pixelSpanX = spanX / tileSize;
  const pixelSpanY = spanY / tileSize;

  const centralColStart = clamp(Math.floor(((demMercatorBounds[0] - tileMercatorBounds[0]) / spanX) * tileSize), 0, tileSize - 1);
  const centralColEnd = clamp(Math.ceil(((demMercatorBounds[2] - tileMercatorBounds[0]) / spanX) * tileSize), centralColStart + 1, tileSize);
  const centralRowStart = clamp(Math.floor(((tileMercatorBounds[3] - demMercatorBounds[3]) / spanY) * tileSize), 0, tileSize - 1);
  const centralRowEnd = clamp(Math.ceil(((tileMercatorBounds[3] - demMercatorBounds[1]) / spanY) * tileSize), centralRowStart + 1, tileSize);

  const demColStart = Math.floor((demMercatorBounds[0] - tileMercatorBounds[0]) / pixelSpanX);
  const demColEnd = Math.ceil((demMercatorBounds[2] - tileMercatorBounds[0]) / pixelSpanX);
  const demRowStart = Math.floor((tileMercatorBounds[3] - demMercatorBounds[3]) / pixelSpanY);
  const demRowEnd = Math.ceil((tileMercatorBounds[3] - demMercatorBounds[1]) / pixelSpanY);

  const readColStart = Math.max(centralColStart - bufferPixels, demColStart);
  const readColEnd = Math.min(centralColEnd + bufferPixels, demColEnd);
  const readRowStart = Math.max(centralRowStart - bufferPixels, demRowStart);
  const readRowEnd = Math.min(centralRowEnd + bufferPixels, demRowEnd);
  const width = readColEnd - readColStart;
  const height = readRowEnd - readRowStart;
  if (width <= 0 || height <= 0) {
    const png = terrariumPng(elevations, tileSize, tileSize);
    return { z, x, y, tileId: zxyToTileId(z, x, y), data: png.data, filledSources: 0, pngFilterType: png.filterType };
  }

  const readWest = tileMercatorBounds[0] + readColStart * pixelSpanX;
  const readEast = tileMercatorBounds[0] + readColEnd * pixelSpanX;
  const readNorth = tileMercatorBounds[3] - readRowStart * pixelSpanY;
  const readSouth = tileMercatorBounds[3] - readRowEnd * pixelSpanY;
  const readBbox = [readWest, readSouth, readEast, readNorth];

  const raster = await fetchImageServerTile(endpoint, readBbox, width, height);
  for (let row = centralRowStart; row < centralRowEnd; row++) {
    const inRow = row - readRowStart;
    if (inRow < 0 || inRow >= height) continue;
    for (let col = centralColStart; col < centralColEnd; col++) {
      const inCol = col - readColStart;
      if (inCol < 0 || inCol >= width) continue;
      elevations[row * tileSize + col] = normalizeElevation(raster.band[inRow * width + inCol]);
    }
  }
  if (requestDelayMs > 0) await delay(requestDelayMs);
  const png = terrariumPng(elevations, tileSize, tileSize);
  return { z, x, y, tileId: zxyToTileId(z, x, y), data: png.data, filledSources: 1, pngFilterType: png.filterType };
}

function archiveForTiles(tiles, opts, maxZoom) {
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
}

export async function buildRasterDemPmtilesFromImageServer(opts) {
  const started = performance.now();
  const demMercatorBounds = lonLatBoundsToMercator(opts.bounds);
  const work = [];
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const range = tileRangeForBounds(opts.bounds, z);
    for (let x = range.xMin; x <= range.xMax; x++) {
      for (let y = range.yMin; y <= range.yMax; y++) {
        work.push({ z, x, y });
      }
    }
  }

  const byZoom = new Map();
  for (const item of work) byZoom.set(item.z, (byZoom.get(item.z) ?? 0) + 1);
  console.log(`  output tiles: ${work.length}`);
  console.log(`  output by zoom: ${[...byZoom.entries()].map(([z, n]) => `z${z}=${n}`).join(', ')}`);

  let completed = 0;
  const tiles = await runLimited(work, opts.concurrency, async (item) => {
    const tile = await renderImageServerTile({
      ...item,
      tileSize: opts.tileSize,
      endpoint: opts.endpoint,
      demMercatorBounds,
      requestDelayMs: opts.requestDelayMs,
      bufferPixels: opts.bufferPixels
    });
    completed++;
    if (completed === work.length || completed % opts.progressEvery === 0) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`  rendered ${completed}/${work.length} tiles in ${elapsed}s`);
    }
    return tile;
  });
  tiles.sort((a, b) => a.tileId - b.tileId);

  const archiveMaxZooms = opts.archiveMaxZooms ?? [opts.maxZoom];
  const archives = new Map(archiveMaxZooms.map((z) => [z, archiveForTiles(tiles, opts, z)]));
  const archive = archives.get(opts.maxZoom);

  const cumulativeSizes = cumulativeArchiveSizes(tiles, opts);
  const elapsedMs = performance.now() - started;
  return {
    archive,
    archives,
    tiles,
    tileCount: tiles.length,
    sourceTileCount: tiles.filter((t) => t.filledSources > 0).length,
    missingSourceTiles: [],
    cumulativeSizes,
    elapsedMs
  };
}
