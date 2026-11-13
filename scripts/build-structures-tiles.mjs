/**
 * Bake the building footprints archive for the desktop 3D Fire view.
 *
 * Step two of a two-step pipeline; scripts/extract-fema-structures.py is step
 * one and must run first (this script refuses to guess at a missing input).
 *
 * Source: USA Structures, by Oak Ridge National Laboratory for the FEMA
 * Geospatial Response Office. Which edition is the owner's ruling (DR-126):
 * only the 2023 edition that ORNL published on Figshare under CC0, never a
 * later release that names no licence. SOURCES below pins each state file by
 * SHA-256; any other input is refused, so a different edition is a deliberate
 * edit here (EDITION, SOURCES, the output name) plus the three places that
 * name the archive: `structuresPmtilesLocal` in src/config/urls.ts, the
 * dataAssets row in scripts/check-activation-budget.mjs, and
 * scripts/data/structures-tiles-receipt.json (rewritten by this script).
 *
 * Scope: the central_oregon region framing only (src/config/regions.ts
 * bounds), zoom 13 to 14. A whole state is ten times the same-origin size
 * line (Oregon alone was measured at about 82 MB).
 *
 * What is kept: the outline, nothing else. The edition publishes no height
 * for any footprint in this box, and the app draws every building at one
 * stated height; this script refuses to bake if a height ever appears, so
 * that presentation cannot go stale silently.
 *
 * Usage: npm run build:structures-tiles (after the extract)
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

const EDITION = '2023';
const CREDIT =
  'Oak Ridge National Laboratory (ORNL); Federal Emergency Management Agency (FEMA) Geospatial Response Office';
/** The only inputs this bake accepts (DR-126), as Figshare serves them. */
const SOURCES = {
  'Deliverable20230526OR.zip': {
    sha256: 'a15793a8e34334af26c9367c1d3c01e374b59c0e8fa8d5db809c86da6496bd37',
    record: 'https://doi.org/10.6084/m9.figshare.24428884.v1',
    url: 'https://ndownloader.figshare.com/files/42887026',
    licence: 'CC0 1.0'
  },
  'Deliverable20230831WA.zip': {
    sha256: 'dfda4a89331207371fdb890b08ed9da036c438f4ff56abf1f06a891f97c46aac',
    record: 'https://doi.org/10.6084/m9.figshare.24428845.v1',
    url: 'https://ndownloader.figshare.com/files/42886972',
    licence: 'CC0 1.0'
  }
};
const BBOX = [-122.0, 43.5, -120.3, 45.65]; // the central_oregon region framing
const CENTER = [-121.3, 44.35, 10];
const MIN_ZOOM = 13;
const MAX_ZOOM = 14;
/** The 2023 edition holds 153,805 footprints in the box; a count far outside
 * this band means the input is not the expected extract. */
const MIN_EXPECTED_FEATURES = 120_000;
const MAX_EXPECTED_FEATURES = 400_000;
/**
 * MUST equal the enforced dataAssets maxBytes for this archive in
 * scripts/check-activation-budget.mjs (the cross-gate agreement rule;
 * tests/structures-3d.test.mjs holds the two together).
 */
const MAX_ARCHIVE_BYTES = 16_000_000;
const OUT_NAME = `structures-central-oregon-${EDITION}.pmtiles`;

