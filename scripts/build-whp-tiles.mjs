/**
 * Build the Pacific Northwest Wildfire Hazard Potential (WHP) drape archive
 * for the desktop 3D Fire view.
 *
 * Source: the 2023 WHP classified raster published by the USDA Forest
 * Service Rocky Mountain Research Station, served as an ESRI ImageServer on
 * the federal GeoPlatform imagery host. This is the SAME service the 2D
 * `usfs-whp` catalog layer draws from, so the drape and the flat layer can
 * never disagree about what WHP says. Resolution is 270 m; the raster is a
 * seven-value classification (five hazard classes plus non-burnable land
 * and water), and the server paints those classes with its own published
 * colors through its default raster function.
 *
 * WHY THIS REPLACED THE FUEL-MODEL DRAPE (owner direction, 2026-08-19).
 * The owner asked for "only the yellow through red colors to indicate
 * risk". The LANDFIRE FBFM40 drape could not honestly answer that: it is a
 * fuel-model classification, not a risk scale, and recoloring its classes
 * into a risk ramp would fabricate a claim the issuer never made (MapLibre
 * also has no client-side raster recolor, so it was not even mechanically
 * possible). WHP is the product that IS a published hazard scale, and its
 * issuer palette already runs bright green through pale green, yellow,
 * orange, to red. A central Oregon sample measured 86 percent of pixels in
 * the yellow-orange-red band, so the owner's ask is answered by choosing
 * the right issuer, not by repainting the wrong one.
 *
 * The bake stores the server's rendered PNG bytes verbatim: DDM chooses no
 * colors and computes no values. Nearest-neighbor resampling keeps class
 * boundaries crisp instead of blending two classes into a color that
 * exists in no legend.
 *
 * Usage: npm run build:whp-tiles
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PMTiles } from 'pmtiles';
import { transformWithOxc } from 'vite';
import { buildRenderedRasterPmtiles } from './lib/raster-image-to-pmtiles.mjs';
import { lonToTileX, latToTileY } from './lib/raster-dem-to-pmtiles.mjs';

const ENDPOINT =
  'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/' +
  'USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer';
const PNW_BBOX = [-125, 41.5, -110.5, 49.5]; // matches the terrain bake exactly
const PNW_CENTER = [-119, 45.5, 5];
const MIN_ZOOM = 0;
/** Measured; the committed depth is chosen by the size ladder below. */
const BAKE_MAX_ZOOM = 9;
const TILE_SIZE = 512;
/**
 * Sized from the measured ladder, not from an assumption.
 *
 * Seven issuer classes at 270 m compress far better than FBFM40's 44
 * classes at 30 m, so this archive lands at roughly half the fuels drape
 * it replaces at the same depth (measured 2026-08-19):
 *
 *   z0-7   4,052,807 bytes    51 tiles
 *   z0-8  13,582,961 bytes   149 tiles
 *   z0-9  33,757,564 bytes   494 tiles
 *
 * The ceiling admits z0-8, matching the fuels drape's shipped depth while
 * cutting 12 MB from every deploy (25.7 MB out, 13.6 MB in). z9 more than
 * doubles the archive for detail a 270 m source does not actually carry.
 *
 * It MUST equal the enforced dataAssets maxBytes for
 * data/whp-2023-pnw.pmtiles in scripts/check-activation-budget.mjs, or a
 * rebake could pass here and fail the gate (or vice versa).
 */
const SIZE_BUDGET_BYTES = 16_000_000;
/** The canary-proven depth; emitting shallower would ship an archive whose
 * palette proof ran at a zoom the archive no longer contains. */
const CANARY_ZOOM = 8;
/**
 * Ceiling on fully transparent tiles.
 *
 * MEASURED, not guessed. A first bake tripped the guard at 37, so every
 * transparent tile across z0-9 was located and classified before this
 * number moved (2026-08-19):
 *
 *   26  entirely north of about 48.9 degrees: British Columbia, outside
 *       the CONUS raster, while the bake box runs to 49.5 to match the
 *       terrain bake exactly
 *   10  the column at longitude -125.16..-124.45 plus one tile in the
 *       Strait of Juan de Fuca: open Pacific beyond the coastal raster.
 *       WHP's own Water class covers inland water INSIDE the footprint;
 *       ocean beyond the footprint is simply absent
 *    1  the single z0 tile spanning the whole world, which this
 *       ImageServer answers with an empty render (the same behavior the
 *       NOAA satellite service shows for a bbox that wide)
 *
 * The ceiling sits just above that measured 37 rather than at a round
 * doubling: the point of the guard is to catch the server dropping tiles
 * INSIDE coverage, and a loose ceiling catches nothing. If a rebake trips
 * this again, locate the tiles before raising it.
 */
const MAX_TRANSPARENT_TILES = 44;
/** UTC retrieval date, matching the archive attribution's own clock. */
const RETRIEVED = new Date().toISOString().slice(0, 10);

