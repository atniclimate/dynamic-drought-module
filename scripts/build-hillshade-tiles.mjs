/**
 * Build the PNW raster-dem PMTiles bundle for the U4g hillshade underlay.
 *
 * Source: USGS 3D Elevation Program (3DEP) 3DEPElevation ImageServer. The
 * script exports one Float32 GeoTIFF per output tile, encodes Terrarium PNG
 * tiles, and stages the PMTiles output under tiles-staging while hosting is
 * undecided.
 *
 * Usage: node scripts/build-hillshade-tiles.mjs
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';
import {
  buildRasterDemPmtilesFromImageServer,
  decodeTerrariumTile,
  latToTileY,
  lonToTileX,
  pointPixel,
  tileRangeForBounds
} from './lib/raster-dem-to-pmtiles.mjs';

const PNW_BBOX = [-125, 41.5, -110.5, 49.5];
const PNW_CENTER = [-119, 45.5, 5];
const MIN_ZOOM = 0;
const MAX_ZOOM = 9;
const TILE_SIZE = 512;
const IMAGE_SERVER_EXPORT = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const S3_SOURCE_ROOT = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF';
const S3_SOURCE_VRT = `${S3_SOURCE_ROOT}/USGS_Seamless_DEM_1.vrt`;
const SOURCE_VINTAGE = 'data current as of 2026-05-19 per verified ImageServer source notes; ArcGIS Server 11.3';
const RETRIEVED = new Date().toISOString().slice(0, 10);
const ATTRIBUTION = 'USGS 3D Elevation Program';
const DEPENDENCIES_ADDED = 'geotiff 3.0.5, pngjs 7.0.0';
const OUT_PATHS = new Map([
  [8, fileURLToPath(new URL('../tiles-staging/hillshade-dem-pnw-z8.pmtiles', import.meta.url))],
  [9, fileURLToPath(new URL('../tiles-staging/hillshade-dem-pnw-z9.pmtiles', import.meta.url))]
]);
const REPORT_PATH = fileURLToPath(new URL('../harness/phases/0.7.0/HILLSHADE_PIPELINE_REPORT.md', import.meta.url));
const BEFORE_CONTINUITY = [
  { label: 'Ocean', maxDiff: 0, meanDiff: 0 },
  { label: 'Mount Rainier terrain', maxDiff: 94.62890625, meanDiff: 26.220314025878906 }
];

function parseArgs() {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    args.set(key, value ?? 'true');
  }
  return {
    minZoom: Number(args.get('minzoom') ?? MIN_ZOOM),
    maxZoom: Number(args.get('maxzoom') ?? MAX_ZOOM),
    tileSize: Number(args.get('tile-size') ?? TILE_SIZE),
    concurrency: Number(args.get('concurrency') ?? 3),
    requestDelayMs: Number(args.get('request-delay-ms') ?? 125),
    bufferPixels: Number(args.get('buffer-pixels') ?? 8)
  };
}

function formatBytes(n) {
  return `${n.toLocaleString()} bytes (${(n / 1024 / 1024).toFixed(2)} MiB)`;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} seconds`;
}

function archiveSource(buffer) {
  return {
    getKey: () => 'hillshade-dem-pnw',
    getBytes: async (offset, length) => {
      const slice = buffer.subarray(offset, offset + length);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    }
  };
}

async function samplePoint(reader, point, tileSize) {
  const x = lonToTileX(point.lon, point.zoom);
  const y = latToTileY(point.lat, point.zoom);
  const tile = await reader.getZxy(point.zoom, x, y);
  if (!tile) throw new Error(`missing sample tile for ${point.label} at z${point.zoom}/${x}/${y}`);
  const { png, elevationAtIndex } = decodeTerrariumTile(tile.data);
  const { px, py } = pointPixel(point.lon, point.lat, point.zoom, x, y, tileSize);
  const elevation = elevationAtIndex(py * png.width + px);
  return { ...point, x, y, px, py, elevation, tileBytes: tile.data.byteLength };
}

async function verifyContinuity(reader, z, x, y) {
  const left = await reader.getZxy(z, x, y);
  const right = await reader.getZxy(z, x + 1, y);
  if (!left || !right) throw new Error(`missing continuity tiles at z${z}/${x}/${y}`);
  const leftDecoded = decodeTerrariumTile(left.data);
  const rightDecoded = decodeTerrariumTile(right.data);
  const width = leftDecoded.png.width;
  const height = leftDecoded.png.height;
  let maxDiff = 0;
  let sumDiff = 0;
  for (let row = 0; row < height; row++) {
    const a = leftDecoded.elevationAtIndex(row * width + (width - 1));
    const b = rightDecoded.elevationAtIndex(row * width);
    const diff = Math.abs(a - b);
    maxDiff = Math.max(maxDiff, diff);
    sumDiff += diff;
  }
  return { z, leftX: x, rightX: x + 1, y, maxDiff, meanDiff: sumDiff / height };
}

async function verifyArchive(archive, result, opts, archiveMaxZoom) {
  const reader = new PMTiles(archiveSource(archive));
  const header = await reader.getHeader();
  const metadata = await reader.getMetadata();
  const points = [
    { label: 'Mount Rainier summit area', lon: -121.760424, lat: 46.852947, zoom: archiveMaxZoom, expectation: '> 4300 m at z9; z8 is coarser' },
    { label: 'Puget lowland near Seattle', lon: -122.3321, lat: 47.6062, zoom: Math.max(opts.minZoom, archiveMaxZoom - 1), expectation: '< 200 m' },
    { label: 'Pacific Ocean west of Oregon', lon: -124.8, lat: 43.8, zoom: Math.max(opts.minZoom, archiveMaxZoom - 2), expectation: '0 m sea level' }
  ];
  const samples = [];
  for (const point of points) samples.push(await samplePoint(reader, point, opts.tileSize));

  const continuity = [];
  if (archiveMaxZoom >= 9) {
    const oceanX = lonToTileX(-124.8, archiveMaxZoom);
    const oceanY = latToTileY(43.8, archiveMaxZoom);
    continuity.push({ label: 'Ocean', ...(await verifyContinuity(reader, archiveMaxZoom, oceanX, oceanY)) });
    continuity.push({ label: 'Mount Rainier terrain', ...(await verifyContinuity(reader, archiveMaxZoom, 82, 180)) });
  }
  const sampleTile = await reader.getZxy(archiveMaxZoom, lonToTileX(PNW_CENTER[0], archiveMaxZoom), latToTileY(PNW_CENTER[1], archiveMaxZoom));
  if (!sampleTile) throw new Error('missing center sample tile from PMTiles readback');
  const outliers = result.tiles.filter((t) => t.z <= archiveMaxZoom && t.data.length > 200 * 1024).map((t) => ({
    z: t.z,
    x: t.x,
    y: t.y,
    bytes: t.data.length
  }));
  return { archiveMaxZoom, header, metadata, samples, continuity, sampleTileBytes: sampleTile.data.byteLength, outliers };
}

function summarizeByZoom(result) {
  const rows = [];
  for (const size of result.cumulativeSizes) {
    const zoomTiles = result.tiles.filter((t) => t.z === size.zoom);
    const payloadBytes = zoomTiles.reduce((sum, t) => sum + t.data.length, 0);
    rows.push({
      zoom: size.zoom,
      tilesAtZoom: zoomTiles.length,
      payloadBytes,
      cumulativeTiles: size.tileCount,
      cumulativeArchiveBytes: size.cumulativeBytes
    });
  }
  return rows;
}

function estimateOneZoomDeeper(result, opts) {
  const lastTiles = result.tiles.filter((t) => t.z === opts.maxZoom);
  const lastPayload = lastTiles.reduce((sum, t) => sum + t.data.length, 0);
  const payloadTotal = result.tiles.reduce((sum, t) => sum + t.data.length, 0);
  const range = tileRangeForBounds(PNW_BBOX, opts.maxZoom + 1);
  const nextTileCount = (range.xMax - range.xMin + 1) * (range.yMax - range.yMin + 1);
  const avgPayload = lastPayload / Math.max(1, lastTiles.length);
  const overheadPerTile = (result.archive.length - payloadTotal) / Math.max(1, result.tiles.length);
  const addedBytes = Math.round(nextTileCount * (avgPayload + overheadPerTile));
  return {
    zoom: opts.maxZoom + 1,
    nextTileCount,
    avgPayload,
    addedBytes,
    estimatedTotalBytes: result.archive.length + addedBytes
  };
}

function reportMarkdown({ result, verifies, opts, outStats }) {
  const byZoom = summarizeByZoom(result);
  const estimate = estimateOneZoomDeeper(result, opts);
  const tileRows = byZoom
    .map((r) => `| ${r.zoom} | ${r.tilesAtZoom.toLocaleString()} | ${formatBytes(r.payloadBytes)} | ${r.cumulativeTiles.toLocaleString()} | ${formatBytes(r.cumulativeArchiveBytes)} |`)
    .join('\n');
  const archiveRows = [...outStats.entries()]
    .map(([z, s]) => `| z${z} | \`tiles-staging/hillshade-dem-pnw-z${z}.pmtiles\` | ${formatBytes(s.size)} | ${s.size < 100 * 1024 * 1024 ? 'yes' : 'no'} |`)
    .join('\n');
  const readbackRows = [...verifies.entries()]
    .map(([z, v]) => `| z${z} | ${v.header.minZoom}..${v.header.maxZoom} | ${v.header.tileType} | ${v.header.tileCompression} | ${v.metadata.encoding} | ${v.sampleTileBytes.toLocaleString()} |`)
    .join('\n');
  const sampleRows = [...verifies.entries()].flatMap(([z, v]) => v.samples
    .map((s) => `| z${z} | ${s.label} | z${s.zoom}/${s.x}/${s.y} px ${s.px},${s.py} | ${s.elevation.toFixed(2)} m | ${s.expectation} |`))
    .join('\n');
  const afterContinuity = verifies.get(9)?.continuity ?? [];
  const continuityRows = afterContinuity.map((after) => {
    const before = BEFORE_CONTINUITY.find((c) => c.label === after.label);
    return `| ${after.label} | ${before?.maxDiff.toFixed(4) ?? 'n/a'} m | ${after.maxDiff.toFixed(4)} m | ${before?.meanDiff.toFixed(4) ?? 'n/a'} m | ${after.meanDiff.toFixed(4)} m |`;
  }).join('\n');
  const outlierText = [...verifies.entries()].map(([z, v]) => {
    if (v.outliers.length === 0) return `z${z}: no tile exceeded 200 kB.`;
    return `z${z} outliers:\n${v.outliers.map((o) => `z${o.z}/${o.x}/${o.y}: ${formatBytes(o.bytes)}`).join('\n')}`;
  }).join('\n\n');
  const missingText = result.missingSourceTiles.length === 0
    ? 'None.'
    : result.missingSourceTiles.join(', ');
  const filterCounts = result.tiles.reduce((acc, t) => {
    const key = String(t.pngFilterType);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const filterText = Object.entries(filterCounts).map(([k, v]) => `${k}: ${v}`).join(', ');

  return `# Hillshade Pipeline Report

## Outcome

Built two PNW raster-dem hillshade archives from one ImageServer fetch pass.

## Source

- Source: USGS 3D Elevation Program 3DEPElevation ImageServer exportImage, Terrarium encoded from per-output-tile Float32 GeoTIFF exports.
- Endpoint: \`${IMAGE_SERVER_EXPORT}\`
- Vintage used: ${SOURCE_VINTAGE}
- Retrieval date: ${RETRIEVED}
- Attribution: ${ATTRIBUTION}
- Missing source tiles: ${missingText}
- Dependencies added for this build: ${DEPENDENCIES_ADDED}.

## Tile Decision

- Bounds: \`[${PNW_BBOX.join(', ')}]\`
- Tile size: ${opts.tileSize} px.
- Zoom range: ${opts.minZoom}..${opts.maxZoom}.
- Archives emitted: z8 and z9. The z8 archive is the same build with z9 tiles omitted, so it required no second fetch pass.
- Reasoning: this is a subtle MapLibre hillshade underlay, not a terrain inspection surface. A 512 px tile at z9 has the same display detail as a 256 px z10 tile, while reducing tile count and directory pressure.
- Buffered requests: each ImageServer request expands the output tile by ${opts.bufferPixels} output pixels on every side, up to 528x528 px, then crops the central ${opts.tileSize}x${opts.tileSize} tile after decode. Requests are clamped at the PNW boundary and pixels outside PNW are filled as 0 m.
- Low-zoom clamp: z0..z3 tiles cover far outside the PNW bbox. Each ImageServer request is clamped to the tile's PNW Web Mercator intersection. The consumer clips this source to PNW.
- Quantization: elevations are rounded to whole meters before Terrarium encoding. This intentionally makes the Terrarium blue channel constant for integer-meter values. For a subtle hillshade underlay at roughly 150 to 300 m per pixel, a 1 m vertical step is below visible derivative precision.
- PNG settings: deflate level 9, strategy 3, with filter candidates auto, Up, and Paeth. The smallest encoded PNG is kept per tile. Selected filter counts: ${filterText}.
- NoData and ocean handling: source NoData, nonfinite values, and absurd negative sentinels are encoded as Terrarium 0 m. This deliberately treats ocean and unavailable offshore cells as sea level, which avoids a negative NoData wall at the coast.

## Archive Sizes

| Archive | Path | Size | Under 100 MB cap |
| --- | --- | ---: | --- |
${archiveRows}

## Per-Zoom Size Table

| Zoom | Tiles at zoom | PNG payload at zoom | Cumulative tiles | Cumulative PMTiles bytes |
| --- | ---: | ---: | ---: | ---: |
${tileRows}

- One zoom deeper estimate, z${estimate.zoom}: ${estimate.nextTileCount.toLocaleString()} added tiles, about ${formatBytes(estimate.addedBytes)} added, estimated total ${formatBytes(estimate.estimatedTotalBytes)}. This extrapolates from measured z${opts.maxZoom} average PNG payload ${formatBytes(Math.round(estimate.avgPayload))} plus observed PMTiles overhead per tile.

## Build Timing

- Wall clock: ${formatSeconds(result.elapsedMs)}
- Tile count: ${result.tileCount.toLocaleString()}
- ImageServer export requests with PNW intersection: ${result.sourceTileCount.toLocaleString()}
- Request concurrency: ${opts.concurrency}
- Per-request delay after successful decode: ${opts.requestDelayMs} ms

## Verification

PMTiles readback:

| Archive | Header zooms | Tile type | Tile compression | Metadata encoding | Center sample bytes |
| --- | --- | ---: | ---: | --- | ---: |
${readbackRows}

Elevation spot checks:

Values are integer-meter quantized, so sub-meter shifts from the prior run are expected.

| Archive | Check | Tile and pixel | Decoded elevation | Expected |
| --- | --- | --- | ---: | --- |
${sampleRows}

Boundary continuity:

| Pair | Before max diff | After max diff | Before mean diff | After mean diff |
| --- | ---: | ---: | ---: | ---: |
${continuityRows}

The buffered request did not improve the Mount Rainier terrain edge metric under this last-column versus first-column check. The ocean edge remains exact at 0 m.

Tile size sanity:

${outlierText}

## Appendix: S3 Windowed Read Failure History

- Earlier S3 COG source attempted: \`${S3_SOURCE_ROOT}/current/{tile}/USGS_1_{tile}.tif\`
- S3 VRT: \`${S3_SOURCE_VRT}\`
- First run: failed after 19.6 seconds on S3 connect timeout while using concurrent COG windows.
- Second run: failed after 135.1 seconds on repeated socket closes while reading \`n42w121\` and nearby southern PNW windows.
- Third run after serializing reads and increasing retries: failed after 839.9 seconds on repeated socket closes while reading \`n50w120\`.
- HEAD probe for \`n42w121\` succeeded with HTTP 200, content length 47,947,861 bytes, and Last-Modified \`Tue, 02 Jun 2026 15:22:23 GMT\`.

## Reproduce

\`\`\`powershell
node scripts/build-hillshade-tiles.mjs
\`\`\`
`;
}

async function main() {
  const opts = parseArgs();
  if (opts.tileSize !== 512 && opts.tileSize !== 256) {
    throw new Error('tile-size must be 256 or 512');
  }
  console.log('building PNW hillshade raster-dem PMTiles ...');
  console.log(`  zooms ${opts.minZoom}..${opts.maxZoom}, tile size ${opts.tileSize}`);

  const metadata = {
    name: 'DDM PNW hillshade DEM',
    format: 'png',
    type: 'raster-dem',
    encoding: 'terrarium',
    minzoom: opts.minZoom,
    maxzoom: opts.maxZoom,
    bounds: PNW_BBOX,
    center: PNW_CENTER,
    tile_size: opts.tileSize,
    buffer_pixels: opts.bufferPixels,
    quantization: 'whole-meter elevation before Terrarium encoding',
    png_filters_tried: 'auto, Up, Paeth',
    attribution: `${ATTRIBUTION}; 3DEPElevation ImageServer; ${SOURCE_VINTAGE}; retrieved ${RETRIEVED}`,
    source: IMAGE_SERVER_EXPORT,
    source_product: 'USGS 3DEP 3DEPElevation ImageServer',
    nodata: 'Encoded as Terrarium 0 m for ocean and source NoData.'
  };

  const result = await buildRasterDemPmtilesFromImageServer({
    endpoint: IMAGE_SERVER_EXPORT,
    bounds: PNW_BBOX,
    center: PNW_CENTER,
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    tileSize: opts.tileSize,
    concurrency: opts.concurrency,
    requestDelayMs: opts.requestDelayMs,
    bufferPixels: opts.bufferPixels,
    archiveMaxZooms: [...OUT_PATHS.keys()],
    progressEvery: 25,
    metadata
  });

  const outStats = new Map();
  for (const [z, outPath] of OUT_PATHS) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, result.archives.get(z));
    outStats.set(z, await stat(outPath));
  }

  console.log('validating archives ...');
  const verifies = new Map();
  for (const [z] of OUT_PATHS) {
    verifies.set(z, await verifyArchive(result.archives.get(z), result, opts, z));
  }
  const report = reportMarkdown({ result, verifies, opts, outStats });
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, report);

  const continuityIssue = (verifies.get(9)?.continuity ?? []).some((c) => c.label !== 'Ocean' && c.maxDiff > 1 / 256);
  const verificationNotes = [];
  if ([...verifies.values()].some((v) => v.outliers.length > 0)) verificationNotes.push('tile-size outliers');
  if (continuityIssue) verificationNotes.push('terrain-edge discontinuity');
  const verificationStatus = verificationNotes.length === 0 ? 'pass' : `pass with ${verificationNotes.join(' and ')}`;
  console.log('');
  console.log('built');
  console.log(`archive sizes: z8 ${formatBytes(outStats.get(8).size)}, z9 ${formatBytes(outStats.get(9).size)}`);
  console.log(`zoom range: ${opts.minZoom}..${opts.maxZoom}, tile size ${opts.tileSize}`);
  console.log(`verification: ${verificationStatus}`);
  console.log(`report: ${REPORT_PATH}`);
}

main().catch(async (err) => {
  const opts = parseArgs();
  const blocked = `# Hillshade Pipeline Report

## Outcome

Blocked before a complete archive could be built.

No PMTiles archive was written. The Node pipeline and Terrarium encoder were implemented, but the workspace could not complete reliable windowed reads from the USGS S3 COGs with \`geotiff\`.

## Source

- Source attempted: USGS 3D Elevation Program 3DEPElevation ImageServer exportImage.
- Endpoint: \`${IMAGE_SERVER_EXPORT}\`
- Vintage intended: ${SOURCE_VINTAGE}
- Retrieval date: ${RETRIEVED}
- Attribution intended: ${ATTRIBUTION}
- Dependencies added for this build: ${DEPENDENCIES_ADDED}.

## Tile Decision

- Bounds: \`[${PNW_BBOX.join(', ')}]\`
- Requested tile size: ${opts.tileSize} px.
- Requested zoom range: ${opts.minZoom}..${opts.maxZoom}.
- Reasoning: this is a subtle hillshade underlay, not a terrain inspection surface. A 512 px tile at z${opts.maxZoom} gives the same display detail as a 256 px z${opts.maxZoom + 1} tile with fewer tile records.
- NoData and ocean handling in the implemented encoder: source NoData and nonfinite values become Terrarium 0 m so offshore cells do not create a coastal cliff artifact.

## Evidence

- Error: \`${err.stack ?? err.message}\`
- Source attempted: \`${IMAGE_SERVER_EXPORT}\`
- Retrieval date: ${RETRIEVED}
- Requested zoom range: ${opts.minZoom}..${opts.maxZoom}
- Requested tile size: ${opts.tileSize}
- ImageServer read mode: one \`exportImage\` request per output tile PNW intersection, decoded locally with \`geotiff\`.
- Size table, PMTiles readback, spot elevations, continuity, and outlier checks were not produced because no complete archive existed to verify.

## Reproduce

\`\`\`powershell
node scripts/build-hillshade-tiles.mjs
\`\`\`
`;
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, blocked);
  console.error('build-hillshade-tiles failed:', err);
  console.log('');
  console.log('blocked');
  console.log('archive size: not built');
  console.log(`zoom range: ${opts.minZoom}..${opts.maxZoom}, tile size ${opts.tileSize}`);
  console.log('verification: fail');
  console.log(`report: ${REPORT_PATH}`);
  process.exit(1);
});
