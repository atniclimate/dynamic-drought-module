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
import { transformWithOxc } from 'vite';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

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
/**
 * The release id, retrieval date, bbox, and count all come from the
 * extract's sidecar (never hand-typed constants): a re-pinned or
 * re-scoped extract can never ship a stale vintage, because the bake
 * refuses to run without the sidecar and refuses a sidecar whose bbox
 * disagrees with the region this artifact claims to cover.
 */
const IN_PATH = fileURLToPath(
  new URL('./.cache/overture-buildings-central-oregon.json', import.meta.url)
);
const META_PATH = `${IN_PATH}.meta.json`;
const OUT_PATH = fileURLToPath(
  new URL('../public/data/structures-central-oregon.pmtiles', import.meta.url)
);

/**
 * The in-app disclosure constants must state the SAME release and height
 * share the archive attribution carries: the oxc-import cross-gate fails
 * the bake on drift, so the legend can never misdescribe the artifact.
 */
async function assertDisclosuresMirror(release, heightShare) {
  const sourcePath = fileURLToPath(
    new URL('../src/config/wildfire-presentation.ts', import.meta.url)
  );
  const source = await readFile(sourcePath, 'utf8');
  const transpiled = await transformWithOxc(source, sourcePath, { lang: 'ts' });
  const encoded = Buffer.from(transpiled.code).toString('base64');
  const mod = await import(`data:text/javascript;base64,${encoded}`);
  const qualification = mod.STRUCTURES_QUALIFICATION;
  if (typeof qualification !== 'string') {
    throw new Error('STRUCTURES_QUALIFICATION not found in the runtime table');
  }
  if (!qualification.includes(`release ${release}`)) {
    throw new Error(
      `STRUCTURES_QUALIFICATION does not state release ${release}; update src/config/wildfire-presentation.ts to match the extract`
    );
  }
  if (!qualification.includes(`${heightShare} percent`)) {
    throw new Error(
      `STRUCTURES_QUALIFICATION does not state ${heightShare} percent published heights; update src/config/wildfire-presentation.ts to match this bake`
    );
  }
  console.log('  in-app qualification mirrors the bake (release and height share)');
}

async function main() {
  console.log('structures bake (Overture buildings, central Oregon pilot)');
  let raw;
  let meta;
  try {
    raw = await readFile(IN_PATH, 'utf8');
    meta = JSON.parse(await readFile(META_PATH, 'utf8'));
  } catch {
    throw new Error(
      `extract or its .meta.json sidecar not found beside ${IN_PATH}; run scripts/extract-overture-buildings.py first`
    );
  }
  if (
    !Array.isArray(meta.bbox) ||
    meta.bbox.length !== 4 ||
    meta.bbox.some((v, i) => v !== BBOX[i])
  ) {
    throw new Error(
      `the extract sidecar covers bbox ${JSON.stringify(meta.bbox)} but this artifact claims ${JSON.stringify(BBOX)}; a different region needs its own deliberately renamed artifact and updated disclosures (public/data/README.md lists them)`
    );
  }
  if (typeof meta.release !== 'string' || typeof meta.retrieved !== 'string') {
    throw new Error('the extract sidecar is missing release or retrieved');
  }

  const features = [];
  let withHeight = 0;
  let withFloors = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const geometry = typeof row.geom === 'string' ? JSON.parse(row.geom) : row.geom;
    const properties = {};
    // Sub-decimeter published heights (24 records in the 2026-08-19
    // extract) would round to h=0 and extrude to nothing while the
    // placeholder split skips them; a height that small is not a usable
    // extrusion, so those footprints take the disclosed placeholder path.
    const roundedHeight = Number.isFinite(row.height)
      ? Math.round(row.height * 10) / 10
      : 0;
    if (roundedHeight >= 0.1) {
      properties.h = roundedHeight;
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
  await assertDisclosuresMirror(meta.release, heightShare);

  const attribution =
    '(c) Overture Maps Foundation, (c) OpenStreetMap contributors (ODbL); ' +
    `buildings theme release ${meta.release}; retrieved ${meta.retrieved} UTC; ` +
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
  const archiveMeta = await reader.getMetadata();
  console.log('\nvalidation:');
  console.log(`  header zooms ${header.minZoom}..${header.maxZoom}, tileType ${header.tileType}`);
  console.log(`  vector_layers: ${archiveMeta.vector_layers.map((l) => `${l.id}(${Object.keys(l.fields).join(',') || 'no fields'})`).join(', ')}`);
  console.log(`  attribution: "${archiveMeta.attribution}"`);
}

main().catch((err) => {
  console.error('build-structures-tiles failed:', err);
  process.exit(1);
});
