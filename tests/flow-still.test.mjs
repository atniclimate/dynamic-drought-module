import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Block E1 unit E1-3 (FLOW-RENDER; design/moving-paths.md sections 4, 5, 6
 * and 13; DR-116): the still form as GeoJSON for the native layers
 * flow-still-casing, flow-still and flow-still-marks, the form plan (phone
 * default), and the ink tokens. Synthetic fields only; no network.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

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

const { createFlowField, sampleField, newSample, mercX, mercY, lonOf, latOf } = await import('../src/layers/flow/field.ts');
const { planForm, particleCount, PHONE_DENSITY_FACTOR } = await import('../src/layers/flow/advect.ts');
const still = await import('../src/layers/flow/still.ts');
const ink = await import('../src/layers/flow/ink.ts');

const META = Object.freeze({
  issuer: 'test', model: 'synthetic', transport: 'none', cycle: 0, forecastHour: 6,
  validTime: Date.UTC(2026, 9, 5, 12), staleAfter: null, level: '10 m above ground',
  units: 'm s-1', sourceUrl: 'about:blank', productKey: 'synthetic'
});

function gridField(kind, grid, fn, meta = META) {
  const n = grid.nx * grid.ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const m = new Float32Array(n);
  const mask = new Uint8Array(n);
  for (let r = 0; r < grid.ny; r++) {
    for (let c = 0; c < grid.nx; c++) {
      const i = r * grid.nx + c;
      const [uu, vv, mm, ok = true] = fn(grid.lon0 + c * grid.dlon, grid.lat0 - r * grid.dlat);
      u[i] = uu;
      v[i] = vv;
      m[i] = mm ?? Math.hypot(uu, vv);
      mask[i] = ok ? 1 : 0;
    }
  }
  return createFlowField({ kind, grid, u, v, magnitude: m, mask, meta });
}

const GLOBAL_1P00 = { lon0: 0, lat0: 90, dlon: 1, dlat: 1, nx: 360, ny: 181, wrapsLon: true };
const WAVE_CROP = { lon0: 165, lat0: 62, dlon: 0.25, dlat: 0.25, nx: 381, ny: 289, wrapsLon: false };

function windField(meta = META) {
  return gridField('wind', GLOBAL_1P00, (lon, lat) => {
    const a = (lon * Math.PI) / 30;
    const b = (lat * Math.PI) / 30;
    // A crude land block (about the North American west coast) so the mask is exercised.
    const land = lon > 235 && lon < 250 && lat > 30 && lat < 60;
    return [6 + 5 * Math.sin(a) * Math.cos(b), 5 * Math.cos((lon * Math.PI) / 40) * Math.sin(b), undefined, !land];
  }, meta);
}

function view(lon, lat, zoom, w = 1440, h = 900) {
  const worldSize = 512 * 2 ** zoom;
  const cx = mercX(lon);
  const cy = mercY(lat);
  const hx = w / 2 / worldSize;
  const hy = h / 2 / worldSize;
  const c = new Float64Array([cx - hx, cy - hy, cx + hx, cy - hy, cx + hx, cy + hy, cx - hx, cy + hy]);
  return { c, worldSize, cssW: w, cssH: h };
}

/** The Pacific framing at 1440x900 (it crosses 180). */
const PACIFIC = view(-145, 26, 3);

test('model-node presence includes calm and masked nodes without inventing a direction', () => {
  for (const valid of [true, false]) {
    const f = gridField('wind', GLOBAL_1P00, () => [0, 0, 0, valid]);
    for (const longitude of [-120, 240]) {
      const nodeView = view(longitude, 45, 12, 390, 844);
      assert.equal(still.hasModelNodeInView(f, nodeView), true, `node ${longitude}, valid=${valid}`);
      assert.deepEqual(still.nodeArrows(f, nodeView), []);
    }
    assert.equal(still.hasModelNodeInView(f, view(-120.5, 45.5, 12, 390, 844)), false);
  }
});

test('model-node presence respects the wave crop and its equivalent longitude', () => {
  const f = gridField('waves', WAVE_CROP, () => [0, 0, 0, false]);
  for (const longitude of [165, -195, -150, 210, -100, 260]) {
    assert.equal(still.hasModelNodeInView(f, view(longitude, 30, 12, 390, 844)), true, `crop node ${longitude}`);
  }
  for (const longitude of [164, -99, -80]) {
    assert.equal(still.hasModelNodeInView(f, view(longitude, 30, 12, 390, 844)), false, `outside ${longitude}`);
  }
  assert.equal(still.hasModelNodeInView(f, view(-150.125, 30.125, 14, 390, 844)), false, 'between crop nodes');
});

