/**
 * DDM's own base map (DDM-P17-T12): the shipped archives, the style's stacking,
 * and the Tribal-area street envelope.
 *
 * Run: node --test tests/base-map.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root));

async function open(rel) {
  const bytes = read(rel);
  const reader = new PMTiles({
    getKey: () => rel,
    getBytes: async (offset, length) => {
      const s = bytes.subarray(offset, offset + length);
      return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    }
  });
  return { header: await reader.getHeader(), meta: await reader.getMetadata(), size: statSync(new URL(rel, root)).size };
}

const BASE_ISSUERS = ['U.S. Census Bureau', 'U.S. Geological Survey', 'Natural Resources Canada', 'Natural Earth'];
const ARCHIVES = [
  ['public/data/ddm-base-na-2026-11.pmtiles', 8, ['land', 'water', 'river', 'boundary', 'county', 'place', 'water_label'], BASE_ISSUERS],
  ['public/data/ddm-roads-na-2026-11.pmtiles', 8, ['road', 'rail'], BASE_ISSUERS],
  ['public/data/ddm-base-world-2026-11.pmtiles', 5, ['land', 'water', 'boundary', 'place', 'water_label'], BASE_ISSUERS],
  ['public/data/ddm-forests-2026-11.pmtiles', 10, ['forest'], ['USDA Forest Service']]
];

for (const [rel, maxZoom, layers, issuers] of ARCHIVES) {
  test(`${rel} ships its layers, zooms and credits under the 20 MB line`, async () => {
    const { header, meta, size } = await open(rel);
    assert.ok(size <= 20 * 1024 * 1024, `${size} bytes is over the public-tree line (DR-150)`);
    assert.equal(header.minZoom, 0);
    assert.equal(header.maxZoom, maxZoom);
    assert.deepEqual(meta.vector_layers.map((l) => l.id).sort(), [...layers].sort());
    for (const l of meta.vector_layers) assert.doesNotMatch(l.id, /tribal|treaty|aiannh|reserv/i, 'Tribal and Treaty boundaries stay live-read');
    for (const issuer of issuers) {
      assert.ok(meta.attribution.includes(issuer), `attribution names ${issuer}`);
    }
  });
}

test('the North America archive draws state lines and both U.S. borders at its own scale', async () => {
  // @mapbox/vector-tile and pbf arrive with vt-pbf (a dev dependency); the app never imports them.
  const { VectorTile } = await import('@mapbox/vector-tile');
  const { default: Pbf } = await import('pbf');
  const bytes = read('public/data/ddm-base-na-2026-11.pmtiles');
  const reader = new PMTiles({
    getKey: () => 'na',
    getBytes: async (offset, length) => {
      const s = bytes.subarray(offset, offset + length);
      return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    }
  });
  const kinds = async (z, lon, lat) => {
    const x = Math.floor(((lon + 180) / 360) * 2 ** z);
    const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
    const tile = await reader.getZxy(z, x, y); // the reader unzips the tile
    const layer = new VectorTile(new Pbf(new Uint8Array(tile.data))).layers.boundary;
    return new Set(Array.from({ length: layer?.length ?? 0 }, (_, i) => layer.feature(i).properties.kind));
  };
  assert.ok((await kinds(8, -121.0, 45.65)).has('state'), 'the Washington-Oregon line on the Columbia');
  assert.ok((await kinds(7, -106.5, 31.76)).has('country'), 'the U.S.-Mexico border at El Paso');
  assert.ok((await kinds(7, -110, 49)).has('country'), 'the U.S.-Canada border on the 49th parallel');
});

test('every base map input is pinned by hash and retrieval date', () => {
  const receipt = JSON.parse(read('scripts/data/base-tiles-inputs.json'));
  assert.ok(receipt.inputs.length >= 70);
  for (const input of receipt.inputs) {
    assert.match(input.sha256, /^[0-9a-f]{64}$/, input.url);
    assert.match(input.retrieved, /^\d{4}-\d{2}-\d{2}$/, input.url);
    assert.doesNotMatch(input.url, /openstreetmap|overpass/i);
  }
});

test('the base style asks no tile host and stacks every base layer by the ruled order', async () => {
  const style = read('src/map/style.ts').toString();
  assert.doesNotMatch(style, /openstreetmap\.org|opentopomap|tile\./i);
  const { BASE_GROUND_IDS, BASE_LINE_IDS, TOP_LABEL_IDS, BOTTOM_STACK_IDS, REFERENCE_BOUNDARY_IDS } = await import('../src/map/layer-order.ts');
  // The Hydrography lake fill has a seat in the chain, directly under its rivers (never on top of every surface).
  assert.equal(REFERENCE_BOUNDARY_IDS.indexOf('hydrography-water'), REFERENCE_BOUNDARY_IDS.indexOf('hydrography') - 1);
  const ids = [...style.matchAll(/(?:id: |Layer\()'(base-[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 18, `found ${ids.length} base layer ids`);
  for (const id of ids) {
    assert.ok([...BASE_GROUND_IDS, ...BASE_LINE_IDS, ...TOP_LABEL_IDS].includes(id), `${id} has no seat in src/map/layer-order.ts`);
  }
  // Ground under the satellite imagery, lines above the terrain shading.
  assert.ok(BOTTOM_STACK_IDS.indexOf('base-land') < BOTTOM_STACK_IDS.indexOf('basemap-satellite'));
  assert.ok(BOTTOM_STACK_IDS.indexOf('base-road') > BOTTOM_STACK_IDS.indexOf('hillshade'));
});

test('Tribal-area streets query only the part of the view that touches a Tribal area', async () => {
  const { streetsEnvelope } = await import('../src/layers/tribal-streets.ts');
  const view = [-121, 46, -120, 47];
  assert.equal(streetsEnvelope(view, []), null);
  assert.equal(streetsEnvelope(view, [[-110, 30, -109, 31]]), null, 'an area outside the view reads nothing');
  assert.deepEqual(streetsEnvelope(view, [[-120.5, 46.2, -119, 46.6]]), [-120.5, 46.2, -120, 46.6], 'cut to the view');
  assert.deepEqual(
    streetsEnvelope(view, [[-120.8, 46.1, -120.7, 46.2], [-120.3, 46.5, -120.2, 46.9], [-100, 10, -99, 11]]),
    [-120.8, 46.1, -120.2, 46.9],
    'the bounds of every area in view, and only those'
  );
});
