import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';

/**
 * The 3D Fire buildings: FEMA USA Structures footprints for the central
 * Oregon pilot box, every one at one stated low height in one quiet tone,
 * with no credit, source line or caveat on the map or in its key (owner,
 * 2026-11-12). The real layer module runs against the committed archive and a
 * fake map; no browser and no network.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

// Same extensionless TypeScript resolver used by palette-contract.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
        typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  }
});

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const text = (path) => readFileSync(root(path), 'utf8');
const receipt = JSON.parse(text('scripts/data/structures-tiles-receipt.json'));
const archive = readFileSync(root(`public/data/${receipt.output.file}`));
const CREDIT = 'Oak Ridge National Laboratory (ORNL); Federal Emergency Management Agency (FEMA) Geospatial Response Office';
const OTHER_SOURCES = /overture|openstreetmap|odbl/i;

// A legend panel the registry can fill, and a map that records what it is given.
const sections = {
  children: [],
  get childElementCount() { return this.children.length; },
  querySelector(selector) { return this.children.find((el) => selector.includes(`"${el.dataset.legend}"`)) ?? null; },
  appendChild(el) { this.children.push(el); },
  insertBefore(el) { this.children.push(el); }
};
const panel = { hidden: true };
globalThis.document = {
  getElementById: (id) => (id === 'legend-panel' ? panel : id === 'legend-sections' ? sections : null),
  createElement: () => {
    const el = { dataset: {}, className: '', innerHTML: '', remove: () => sections.children.splice(sections.children.indexOf(el), 1) };
    return el;
  }
};

// Views as [west, south, east, north]: Bend sits inside the archive's box, Seattle outside it.
const BEND = [-121.35, 44.03, -121.27, 44.09];
const SEATTLE = [-122.38, 47.57, -122.28, 47.65];

function fakeMap() {
  const sources = new Map();
  const layers = [];
  const moveend = new Set();
  let zoom = 13;
  let [west, south, east, north] = BEND;
  return {
    sources,
    layers,
    moveend,
    /** Settle the camera somewhere else, the way a pan or zoom ends. */
    view(nextZoom, box) {
      zoom = nextZoom;
      [west, south, east, north] = box;
      for (const listener of [...moveend]) listener({});
    },
    getZoom: () => zoom,
    getBounds: () => ({ getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north }),
    on: (type, listener) => { if (type === 'moveend') moveend.add(listener); },
    off: (type, listener) => { if (type === 'moveend') moveend.delete(listener); },
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => sources.set(id, spec),
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.find((l) => l.id === id),
    addLayer: (spec) => layers.push(spec),
    removeLayer: (id) => layers.splice(layers.findIndex((l) => l.id === id), 1),
    moveLayer: () => {},
    getStyle: () => ({ layers })
  };
}

/** Answer the header probe from the committed archive, as a static host does. */
function serveArchive(bytes) {
  const requested = [];
  globalThis.fetch = async (url, init) => {
    requested.push(String(url));
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
    return new Response(new Uint8Array(bytes.subarray(+from, +to + 1)), {
      status: 206,
      headers: { 'Content-Range': `bytes ${from}-${to}/${bytes.length}` }
    });
  };
  return requested;
}

const presentation = await import('../src/config/wildfire-presentation.ts');
const { URLS } = await import('../src/config/urls.ts');
const layerOrder = await import('../src/map/layer-order.ts');
const { activateStructures, deactivateStructures } = await import('../src/layers/structures-3d.ts');

