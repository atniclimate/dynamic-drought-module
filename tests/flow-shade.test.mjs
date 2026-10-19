/**
 * The scalar drawing path of the ENSO "Ocean & atmosphere" control: NOAA GFS
 * precipitable water as a still shade (src/layers/flow/shade.ts) and its map
 * view (src/layers/flow/index.ts `mountShadeView`).
 *
 * - The value-to-shade mapping: the display bins, one hue, opacity rising in
 *   steps and nothing under the first bin; the key's sentence is held to the
 *   bins.
 * - The picture: rows evenly spaced in Web Mercator, columns that wrap at the
 *   grid's own join, one value where the world copies meet at the date line,
 *   and no pixel drawn from the pole rows.
 * - The view, on a recording map: one image source with no URL, one raster
 *   layer in its ruled seat, nothing made again on a pan, the image handed
 *   over again after a restored context, the 24-hour limit, and teardown.
 *
 * The decode of the committed PWAT message is held to ecCodes in
 * tests/flow-grib-decode.test.mjs, the read in tests/flow-nodd.test.mjs and
 * the bound in tests/flow-plausibility.test.mjs. No network, no GL. Runs
 * under plain `node --test` (Node 24 strips types).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

globalThis.fetch = () => {
  throw new Error('unexpected network call from a node test');
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

// The view hands MapLibre an ImageData; Node has none, so the bytes are recorded as they are.
globalThis.ImageData = class {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};

const shade = await import('../src/layers/flow/shade.ts');
const { mercY, latOf } = await import('../src/layers/flow/field.ts');
const { mountShadeView, FLOW_SHADE_ID, FLOW_LAYER_IDS } = await import('../src/layers/flow/index.ts');
const { FLOW_WORDS, isShadeKind } = await import('../src/layers/enso-flow-data.ts');
const { CONDITION_SURFACE_IDS, EVENT_OVERLAY_IDS } = await import('../src/map/layer-order.ts');
const { SHADE_ALPHA, SHADE_BINS, SHADE_COORDINATES, SHADE_IMAGE_SIZE, SHADE_RGB, isScalarKind, shadeClass, shadePixels } = shade;

const GLOBAL_1P00 = { lon0: 0, lat0: 90, dlon: 1, dlat: 1, nx: 360, ny: 181, wrapsLon: true };
const CYCLE = Date.UTC(2026, 9, 5, 6);
const META = Object.freeze({
  issuer: 'NOAA', model: 'GFS', transport: 'none', cycle: CYCLE, forecastHour: 6,
  validTime: CYCLE + 6 * 3_600_000, staleAfter: null, level: 'entire atmosphere (considered as a single layer)',
  units: 'kg m-2', sourceUrl: 'about:blank', productKey: 'synthetic'
});
const ALPHA = SHADE_ALPHA.map((a) => Math.round(a * 255));

/** A global 1.0 degree field from a function of the node's longitude (0 to 359 E) and latitude. */
function field(valueAt, meta = META) {
  const values = new Float32Array(360 * 181);
  for (let row = 0; row < 181; row++) {
    for (let column = 0; column < 360; column++) values[row * 360 + column] = valueAt(column, 90 - row);
  }
  return { kind: 'pwat', grid: GLOBAL_1P00, values, meta };
}
const alphaAt = (pixels, size, px, py) => pixels[(py * size + px) * 4 + 3];
const rowAlphas = (pixels, size, py) => Array.from({ length: size }, (_, px) => alphaAt(pixels, size, px, py));

// --- the value-to-shade mapping ---------------------------------------------

test('precipitable water has four display steps: no shade under 15, then 15, 30 and 45 kg m-2', () => {
  assert.deepEqual(SHADE_BINS.pwat, [15, 30, 45]);
  assert.deepEqual(
    [0, 0.1, 14.99, 15, 29.99, 30, 44.99, 45, 83.9, 120].map((value) => shadeClass('pwat', value)),
    [0, 0, 0, 1, 1, 2, 2, 3, 3, 3]
  );
  assert.equal(shadeClass('pwat', Number.NaN), 0, 'a value that is not a number draws nothing');
  // One opacity for each step, rising, nothing first, and the deepest under half.
  assert.equal(SHADE_ALPHA.length, SHADE_BINS.pwat.length + 1);
  assert.equal(SHADE_ALPHA[0], 0);
  for (let k = 1; k < SHADE_ALPHA.length; k++) assert.ok(SHADE_ALPHA[k] > SHADE_ALPHA[k - 1], `step ${k} is deeper than step ${k - 1}`);
  assert.ok(SHADE_ALPHA.at(-1) < 0.5, 'what lies under the deepest shade still shows through more than the shade does');
  assert.deepEqual(ALPHA, [0, 36, 71, 107]);
});

