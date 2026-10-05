import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Block E1 unit E1-3 (FLOW-RENDER; design/moving-paths.md sections 3 to 9
 * and 14; DR-116): the FlowField sampler, CPU advection, wave crest marks
 * and the WebGL2 ribbon layer's CPU-side contract, over synthetic fields
 * (no network, no GRIB: E1-1 owns the decoded fixtures). The ribbon layer
 * runs against a recording fake WebGL2 context and a fake Mercator map.
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

const field = await import('../src/layers/flow/field.ts');
const advect = await import('../src/layers/flow/advect.ts');
const ribbon = await import('../src/layers/flow/ribbon-layer.ts');
const still = await import('../src/layers/flow/still.ts');

const { createFlowField, sampleField, newSample, mercX, mercY, lonOf, latOf, classOf } = field;
const {
  Particles, CrestMarks, FlowClock, WIND_PACE, WAVE_PACE, STEP_S, MAX_PARTICLES, MAX_COVERAGE,
  MARK_LENGTH_PX, particleCount, ribbonCoverage, mulberry32, advance, planForm, FADE_S
} = advect;
const { FLOW_CORE_WIDTH_PX, FLOW_CASING_WIDTH_PX } = await import('../src/layers/flow/ink.ts');

const META = Object.freeze({
  issuer: 'test', model: 'synthetic', transport: 'none', cycle: 0, forecastHour: 6,
  validTime: Date.UTC(2026, 9, 5, 12), staleAfter: null, level: '10 m above ground',
  units: 'm s-1', sourceUrl: 'about:blank', productKey: 'synthetic'
});

/** A grid filled from fn(lon, lat) -> [u, v, magnitude?, valid?]. */
function gridField(kind, grid, fn) {
  const n = grid.nx * grid.ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const m = new Float32Array(n);
  const mask = new Uint8Array(n);
  for (let r = 0; r < grid.ny; r++) {
    for (let c = 0; c < grid.nx; c++) {
      const i = r * grid.nx + c;
      const [uu, vv, mm, ok = true] = fn(grid.lon0 + c * grid.dlon, grid.lat0 - r * grid.dlat, c, r);
      u[i] = uu;
      v[i] = vv;
      m[i] = mm ?? Math.hypot(uu, vv);
      mask[i] = ok ? 1 : 0;
    }
  }
  return createFlowField({ kind, grid, u, v, magnitude: m, mask, meta: META });
}

const GLOBAL_1P00 = { lon0: 0, lat0: 90, dlon: 1, dlat: 1, nx: 360, ny: 181, wrapsLon: true };
/** E1-2's wave crop: 10 S to 62 N, 165 E to 100 W across the antimeridian (0.25 degree). */
const WAVE_CROP = { lon0: 165, lat0: 62, dlon: 0.25, dlat: 0.25, nx: 381, ny: 289, wrapsLon: false };

/** A smooth synthetic 10 m wind, about 0 to 16 m/s, median near 7. */
function windField() {
  return gridField('wind', GLOBAL_1P00, (lon, lat) => {
    const a = (lon * Math.PI) / 30;
    const b = (lat * Math.PI) / 30;
    return [6 + 5 * Math.sin(a) * Math.cos(b), 5 * Math.cos((lon * Math.PI) / 40) * Math.sin(b)];
  });
}

/** A Mercator view centred on (lon, lat) at zoom, w x h CSS px, north up. */
function view(lon, lat, zoom, w = 1440, h = 900) {
  const worldSize = 512 * 2 ** zoom;
  const cx = mercX(lon);
  const cy = mercY(lat);
  const hx = w / 2 / worldSize;
  const hy = h / 2 / worldSize;
  const c = new Float64Array([cx - hx, cy - hy, cx + hx, cy - hy, cx + hx, cy + hy, cx - hx, cy + hy]);
  return { c, worldSize, cssW: w, cssH: h };
}