test('the committed archive is the bake its receipt records, from the pinned 2023 files, outlines only', async () => {
  assert.equal(archive.length, receipt.output.bytes);
  assert.equal(createHash('sha256').update(archive).digest('hex'), receipt.output.sha256);
  assert.ok(URLS.structuresPmtilesLocal.endsWith(`data/${receipt.output.file}`));

  const reader = new PMTiles({
    getKey: () => 'test',
    getBytes: async (offset, length) => {
      const slice = archive.subarray(offset, offset + length);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    }
  });
  const header = await reader.getHeader();
  const meta = await reader.getMetadata();
  assert.deepEqual([header.minZoom, header.maxZoom], [13, 14]);
  assert.equal(header.numAddressedTiles, receipt.output.tiles);
  // Outline only: one tile layer and no attribute on it.
  assert.deepEqual(meta.vector_layers.map((l) => [l.id, Object.keys(l.fields)]), [['structures', []]]);
  assert.ok(meta.attribution.startsWith(CREDIT));
  assert.doesNotMatch(JSON.stringify(meta), OTHER_SOURCES);

  // DR-126: only the 2023 edition published under CC0, each file pinned.
  assert.equal(receipt.edition, '2023');
  assert.equal(receipt.inputs.length, 2);
  for (const input of receipt.inputs) {
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
    assert.equal(input.licence, 'CC0 1.0');
    assert.match(input.record, /^https:\/\/doi\.org\/10\.6084\/m9\.figshare\./);
    assert.equal(input.credit, CREDIT);
  }
  assert.equal(receipt.output.footprints, receipt.inputs.reduce((sum, input) => sum + input.footprintsInBox, 0));
});

test('the archive fits the size line, and the bake and the activation gate hold the same line', () => {
  const ceiling = Number(/const MAX_ARCHIVE_BYTES = ([\d_]+);/.exec(text('scripts/build-structures-tiles.mjs'))[1].replaceAll('_', ''));
  const row = new RegExp(`path: 'data/${receipt.output.file.replaceAll('.', '\\.')}',\\s+maxBytes: ([\\d_]+)`).exec(text('scripts/check-activation-budget.mjs'));
  assert.ok(row, 'the fire3d-mode row lists the archive');
  assert.equal(Number(row[1].replaceAll('_', '')), ceiling);
  assert.ok(archive.length <= ceiling);
});

test('every building stands at one low stated height in one tone, because none is published', () => {
  assert.equal(receipt.output.withHeight, 0);
  const paint = presentation.buildStructuresPaint();
  // Constants, not expressions: no footprint can stand taller or read brighter than another.
  assert.equal(paint['fill-extrusion-height'], presentation.STRUCTURES_PRESENTATION.heightMeters);
  assert.equal(paint['fill-extrusion-color'], presentation.STRUCTURES_PRESENTATION.color);
  assert.equal(paint['fill-extrusion-base'], 0);
  assert.equal(typeof paint['fill-extrusion-opacity'], 'number');
  const height = presentation.STRUCTURES_PRESENTATION.heightMeters;
  assert.ok(height >= 2.5 && height <= 5, 'about one storey');
});

