/**
 * Build the Pacific Northwest (PNW) ecoregion PMTiles bundle (Phase D, Phase 8).
 *
 * Source: the Environmental Protection Agency (EPA) Omernik Level III and Level
 * IV ecoregions, EPA Region 10 pre-clipped shapefiles on the agency's public
 * Amazon Web Services Simple Storage Service (S3) bucket (wildcard Cross-Origin
 * Resource Sharing (CORS), verified live 2026-05-30; see src/config/urls.ts).
 * The shapefiles are Albers Equal Area Conic (North American Datum 1983); this
 * script reprojects them to World Geodetic System 1984 (WGS 84), clips to the
 * PNW bounding box (dropping the Alaska part of Region 10), simplifies, keeps
 * only the name and code fields, and bakes a two-layer PMTiles vector bundle
 * (ecoregions-l3, ecoregions-l4) committed to public/data/.
 *
 * This is a precompute step in the style of build-enso-snapshot.mjs: run
 * occasionally (the ecoregion delineation is a static 2012 scientific
 * reference, not a live feed), commit the output with its retrieval date. It
 * runs entirely in Node with no native tooling, so it works on this Windows
 * toolchain and in continuous integration alike.
 *
 * Honesty: ecoregion boundaries are a landscape representation, not a
 * jurisdictional boundary. The simplification tolerance and source vintage are
 * recorded in the archive metadata and printed here so the overlay never
 * implies precision the source does not carry.
 *
 * Usage: npm run build:ecoregion-tiles
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import { unzipSync } from 'fflate';
import { PMTiles } from 'pmtiles';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

const PNW_BBOX = [-125, 41.5, -110.5, 49.5]; // [minLon, minLat, maxLon, maxLat]
const PNW_CENTER = [-119, 45.5, 5];
const MAX_ZOOM = 10;
const SIMPLIFY = '18%';
const SOURCE_VINTAGE = '2012 (EPA Region 10 Omernik delineation)';
const RETRIEVED = '2026-05-30';
const ATTRIBUTION = 'EPA Omernik Ecoregions (Level III and IV), Region 10';

const S3_ROOT = 'https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/reg10';
const SOURCES = {
  'ecoregions-l3': {
    zip: `${S3_ROOT}/reg10_eco_l3.zip`,
    shp: 'reg10_eco_l3.shp',
    fields: 'US_L3CODE,US_L3NAME,NA_L3CODE,NA_L3NAME'
  },
  'ecoregions-l4': {
    zip: `${S3_ROOT}/reg10_eco_l4.zip`,
    shp: 'reg10_eco_l4.shp',
    fields: 'US_L4CODE,US_L4NAME,US_L3CODE,US_L3NAME,NA_L3CODE,NA_L3NAME'
  }
};

const OUT_PATH = fileURLToPath(new URL('../public/data/ecoregions-pnw.pmtiles', import.meta.url));
const CATALOG_OUT_PATH = fileURLToPath(
  new URL('../public/data/ecoregions-pnw-catalog.json', import.meta.url)
);
const CACHE_DIR = join(tmpdir(), 'ddm-ecoregion-cache');

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

/** Reproject to WGS 84, clip to the PNW, simplify, and keep only name/code fields. */
function mapshaperToGeoJson(input, shpName, fields) {
  const cmd = [
    `-i ${shpName} encoding=utf8`,
    '-proj wgs84',
    `-clip bbox=${PNW_BBOX.join(',')}`,
    `-simplify ${SIMPLIFY} keep-shapes`,
    `-filter-fields ${fields}`,
    '-o out.geojson format=geojson precision=0.0001'
  ].join(' ');
  return new Promise((resolve, reject) => {
    mapshaper.applyCommands(cmd, input, (err, output) => {
      if (err) return reject(err);
      const text = output['out.geojson'];
      if (!text) return reject(new Error(`mapshaper produced no output for ${shpName}`));
      resolve(JSON.parse(text));
    });
  });
}