test('model-node presence tests the actual rotated view, not just its bounding box', () => {
  const f = gridField('wind', GLOBAL_1P00, () => [0, 0, 0]);
  const nodeX = mercX(-120);
  const nodeY = mercY(45);
  const d = 1 / 360;
  const diamond = (offset) => {
    const x = nodeX + offset * d;
    const y = nodeY + offset * d;
    return {
      c: new Float64Array([x, y - 0.5 * d, x + 0.5 * d, y, x, y + 0.5 * d, x - 0.5 * d, y]),
      worldSize: 512 * 2 ** 12, cssW: 390, cssH: 844
    };
  };
  assert.equal(still.hasModelNodeInView(f, diamond(0)), true, 'node inside rotated quad');
  assert.equal(still.hasModelNodeInView(f, diamond(0.4)), false, 'node in bounding box but outside quad');
});

test('the still form is deterministic for one seed and view', () => {
  const f = windField();
  const a = still.buildStillForm(f, PACIFIC, 'still');
  const b = still.buildStillForm(windField(), PACIFIC, 'still');
  assert.ok(a.features.length > 1000, `${a.features.length} features`);
  assert.deepEqual(a, b, 'same field, valid time and view give the same lines');
  assert.equal(still.stillSeed(f, PACIFIC), still.stillSeed(windField(), PACIFIC));
  // A different valid time (or view) is a different seed and different lines.
  const later = windField({ ...META, validTime: META.validTime + 3600000 });
  assert.notEqual(still.stillSeed(later, PACIFIC), still.stillSeed(f, PACIFIC));
  assert.notDeepEqual(still.buildStillForm(later, PACIFIC, 'still'), a);
  // An explicit seed wins.
  assert.deepEqual(still.buildStillForm(f, PACIFIC, 'still', { seed: 9 }), still.buildStillForm(windField(), PACIFIC, 'still', { seed: 9 }));
  // Each path is 3 pieces of stepped width, tail to head, plus a 6 px chevron.
  const paths = a.features.filter((x) => x.properties.role === 'path');
  assert.equal(paths.length % 4, 0);
  for (let i = 0; i < paths.length; i += 4) {
    const [p0, p1, p2, chevron] = paths.slice(i, i + 4).map((x) => x.properties);
    assert.deepEqual([p0.piece, p1.piece, p2.piece, chevron.piece], [0, 1, 2, 3]);
    assert.ok(p0.w < p1.w && p1.w < p2.w, 'the taper is monotone, tail to head');
    assert.equal(p2.w, ink.FLOW_CORE_WIDTH_PX[p2.cls]);
    const [w0, head, w1] = paths[i + 3].geometry.coordinates;
    for (const wing of [w0, w1]) {
      const px = Math.hypot(mercX(wing[0]) - mercX(head[0]), mercY(wing[1]) - mercY(head[1])) * PACIFIC.worldSize;
      assert.ok(Math.abs(px - still.CHEVRON_PX) < 1e-3, `chevron wing ${px} px`);
    }
  }
  // No still path crosses a masked cell either.
  const s = newSample();
  for (const feat of paths) {
    if (feat.properties.piece === 3) continue;
    const cs = feat.geometry.coordinates;
    for (let k = 1; k < cs.length; k++) {
      for (let j = 0; j <= 8; j++) {
        const t = j / 8;
        const x = mercX(cs[k - 1][0]) + (mercX(cs[k][0]) - mercX(cs[k - 1][0])) * t;
        const y = mercY(cs[k - 1][1]) + (mercY(cs[k][1]) - mercY(cs[k - 1][1])) * t;
        assert.ok(sampleField(f, lonOf(x), latOf(y), s), 'a still path touches a masked cell');
      }
    }
  }
});

test('the still form for waves is static crest marks on the marks layer', () => {
  const f = gridField('waves', WAVE_CROP, (lon, lat) => {
    const to = ((lon * 3 + lat * 5) % 360) * (Math.PI / 180);
    return [Math.sin(to), Math.cos(to), 1 + (lat % 5)];
  });
  const fc = still.buildStillForm(f, PACIFIC, 'still');
  assert.ok(fc.features.length > 200);
  for (const feat of fc.features) assert.equal(feat.properties.role, 'mark');
  assert.deepEqual(fc, still.buildStillForm(f, PACIFIC, 'still'));
});