/** Bearing (degrees true, TO) of a sample's components. */
function bearingOf(s) {
  return ((Math.atan2(s.u, s.v) * 180) / Math.PI + 360) % 360;
}

test('350° and 10° interpolate to about 0, never 180', () => {
  // A wave unit-vector field: TO bearing 350 on column 0, 10 on column 1.
  const grid = { lon0: -140, lat0: 40, dlon: 1, dlat: 1, nx: 2, ny: 2, wrapsLon: false };
  const toDeg = [350, 10];
  const f = gridField('waves', grid, (_lon, _lat, c) => {
    const t = (toDeg[c] * Math.PI) / 180;
    return [Math.sin(t), Math.cos(t), 1.5];
  });
  const s = sampleField(f, -139.5, 39.5, newSample());
  assert.ok(s, 'the cell between 350 and 10 is valid');
  const b = bearingOf(s);
  const off = Math.min(b, 360 - b);
  assert.ok(off < 0.5, `blend of 350 and 10 points ${b.toFixed(2)} degrees, expected about 0`);
  assert.ok(Math.abs(b - 180) > 170, 'never 180');
  // A particle on that cell moves north, not south.
  const out = new Float64Array(2);
  const x = mercX(-139.5);
  const y = mercY(39.6);
  assert.ok(advance(f, WAVE_PACE, 512 * 2 ** 6, x, y, STEP_S, out));
  assert.ok(out[1] < y, 'travel is north (Mercator y decreases)');
});

test('the FlowField takes TO components and never adds 180', () => {
  // Wind u +5, v 0 is air moving east; the field and a step keep it east.
  const grid = { lon0: -130, lat0: 50, dlon: 1, dlat: 1, nx: 4, ny: 4, wrapsLon: false };
  const f = gridField('wind', grid, () => [5, 0]);
  const s = sampleField(f, -128.5, 48.5, newSample());
  assert.equal(s.u, 5);
  assert.equal(s.v, 0);
  const out = new Float64Array(2);
  const x = mercX(-128.5);
  assert.ok(advance(f, WIND_PACE, 512 * 2 ** 6, x, mercY(48.5), STEP_S, out));
  assert.ok(out[0] > x, 'east');
});

test('a masked cell is absent, never 0, and never read as calm', () => {
  const grid = { lon0: -130, lat0: 50, dlon: 1, dlat: 1, nx: 4, ny: 4, wrapsLon: false };
  // Node (1, 1) is masked by the issuer bitmap while its stored value is 0 (calm-looking).
  const n = 16;
  const u = new Float32Array(n).fill(3);
  const v = new Float32Array(n).fill(4);
  const mask = new Uint8Array(n).fill(1);
  u[5] = 0;
  v[5] = 0;
  mask[5] = 0;
  // Node (3, 3) has no bitmap entry but a NaN value: also masked.
  u[15] = Number.NaN;
  const f = createFlowField({ kind: 'wind', grid, u, v, mask, meta: META });
  assert.equal(f.mask[5], 0);
  assert.equal(f.mask[15], 0);
  assert.ok(Number.isNaN(f.u[5]) && Number.isNaN(f.v[5]) && Number.isNaN(f.magnitude[5]), 'a masked node holds NaN, never 0');
  // Every cell touching node (1, 1) is absent, not a 0 m/s reading.
  for (const [lon, lat] of [[-129.5, 49.5], [-128.5, 49.5], [-129.5, 48.5], [-128.5, 48.5], [-129, 49]]) {
    assert.equal(sampleField(f, lon, lat, newSample()), null, `(${lon}, ${lat}) reads absent`);
  }
  // A cell with four valid corners reads the real value.
  const ok = sampleField(f, -127.5, 47.5 + 0.0, newSample());
  assert.equal(ok, null, 'the cell touching NaN node (3, 3) is absent too');
  const good = sampleField(f, -127.5, 49.5, newSample());
  assert.ok(good);
  assert.ok(Math.abs(good.m - 5) < 1e-6, 'hypot(3, 4) = 5 where valid');
  // Nearest-sample mode: a masked node is absent too.
  const near = createFlowField({ kind: 'wind', grid, u: new Float32Array(u), v: new Float32Array(v), mask, interpolation: 'nearest-sample', meta: META });
  assert.equal(sampleField(near, -129, 49, newSample()), null);
});

