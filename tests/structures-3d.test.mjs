import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';

/**
 * The 3D Fire buildings: FEMA USA Structures footprints for the central
 * Oregon pilot box, each at the height sampled for it from GBA.Height (4 m
 * where it has none), all in one quiet tone, with no credit, source line or
 * caveat on the map, in its key or in the embed chip (owner, 2026-11-12). The
 * real layer module runs against the committed archive and a fake map; no
 * browser and no network.
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
const OTHER_SOURCES = /overture|openstreetmap|odbl|microsoft/i;
// Nothing that names a building source, or says how a height was made, may print on the map.
const ON_MAP_CREDIT = /overture|openstreetmap|odbl|fema|oak ridge|usa structures|structure data|pilot area|globalbuildingatlas|gba\.|tu munich|technical university|modeled|estimate|surveyed|cc by/i;
/** The tallest drawn height the bake accepts (MAX_HEIGHT_M in scripts/build-structures-tiles.mjs). */
const MAX_HEIGHT_M = 200;

/** A source file without its comments: what can reach the page, not what explains it. */
const code = (path) => text(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, ''); // `://` is a URL, not a comment

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

const reader = new PMTiles({
  getKey: () => 'test',
  getBytes: async (offset, length) => {
    const slice = archive.subarray(offset, offset + length);
    return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  }
});

/** The properties of every footprint in the zoom 14 tile over downtown Bend. */
async function bendFootprints() {
  // @mapbox/vector-tile and pbf arrive with vt-pbf (a dev dependency); the app never imports them.
  const { VectorTile } = await import('@mapbox/vector-tile');
  const { default: Pbf } = await import('pbf');
  const [lon, lat, z] = [-121.31, 44.06, 14];
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const tile = await reader.getZxy(z, x, y); // the reader unzips the tile
  const decoded = new VectorTile(new Pbf(new Uint8Array(tile.data)));
  assert.deepEqual(Object.keys(decoded.layers), ['structures']);
  const layer = decoded.layers.structures;
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}

const presentation = await import('../src/config/wildfire-presentation.ts');
const { URLS } = await import('../src/config/urls.ts');
const layerOrder = await import('../src/map/layer-order.ts');
const { activateStructures, deactivateStructures } = await import('../src/layers/structures-3d.ts');

test('the committed archive is the bake its receipt records: the pinned 2023 outlines, each with its sampled height or none', async () => {
  assert.equal(archive.length, receipt.output.bytes);
  assert.equal(createHash('sha256').update(archive).digest('hex'), receipt.output.sha256);
  assert.ok(URLS.structuresPmtilesLocal.endsWith(`data/${receipt.output.file}`));

  const header = await reader.getHeader();
  const meta = await reader.getMetadata();
  assert.deepEqual([header.minZoom, header.maxZoom], [13, 14]);
  assert.equal(header.numAddressedTiles, receipt.output.tiles);
  // One tile layer whose only attribute is the drawn height.
  assert.equal(receipt.output.heightProperty, 'h');
  assert.deepEqual(meta.vector_layers.map((l) => [l.id, l.fields]), [['structures', { h: 'Number' }]]);
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

  // The heights: the GBA.Height raster only, pinned, its licence and the changes made carried in the archive.
  const { heights } = receipt;
  assert.equal(heights.source, 'GBA.Height (GlobalBuildingAtlas)');
  assert.equal(heights.record, 'https://doi.org/10.14459/2025mp1782307');
  assert.equal(heights.licence, 'CC BY-NC 4.0');
  assert.equal(heights.licenceUrl, 'https://creativecommons.org/licenses/by-nc/4.0/');
  assert.match(heights.sha256, /^[0-9a-f]{64}$/);
  assert.ok(heights.cells.length > 0);
  for (const cell of heights.cells) assert.match(cell.sha256, /^[0-9a-f]{64}$/, cell.cell);
  for (const part of [heights.record, heights.licence, heights.licenceUrl, heights.credit, 'Changes made:']) {
    assert.ok(meta.attribution.includes(part), `the archive carries "${part}"`);
  }
  // No polygon or per-building product of the same issuer is in the chain, only its raster.
  assert.doesNotMatch(JSON.stringify(receipt), /GBA\.(Polygon|ODbLPolygon|LoD1)|huggingface/i);

  // Heights in range, in the receipt and in a decoded tile.
  const { withHeight, withoutHeight, footprints, minimumHeightMeters, raisedToMinimum } = receipt.output;
  assert.equal(withHeight + withoutHeight, footprints);
  assert.ok(withHeight > 0 && raisedToMinimum <= withHeight);
  assert.equal(minimumHeightMeters, 3);
  const bend = await bendFootprints();
  assert.ok(bend.length > 100, 'downtown Bend holds buildings');
  for (const properties of bend) {
    assert.ok(Object.keys(properties).every((key) => key === 'h'), 'the height is the only property');
    if ('h' in properties) {
      assert.ok(
        Number.isInteger(properties.h) && properties.h >= minimumHeightMeters && properties.h <= MAX_HEIGHT_M,
        `a whole number of metres in range, not ${properties.h}`
      );
    }
  }
  assert.ok(new Set(bend.map((properties) => properties.h)).size > 1, 'the heights differ from building to building');
});