test('the key states the bins the shade is drawn with, in the unit the issuer gives', () => {
  const [a, b, c] = SHADE_BINS.pwat;
  assert.equal(FLOW_WORDS.bins.pwat, `Shade deepens in steps: none under ${a}, then ${a} to ${b}, ${b} to ${c}, ${c} or more kg m-2.`);
  assert.equal(META.units, 'kg m-2');
});

test('only precipitable water is a scalar kind, here and in the panel', () => {
  assert.equal(isScalarKind('pwat'), true);
  for (const kind of ['wind', 'jet', 'waves', 'currents', 'off', 'toString', 'constructor', '']) {
    assert.equal(isScalarKind(kind), false, kind);
  }
  assert.deepEqual(['off', 'currents', 'wind', 'jet', 'waves', 'pwat'].filter(isShadeKind), ['pwat']);
});

test('the shade is one hue with straight alpha, and fully transparent wherever the value is under the first bin', () => {
  const size = 48;
  const dry = shadePixels(field(() => 14.9), size);
  assert.equal(dry.length, size * size * 4);
  assert.ok(dry.every((byte) => byte === 0), 'dry air leaves every pixel untouched');
  const moist = shadePixels(field(() => 50), size);
  for (let o = 0; o < moist.length; o += 4) {
    assert.deepEqual([moist[o], moist[o + 1], moist[o + 2], moist[o + 3]], [...SHADE_RGB, 107]);
  }
  assert.deepEqual(SHADE_RGB, [255, 255, 255], 'white: no class of the SST anomaly scale');
  // A field through every step: only the four opacities occur, and each shaded pixel is the one hue.
  const mixed = shadePixels(field((lon, lat) => 30 + 30 * Math.cos((lon * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180)), size);
  const seen = new Set();
  for (let o = 0; o < mixed.length; o += 4) {
    seen.add(mixed[o + 3]);
    assert.deepEqual([mixed[o], mixed[o + 1], mixed[o + 2]], mixed[o + 3] === 0 ? [0, 0, 0] : [...SHADE_RGB]);
  }
  assert.deepEqual([...seen].sort((x, y) => x - y), ALPHA);
});

// --- the picture --------------------------------------------------------------

test('rows are evenly spaced in Web Mercator: a band of latitude lands on its Mercator rows, not on equal steps of latitude', () => {
  const size = SHADE_IMAGE_SIZE;
  assert.equal(size, 720);
  // The value is the distance from the equator in degrees, so the steps begin at 15, 30 and 45 N and S.
  const pixels = shadePixels(field((_lon, lat) => Math.abs(lat)));
  const column = Array.from({ length: size }, (_, py) => alphaAt(pixels, size, 360, py));
  for (const [k, latitude] of [[1, 15], [2, 30], [3, 45]]) {
    // The first row, going north from the equator, whose centre is at or past the latitude.
    const northRow = column.findLastIndex((alpha, py) => py < size / 2 && alpha >= ALPHA[k]);
    const southRow = column.findIndex((alpha, py) => py >= size / 2 && alpha >= ALPHA[k]);
    assert.ok(Math.abs((northRow + 0.5) / size - mercY(latitude)) <= 1 / size, `${latitude} N at row ${northRow}`);
    assert.ok(Math.abs((southRow + 0.5) / size - mercY(-latitude)) <= 1 / size, `${latitude} S at row ${southRow}`);
  }
  // 45 N is 47 percent of the way from the image's north edge to the equator in latitude, and 72 percent in Mercator.
  assert.ok(Math.abs(mercY(45) * size - 259) < 1, 'the Mercator row of 45 N');
  // Symmetric about the equator, and the same in every column of a field that does not vary with longitude.
  assert.deepEqual(column, [...column].reverse());
  for (const py of [3, 200, 359, 500, 716]) assert.equal(new Set(rowAlphas(pixels, size, py)).size, 1, `row ${py}`);
});

test('each pixel is the bilinear value of the grid at its centre, across the grid\'s own join at the prime meridian', () => {
  const size = 720;
  // A smooth wave around the globe, uneven on purpose, with steep sides so the steps fall at many columns.
  const wave = (lon) => 30 + 22 * Math.sin((lon * Math.PI) / 180) + 9 * Math.cos((3 * lon * Math.PI) / 180);
  const pixels = shadePixels(field((lon) => wave(lon)), size);
  for (const py of [10, 360, 700]) {
    for (let px = 1; px < size - 1; px++) {
      const east = ((((px + 0.5) / size) * 360 - 180) % 360 + 360) % 360;
      const column = Math.floor(east);
      // Float32 as the field holds it; the next column past 359 is 0.
      const value = Math.fround(wave(column)) * (1 - (east - column)) + Math.fround(wave((column + 1) % 360)) * (east - column);
      assert.equal(alphaAt(pixels, size, px, py), ALPHA[shadeClass('pwat', value)], `row ${py}, column ${px} (${east} E)`);
    }
  }
  // The pixels either side of the prime meridian (359.75 E and 0.25 E) read columns 359 and 0, not an edge.
  const row = rowAlphas(pixels, size, 360);
  assert.equal(row[359], ALPHA[shadeClass('pwat', 0.25 * wave(359) + 0.75 * wave(0))]);
  assert.equal(row[360], ALPHA[shadeClass('pwat', 0.75 * wave(0) + 0.25 * wave(1))]);
});

test('the date line has no seam: both edge columns hold the value at 180, so neighbouring world copies meet at one value', () => {
  const size = 720;
  // Steep across the date line: 22 kg m-2 at 179 E, 31 at 180, 46 at 179 W. Read at their own centres the east edge
  // (179.75 E, 28.75) would fall one step under the west edge (179.75 W, 34.75): a line down the Pacific.
  const steep = field((lon) => (lon === 179 ? 22 : lon === 180 ? 31 : lon === 181 ? 46 : 5));
  const pixels = shadePixels(steep, size);
  for (let py = 0; py < size; py++) {
    assert.equal(alphaAt(pixels, size, 0, py), ALPHA[2], `row ${py}: the west edge is the value at 180 (31, the second step)`);
    assert.equal(alphaAt(pixels, size, size - 1, py), ALPHA[2], `row ${py}: the east edge is the same value`);
  }
  // One pixel in from each edge the field is read at its own longitude again: 179.25 W and 179.25 E.
  assert.equal(alphaAt(pixels, size, 1, 360), ALPHA[shadeClass('pwat', 0.25 * 31 + 0.75 * 46)]);
  assert.equal(alphaAt(pixels, size, size - 2, 360), ALPHA[shadeClass('pwat', 0.75 * 22 + 0.25 * 31)]);
  // A plume lying across the date line is one plume: shaded on both sides of it, with no gap at the edges.
  const plume = shadePixels(field((lon) => (lon >= 170 && lon <= 190 ? 50 : 5)), size);
  const row = rowAlphas(plume, size, 360);
  assert.ok(row.slice(0, 18).every((alpha) => alpha === ALPHA[3]), '180 to 171 W');
  assert.ok(row.slice(size - 18).every((alpha) => alpha === ALPHA[3]), '171 E to 180');
  assert.equal(row[100], 0);
  // The image spans the whole Mercator world, so MapLibre repeats it edge to edge in each world copy.
  assert.deepEqual(SHADE_COORDINATES, [[-180, 85.051129], [180, 85.051129], [180, -85.051129], [-180, -85.051129]]);
});

test('the poles are never drawn: the image ends at the Web Mercator limit and no pixel reads a row beyond it', () => {
  const size = 720;
  // The first and last image rows lie just inside 85.05 degrees, between grid rows 4 and 5 (86 N and 85 N).
  assert.ok(latOf(0.5 / size) < 85.051129 && latOf(0.5 / size) > 85);
  assert.ok(latOf((size - 0.5) / size) > -85.051129 && latOf((size - 0.5) / size) < -85);
  // Values that would shade, on the pole rows and the three rows next to each, and none elsewhere.
  const caps = shadePixels(field((_lon, lat) => (Math.abs(lat) >= 87 ? 100 : 0)), size);
  assert.ok(caps.every((byte) => byte === 0), 'nothing north of 86 N or south of 86 S reaches a pixel');
  // The rows that are read (86 N and 85 N) do reach the first image row.
  const edge = shadePixels(field((_lon, lat) => (lat >= 85 ? 100 : 0)), size);
  assert.equal(alphaAt(edge, size, 360, 0), ALPHA[3]);
  assert.equal(alphaAt(edge, size, 360, 40), 0);
});

test('a field that is not a whole global grid is refused, never stretched', () => {
  const whole = field(() => 20);
  assert.throws(() => shadePixels({ ...whole, grid: { ...GLOBAL_1P00, wrapsLon: false } }), /not a whole global grid/);
  assert.throws(() => shadePixels({ ...whole, values: whole.values.subarray(360) }), /not a whole global grid/);
});

// --- the view -----------------------------------------------------------------

/** A recording map: sources, layers in paint order and listeners, as much of MapLibre as the view touches. */
const ENSO_STYLE = [
  'background', 'basemap', 'sst-anomaly', 'nino34-box-fill', 'nino34-box-line', 'nino34-box-label',
  'tropical-cyclones-points', 'us-states-outline', 'us-places-labels'
];

function fakeMap({ failLayer = false, style = ENSO_STYLE } = {}) {
  const listeners = new Map();
  const sources = new Map();
  let layers = style.map((id) => ({ id }));
  const updates = [];
  const place = (layer, before) => {
    const at = before === undefined ? -1 : layers.findIndex((l) => l.id === before);
    if (at < 0) layers.push(layer);
    else layers.splice(at, 0, layer);
  };
  const map = {
    updates,
    lost: false,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    once(type, fn) {
      const wrapped = (...args) => {
        map.off(type, wrapped);
        fn(...args);
      };
      wrapped.original = fn;
      map.on(type, wrapped);
    },
    off(type, fn) {
      for (const held of listeners.get(type) ?? []) if (held === fn || held.original === fn) listeners.get(type).delete(held);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type });
    },
    listening: () => [...listeners].filter(([, set]) => set.size > 0).map(([type]) => type).sort(),
    getSource: (id) => sources.get(id),
    addSource(id, spec) {
      sources.set(id, {
        spec,
        image: null,
        updateImage(options) {
          updates.push(options);
          this.image = options.image;
          return this;
        }
      });
    },
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.find((l) => l.id === id),
    addLayer(layer, before) {
      if (failLayer) throw new Error('synthetic addLayer failure');
      place(layer, before);
    },
    removeLayer(id) {
      layers = layers.filter((l) => l.id !== id);
    },
    moveLayer(id, before) {
      const layer = layers.find((l) => l.id === id);
      layers = layers.filter((l) => l.id !== id);
      place(layer, before);
    },
    getStyle: () => ({ layers }),
    getCanvas: () => ({ getContext: () => ({ isContextLost: () => map.lost }) }),
    order: () => layers.map((l) => l.id),
    /** A lost context: MapLibre drops the style's layers and sources of this view. */
    dropStyle() {
      layers = layers.filter((l) => l.id !== FLOW_SHADE_ID);
      sources.delete(FLOW_SHADE_ID);
    }
  };
  return map;
}