test('a step into a masked or out-of-grid cell kills the particle before the step commits', () => {
  // Strong east wind; column 6 is land. A particle west of it must never commit into it.
  const grid = { lon0: -140, lat0: 45, dlon: 1, dlat: 1, nx: 10, ny: 6, wrapsLon: false };
  const f = gridField('wind', grid, (_lon, _lat, c) => [40, 0, undefined, c !== 6]);
  const worldSize = 512 * 2 ** 3; // 1 degree is about 11 px; one 1/30 s step at 40 m/s is about half a cell
  const out = new Float64Array(2);
  // Start inside the cell just west of the masked column's cells (cell 4 has corners at columns 4 and 5).
  let x = mercX(-135.95);
  const y = mercY(42.5);
  let killed = false;
  for (let i = 0; i < 20; i++) {
    const s = advance(f, WIND_PACE, worldSize, x, y, STEP_S, out);
    if (!s) {
      killed = true;
      break;
    }
    assert.ok(lonOf(out[0]) < -135, `committed position ${lonOf(out[0]).toFixed(3)} is west of the masked cells`);
    x = out[0];
  }
  assert.ok(killed, 'the step into the masked cell was refused');
  // Off the east edge of a regional grid: refused too, nothing extrapolated.
  const open = gridField('wind', grid, () => [40, 0]);
  assert.equal(advance(open, WIND_PACE, worldSize, mercX(-131.05), y, STEP_S, out), null);
  // Through Particles: a refused step respawns (a new generation), so no segment joins the two.
  const p = new Particles(f, WIND_PACE, mulberry32(7));
  const vq = view(-135.5, 42.5, 3, 64, 64);
  p.setCount(vq, 1);
  p.reset(vq);
  for (let i = 0; i < 40; i++) p.step(vq);
  p.forEachSegment((_p, ax, _ay, bx) => {
    const a = lonOf(ax);
    const b = lonOf(bx);
    assert.ok(!(a < -135 && b > -135), `a segment ${a.toFixed(2)} to ${b.toFixed(2)} crosses into the masked cells`);
  });
});

test('no path segment crosses a masked cell (property test, 1,000 seeds)', () => {
  let segments = 0;
  let refusals = 0;
  const probe = newSample();
  for (let seed = 1; seed <= 1000; seed++) {
    const rng = mulberry32(seed * 7919);
    const grid = { lon0: -150, lat0: 50, dlon: 1, dlat: 1, nx: 16, ny: 16, wrapsLon: false };
    const f = gridField('wind', grid, () => [(rng() - 0.5) * 50, (rng() - 0.5) * 50, undefined, rng() > 0.15]);
    const zoom = 2 + rng() * 4; // includes zooms where one step spans several cells (sub-steps)
    const vq = view(-142, 42, zoom, 160, 160);
    const p = new Particles(f, WIND_PACE, mulberry32(seed));
    p.setCount(vq, 1);
    p.reset(vq);
    for (let i = 0; i < 12; i++) p.step(vq);
    const before = segments;
    p.forEachSegment((_i, ax, ay, bx, by) => {
      segments++;
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const s = sampleField(f, lonOf(ax + (bx - ax) * t), latOf(ay + (by - ay) * t), probe);
        assert.ok(s, `seed ${seed}: a drawn segment touches a masked or out-of-grid cell at t=${t}`);
      }
    });
    if (segments - before < p.count * 11) refusals++;
  }
  assert.ok(segments > 100000, `the property saw ${segments} segments`);
  assert.ok(refusals > 500, 'the masks actually refused steps in most seeds');
});