test('the still-form build of a 1440x900 Pacific view is under 50 ms (Node median)', (t) => {
  const f = windField();
  still.buildStillForm(f, PACIFIC, 'still'); // warm
  const times = [];
  for (let i = 0; i < 11; i++) {
    const t0 = performance.now();
    still.buildStillForm(f, PACIFIC, 'still', { seed: i + 1 });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[5];
  assert.ok(median < 50, `median still-form build ${median.toFixed(1)} ms`);
  t.diagnostic(`median still-form build ${median.toFixed(1)} ms`);
});

test('on a phone-width view (720 CSS px or less) the form starts still at half density', () => {
  const f = windField();
  const phone = view(-125, 45, 4, 390, 844);
  const edge = view(-125, 45, 4, 720, 900);
  const desk = view(-125, 45, 4, 721, 900);
  const p = planForm(f, phone, { motionAllowed: true });
  assert.equal(p.form, 'still');
  assert.equal(p.densityFactor, PHONE_DENSITY_FACTOR);
  assert.equal(PHONE_DENSITY_FACTOR, 0.5);
  assert.equal(planForm(f, edge, { motionAllowed: true }).form, 'still', '720 px is the phone rail');
  assert.equal(planForm(f, desk, { motionAllowed: true }).form, 'moving');
  assert.equal(planForm(f, desk, { motionAllowed: true }).densityFactor, 1);
  // Play is the viewer's choice: moving, still at half density.
  const played = planForm(f, phone, { motionAllowed: true, playPressed: true });
  assert.deepEqual(played, { form: 'moving', densityFactor: 0.5 });
  // Reduced motion or Pause keeps it still even after Play.
  assert.equal(planForm(f, phone, { motionAllowed: false, playPressed: true }).form, 'still');
  // The still seeds follow the half density.
  const full = still.buildStillForm(f, phone, 'still', { densityFactor: 1 }).features.length;
  const half = still.buildStillForm(f, phone, 'still', { densityFactor: p.densityFactor }).features.length;
  assert.ok(half < full * 0.65 && half > full * 0.35, `half density gives ${half} of ${full} features`);
  assert.equal(particleCount(phone, p.densityFactor), Math.round((390 * 844) / 1024 / 2));
});

test('the moving form draws nothing in the still layers', () => {
  assert.deepEqual(still.buildStillForm(windField(), PACIFIC, 'moving').features, []);
});

test('the still layers are flow-still-casing, flow-still and flow-still-marks with the section 6 ink', () => {
  const layers = still.stillLayers('light');
  assert.deepEqual(layers.map((l) => l.id), ['flow-still-casing', 'flow-still', 'flow-still-marks']);
  for (const l of layers) {
    assert.equal(l.type, 'line');
    assert.equal(l.source, still.STILL_SOURCE_ID);
  }
  assert.equal(layers[0].paint['line-color'], '#010B13');
  assert.deepEqual(layers[1].paint['line-color'], ['match', ['get', 'cls'], 0, '#C6CBD4', 1, '#E8ECF0', '#FFFFFF']);
  assert.deepEqual(still.stillLayers('dark')[2].paint['line-color'], ['match', ['get', 'cls'], 0, '#3B3B3B', 1, '#1E242C', '#010B13']);
});

test('the ink tokens clear 3:1 over any ground', () => {
  for (const name of ['light', 'dark']) {
    const t = ink.FLOW_INK[name];
    for (const core of t.core) {
      const ratio = ink.contrastRatio(core, t.casing);
      // The worst ground makes core and casing equally contrasting: sqrt of their ratio.
      assert.ok(Math.sqrt(ratio) >= 3, `${name} ${core} on ${t.casing}: ${Math.sqrt(ratio).toFixed(2)}:1 over the worst ground`);
    }
  }
  assert.ok(Math.abs(ink.contrastRatio('#FFFFFF', '#010B13') - 19.84) < 0.01);
  assert.deepEqual(ink.FLOW_CORE_WIDTH_PX, [1.0, 1.5, 2.0]);
  assert.equal(ink.FLOW_CASING_WIDTH_PX, 0.75);
});
