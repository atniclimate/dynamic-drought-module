/**
 * Bake the building footprints archive for the desktop 3D Fire view.
 *
 * Step three of a three-step pipeline: scripts/extract-fema-structures.py
 * writes the footprints, scripts/sample-gba-heights.py gives each one a
 * height, and both must run first (this script refuses to guess at a missing
 * input).
 *
 * Outlines: USA Structures, by Oak Ridge National Laboratory for the FEMA
 * Geospatial Response Office. Which edition is the owner's ruling (DR-126):
 * only the 2023 edition that ORNL published on Figshare under CC0, never a
 * later release that names no licence. SOURCES below pins each state file by
 * SHA-256; any other input is refused.
 *
 * Heights: GBA.Height, the height raster of GlobalBuildingAtlas (Technical
 * University of Munich), CC BY-NC 4.0, modeled from 2019 satellite imagery
 * and not surveyed (owner, 2026-11-13). Only the raster is used; no footprint
 * product of that issuer enters the chain. HEIGHTS below pins the sampled
 * heights file whole, and that file records the extract it was sampled over
 * and the SHA-256 of every raster cell file it read.
 *
 * A different edition or height source is a deliberate edit here (EDITION,
 * SOURCES, HEIGHTS, ARCHIVE_DATE) plus the three places that name the
 * archive: `structuresPmtilesLocal` in src/config/urls.ts, the dataAssets row
 * in scripts/check-activation-budget.mjs, and
 * scripts/data/structures-tiles-receipt.json (rewritten by this script).
 *
 * Scope: the central_oregon region framing only (src/config/regions.ts
 * bounds), zoom 13 to 14. A whole state is ten times the same-origin size
 * line (Oregon alone was measured at about 82 MB).
 *
 * What is kept: the outline and, where the raster gives an estimate, one
 * whole number, `h`, the height to draw in metres. An estimate under 3 m is
 * stored as 3; a footprint with no estimate carries no `h` and the app draws
 * its stated placeholder height. This script refuses to bake a height that is
 * not a whole number from 3 to 200.
 *
 * Usage: npm run build:structures-tiles (after the extract and the sampling)
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

const EDITION = '2023';
/** The month this pairing of outlines and heights was first baked; part of the file name. */
const ARCHIVE_DATE = '2026-11';
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
/** The only heights this bake accepts: the file scripts/sample-gba-heights.py wrote from GBA.Height. */
const HEIGHTS = {
  sha256: '2ad92bca3718033bd13dbb37434f21edf2055eab3b25bbcec3e9080f19c54324',
  source: 'GBA.Height (GlobalBuildingAtlas)',
  // The paper's own "How to cite" line (https://essd.copernicus.org/articles/17/6647/2025/).
  credit:
    'Zhu, X. X., Chen, S., Zhang, F., Shi, Y., and Wang, Y.: GlobalBuildingAtlas: an open global and complete dataset of building polygons, heights and LoD1 3D models, Earth Syst. Sci. Data, 17, 6647–6668, https://doi.org/10.5194/essd-17-6647-2025, 2025',
  record: 'https://doi.org/10.14459/2025mp1782307',
  terms: 'https://tubvsig-so2sat-vm1.srv.mwn.de/terms_of_use.html',
  licence: 'CC BY-NC 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
  retrieved: '2026-11-13'
};
/** The tile property that carries a footprint's drawn height in metres. */
const HEIGHT_PROPERTY = 'h';
const MIN_HEIGHT_M = 3;
const MAX_HEIGHT_M = 200;
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
const OUT_NAME = `structures-central-oregon-${ARCHIVE_DATE}.pmtiles`;