test('the archive fits the size line, and the bake and the activation gate hold the same line', () => {
  const ceiling = Number(/const MAX_ARCHIVE_BYTES = ([\d_]+);/.exec(text('scripts/build-structures-tiles.mjs'))[1].replaceAll('_', ''));
  const budget = text('scripts/check-activation-budget.mjs');
  const row = new RegExp(`path: 'data/${receipt.output.file.replaceAll('.', '\\.')}',\\s+maxBytes: ([\\d_]+)`).exec(budget);
  assert.ok(row, 'the fire3d-mode row lists the archive');
  assert.equal(Number(row[1].replaceAll('_', '')), ceiling);
  assert.ok(archive.length <= ceiling);
  // One buildings archive: no row and no URL still names a retired one.
  assert.deepEqual(budget.match(/structures-central-oregon[^']*\.pmtiles/g), [receipt.output.file]);
  assert.deepEqual(text('src/config/urls.ts').match(/structures-central-oregon[^']*\.pmtiles/g), [receipt.output.file]);
  assert.equal(Number(/const MAX_HEIGHT_M = (\d+);/.exec(text('scripts/build-structures-tiles.mjs'))[1]), MAX_HEIGHT_M);
});

test('each building stands at its sampled height, 4 m where it has none, all in one tone', async () => {
  const { heightMeters, heightProperty, color } = presentation.STRUCTURES_PRESENTATION;
  assert.equal(heightProperty, receipt.output.heightProperty);
  assert.equal(heightMeters, 4);
  assert.ok(heightMeters >= receipt.output.minimumHeightMeters, 'the stand-in is not lower than the lowest drawn estimate');

  const paint = presentation.buildStructuresPaint();
  // The height reads the footprint's own property and falls back to the stand-in.
  assert.deepEqual(paint['fill-extrusion-height'], ['number', ['get', 'h'], 4]);
  // One tone: constants, so no footprint reads brighter than another.
  assert.equal(paint['fill-extrusion-color'], color);
  assert.equal(typeof paint['fill-extrusion-color'], 'string');
  assert.equal(paint['fill-extrusion-base'], 0);
  assert.equal(typeof paint['fill-extrusion-opacity'], 'number');

  // MapLibre's own style specification accepts the layer and evaluates the height.
  const styleSpec = await import('@maplibre/maplibre-gl-style-spec');
  assert.deepEqual(styleSpec.validateStyleMin({
    version: 8,
    sources: { 'structures-3d': { type: 'vector', url: 'pmtiles://buildings' } },
    layers: [{ id: 'structures-3d', type: 'fill-extrusion', source: 'structures-3d', 'source-layer': 'structures', paint }]
  }), []);
  const height = styleSpec.normalizePropertyExpression(
    paint['fill-extrusion-height'],
    'layers[0].paint.fill-extrusion-height',
    styleSpec.latest['paint_fill-extrusion']['fill-extrusion-height']
  );
  const drawn = (properties) => height.evaluate({ zoom: 14 }, { type: 3, properties });
  assert.equal(drawn({ h: 7 }), 7);
  assert.equal(drawn({}), 4);
  // A value that is not a number draws the stand-in, never a flat or absent building.
  assert.equal(drawn({ h: null }), 4);
  assert.equal(drawn({ h: 'tall' }), 4);
  for (const properties of await bendFootprints()) {
    assert.equal(drawn(properties), properties.h ?? 4);
  }
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
  assert.doesNotMatch(key.innerHTML, ON_MAP_CREDIT);
  // Nor does anything handed to the map name a source.
  assert.doesNotMatch(JSON.stringify([layer, ...map.sources.values()]), ON_MAP_CREDIT);

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

test('the credit written inside the archive stays there: the map is told nothing it could print', async () => {
  // The app's own tile transport, asked what MapLibre asks when the source is added.
  serveArchive(archive);
  const { createPmtilesTransport } = await import('../src/map/tile-protocol.ts');
  const { data } = await createPmtilesTransport().tilev4(
    { type: 'json', url: `pmtiles://${URLS.structuresPmtilesLocal}` },
    new AbortController()
  );
  assert.deepEqual(Object.keys(data).sort(), ['bounds', 'maxzoom', 'minzoom', 'tiles']);
  assert.doesNotMatch(JSON.stringify(data), /attribution/i);
  // And the map draws no attribution control that a source could fill.
  assert.match(text('src/map/init.ts'), /attributionControl: false/);
});

test('the scene reports buildings without an on-map line, and no other building source is named anywhere in the lane', async () => {
  const context = text('src/map/fire3d-context.ts');
  assert.match(context, /keys\.push\('structures'\)/);
  // Embed lines print on the map surface, so buildings add none.
  assert.doesNotMatch(context, /STRUCTURES_EMBED_LINE|STRUCTURES_HEIGHT|embedLines\.push\([^)]*([Bb]uilding|[Hh]eight|[Ss]tructure)/);
  // Outside their comments, neither module that puts buildings on the map names a source or a method.
  for (const path of ['src/layers/structures-3d.ts', 'src/map/fire3d-context.ts']) {
    assert.doesNotMatch(code(path), /fema|oak ridge|usa structures|globalbuildingatlas|gba\.|tu munich|technical university|modeled|surveyed|cc by/i, path);
  }

  for (const path of [
    'src/layers/structures-3d.ts',
    'src/map/fire3d-context.ts',
    'src/config/wildfire-presentation.ts',
    'scripts/extract-fema-structures.py',
    'scripts/sample-gba-heights.py',
    'scripts/build-structures-tiles.mjs',
    'scripts/data/structures-tiles-receipt.json'
  ]) {
    assert.doesNotMatch(text(path), OTHER_SOURCES, path);
  }

  // The sentence about modeled heights is the owner's to approve: held, read by nothing.
  assert.equal(
    presentation.STRUCTURES_HEIGHT_NOTE_DRAFT,
    'Building heights in the 3D view are estimates modeled from 2019 satellite imagery (GlobalBuildingAtlas, Technical University of Munich), not surveyed. Where no estimate exists a building is drawn 4 meters tall.'
  );
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
  assert.doesNotMatch(
    code('src/config/fire3d-presentation.ts'),
    /structure data|pilot area|globalbuildingatlas|gba\.|tu munich|technical university|modeled|surveyed/i
  );
});
