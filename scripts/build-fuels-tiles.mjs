/**
 * Build the Pacific Northwest LANDFIRE FBFM40 fuel-model drape archive.
 *
 * Source: LANDFIRE 2024 (LF2024) Scott and Burgan 40 Fire Behavior Fuel
 * Models (FBFM40), CONUS, from the LANDFIRE Program's own ImageServer
 * (lfps.usgs.gov; U.S. Public Domain, USGS-produced). LF2024 is the newest
 * COMPLETE CONUS vintage: the LF2025 update is a phased GeoArea release
 * through December 2026 whose unpopulated areas render silent all-black
 * pixels (verified live 2026-08-18 over the south-east), which is exactly
 * the kind of quiet lie this bake refuses (the builder hard-fails on any
 * all-opaque-black tile).
 *
 * The server renders each tile itself through its default raster function,
 * so every pixel carries LANDFIRE's own published class color; this script
 * chooses no palette and computes no values. Nearest-neighbor resampling
 * keeps class boundaries crisp. The drape is baked at reduced resolution
 * relative to the 30 m source (the committed zoom depth is chosen by the
 * measured archive size against the same-origin Pages hosting budget that
 * governs the hillshade archive); the legend qualification in the app
 * discloses the reduction.
 *
 * The issuer's class legend (labels + colors) is also fetched and written
 * to scripts/.cache for reference; the runtime legend constants in
 * src/config/wildfire-presentation.ts mirror those values as literals.
 *
 * Usage: npm run build:fuels-tiles
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PMTiles } from 'pmtiles';
import { transformWithOxc } from 'vite';
import { buildRenderedRasterPmtiles } from './lib/raster-image-to-pmtiles.mjs';
import { lonToTileX, latToTileY } from './lib/raster-dem-to-pmtiles.mjs';

const ENDPOINT =
  'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/LF2024_FBFM40_CONUS/ImageServer';
const PNW_BBOX = [-125, 41.5, -110.5, 49.5]; // matches the terrain bake exactly
const PNW_CENTER = [-119, 45.5, 5];
const MIN_ZOOM = 0;
const BAKE_MAX_ZOOM = 9; // measured; the committed depth is chosen by size below
const TILE_SIZE = 512;
/**
 * Stay in the hillshade archive's proven same-origin hosting envelope.
 * This MUST equal the enforced dataAssets maxBytes for
 * data/fuels-fbfm40-pnw.pmtiles in scripts/check-activation-budget.mjs, or
 * a rebake could pass here and fail the gate (or vice versa).
 */
const SIZE_BUDGET_BYTES = 30_000_000;
/** The canary-proven depth; emitting shallower would ship an archive whose
 * palette proof ran at a zoom the archive no longer contains. */
const CANARY_ZOOM = 8;
/**
 * Ceiling on fully transparent tiles: within the PNW bake box only the
 * British Columbia strip north of 49 degrees and open Pacific water sit
 * outside LF2024 CONUS coverage (measured 10 such tiles across z0-9 on the
 * 2026-08-19 UTC bake); anything well beyond that means the server started
 * returning empty renders inside coverage.
 */
const MAX_TRANSPARENT_TILES = 24;
/** UTC retrieval date, matching the archive attribution's own clock. */
const RETRIEVED = new Date().toISOString().slice(0, 10);

const OUT_PATH = fileURLToPath(new URL('../public/data/fuels-fbfm40-pnw.pmtiles', import.meta.url));
const LEGEND_CACHE_PATH = fileURLToPath(
  new URL('./.cache/fbfm40-legend-lf2024.json', import.meta.url)
);

/** Decode the issuer legend: label -> #rrggbb from each swatch's center pixel. */
async function fetchIssuerLegend() {
  const res = await fetch(`${ENDPOINT}/legend?f=pjson`);
  if (!res.ok) throw new Error(`legend fetch HTTP ${res.status}`);
  const body = await res.json();
  const legend = body?.layers?.[0]?.legend;
  if (!Array.isArray(legend) || legend.length === 0) {
    throw new Error('legend endpoint returned no entries');
  }
  const entries = [];
  for (const item of legend) {
    const png = PNG.sync.read(Buffer.from(item.imageData, 'base64'));
    const at = ((png.height >> 1) * png.width + (png.width >> 1)) * 4;
    const hex = `#${[png.data[at], png.data[at + 1], png.data[at + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`;
    entries.push({ label: item.label, color: hex });
  }
  return entries;
}

/**
 * Import the runtime presentation table (TypeScript, type-only imports)
 * through the same oxc-transpile pattern build-minimap-whp.mjs uses, and
 * hard-fail the bake when the fetched issuer legend and the committed
 * FBFM40_PRESENTATION literals disagree: the archive's pixels and the
 * in-app key must never drift apart across a rebake.
 */
async function assertRuntimeTableMirrors(classEntries) {
  const sourcePath = fileURLToPath(
    new URL('../src/config/wildfire-presentation.ts', import.meta.url)
  );
  const source = await readFile(sourcePath, 'utf8');
  const transpiled = await transformWithOxc(source, sourcePath, { lang: 'ts' });
  const encoded = Buffer.from(transpiled.code).toString('base64');
  const mod = await import(`data:text/javascript;base64,${encoded}`);
  const table = mod.FBFM40_PRESENTATION?.classes;
  if (!Array.isArray(table)) {
    throw new Error('FBFM40_PRESENTATION.classes not found in the runtime table');
  }
  if (table.length !== classEntries.length) {
    throw new Error(
      `runtime table lists ${table.length} classes but the issuer legend serves ${classEntries.length}; update src/config/wildfire-presentation.ts from the fetched legend`
    );
  }
  const byCode = new Map(table.map((c) => [c.code, c.color]));
  for (const entry of classEntries) {
    const committed = byCode.get(entry.label);
    if (committed !== entry.color) {
      throw new Error(
        `runtime table color for ${entry.label} is ${committed ?? '(missing)'} but the issuer legend serves ${entry.color}; update src/config/wildfire-presentation.ts`
      );
    }
  }
  console.log(`  runtime FBFM40 table mirrors the fetched issuer legend (${table.length} classes)`);
}