const moist = () => field((lon, lat) => 30 + 30 * Math.cos((lon * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180));

test('the shade is one image source with no URL and one raster layer with linear resampling', () => {
  const map = fakeMap();
  const frame = moist();
  const view = mountShadeView(map, frame, { onStale: () => assert.fail('the frame has no limit') });
  assert.equal(view.field, frame);
  const source = map.getSource(FLOW_SHADE_ID);
  // No `url`: MapLibre requests nothing for it.
  assert.deepEqual(source.spec, { type: 'image', coordinates: SHADE_COORDINATES });
  assert.equal(map.updates.length, 1);
  const { image } = map.updates[0];
  assert.deepEqual([image.width, image.height, image.data.length], [720, 720, 720 * 720 * 4]);
  assert.deepEqual(image.data, shadePixels(frame));
  assert.deepEqual(map.getLayer(FLOW_SHADE_ID), {
    id: 'flow-shade', type: 'raster', source: 'flow-shade',
    paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 }
  });
  view.dispose();
});

test('the shade sits above the SST and the Nino box, and under the tropical cyclones, every outline and the labels', () => {
  assert.equal(FLOW_SHADE_ID, 'flow-shade');
  assert.equal(FLOW_LAYER_IDS[0], FLOW_SHADE_ID);
  const seat = CONDITION_SURFACE_IDS.indexOf(FLOW_SHADE_ID);
  assert.ok(seat > CONDITION_SURFACE_IDS.indexOf('sst-anomaly'));
  // A dated SST frame inserts directly under the Nino box's line, so the shade must seat above the box.
  assert.equal(seat, CONDITION_SURFACE_IDS.indexOf('nino34-box-line') + 1);
  assert.equal(seat, CONDITION_SURFACE_IDS.indexOf('flow-still-casing') - 1);
  // The Nino 3.4 label reads above the paths and the shade.
  assert.ok(CONDITION_SURFACE_IDS.indexOf('nino34-box-label') > CONDITION_SURFACE_IDS.indexOf('flow-paths'));
  assert.ok(!EVENT_OVERLAY_IDS.includes(FLOW_SHADE_ID));
  const map = fakeMap();
  const view = mountShadeView(map, moist(), { onStale: () => undefined });
  assert.deepEqual(map.order(), [
    'background', 'basemap', 'sst-anomaly', 'nino34-box-fill', 'nino34-box-line', 'flow-shade',
    'nino34-box-label', 'tropical-cyclones-points', 'us-states-outline', 'us-places-labels'
  ]);
  view.dispose();
});

