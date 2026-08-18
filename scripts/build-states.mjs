/**
 * Build the bundled United States state-boundary GeoJSON (E1, national framing).
 *
 * Source: the United States Census Bureau cartographic boundary file for
 * states, 1:20,000,000 generalization, 2023 vintage, public domain
 * (https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html).
 * State boundaries are public administrative reference data, not
 * sovereign-jurisdiction polygons, so bundling them is consistent with the
 * no-redistribution hard rule (the rule protects Tribal, Treaty, and
 * sovereign-jurisdiction data).
 *
 * The 1:20,000,000 generalization is deliberately coarse: the layer exists as
 * a selectable reference boundary (click a state, get the impact briefing and
 * resource routing), not as a survey-grade depiction. The generalization and
 * vintage are recorded in the output's metadata member so the layer never
 * implies precision the source does not carry.
 *
 * This is a precompute step in the style of build-ecoregion-tiles.mjs: run
 * once per Census vintage, commit the output with its retrieval date.
 *
 * Usage: npm run build:states
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import { unzipSync } from 'fflate';

const SOURCE_ZIP =
  'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_20m.zip';
const SOURCE_SHP = 'cb_2023_us_state_20m.shp';
// STATEFP (Federal Information Processing Standards code), STUSPS (two-letter
// postal code), and NAME are the three fields the layer, the popup, and the
// resource routing consume.
const FIELDS = 'STATEFP,STUSPS,NAME';
const SOURCE_VINTAGE = '2023 (Census cartographic boundary, 1:20,000,000)';
const RETRIEVED = '2026-07-01';

const OUT_PATH = fileURLToPath(
  new URL('../public/data/us-states.geojson', import.meta.url)
);
const CACHE_DIR = join(tmpdir(), 'ddm-states-cache');

/** Download a URL to a cache file, reusing the cached copy when present. */
async function fetchCached(url) {
  const cachePath = join(CACHE_DIR, basename(url));
  try {
    const s = await stat(cachePath);
    if (s.size > 0) {
      console.log(`  cache hit:  ${basename(url)} (${s.size.toLocaleString()} bytes)`);
      return readFile(cachePath);
    }
  } catch {
    // not cached yet
  }
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(cachePath, buf);
  console.log(`  saved:      ${basename(url)} (${buf.length.toLocaleString()} bytes)`);
  return buf;
}

/** Unzip a shapefile bundle into a filename -> Buffer dict (basenames only). */
function unzipShapefile(zipBuffer) {
  const members = unzipSync(new Uint8Array(zipBuffer));
  const input = {};
  for (const [name, bytes] of Object.entries(members)) {
    if (name.endsWith('/')) continue; // directory entry
    input[basename(name)] = Buffer.from(bytes);
  }
  return input;
}

/** Convert to WGS 84 GeoJSON keeping only the identity fields. */
function mapshaperToGeoJson(input) {
  const cmd = [
    `-i ${SOURCE_SHP} encoding=utf8`,
    '-proj wgs84',
    `-filter-fields ${FIELDS}`,
    '-o out.geojson format=geojson precision=0.0001'
  ].join(' ');
  return new Promise((resolve, reject) => {
    mapshaper.applyCommands(cmd, input, (err, output) => {
      if (err) return reject(err);
      const text = output['out.geojson'];
      if (!text) return reject(new Error(`mapshaper produced no output for ${SOURCE_SHP}`));
      resolve(JSON.parse(text));
    });
  });
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });

  console.log('us-states:');
  const zipBuffer = await fetchCached(SOURCE_ZIP);
  const input = unzipShapefile(zipBuffer);
  const fc = await mapshaperToGeoJson(input);
  console.log(`  features: ${fc.features.length}`);

  const names = fc.features
    .map((f) => f.properties && f.properties.STUSPS)
    .filter(Boolean)
    .sort();
  console.log(`  codes: ${names.join(' ')}`);

  // Foreign member carrying provenance (valid per RFC 7946 section 6.1); the
  // honesty stamp the Phase D guards require for every baked artifact.
  fc.metadata = {
    source: SOURCE_ZIP,
    attribution: 'U.S. Census Bureau cartographic boundary file',
    vintage: SOURCE_VINTAGE,
    retrieved: RETRIEVED,
    fields: FIELDS.split(',')
  };

  const text = JSON.stringify(fc);
  await writeFile(OUT_PATH, text);
  console.log(`  wrote ${OUT_PATH} (${(text.length / 1024).toFixed(1)} KiB)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