async function main() {
  console.log('fuels-fbfm40 drape bake (LF2024, PNW box)');
  console.log(`  endpoint: ${ENDPOINT}`);

  const legend = await fetchIssuerLegend();
  await mkdir(new URL('./.cache/', import.meta.url), { recursive: true });
  await writeFile(LEGEND_CACHE_PATH, `${JSON.stringify({ retrieved: RETRIEVED, entries: legend }, null, 2)}\n`);
  const classEntries = legend.filter((e) => e.label !== 'Fill-NoData');
  console.log(`  issuer legend: ${classEntries.length} classes (+NoData); cached to scripts/.cache`);
  await assertRuntimeTableMirrors(classEntries);

  const attribution =
    'LANDFIRE 2024 (LF2024) Scott and Burgan 40 Fire Behavior Fuel Models (FBFM40), CONUS; ' +
    'U.S. Department of the Interior, Geological Survey, and U.S. Department of Agriculture; ' +
    `public domain; accessed ${RETRIEVED} at ${ENDPOINT}; ` +
    'server-rendered with the issuer\'s published class colors at reduced resolution; ' +
    'a static classified snapshot of the issuer\'s fuel model classes, not a prediction of fire behavior.';

  const result = await buildRenderedRasterPmtiles({
    endpoint: ENDPOINT,
    bounds: PNW_BBOX,
    minZoom: MIN_ZOOM,
    maxZoom: BAKE_MAX_ZOOM,
    tileSize: TILE_SIZE,
    concurrency: 3,
    requestDelayMs: 150,
    progressEvery: 25,
    maxTransparentTiles: MAX_TRANSPARENT_TILES,
    center: PNW_CENTER,
    metadata: {
      name: 'DDM PNW LANDFIRE FBFM40 fuel model drape',
      format: 'png',
      type: 'overlay',
      minzoom: MIN_ZOOM,
      bounds: PNW_BBOX,
      attribution
    },
    canary: {
      lon: -122.72,
      lat: 43.47,
      zoom: CANARY_ZOOM,
      paletteHex: classEntries.map((e) => e.color)
    },
    archiveMaxZooms: Array.from(
      { length: BAKE_MAX_ZOOM - MIN_ZOOM + 1 },
      (_, i) => MIN_ZOOM + i
    )
  });

  console.log(`  data tiles: ${result.counts.data}, transparent (skipped): ${result.counts.transparent}`);
  console.log('  cumulative archive sizes (the section-0 checkpoint):');
  for (const s of result.cumulativeSizes) {
    console.log(`    z${MIN_ZOOM}-${s.zoom}: ${s.cumulativeBytes.toLocaleString()} bytes (${s.tileCount} tiles)`);
  }

  const fit = [...result.cumulativeSizes].reverse().find((s) => s.cumulativeBytes <= SIZE_BUDGET_BYTES);
  if (!fit) throw new Error('no zoom depth fits the size budget; lower BAKE_MAX_ZOOM expectations');
  if (fit.zoom < CANARY_ZOOM) {
    // The emitted archive must contain the canary-proven zoom, or the
    // palette proof certified tiles the archive does not ship.
    throw new Error(
      `size budget selected max zoom ${fit.zoom}, shallower than the canary-proven z${CANARY_ZOOM}; refusing to emit an unproven archive`
    );
  }
  console.log(`  selected max zoom ${fit.zoom} (${fit.cumulativeBytes.toLocaleString()} bytes <= ${SIZE_BUDGET_BYTES.toLocaleString()})`);
  const archive = result.archives.get(fit.zoom);
  if (!archive) throw new Error(`no archive emitted for max zoom ${fit.zoom}`);

  await writeFile(OUT_PATH, archive);
  console.log(`  wrote ${OUT_PATH} (${archive.length.toLocaleString()} bytes)`);

  // Validate: read the archive back through the runtime pmtiles reader.
  const source = {
    getKey: () => 'build',
    getBytes: async (offset, length) => {
      const slice = archive.subarray(offset, offset + length);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    }
  };
  const reader = new PMTiles(source);
  const header = await reader.getHeader();
  const meta = await reader.getMetadata();
  const sampleZ = Math.min(7, fit.zoom);
  const sample = await reader.getZxy(sampleZ, lonToTileX(-122.7, sampleZ), latToTileY(44.0, sampleZ));
  if (!sample) throw new Error('validation failed: sample tile did not decode');
  console.log('\nvalidation:');
  console.log(`  header zooms ${header.minZoom}..${header.maxZoom}, tileType ${header.tileType}`);
  console.log(`  sample tile z${sampleZ} decoded: ${sample.data.byteLength} bytes`);
  console.log(`  attribution: "${meta.attribution}"`);
}

main().catch((err) => {
  console.error('build-fuels-tiles failed:', err);
  process.exit(1);
});