const IN_PATH = fileURLToPath(
  new URL('./.cache/fema-structures-central-oregon.ndjson', import.meta.url)
);
const OUT_PATH = fileURLToPath(new URL(`../public/data/${OUT_NAME}`, import.meta.url));
const RECEIPT_PATH = fileURLToPath(
  new URL('./data/structures-tiles-receipt.json', import.meta.url)
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  console.log(`buildings bake (USA Structures ${EDITION}, central Oregon pilot)`);
  const inPath = process.argv[2] ?? IN_PATH;
  let raw;
  let meta;
  try {
    raw = await readFile(inPath);
    meta = JSON.parse(await readFile(`${inPath}.meta.json`, 'utf8'));
  } catch {
    throw new Error(
      `extract or its .meta.json sidecar not found at ${inPath}; run scripts/extract-fema-structures.py first`
    );
  }
  if (sha256(raw) !== meta.extractSha256) {
    throw new Error('the extract does not match the SHA-256 its sidecar records; run the extract again');
  }
  if (!Array.isArray(meta.bbox) || meta.bbox.length !== 4 || meta.bbox.some((v, i) => v !== BBOX[i])) {
    throw new Error(
      `the extract covers bbox ${JSON.stringify(meta.bbox)} but this artifact claims ${JSON.stringify(BBOX)}; a different region needs its own deliberately renamed artifact`
    );
  }
  if (meta.inputs.length !== Object.keys(SOURCES).length) {
    throw new Error(`expected the inputs ${Object.keys(SOURCES).join(', ')}; the extract read ${meta.inputs.map((i) => i.file).join(', ')}`);
  }
  for (const input of meta.inputs) {
    const pinned = SOURCES[input.file];
    if (!pinned || pinned.sha256 !== input.sha256) {
      throw new Error(
        `${input.file} (${input.sha256}) is not a pinned input. DR-126 allows only the 2023 Figshare edition; a different file is a deliberate edit of SOURCES.`
      );
    }
    if (input.credit !== CREDIT) {
      throw new Error(`${input.file} credits "${input.credit}", not the credit this bake writes`);
    }
  }
  if (meta.withHeight !== 0) {
    throw new Error(
      `${meta.withHeight} footprints carry a published height. The app draws every building at one stated height on the ground that none is published; decide the presentation before baking.`
    );
  }

  // Outline only: no property is written, so nothing but geometry ships.
  const features = raw
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => ({
      type: 'Feature',
      properties: {},
      geometry: JSON.parse(line.replace(/^\x1e/, '')).geometry
    }));
  if (features.length !== meta.features) {
    throw new Error(`${features.length} footprints read but the sidecar says ${meta.features}`);
  }
  if (features.length < MIN_EXPECTED_FEATURES || features.length > MAX_EXPECTED_FEATURES) {
    throw new Error(
      `${features.length} footprints is outside the expected ${MIN_EXPECTED_FEATURES}..${MAX_EXPECTED_FEATURES} band; wrong or stale extract`
    );
  }
  console.log(`  footprints: ${features.length.toLocaleString()}; published heights: 0`);

  const releases = meta.inputs.map((i) => `${i.file} release ${i.release}`).join(', ');
  const attribution =
    `${CREDIT}. USA Structures, ${EDITION} edition as published on Figshare under CC0 1.0 ` +
    `(${releases}); central Oregon pilot coverage only; outlines only, no height is published here.`;

  const { archive, tileCount } = geojsonLayersToPmtiles(
    { structures: { type: 'FeatureCollection', features } },
    {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      bounds: BBOX,
      center: CENTER,
      tolerance: 1,
      name: `DDM central Oregon buildings (USA Structures ${EDITION})`,
      attribution
    }
  );
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `archive is ${archive.length} bytes, over the ${MAX_ARCHIVE_BYTES} ceiling shared with the activation gate`
    );
  }

  // Read-back check through the runtime reader, before anything is written.
  const reader = new PMTiles({
    getKey: () => 'build',
    getBytes: async (offset, length) => {
      const slice = archive.subarray(offset, offset + length);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    }
  });
  const header = await reader.getHeader();
  const archiveMeta = await reader.getMetadata();
  const layers = archiveMeta.vector_layers.map((l) => `${l.id}(${Object.keys(l.fields).join(',')})`);
  if (
    header.minZoom !== MIN_ZOOM ||
    header.maxZoom !== MAX_ZOOM ||
    header.numAddressedTiles !== tileCount ||
    layers.join() !== 'structures()' ||
    archiveMeta.attribution !== attribution
  ) {
    throw new Error(`read-back disagrees with the bake: ${JSON.stringify({ header, layers })}`);
  }
  console.log(`  read back: zooms ${header.minZoom}..${header.maxZoom}, ${tileCount} tiles, layer ${layers[0]}`);

  await writeFile(OUT_PATH, archive);
  const receipt = {
    edition: EDITION,
    built: new Date().toISOString().slice(0, 10),
    bbox: BBOX,
    output: {
      file: OUT_NAME,
      bytes: archive.length,
      sha256: sha256(archive),
      tiles: tileCount,
      zooms: [MIN_ZOOM, MAX_ZOOM],
      footprints: features.length,
      withHeight: meta.withHeight
    },
    extract: { sha256: meta.extractSha256, bytes: meta.extractBytes },
    inputs: meta.inputs.map((input) => ({ ...input, ...SOURCES[input.file] }))
  };
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`  wrote ${OUT_PATH} (${archive.length.toLocaleString()} bytes, SHA-256 ${receipt.output.sha256})`);
  console.log(`  wrote ${RECEIPT_PATH}`);
}

main().catch((err) => {
  console.error('build-structures-tiles failed:', err.message ?? err);
  process.exit(1);
});