test('the sampler wraps across the antimeridian inside the wave crop', () => {
  // u carries the column index, so the sample says where it read.
  const f = gridField('waves', WAVE_CROP, (_lon, _lat, c) => [c, 1, 1]);
  const s = newSample();
  const col = (lon) => {
    const r = sampleField(f, lon, 50.1, s);
    return r ? r.u : null;
  };
  assert.ok(Math.abs(col(165) - 0) < 1e-4, '165 E is column 0');
  assert.ok(Math.abs(col(179.9) - 59.6) < 1e-3, '179.9 E');
  assert.ok(Math.abs(col(-179.9) - 60.4) < 1e-3, '179.9 W continues east of 180');
  assert.ok(Math.abs(col(180) - 60) < 1e-3, '180');
  assert.ok(Math.abs(col(-155.1) - 159.6) < 1e-3, 'Hilo longitude');
  assert.ok(Math.abs(col(-100) - 380) < 1e-3, '100 W is the last column');
  assert.equal(col(164.9), null, 'west of the crop is absent');
  assert.equal(col(-99.9), null, 'east of the crop is absent');
  assert.equal(sampleField(f, 172.9, 62.1, s), null, 'north of the crop is absent');
  // A particle crossing 180 keeps a continuous x with no jump.
  const east = gridField('waves', WAVE_CROP, () => [1, 0, 1]);
  const out = new Float64Array(2);
  let x = mercX(179.95);
  const y = mercY(52.9);
  const worldSize = 512 * 2 ** 6;
  for (let i = 0; i < 60; i++) {
    assert.ok(advance(east, WAVE_PACE, worldSize, x, y, STEP_S, out));
    const stepPx = (out[0] - x) * worldSize;
    assert.ok(stepPx > 0 && stepPx < 1, 'no jump across 180');
    x = out[0];
  }
  assert.ok(lonOf(x) > 180, 'the unwrapped longitude ran past 180');
});

/** Mark positions, ages and classes after `steps`, keyed by index. */
function runMarks(f, seed, vq, steps) {
  const m = new CrestMarks(f, mulberry32(seed));
  m.setCount(vq, 1);
  m.reset(vq);
  const track = [];
  for (let k = 0; k < steps; k++) {
    const x = Float64Array.from(m.x);
    const y = Float64Array.from(m.y);
    const age = Float32Array.from(m.age);
    const alive = Uint8Array.from(m.alive);
    m.step(vq);
    track.push({ x, y, age, alive, nx: Float64Array.from(m.x), ny: Float64Array.from(m.y), nage: Float32Array.from(m.age), nalive: Uint8Array.from(m.alive) });
  }
  return { m, track };
}

/** A smooth wave field (unit TO vectors) over the crop with height from `h`. */
function waveField(h) {
  return gridField('waves', WAVE_CROP, (lon, lat) => {
    const to = ((lon * 3 + lat * 5) % 360) * (Math.PI / 180);
    return [Math.sin(to), Math.cos(to), h(lon, lat)];
  });
}

test('wave height sets the class and mark length, never the rate', () => {
  const vq = view(-150, 30, 4, 800, 600);
  const low = waveField(() => 1.5);
  const high = waveField(() => 3.0); // doubled: class 0 becomes class 1
  const a = runMarks(low, 42, vq, 30);
  const b = runMarks(high, 42, vq, 30);
  assert.deepEqual(Array.from(a.m.x), Array.from(b.m.x), 'doubling height leaves every position (the rate) unchanged');
  assert.deepEqual(Array.from(a.m.y), Array.from(b.m.y));
  assert.equal(classOf('waves', 1.5), 0);
  assert.equal(classOf('waves', 3.0), 1);
  const crestPx = (m, k) => {
    const o = k * 12;
    return Math.hypot(m.segs[o + 2] - m.segs[o], m.segs[o + 3] - m.segs[o + 1]) * vq.worldSize;
  };
  assert.ok(a.m.segCount > 100 && a.m.segCount === b.m.segCount);
  for (let k = 0; k < a.m.segCount / 2; k++) {
    assert.equal(a.m.segs[k * 12 + 4], 0);
    assert.equal(b.m.segs[k * 12 + 4], 1);
    assert.ok(Math.abs(crestPx(a.m, k) - MARK_LENGTH_PX[0]) < 1e-3);
    assert.ok(Math.abs(crestPx(b.m, k) - MARK_LENGTH_PX[1]) < 1e-3);
  }
});