/** Build the catalog from the same clipped feature collections sent to PMTiles. */
function buildCatalogManifest(layers) {
  const specs = [
    ['ecoregions-l3', 'III', 'US_L3CODE', 'US_L3NAME'],
    ['ecoregions-l4', 'IV', 'US_L4CODE', 'US_L4NAME']
  ];
  const entries = new Map();
  for (const [layerName, level, codeField, nameField] of specs) {
    const layer = layers[layerName];
    if (!layer || !Array.isArray(layer.features)) {
      throw new Error(`catalog source layer missing: ${layerName}`);
    }
    for (const feature of layer.features) {
      const rawCode = feature?.properties?.[codeField];
      const rawName = feature?.properties?.[nameField];
      const code = rawCode === null || rawCode === undefined ? '' : String(rawCode).trim();
      const name = rawName === null || rawName === undefined ? '' : String(rawName).trim();
      if (!code || !name) {
        throw new Error(`catalog field missing in ${layerName}: ${codeField}/${nameField}`);
      }
      const key = `${level}:${code}`;
      const prior = entries.get(key);
      if (prior && prior.name !== name) {
        throw new Error(`conflicting catalog names for ${key}: ${prior.name}/${name}`);
      }
      entries.set(key, { code, name, level });
    }
  }
  return {
    entries: [...entries.values()].sort((a, b) => {
      const levelOrder = a.level === b.level ? 0 : a.level === 'III' ? -1 : 1;
      return levelOrder || a.code.localeCompare(b.code, undefined, { numeric: true });
    })
  };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });

  const layers = {};
  for (const [layerName, src] of Object.entries(SOURCES)) {
    console.log(`\n${layerName}:`);
    const zipBuffer = await fetchCached(src.zip);
    const input = unzipShapefile(zipBuffer);
    const fc = await mapshaperToGeoJson(input, src.shp, src.fields);
    console.log(`  features after clip/simplify: ${fc.features.length}`);
    layers[layerName] = fc;
  }

  console.log('\nbaking PMTiles ...');
  const catalog = buildCatalogManifest(layers);
  const { archive, tileCount, vectorLayers } = geojsonLayersToPmtiles(layers, {
    minZoom: 0,
    maxZoom: MAX_ZOOM,
    bounds: PNW_BBOX,
    center: PNW_CENTER,
    name: 'DDM PNW ecoregions',
    attribution: `${ATTRIBUTION}; vintage ${SOURCE_VINTAGE}; simplified ${SIMPLIFY}; retrieved ${RETRIEVED}`
  });

  await Promise.all([
    writeFile(OUT_PATH, archive),
    writeFile(CATALOG_OUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`)
  ]);
  console.log(`  wrote ${OUT_PATH}`);
  console.log(`  wrote ${CATALOG_OUT_PATH} (${catalog.entries.length} catalog members)`);
  console.log(`  tiles: ${tileCount}, size: ${(archive.length / 1024).toFixed(1)} KiB`);

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
  const sampleZ = Math.min(7, MAX_ZOOM);
  const sample = await reader.getZxy(sampleZ, lonX(PNW_CENTER[0], sampleZ), latY(PNW_CENTER[1], sampleZ));
  if (!sample) throw new Error('validation failed: center tile did not decode');
  console.log('\nvalidation:');
  console.log(`  header zooms ${header.minZoom}..${header.maxZoom}, tileType ${header.tileType}`);
  console.log(`  vector_layers: ${meta.vector_layers.map((l) => `${l.id}(${Object.keys(l.fields).length} fields)`).join(', ')}`);
  console.log(`  center tile z${sampleZ} decoded: ${sample.data.byteLength} bytes`);
  console.log('\nOK. Honesty note baked into attribution:');
  console.log(`  "${meta.attribution}"`);
}

function lonX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

main().catch((err) => {
  console.error('build-ecoregion-tiles failed:', err);
  process.exit(1);
});