test('with a dated SST frame on the map the shade still seats above it, and the outlines stay above both', () => {
  // src/layers/sst-anomaly.ts inserts a dated frame directly under the Nino box's line, inside the ruled chain.
  const style = [
    'background', 'basemap', 'sst-anomaly', 'nino34-box-fill', 'sst-frame-2026-09-06', 'sst-frame-2026-09-07',
    'nino34-box-line', 'nino34-box-label', 'tropical-cyclones-points', 'us-states-outline', 'us-places-labels'
  ];
  const map = fakeMap({ style });
  const view = mountShadeView(map, moist(), { onStale: () => undefined });
  const order = map.order();
  const at = (id) => order.indexOf(id);
  for (const frame of ['sst-frame-2026-09-06', 'sst-frame-2026-09-07']) {
    assert.ok(at('flow-shade') > at(frame), `the shade is above ${frame}: ${order.join(' < ')}`);
    assert.ok(at('nino34-box-line') > at(frame), `the Nino box stays above ${frame}`);
    assert.ok(at('us-states-outline') > at(frame), `outlines stay above ${frame}`);
  }
  assert.ok(at('sst-frame-2026-09-07') > at('sst-frame-2026-09-06'), 'the frames keep their own order');
  assert.ok(at('flow-shade') < at('tropical-cyclones-points') && at('tropical-cyclones-points') < at('us-states-outline'));
  assert.equal(order.at(-1), 'us-places-labels');
  view.dispose();
  // The prefix is the owning module's own.
  const owner = readFileSync(new URL('../src/layers/sst-anomaly.ts', import.meta.url), 'utf8');
  assert.ok(owner.includes('const frameSourceId = (date: string): string => `sst-frame-${date}`;'));
});