test('every wave mark moves at 24 px/s', () => {
  const vq = view(-150, 30, 4, 1440, 900);
  const f = waveField((lon, lat) => 0.5 + Math.abs(Math.sin(lon / 7 + lat / 3)) * 7); // all three classes
  const { track } = runMarks(f, 3, vq, 45);
  let measured = 0;
  for (const t of track) {
    for (let i = 0; i < t.x.length; i++) {
      if (!t.alive[i] || !t.nalive[i]) continue;
      if (Math.abs(t.nage[i] - t.age[i] - STEP_S) > 1e-6) continue; // respawned this step
      const px = Math.hypot(t.nx[i] - t.x[i], t.ny[i] - t.y[i]) * vq.worldSize;
      const rate = px / STEP_S;
      assert.ok(Math.abs(rate - 24) < 0.05, `a mark moved at ${rate.toFixed(3)} px/s`);
      measured++;
    }
  }
  assert.ok(measured > 10000, `measured ${measured} mark steps`);
  assert.equal(WAVE_PACE.pxPerSecPerUnit, 24);
  assert.equal(WAVE_PACE.uniform, true);
});

test('density is capped at 4,096 and coverage at 8 percent', () => {
  assert.equal(particleCount(view(0, 0, 3), 1), 1266, 'Standard at 1440x900');
  assert.equal(particleCount(view(0, 0, 3), 0.5), 633, 'Sparse');
  assert.equal(particleCount(view(0, 0, 3), 2), 2531, 'Dense');
  assert.equal(particleCount(view(0, 0, 3, 3840, 2160), 2), MAX_PARTICLES, 'Dense on a 4K view is capped');
  assert.equal(MAX_PARTICLES, 4096);
  const big = new Particles(windField(), WIND_PACE, mulberry32(1));
  big.setCount(view(-145, 26, 3, 3840, 2160), 2);
  assert.equal(big.count, 4096);
  assert.ok(big.capacity <= 4096);
  // Coverage at Standard over the Pacific framing (the view crosses 180).
  const vq = view(-145, 26, 3);
  const p = new Particles(windField(), WIND_PACE, mulberry32(2));
  p.setCount(vq, 1);
  p.reset(vq);
  for (let i = 0; i < 90; i++) p.step(vq);
  const cover = ribbonCoverage(p, vq, FLOW_CORE_WIDTH_PX, FLOW_CASING_WIDTH_PX);
  assert.ok(cover > 0.01, `coverage ${cover} shows ribbons drew`);
  assert.ok(cover <= MAX_COVERAGE, `coverage ${(cover * 100).toFixed(2)} percent exceeds 8 percent`);
});