test('the layer draws the committed archive as one extrusion layer and its key says only Buildings', async () => {
  const requested = serveArchive(archive);
  const map = fakeMap();
  assert.equal(await activateStructures(map, new AbortController().signal), true);

  assert.deepEqual(requested, [URLS.structuresPmtilesLocal]);
  assert.deepEqual(map.sources.get('structures-3d'), { type: 'vector', url: `pmtiles://${URLS.structuresPmtilesLocal}` });
  assert.equal(map.layers.length, 1);
  const [layer] = map.layers;
  assert.deepEqual(
    { id: layer.id, type: layer.type, source: layer.source, sourceLayer: layer['source-layer'], filter: layer.filter },
    { id: 'structures-3d', type: 'fill-extrusion', source: 'structures-3d', sourceLayer: 'structures', filter: undefined }
  );
  assert.deepEqual(layer.paint, presentation.buildStructuresPaint());

  // The key: one swatch and the one word. No title, source line, credit or caveat.
  assert.equal(sections.children.length, 1);
  const key = sections.children[0];
  assert.equal(key.dataset.legend, 'structures-3d');
  assert.equal(key.innerHTML.replace(/<[^>]*>/g, ''), 'Buildings');
  assert.doesNotMatch(key.innerHTML, /legend-note|legend-section-title|href/);

  // A second activation adds nothing twice; leaving removes everything.
  assert.equal(await activateStructures(map, new AbortController().signal), true);
  assert.equal(map.layers.length, 1);
  assert.equal(sections.children.length, 1);
  deactivateStructures(map);
  assert.equal(map.layers.length, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(sections.children.length, 0);
});

test('the key lists Buildings only while a building can draw in the view', async () => {
  serveArchive(archive);
  const map = fakeMap();
  // Entering 3D on a state view: inside no zoom the archive stores, so no row.
  map.view(7, [-124.9, 45.5, -116.9, 49.0]);
  assert.equal(await activateStructures(map, new AbortController().signal), true);
  assert.equal(map.layers.length, 1, 'the layer is on the map either way');
  assert.equal(sections.children.length, 0);
  assert.equal(map.moveend.size, 1);

  map.view(13, BEND);
  assert.equal(sections.children.length, 1);
  const row = sections.children[0];
  map.view(14, BEND);
  assert.equal(sections.children[0], row, 'a pan that changes nothing does not rebuild the row');
  // Below the archive's own zoom floor, then at that zoom outside its box.
  map.view(12.9, BEND);
  assert.equal(sections.children.length, 0);
  map.view(13, SEATTLE);
  assert.equal(sections.children.length, 0);
  map.view(13, BEND);
  assert.equal(sections.children.length, 1);

  // A second activation does not listen twice; leaving stops listening.
  assert.equal(await activateStructures(map, new AbortController().signal), true);
  assert.equal(map.moveend.size, 1);
  deactivateStructures(map);
  assert.equal(map.moveend.size, 0);
  assert.equal(sections.children.length, 0);
});

test('an archive that is not tiles, or a scene left during the probe, adds nothing', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(String(args[0]));
  try {
    globalThis.fetch = async () => new Response('<html>not tiles</html>', { status: 200 });
    const map = fakeMap();
    assert.equal(await activateStructures(map, new AbortController().signal), false);
    assert.deepEqual([map.layers.length, map.sources.size, sections.children.length], [0, 0, 0]);
    assert.deepEqual(warnings, ['[structures-3d] invalid or unavailable archive.']);

    serveArchive(archive);
    const left = new AbortController();
    left.abort();
    assert.equal(await activateStructures(map, left.signal), false);
    assert.deepEqual([map.layers.length, map.sources.size, sections.children.length], [0, 0, 0]);
    assert.equal(warnings.length, 1, 'leaving is not a fault and warns nothing');
  } finally {
    console.warn = warn;
  }
});

test('the scene reports buildings without an on-map line, and no other building source is named anywhere in the lane', async () => {
  const context = text('src/map/fire3d-context.ts');
  assert.match(context, /keys\.push\('structures'\)/);
  // Embed lines print on the map surface, so buildings add none.
  assert.doesNotMatch(context, /STRUCTURES_EMBED_LINE|embedLines\.push\([^)]*[Bb]uilding/);

  for (const path of [
    'src/layers/structures-3d.ts',
    'src/map/fire3d-context.ts',
    'src/config/wildfire-presentation.ts',
    'scripts/extract-fema-structures.py',
    'scripts/build-structures-tiles.mjs',
    'scripts/data/structures-tiles-receipt.json'
  ]) {
    assert.doesNotMatch(text(path), OTHER_SOURCES, path);
  }

  // The sentence about unmeasured heights is the owner's to approve: held, read by nothing.
  assert.equal(typeof presentation.STRUCTURES_HEIGHT_NOTE_DRAFT, 'string');
  assert.ok(presentation.STRUCTURES_HEIGHT_NOTE_DRAFT.includes(`${presentation.STRUCTURES_PRESENTATION.heightMeters} meters`));
  const readers = readdirSync(root('src'), { recursive: true })
    .filter((path) => /\.ts$/.test(path) && readFileSync(root(`src/${path}`), 'utf8').includes('STRUCTURES_HEIGHT_NOTE_DRAFT'))
    .map((path) => path.replaceAll('\\', '/'));
  assert.deepEqual(readers, ['config/wildfire-presentation.ts']);
});

test('the two scene files outside the buildings lane know the layer (main-session handoff)', () => {
  // Seated with the context overlays, so fires, smoke and boundaries draw above the buildings.
  assert.equal(layerOrder.CONTEXT_OVERLAY_IDS[0], 'structures-3d');
  // The scene counts the buildings source before it reports its tiles settled.
  assert.match(text('src/map/fire3d.ts'), /contextKeys\.includes\('structures'\)/);
  // The note beside the 3D button also prints on the map in embeds, so it says nothing about buildings.
  assert.doesNotMatch(text('src/config/fire3d-presentation.ts'), /structure data|pilot area/i);
});