test('a pan, a zoom or a resize makes nothing again, and the still shade asks for no frame', () => {
  const map = fakeMap();
  const view = mountShadeView(map, moist(), { onStale: () => undefined });
  // The view listens only for a restored context: no move, no render, no resize.
  assert.deepEqual(map.listening(), ['webglcontextrestored']);
  for (const type of ['movestart', 'move', 'moveend', 'zoomend', 'resize', 'render', 'idle']) map.fire(type);
  assert.equal(map.updates.length, 1, 'the image was made once, from the frame');
  view.dispose();
  // The same frame chosen again (inside the panel's ten-minute hold) shows the picture already made.
  const frame = moist();
  const first = fakeMap();
  mountShadeView(first, frame, { onStale: () => undefined }).dispose();
  const second = fakeMap();
  mountShadeView(second, frame, { onStale: () => undefined }).dispose();
  assert.equal(second.updates[0].image, first.updates[0].image);
  // Another frame is another picture.
  const third = fakeMap();
  mountShadeView(third, moist(), { onStale: () => undefined }).dispose();
  assert.notEqual(third.updates[0].image, first.updates[0].image);
});

test('after a restored context the same image is handed over again, with no new read and no new picture', () => {
  const map = fakeMap();
  const view = mountShadeView(map, moist(), { onStale: () => undefined });
  const first = map.updates[0].image;
  map.dropStyle();
  map.fire('webglcontextrestored');
  assert.ok(map.getSource(FLOW_SHADE_ID) && map.getLayer(FLOW_SHADE_ID), 'the source and the layer are back');
  assert.equal(map.updates.length, 2);
  assert.equal(map.updates[1].image, first, 'the picture held on the CPU, not a new one');
  // MapLibre restored the source itself, without its pixels: the later style.load hands them over once more.
  map.getSource(FLOW_SHADE_ID).image = null;
  map.fire('style.load');
  assert.equal(map.getSource(FLOW_SHADE_ID).image, first);
  assert.equal(map.order().indexOf('flow-shade'), map.order().indexOf('nino34-box-line') + 1);
  view.dispose();
  assert.deepEqual(map.listening(), []);
});