test('resuming resets ages, so no burst', () => {
  const vq = view(-145, 26, 3);
  const p = new Particles(windField(), WIND_PACE, mulberry32(5));
  p.setCount(vq, 1);
  p.reset(vq);
  for (let i = 0; i < 60; i++) p.step(vq);
  let segs = 0;
  p.forEachSegment(() => segs++);
  assert.ok(segs > 10000, 'trails exist before the pause');
  // Resume: every particle young, no trail kept, first step fades in.
  p.reset(vq);
  for (let i = 0; i < p.count; i++) if (p.alive[i]) assert.equal(p.age[i], 0);
  segs = 0;
  p.forEachSegment(() => segs++);
  assert.equal(segs, 0, 'the ring is empty after resume');
  p.step(vq);
  let maxAlpha = 0;
  for (let i = 0; i < p.count; i++) {
    const w = p.ring[p.slotOffset(i, 0) + 3];
    if (w >= 0) maxAlpha = Math.max(maxAlpha, w - Math.floor(w / 2) * 2);
  }
  assert.ok(maxAlpha <= STEP_S / FADE_S + 1e-6, `first step after resume draws at most alpha ${maxAlpha}`);
  // The clock: a 10 s pause never comes back as a burst of steps.
  const clock = new FlowClock();
  assert.equal(clock.due(0), 1);
  assert.equal(clock.due(STEP_S * 1.01), 1);
  assert.equal(clock.due(10), 2, 'without resume, catch-up is bounded at 2');
  clock.resume();
  assert.equal(clock.due(20), 1, 'the first tick after resume is one step');
  assert.equal(clock.due(20 + STEP_S * 0.5), 0);
});

// ---------------------------------------------------------------------------
// The ribbon layer against a recording fake WebGL2 context and a fake map
// ---------------------------------------------------------------------------

function fakeGl() {
  const calls = [];
  let lost = false;
  let id = 0;
  const handle = (kind) => ({ kind, id: ++id });
  const gl = new Proxy({ drawingBufferWidth: 1440, drawingBufferHeight: 900 }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'calls') return calls;
      if (prop === 'lose') return () => { lost = true; };
      if (prop === 'isContextLost') return () => lost;
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return prop;
      return (...args) => {
        calls.push([prop, ...args]);
        if (prop.startsWith('create')) return handle(prop.slice(6));
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true;
        if (prop === 'getAttribLocation') return 0;
        if (prop === 'getUniformLocation') return { uniform: args[1] };
        return undefined;
      };
    }
  });
  return gl;
}

function fakeMap(lon, lat, zoom, w = 1440, h = 900) {
  const listeners = new Map();
  const canvas = {
    clientWidth: w, clientHeight: h,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type)
  };
  const state = { lon, lat, zoom };
  return {
    state, listeners,
    getCanvas: () => canvas,
    getZoom: () => state.zoom,
    getCenter: () => ({ lng: state.lon, lat: state.lat }),
    unproject: ([sx, sy]) => {
      const ws = 512 * 2 ** state.zoom;
      const x = mercX(state.lon) + (sx - w / 2) / ws;
      const y = mercY(state.lat) + (sy - h / 2) / ws;
      return { lng: lonOf(x), lat: latOf(y) };
    }
  };
}

const RENDER_INPUT = { defaultProjectionData: { mainMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } };

test('the ribbon layer binds its own vertex array, leaves none bound, and outputs premultiplied colour', () => {
  let t = 0;
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: windField(), now: () => t });
  const map = fakeMap(-145, 26, 3);
  const gl = fakeGl();
  layer.onAdd(map, gl);
  layer.setRunning(true);
  for (let i = 0; i < 5; i++) {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  }
  const binds = gl.calls.filter((c) => c[0] === 'bindVertexArray');
  assert.ok(binds.length > 0);
  assert.equal(binds.at(-1)[1], null, 'the last vertex-array bind is null');
  const draw = gl.calls.findLastIndex((c) => c[0] === 'drawArraysInstanced');
  const lastBindBeforeDraw = gl.calls.slice(0, draw).findLast((c) => c[0] === 'bindVertexArray');
  assert.ok(lastBindBeforeDraw[1] && lastBindBeforeDraw[1].kind === 'VertexArray', 'its own VAO is bound for the draw');
  assert.equal(gl.calls[draw][4], layer.particles.count * 17, 'one instance per trail segment');
  assert.match(ribbon.RIBBON_SHADERS.FRAG, /fragColor = vec4\(mix\(u_casing, ink, core\) \* a, a\)/, 'colour is multiplied by alpha');
  assert.ok(!gl.calls.some((c) => c[0] === 'blendFunc'), 'the layer leaves MapLibre blend state alone');
  // The per-frame origin: the matrix is translated to the origin in double precision.
  const m = ribbon.originMatrix(RENDER_INPUT.defaultProjectionData.mainMatrix, 0.25, 0.5);
  assert.deepEqual(Array.from(m.slice(12)), [0.25, 0.5, 0, 1]);
  // Paused: no steps and no draw.
  layer.setRunning(false);
  const steps = layer.stats.steps;
  const draws = gl.calls.filter((c) => c[0] === 'drawArraysInstanced').length;
  t += 1;
  layer.render(gl, RENDER_INPUT);
  assert.equal(layer.stats.steps, steps);
  assert.equal(gl.calls.filter((c) => c[0] === 'drawArraysInstanced').length, draws);
});