const IN_PATH = fileURLToPath(
  new URL('./.cache/fema-structures-central-oregon.ndjson', import.meta.url)
);
const HEIGHTS_PATH = fileURLToPath(
  new URL('./.cache/gba-heights-central-oregon.json', import.meta.url)
);
const OUT_PATH = fileURLToPath(new URL(`../public/data/${OUT_NAME}`, import.meta.url));
const RECEIPT_PATH = fileURLToPath(
  new URL('./data/structures-tiles-receipt.json', import.meta.url)
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  console.log(`buildings bake (USA Structures ${EDITION} outlines, GBA.Height heights, central Oregon pilot)`);
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

  let heightsRaw;
  try {
    heightsRaw = await readFile(HEIGHTS_PATH);
  } catch {
    throw new Error(`sampled heights not found at ${HEIGHTS_PATH}; run scripts/sample-gba-heights.py first`);
  }
  if (sha256(heightsRaw) !== HEIGHTS.sha256) {
    throw new Error(
      `the sampled heights (${sha256(heightsRaw)}) are not the pinned file; different heights are a deliberate edit of HEIGHTS.`
    );
  }
  const sampled = JSON.parse(heightsRaw.toString('utf8'));
  if (sampled.extractSha256 !== meta.extractSha256) {
    throw new Error('the heights were sampled over a different extract; run scripts/sample-gba-heights.py again');
  }
  const { heights } = sampled;
  const bad = heights.findIndex(
    (h) => h !== null && !(Number.isInteger(h) && h >= MIN_HEIGHT_M && h <= MAX_HEIGHT_M)
  );
  if (bad !== -1) {
    throw new Error(
      `footprint ${bad} has the height ${JSON.stringify(heights[bad])}; every height must be a whole number from ${MIN_HEIGHT_M} to ${MAX_HEIGHT_M}`
    );
  }

  // The outline and the drawn height only: no other property is written.
  const features = raw
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, i) => ({
      type: 'Feature',
      properties: heights[i] == null ? {} : { [HEIGHT_PROPERTY]: heights[i] },
      geometry: JSON.parse(line.replace(/^\x1e/, '')).geometry
    }));
  if (features.length !== meta.features || features.length !== heights.length) {
    throw new Error(
      `${features.length} footprints read; the sidecar says ${meta.features} and the heights file holds ${heights.length}`
    );
  }
  if (features.length < MIN_EXPECTED_FEATURES || features.length > MAX_EXPECTED_FEATURES) {
    throw new Error(
      `${features.length} footprints is outside the expected ${MIN_EXPECTED_FEATURES}..${MAX_EXPECTED_FEATURES} band; wrong or stale extract`
    );
  }
  const withHeight = heights.filter((h) => h !== null).length;
  if (
    withHeight !== sampled.counts.withEstimate ||
    features.length - withHeight !== sampled.counts.withoutEstimate
  ) {
    throw new Error('the heights file disagrees with its own counts');
  }
  console.log(
    `  footprints: ${features.length.toLocaleString()}; with a height: ${withHeight.toLocaleString()}; without: ${(features.length - withHeight).toLocaleString()}`
  );

  const releases = meta.inputs.map((i) => `${i.file} release ${i.release}`).join(', ');
  const attribution =
    `${CREDIT}. USA Structures, ${EDITION} edition as published on Figshare under CC0 1.0 ` +
    `(${releases}); central Oregon pilot coverage only. ` +
    `Heights: ${HEIGHTS.source}, ${HEIGHTS.record}, licensed ${HEIGHTS.licence} (${HEIGHTS.licenceUrl}); ` +
    `${HEIGHTS.credit}. Changes made: estimates modeled from 2019 satellite imagery, not surveyed, were sampled as the ` +
    `${sampled.statistic}, rounded to whole metres and raised to ${MIN_HEIGHT_M} m where lower; a footprint with no estimate carries no height.`;

  const { archive, tileCount } = geojsonLayersToPmtiles(
    { structures: { type: 'FeatureCollection', features } },
    {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      bounds: BBOX,
      center: CENTER,
      tolerance: 1,
      name: `DDM central Oregon buildings (USA Structures ${EDITION}, GBA.Height)`,
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
    layers.join() !== `structures(${HEIGHT_PROPERTY})` ||
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
      heightProperty: HEIGHT_PROPERTY,
      withHeight,
      withoutHeight: features.length - withHeight,
      raisedToMinimum: sampled.counts.under3m,
      minimumHeightMeters: MIN_HEIGHT_M
    },
    extract: { sha256: meta.extractSha256, bytes: meta.extractBytes },
    inputs: meta.inputs.map((input) => ({ ...input, ...SOURCES[input.file] })),
    heights: {
      ...HEIGHTS,
      bytes: heightsRaw.length,
      statistic: sampled.statistic,
      raster: sampled.raster,
      counts: sampled.counts,
      cells: sampled.cells
    }
  };
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`  wrote ${OUT_PATH} (${archive.length.toLocaleString()} bytes, SHA-256 ${receipt.output.sha256})`);
  console.log(`  wrote ${RECEIPT_PATH}`);
}

main().catch((err) => {
  console.error('build-structures-tiles failed:', err.message ?? err);
  process.exit(1);
});