test('dispose removes the layer and the source; halt touches no layer and drops every listener', () => {
  const map = fakeMap();
  const view = mountShadeView(map, moist(), { onStale: () => undefined });
  view.halt();
  assert.deepEqual(map.listening(), []);
  assert.ok(map.getLayer(FLOW_SHADE_ID) && map.getSource(FLOW_SHADE_ID), 'off intent leaves the map as it is');
  map.dropStyle();
  map.fire('webglcontextrestored');
  assert.equal(map.getSource(FLOW_SHADE_ID), undefined, 'a halted view adds nothing back');
  view.dispose();
  view.dispose();
  const again = fakeMap();
  const second = mountShadeView(again, moist(), { onStale: () => undefined });
  second.dispose();
  assert.equal(again.getLayer(FLOW_SHADE_ID), undefined);
  assert.equal(again.getSource(FLOW_SHADE_ID), undefined);
  assert.deepEqual(again.order(), fakeMap().order());
});

test('a mount that fails part way leaves nothing on the map', () => {
  const map = fakeMap({ failLayer: true });
  assert.throws(() => mountShadeView(map, moist(), { onStale: () => undefined }), /synthetic addLayer failure/);
  assert.equal(map.getSource(FLOW_SHADE_ID), undefined);
  assert.deepEqual(map.listening(), []);
});

test('past cycle + 24 h the shade leaves the map on its own and says so once', async () => {
  const map = fakeMap();
  let clock = CYCLE + 24 * 3_600_000 - 25;
  let stale = 0;
  const frame = field(() => 40, { ...META, staleAfter: CYCLE + 24 * 3_600_000 });
  const view = mountShadeView(map, frame, { onStale: () => { stale++; }, now: () => clock });
  assert.ok(map.getLayer(FLOW_SHADE_ID));
  clock += 60;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stale, 1);
  assert.equal(map.getLayer(FLOW_SHADE_ID), undefined, 'nothing is drawn past the limit');
  assert.equal(map.getSource(FLOW_SHADE_ID), undefined);
  view.dispose();
  // A halted view never reports: off intent cancels the limit's timer.
  const other = fakeMap();
  clock = CYCLE + 24 * 3_600_000 - 25;
  const halted = mountShadeView(other, frame, { onStale: () => { stale++; }, now: () => clock });
  halted.halt();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stale, 1);
  halted.dispose();
});