test('after a context loss the ribbon layer rebuilds from CPU state with the same particles and field', () => {
  let t = 0;
  const f = windField();
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: f, now: () => t });
  const map = fakeMap(-145, 26, 3);
  const gl = fakeGl();
  layer.onAdd(map, gl);
  layer.setRunning(true);
  for (let i = 0; i < 10; i++) {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  }
  const count = layer.particles.count;
  const xs = Array.from(layer.particles.x.slice(0, count));
  gl.lose();
  map.listeners.get('webglcontextlost')();
  assert.equal(layer.gpuEpoch, 1);
  layer.render(gl, RENDER_INPUT); // still lost: nothing happens
  assert.deepEqual(Array.from(layer.particles.x.slice(0, count)), xs, 'CPU particles kept through the loss');
  const restored = fakeGl();
  layer.render(restored, RENDER_INPUT);
  assert.ok(restored.calls.some((c) => c[0] === 'createProgram'), 'programs rebuilt on the restored context');
  const upload = restored.calls.find((c) => c[0] === 'texImage2D');
  assert.ok(upload && upload[9] === layer.particles.ring, 'the whole CPU ring is re-uploaded');
  assert.equal(layer.particles.count, count, 'the same particle count');
  assert.equal(layer.field, f, 'the same field: no refetch');
  assert.ok(restored.calls.some((c) => c[0] === 'drawArraysInstanced'));
});

test('past 384 CSS px per cell, nodes draw arrows and nothing advects', () => {
  const f = windField();
  // 1 degree cells near 45 N: about 390 CSS px at zoom 7.6.
  const near = view(-124, 45, 7.4);
  const past = view(-124, 45, 7.7);
  assert.equal(planForm(f, near, { motionAllowed: true }).form, 'moving');
  assert.equal(planForm(f, past, { motionAllowed: true }).form, 'arrows');
  assert.equal(planForm(f, past, { motionAllowed: false }).form, 'arrows');
  const fc = still.buildStillForm(f, past, 'arrows');
  assert.ok(fc.features.length > 0 && fc.features.length % 2 === 0, 'one shaft and one head per node');
  for (const feat of fc.features) assert.equal(feat.properties.role, 'mark');
  // Every shaft is centred on a grid node (integer degrees here).
  for (let i = 0; i < fc.features.length; i += 2) {
    const [a, b] = fc.features[i].geometry.coordinates;
    const mx = lonOf((mercX(a[0]) + mercX(b[0])) / 2);
    const my = latOf((mercY(a[1]) + mercY(b[1])) / 2);
    assert.ok(Math.abs(mx - Math.round(mx)) < 1e-6 && Math.abs(my - Math.round(my)) < 1e-6, `arrow centre ${mx}, ${my} is a node`);
  }
  // The moving layer takes no step there.
  let t = 0;
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: f, now: () => t });
  const map = fakeMap(-124, 45, 7.7);
  const gl = fakeGl();
  layer.onAdd(map, gl);
  layer.setRunning(true);
  for (let i = 0; i < 5; i++) {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  }
  assert.equal(layer.stats.steps, 0, 'nothing advects past the grid');
  assert.ok(!gl.calls.some((c) => c[0] === 'drawArraysInstanced'));
});
