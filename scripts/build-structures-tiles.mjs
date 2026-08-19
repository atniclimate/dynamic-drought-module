/**
 * Build the central Oregon structures archive for the desktop 3D Fire
 * view's building context.
 *
 * Source: the Overture Maps Foundation buildings theme (ODbL; fuses
 * OpenStreetMap, Esri Community Maps, Microsoft ML Building Footprints,
 * Google Open Buildings, and other open sources), extracted by
 * scripts/extract-overture-buildings.py into scripts/.cache. Run the
 * extract first; this script refuses to guess at a missing input.
 *
 * Scope honesty: the committed default covers the central_oregon region
 * framing only (src/config/regions.ts bounds). The full PNW terrain box
 * holds 9,160,813 footprints, roughly 240 MB of z14 vector tiles at the
 * empirically measured 26 bytes per building, which no same-origin Pages
 * path can carry; the 3D Fire control's coverage note and the structures
 * legend both state the pilot coverage, and a deployer can bake any other
 * region with the extract script's --bbox parameter.
 *
 * Height honesty: `height` is baked (rounded to 0.1 m) only where the
 * issuer published it; `num_floors` likewise. The runtime extrudes
 * published heights, draws placeholder heights in a visibly dimmer tone,
 * and the legend says which is which. Nothing here estimates a height the
 * issuer did not publish; the placeholder rule (three meters per
 * published floor, otherwise four meters) is a disclosed presentation
 * constant, not a data claim.
 *
 * Usage: npm run build:structures-tiles (after the extract)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

const RELEASE = '2026-07-22.0';
const BBOX = [-122.0, 43.5, -120.3, 45.65]; // the central_oregon region framing
const CENTER = [-121.3, 44.35, 10];
const MIN_ZOOM = 13;
const MAX_ZOOM = 14;
/** The extract held 189,769 footprints at 2026-08-19 UTC; a count far
 * outside this band means the input is not the expected extract. */
const MIN_EXPECTED_FEATURES = 120_000;
const MAX_EXPECTED_FEATURES = 400_000;
/**
 * MUST equal the enforced dataAssets maxBytes for
 * data/structures-central-oregon.pmtiles in
 * scripts/check-activation-budget.mjs (the cross-gate agreement rule).
 */
const MAX_ARCHIVE_BYTES = 16_000_000;
/** UTC retrieval date recorded by the extract; restated here for the
 * attribution (the bake is deterministic over the cached extract). */
const IN_PATH = fileURLToPath(
  new URL('./.cache/overture-buildings-central-oregon.json', import.meta.url)
);
const OUT_PATH = fileURLToPath(
  new URL('../public/data/structures-central-oregon.pmtiles', import.meta.url)
);

async function main() {
  console.log('structures bake (Overture buildings, central Oregon pilot)');
  let raw;
  try {
    raw = await readFile(IN_PATH, 'utf8');
  } catch {
    throw new Error(
      `extract not found at ${IN_PATH}; run scripts/extract-overture-buildings.py first`
    );
  }

  const features = [];
  let withHeight = 0;
  let withFloors = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const geometry = typeof row.geom === 'string' ? JSON.parse(row.geom) : row.geom;
    const properties = {};
    if (Number.isFinite(row.height) && row.height > 0) {
      properties.h = Math.round(row.height * 10) / 10;
      withHeight++;
    }
    if (Number.isInteger(row.num_floors) && row.num_floors > 0) {
      properties.f = row.num_floors;
      withFloors++;
    }
    features.push({ type: 'Feature', properties, geometry });
  }
  if (features.length < MIN_EXPECTED_FEATURES || features.length > MAX_EXPECTED_FEATURES) {
    throw new Error(
      `${features.length} footprints is outside the expected ${MIN_EXPECTED_FEATURES}..${MAX_EXPECTED_FEATURES} band; wrong or stale extract`
    );
  }
  const heightShare = ((withHeight / features.length) * 100).toFixed(0);
  console.log(
    `  footprints: ${features.length.toLocaleString()}; published heights: ${withHeight.toLocaleString()} (${heightShare}%); published floors: ${withFloors.toLocaleString()}`
  );

  const attribution =
    '(c) Overture Maps Foundation, (c) OpenStreetMap contributors (ODbL); ' +
    `buildings theme release ${RELEASE}; retrieved 2026-08-19 UTC; ` +
    `central Oregon pilot coverage only; ${heightShare}% of footprints carry an ` +
    'issuer-published height, and the app draws the rest at a disclosed placeholder height.';

  const { archive, tileCount } = geojsonLayersToPmtiles(
    { structures: { type: 'FeatureCollection', features } },
    {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      bounds: BBOX,
      center: CENTER,
      tolerance: 1,
      name: 'DDM central Oregon structures (Overture buildings)',
      attribution
    }
  );
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `archive is ${archive.length} bytes, over the ${MAX_ARCHIVE_BYTES} ceiling shared with the activation gate`
    );
  }

  await writeFile(OUT_PATH, archive);
  console.log(
    `  wrote ${OUT_PATH} (${archive.length.toLocaleString()} bytes, ${tileCount} tiles, z${MIN_ZOOM}-${MAX_ZOOM})`
  );

  // Read-back validation through the runtime reader.
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
  console.log('\nvalidation:');
  console.log(`  header zooms ${header.minZoom}..${header.maxZoom}, tileType ${header.tileType}`);
  console.log(`  vector_layers: ${meta.vector_layers.map((l) => `${l.id}(${Object.keys(l.fields).join(',') || 'no fields'})`).join(', ')}`);
  console.log(`  attribution: "${meta.attribution}"`);
}

main().catch((err) => {
  console.error('build-structures-tiles failed:', err);
  process.exit(1);
});
