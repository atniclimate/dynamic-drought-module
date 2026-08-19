/**
 * Build the Pacific Northwest transmission-line archive for the desktop 3D
 * Fire view's power context layer.
 *
 * Source: "U.S. Electric Power Transmission Lines (Archive)" hosted by the
 * Esri Federal_User_Community organization (ArcGIS item
 * d4090758322c4d32a4cd002ffaa0aa12, Living Atlas, public, Extract
 * capability enabled; accessInformation "U.S. Government"). The federal
 * HIFLD Open program that originally published this data was discontinued
 * 2025-08-26; the item states verbatim: "This feature layer has been
 * archived. It will no longer be updated or maintained. Last Data Update:
 * 09/30/2024." Because the source is an orphaned archive rather than a
 * maintained agency feed, DDM bakes a one-time extract instead of fetching
 * it live, and the in-app legend carries the mandatory currency caveat.
 *
 * Attribute honesty: issuer sentinel values are preserved verbatim
 * (VOLTAGE -999999 means unknown; OWNER and VOLT_CLASS may be
 * 'NOT AVAILABLE'); the presentation maps them to a disclosed
 * thinnest-width read, never to a fabricated value. Some source
 * geometries carry OpenStreetMap provenance (the SOURCE field), so the
 * attribution names OpenStreetMap contributors.
 *
 * Usage: npm run build:power-tiles
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';
import { geojsonLayersToPmtiles } from './lib/geojson-to-pmtiles.mjs';

const SERVICE =
  'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0';
const PNW_BBOX = [-125, 41.5, -110.5, 49.5]; // matches the terrain bake exactly
const PNW_CENTER = [-119, 45.5, 5];
const MAX_ZOOM = 10;
const PAGE_SIZE = 2000;
const MAX_PAGES = 10;
/** The PNW envelope held 6,941 lines at extract time (2026-08-19 UTC);
 * a count far outside that band means the archive changed shape. */
const MIN_EXPECTED_FEATURES = 5_000;
const MAX_EXPECTED_FEATURES = 20_000;
/**
 * MUST equal the enforced dataAssets maxBytes for
 * data/power-lines-pnw.pmtiles in scripts/check-activation-budget.mjs, or
 * a rebake could pass here and fail the gate (or vice versa).
 */
const MAX_ARCHIVE_BYTES = 8_000_000;
const FIELDS = ['ID', 'TYPE', 'STATUS', 'OWNER', 'VOLTAGE', 'VOLT_CLASS', 'SOURCEDATE', 'VAL_DATE'];
/** UTC retrieval date, matching the archive attribution's own clock. */
const RETRIEVED = new Date().toISOString().slice(0, 10);

const OUT_PATH = fileURLToPath(new URL('../public/data/power-lines-pnw.pmtiles', import.meta.url));

async function fetchPage(offset) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: PNW_BBOX.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: FIELDS.join(','),
    outSR: '4326',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'geojson'
  });
  const res = await fetch(`${SERVICE}/query?${params.toString()}`);
  if (!res.ok) throw new Error(`page at offset ${offset}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) {
    throw new Error(`page at offset ${offset}: ${JSON.stringify(body.error).slice(0, 160)}`);
  }
  if (!Array.isArray(body.features)) {
    throw new Error(`page at offset ${offset}: no features array`);
  }
  return body;
}

async function main() {
  console.log('power transmission-line bake (archived HIFLD copy, PNW box)');
  console.log(`  service: ${SERVICE}`);

  const features = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchPage(features.length);
    features.push(...body.features);
    console.log(`  fetched ${features.length} features`);
    const more =
      body.exceededTransferLimit === true ||
      body.properties?.exceededTransferLimit === true ||
      body.features.length === PAGE_SIZE;
    if (!more || body.features.length === 0) break;
  }
  if (features.length < MIN_EXPECTED_FEATURES || features.length > MAX_EXPECTED_FEATURES) {
    throw new Error(
      `${features.length} features is outside the expected ${MIN_EXPECTED_FEATURES}..${MAX_EXPECTED_FEATURES} band for the PNW envelope; the archive changed shape`
    );
  }

  // Verbatim attributes; no recoding of issuer sentinels.
  const fc = { type: 'FeatureCollection', features };

  const attribution =
    'U.S. Electric Power Transmission Lines (HIFLD, U.S. Government), via the Esri ' +
    'Federal User Community archive; includes OpenStreetMap-derived geometries ' +
    '(OpenStreetMap contributors); ARCHIVED source, last data update 2024-09-30, ' +
    `no longer maintained; retrieved ${RETRIEVED}; not comprehensive or current and ` +
    'not for siting or safety-critical decisions.';

  const { archive, tileCount } = geojsonLayersToPmtiles(
    { 'power-lines': fc },
    {
      minZoom: 0,
      maxZoom: MAX_ZOOM,
      bounds: PNW_BBOX,
      center: PNW_CENTER,
      tolerance: 1.5,
      name: 'DDM PNW transmission lines (archived HIFLD)',
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
    `  wrote ${OUT_PATH} (${archive.length.toLocaleString()} bytes, ${tileCount} tiles, ${features.length} features)`
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
  console.log(`  vector_layers: ${meta.vector_layers.map((l) => l.id).join(', ')}`);
  console.log(`  attribution: "${meta.attribution}"`);
}

main().catch((err) => {
  console.error('build-power-tiles failed:', err);
  process.exit(1);
});