const OUT_PATH = fileURLToPath(
  new URL('../public/data/whp-2023-pnw.pmtiles', import.meta.url)
);
const LEGEND_CACHE_PATH = fileURLToPath(
  new URL('./.cache/whp-2023-legend.json', import.meta.url)
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
 * through the oxc-transpile pattern the fuels bake uses, and hard-fail when
 * the fetched issuer legend and the committed USFS_WHP_PRESENTATION
 * literals disagree.
 *
 * This guard exists because the drift it catches ALREADY HAPPENED: before
 * 2026-08-19 the committed table carried a ColorBrewer ramp and five
 * classes while the service served seven classes in different colors, so
 * the in-app key described an image nobody was looking at. A legend that
 * can drift from its raster is a legend that will.
 */
async function assertRuntimeTableMirrors(legendEntries) {
  const sourcePath = fileURLToPath(
    new URL('../src/config/wildfire-presentation.ts', import.meta.url)
  );
  const source = await readFile(sourcePath, 'utf8');
  const transpiled = await transformWithOxc(source, sourcePath, { lang: 'ts' });
  const encoded = Buffer.from(transpiled.code).toString('base64');
  const mod = await import(`data:text/javascript;base64,${encoded}`);
  const table = mod.USFS_WHP_PRESENTATION?.categories;
  if (!Array.isArray(table)) {
    throw new Error('USFS_WHP_PRESENTATION.categories not found in the runtime table');
  }
  if (table.length !== legendEntries.length) {
    throw new Error(
      `runtime table lists ${table.length} classes but the issuer legend serves ${legendEntries.length}; update src/config/wildfire-presentation.ts from the fetched legend`
    );
  }
  for (const [i, entry] of legendEntries.entries()) {
    const committed = table[i];
    if (committed.label !== entry.label || committed.color !== entry.color) {
      throw new Error(
        `runtime table entry ${i} is "${committed.label}" ${committed.color} but the issuer legend serves "${entry.label}" ${entry.color}; update src/config/wildfire-presentation.ts`
      );
    }
  }
  console.log(
    `  runtime WHP table mirrors the fetched issuer legend (${table.length} classes, in order)`
  );
}

async function main() {
  console.log('WHP 2023 risk drape bake (USFS RMRS, PNW box)');
  console.log(`  endpoint: ${ENDPOINT}`);

  const legend = await fetchIssuerLegend();
  await mkdir(new URL('./.cache/', import.meta.url), { recursive: true });
  await writeFile(
    LEGEND_CACHE_PATH,
    `${JSON.stringify({ retrieved: RETRIEVED, entries: legend }, null, 2)}\n`
  );
  console.log(`  issuer legend: ${legend.length} classes; cached to scripts/.cache`);
  for (const entry of legend) console.log(`    ${entry.color}  ${entry.label}`);
  await assertRuntimeTableMirrors(legend);

  const attribution =
    'Wildfire Hazard Potential (WHP) for the United States, 2023 edition; ' +
    'U.S. Department of Agriculture, Forest Service, Rocky Mountain Research ' +
    'Station (Fire Modeling Institute); public domain; ' +
    `accessed ${RETRIEVED} at ${ENDPOINT}; ` +
    'server-rendered with the issuer\'s published class colors at reduced ' +
    'resolution; a static classified snapshot of wildfire hazard potential, ' +
    'not current fire conditions and not a prediction.';

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
      name: 'DDM PNW USFS Wildfire Hazard Potential 2023 drape',
      format: 'png',
      type: 'overlay',
      minzoom: MIN_ZOOM,
      bounds: PNW_BBOX,
      attribution
    },
    canary: {
      // Central Oregon, east of the Cascade crest: mixed hazard classes in
      // the 2026-08-19 sample, so the proof exercises real palette pixels
      // rather than a single-class expanse.
      lon: -121.4,
      lat: 43.8,
      zoom: CANARY_ZOOM,
      paletteHex: legend.map((e) => e.color)
    },
    archiveMaxZooms: Array.from(
      { length: BAKE_MAX_ZOOM - MIN_ZOOM + 1 },
      (_, i) => MIN_ZOOM + i
    )
  });

  console.log(
    `  data tiles: ${result.counts.data}, transparent (skipped): ${result.counts.transparent}`
  );
  console.log('  cumulative archive sizes (the size ladder):');
  for (const s of result.cumulativeSizes) {
    console.log(
      `    z${MIN_ZOOM}-${s.zoom}: ${s.cumulativeBytes.toLocaleString()} bytes (${s.tileCount} tiles)`
    );
  }

  const fit = [...result.cumulativeSizes]
    .reverse()
    .find((s) => s.cumulativeBytes <= SIZE_BUDGET_BYTES);
  if (!fit) throw new Error('no zoom depth fits the size budget; lower BAKE_MAX_ZOOM expectations');
  if (fit.zoom < CANARY_ZOOM) {
    throw new Error(
      `size budget selected max zoom ${fit.zoom}, shallower than the canary-proven z${CANARY_ZOOM}; refusing to emit an unproven archive`
    );
  }
  console.log(
    `  selected max zoom ${fit.zoom} (${fit.cumulativeBytes.toLocaleString()} bytes <= ${SIZE_BUDGET_BYTES.toLocaleString()})`
  );
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
  const sample = await reader.getZxy(
    sampleZ,
    lonToTileX(-121.4, sampleZ),
    latToTileY(43.8, sampleZ)
  );
  if (!sample) throw new Error('validation failed: sample tile did not decode');
  console.log('\nvalidation:');
  console.log(`  header zooms ${header.minZoom}..${header.maxZoom}, tileType ${header.tileType}`);
  console.log(`  sample tile z${sampleZ} decoded: ${sample.data.byteLength} bytes`);
  console.log(`  attribution: "${meta.attribution}"`);
}

main().catch((err) => {
  console.error('build-whp-tiles failed:', err);
  process.exit(1);
});
