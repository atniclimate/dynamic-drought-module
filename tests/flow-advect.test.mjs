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
  Particles, CrestMarks, FlowClock, WIND_PACE, WAVE_RATE_PX_PER_S, STEP_S, MAX_PARTICLES, MAX_COVERAGE,
  MARK_LENGTH_PX, MARK_CRESTS, MARK_CREST_WEIGHT, MARK_END_TAPER, MARK_SEG_FLOATS, MARK_SEGS_PER_SET, MAX_MARKS,
  MARK_ARC, MARK_GAP_RATIO, MARK_CREST_RATIO, MARK_MIN_AGREEMENT, MARK_MAX_TURN_DEG, MARK_LIFE_S, MARK_MIN_LIFE_S,
  MARK_SMOOTH_NODES, waveDirections,
  markCount, particleCount, ribbonCoverage, mulberry32, advance, planForm, FADE_S
} = advect;
const { FLOW_CORE_WIDTH_PX, FLOW_CASING_WIDTH_PX, inkRgb } = await import('../src/layers/flow/ink.ts');

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
  assert.ok(advance(f, WIND_PACE, 512 * 2 ** 6, x, y, STEP_S, out));
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
    assert.ok(advance(east, WIND_PACE, worldSize, x, y, STEP_S, out));
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

/**
 * The drawn crests of a CrestMarks, back to front within each set. A crest is
 * four segments drawn from its centre outward: centre to mid and mid to end on
 * one side, then the same on the other, each with a width factor at both ends.
 * `pts` is end, mid, centre, mid, end in absolute Mercator units.
 */
function crestsOf(m) {
  assert.equal(MARK_SEGS_PER_SET / MARK_CRESTS, 4, 'four segments per crest');
  const out = [];
  for (let k = 0; k < m.segCount / 4; k++) {
    const seg = (j) => (k * 4 + j) * MARK_SEG_FLOATS;
    const a = (o) => [m.segs[o] + m.originX, m.segs[o + 1] + m.originY];
    const b = (o) => a(o + 2);
    assert.deepEqual(a(seg(0)), a(seg(2)), 'both sides start at the crest centre');
    assert.deepEqual(b(seg(0)), a(seg(1)), 'one side is continuous');
    assert.deepEqual(b(seg(2)), a(seg(3)), 'the other side is continuous');
    for (let j = 1; j < 4; j++) {
      for (const f of [4, 5]) assert.equal(m.segs[seg(j) + f], m.segs[seg(0) + f], 'one class and alpha per crest');
    }
    for (const side of [0, 2]) {
      assert.equal(m.segs[seg(side) + 7], m.segs[seg(side + 1) + 6], 'the width factor runs on through the mid point');
      assert.ok(Math.abs(m.segs[seg(side + 1) + 7] - m.segs[seg(0) + 6] * MARK_END_TAPER) < 1e-6, 'and thins to the end');
    }
    out.push({
      pts: [b(seg(1)), b(seg(0)), a(seg(0)), b(seg(2)), b(seg(3))],
      cls: m.segs[seg(0) + 4], alpha: m.segs[seg(0) + 5], weight: m.segs[seg(0) + 6]
    });
  }
  return out;
}

/** CSS px along a crest polyline. */
function crestLengthPx(crest, worldSize) {
  let len = 0;
  for (let j = 1; j < crest.pts.length; j++) {
    len += Math.hypot(crest.pts[j][0] - crest.pts[j - 1][0], crest.pts[j][1] - crest.pts[j - 1][1]);
  }
  return len * worldSize;
}

/** Bearing in degrees (0 north, clockwise) of a Mercator-axes direction (x east, y south). */
const bearingOfDir = (dx, dy) => ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Turning per life from the held directions: run `steps` and, for each mark,
 * sum |wrap180(bearing_k - bearing_(k-1))| over a life (a life ends when its
 * age drops or it dies). Returns the completed lives' turning (degrees) and
 * the largest single-step turn.
 */
function lifeTurning(m, vq, steps) {
  const turns = [];
  let maxStep = 0;
  const prev = new Array(m.count).fill(null);
  const acc = new Float64Array(m.count);
  for (let k = 0; k < steps; k++) {
    const age0 = Float32Array.from(m.age);
    const alive0 = Uint8Array.from(m.alive);
    m.step(vq);
    for (let i = 0; i < m.count; i++) {
      const continued = alive0[i] && m.alive[i] && m.age[i] >= age0[i];
      if (!continued) {
        if (prev[i] !== null) turns.push(acc[i]);
        acc[i] = 0;
        prev[i] = m.alive[i] ? bearingOfDir(m.dirX[i], m.dirY[i]) : null;
        continue;
      }
      const b = bearingOfDir(m.dirX[i], m.dirY[i]);
      if (prev[i] !== null) {
        const d = Math.abs(wrap180(b - prev[i]));
        acc[i] += d;
        maxStep = Math.max(maxStep, d);
      }
      prev[i] = b;
    }
  }
  return { turns, maxStep };
}

/** The production FlowField of the committed GFS-Wave fixture (2026-10-05 06Z f006), as tests/flow-nodd.test.mjs reads it. */
async function fixtureWaveField() {
  const { readFileSync } = await import('node:fs');
  const { decodeGrib2 } = await import('../src/layers/flow/grib2.ts');
  const { buildPacket } = await import('../src/layers/flow/decode-worker.ts');
  const source = await import('../src/layers/flow/source.ts');
  const read = (name) => decodeGrib2(new Uint8Array(readFileSync(new URL(`./fixtures/flow/${name}`, import.meta.url))), {
    grid: { ni: 1440, nj: 721, la1: 90, lo1: 0 }
  }).values;
  const cycle = Date.UTC(2026, 9, 5, 6);
  const packet = buildPacket('waves', [read('global0p25-DIRPW-f006.grib2'), read('global0p25-HTSGW-f006.grib2')], cycle, 6);
  return source.fieldFromPacket(packet, source.frameMeta('waves', cycle, 6));
}

/** The Pacific framing of the 8.03 capture. */
const PACIFIC_FRAMING = () => view(-144.8, 34.5, 2.7, 1440, 900);

/** The unit travel direction in Mercator axes (y south) the field gives at (x, y), or null. */
function travelAt(f, x, y) {
  const s = sampleField(f, lonOf(x), latOf(y), newSample());
  if (!s) return null;
  const n = Math.hypot(s.u, s.v);
  return [s.u / n, -s.v / n];
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
  const ca = crestsOf(a.m);
  const cb = crestsOf(b.m);
  assert.ok(ca.length > 100, `${ca.length} crests drawn`);
  // The front crest (full weight) is an arc of the class length, drawn as four chords.
  for (const c of ca) {
    assert.equal(c.cls, 0);
    if (c.weight === 1) assert.ok(Math.abs(crestLengthPx(c, vq.worldSize) - chordsOf(MARK_LENGTH_PX[0])) < 1e-2, 'class 0 front crest length');
  }
  for (const c of cb) {
    assert.equal(c.cls, 1);
    if (c.weight === 1) assert.ok(Math.abs(crestLengthPx(c, vq.worldSize) - chordsOf(MARK_LENGTH_PX[1])) < 1e-2, 'class 1 front crest length');
  }
});

/** The four-chord length of an arc of length L spanning MARK_ARC. */
function chordsOf(L) {
  return (L * Math.sin(MARK_ARC / 8)) / (MARK_ARC / 8);
}

/** Unit travel in Mercator axes for a TO bearing in degrees. */
const travelOf = (deg) => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];

test('a set is three concentric arcs across the travel, the longest and boldest in front, sized by class', () => {
  assert.equal(MARK_CRESTS, 3);
  assert.deepEqual(MARK_LENGTH_PX, [20, 28, 36]);
  assert.deepEqual(MARK_CREST_WEIGHT, [0.5, 0.75, 1], 'weights back to front, the wind ribbons\' tail-to-head taper');
  assert.ok(Math.abs(MARK_ARC - (40 * Math.PI) / 180) < 1e-12, 'every crest spans 40 degrees of arc');
  assert.equal(MARK_GAP_RATIO, 0.25);
  assert.deepEqual(MARK_CREST_RATIO, [1 - MARK_ARC / 2, 1 - MARK_ARC / 4, 1]);
  for (const [h, cls] of [[1.5, 0], [3, 1], [5, 2]]) {
    // One travel direction everywhere: TO bearing 60 degrees.
    const f = gridField('waves', WAVE_CROP, () => [Math.sin(Math.PI / 3), Math.cos(Math.PI / 3), h]);
    const vq = view(-150, 30, 4, 800, 600);
    const { m } = runMarks(f, 11, vq, 40);
    assert.ok(m.segCount > 0 && m.segCount % MARK_SEGS_PER_SET === 0, 'whole sets only');
    const t = travelOf(60);
    const n = [-t[1], t[0]];
    const Lf = MARK_LENGTH_PX[cls] / vq.worldSize;
    const crests = crestsOf(m);
    for (let s = 0; s < crests.length; s += MARK_CRESTS) {
      const set = crests.slice(s, s + MARK_CRESTS);
      assert.deepEqual(set.map((c) => c.weight), MARK_CREST_WEIGHT, 'back to front: half, three quarters, full');
      const front = set[MARK_CRESTS - 1].pts[2];
      // One centre for all three arcs, the front arc's radius L_f / ARC behind its midpoint.
      const centre = [front[0] - (Lf / MARK_ARC) * t[0], front[1] - (Lf / MARK_ARC) * t[1]];
      const tol = 1e-3 / vq.worldSize; // a thousandth of a CSS px
      set.forEach((c, k) => {
        assert.equal(c.cls, cls);
        const rho = (MARK_CREST_RATIO[k] * Lf) / MARK_ARC;
        for (const p of c.pts) {
          assert.ok(Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - rho) < tol, 'every vertex on its arc about the one centre');
        }
        // The arc spans MARK_ARC symmetrically about the travel, so its length is ratio * L_f.
        const ends = [c.pts[0], c.pts[4]].map((p) => Math.atan2((p[0] - centre[0]) * n[0] + (p[1] - centre[1]) * n[1],
          (p[0] - centre[0]) * t[0] + (p[1] - centre[1]) * t[1]));
        assert.ok(Math.abs(Math.abs(ends[0] - ends[1]) - MARK_ARC) < 1e-4, 'the arc spans 40 degrees');
        // Midpoints a quarter of the front length apart along the travel, the front one on the mark.
        const mid = c.pts[2];
        const back = ((front[0] - mid[0]) * t[0] + (front[1] - mid[1]) * t[1]) * vq.worldSize;
        assert.ok(Math.abs(back - (MARK_CRESTS - 1 - k) * MARK_GAP_RATIO * MARK_LENGTH_PX[cls]) < 1e-2, 'midpoint gap');
      });
      // The front crest's bow (sagitta).
      const fc = set[MARK_CRESTS - 1].pts;
      const chordMid = [(fc[0][0] + fc[4][0]) / 2, (fc[0][1] + fc[4][1]) / 2];
      const sag = ((front[0] - chordMid[0]) * t[0] + (front[1] - chordMid[1]) * t[1]) * vq.worldSize;
      assert.ok(Math.abs(sag - (MARK_LENGTH_PX[cls] / MARK_ARC) * (1 - Math.cos(MARK_ARC / 2))) < 1e-2, `front sagitta ${sag}`);
      const live = [];
      for (let i = 0; i < m.count; i++) if (m.alive[i]) live.push([m.x[i], m.y[i]]);
      assert.ok(live.some(([x, y]) => Math.hypot(x - front[0], y - front[1]) * vq.worldSize < 1e-3), 'the front midpoint is the mark');
    }
  }
});

test('the spin metric on the real field: no set turns at all over its life (fixture, Pacific framing)', async (tc) => {
  const f = await fixtureWaveField();
  const vq = PACIFIC_FRAMING();
  const m = new CrestMarks(f, mulberry32(3));
  m.setCount(vq, 1);
  m.reset(vq);
  const { turns, maxStep } = lifeTurning(m, vq, 300);
  tc.diagnostic(`${turns.length} completed lives; largest single-step turn ${maxStep} degrees`);
  assert.ok(turns.length >= 100, `${turns.length} completed lives`);
  for (const T of turns) assert.ok(T <= 1e-6, `a set turned ${T} degrees over its life`);
  // The guard any later turning design must also meet.
  const sorted = turns.slice().sort((a, b) => a - b);
  assert.ok(sorted[Math.floor(0.95 * sorted.length)] <= 10 && maxStep <= 2);
});

test('the agreement gate: every set on the fixture spawned where neighbouring directions agree (R >= 0.8)', async () => {
  const f = await fixtureWaveField();
  const smooth = waveDirections(f);
  const vq = PACIFIC_FRAMING();
  const m = new CrestMarks(f, mulberry32(9));
  m.setCount(vq, 1);
  m.reset(vq);
  m.step(vq, 0); // spawn only
  let n = 0;
  for (let i = 0; i < m.count; i++) {
    if (!m.alive[i]) continue;
    const s = sampleField(smooth, lonOf(m.x[i]), latOf(m.y[i]), newSample());
    assert.ok(s && Math.hypot(s.u, s.v) >= MARK_MIN_AGREEMENT, 'agreement at the spawn point');
    n++;
  }
  assert.ok(n > 50, `${n} sets spawned`);
});

test('a set keeps its spawn orientation on a turning field, and only travels where the averaged direction stays within 20 degrees', () => {
  // TO bearing turns 1 degree per 0.25 degree of longitude, from 60 degrees at 160 W.
  const f = gridField('waves', WAVE_CROP, (lon) => {
    const deg = 60 + (lon - 200) * 4;
    return [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 2.5];
  });
  const smooth = waveDirections(f);
  const vq = view(-160, 30, 4, 1440, 900);
  const m = new CrestMarks(f, mulberry32(4));
  m.setCount(vq, 1);
  m.reset(vq);
  const held = new Array(m.count).fill(null);
  let checked = 0;
  for (let k = 0; k < 150; k++) {
    const age0 = Float32Array.from(m.age);
    m.step(vq);
    for (let i = 0; i < m.count; i++) {
      if (!m.alive[i]) continue;
      const b = bearingOfDir(m.dirX[i], m.dirY[i]);
      if (m.age[i] < age0[i] || held[i] === null) held[i] = b;
      assert.ok(Math.abs(wrap180(b - held[i])) < 1e-9, 'the held direction never changes within a life');
      const s = sampleField(smooth, lonOf(m.x[i]), latOf(m.y[i]), newSample());
      assert.ok(s, 'the path stays on valid water');
      assert.ok(Math.abs(wrap180(bearingOfDir(s.u, -s.v) - b)) <= MARK_MAX_TURN_DEG + 1e-6, 'within 20 degrees of the water it crosses');
      checked++;
    }
  }
  assert.ok(checked > 5000, `${checked} set steps checked`);
  // And the drawn set lies across its own held direction.
  const crests = crestsOf(m);
  for (let s = 0; s < crests.length; s += MARK_CRESTS) {
    const fc = crests[s + MARK_CRESTS - 1].pts;
    const i = [...Array(m.count).keys()].find((j) => m.alive[j] && Math.hypot(m.x[j] - fc[2][0], m.y[j] - fc[2][1]) * vq.worldSize < 1e-3);
    assert.ok(i !== undefined);
    const chord = [fc[4][0] - fc[0][0], fc[4][1] - fc[0][1]];
    assert.ok(Math.abs(chord[0] * m.dirX[i] + chord[1] * m.dirY[i]) / Math.hypot(...chord) < 1e-3, 'the arc ends lie across the held travel');
  }
});

test('no set is drawn at a convergent front where the primary direction flips', () => {
  // Travel toward 0 degrees south of the line and toward 180 degrees north of it; the nodes either side
  // sit at 19.75 and 20 N, so the line is 19.875 N. Re-aimed sets are pulled into it and flip there.
  const front = 19.875;
  const f = gridField('waves', WAVE_CROP, (_lon, lat) => (lat < front ? [0, 1, 2.5] : [0, -1, 2.5]));
  const vq = view(-150, 20, 4, 1440, 900);
  const m = new CrestMarks(f, mulberry32(6));
  m.setCount(vq, 1);
  m.reset(vq);
  let drawn = 0;
  let nearest = Infinity;
  for (let k = 0; k < 300; k++) {
    m.step(vq);
    for (const c of crestsOf(m)) {
      drawn++;
      for (const p of c.pts) nearest = Math.min(nearest, Math.abs(latOf(p[1]) - front));
    }
  }
  // Where the 5x5 mean's agreement first reaches 0.8: half a degree either side of the line.
  assert.ok(nearest > 0.45, `a crest vertex came within ${nearest.toFixed(3)} degrees of the front`);
  assert.ok(drawn > 1000, `${drawn} crests drawn away from the front`);
});

test('no pops in a static view: every set ends at its own faded end', () => {
  const f = waveField(() => 2.5);
  const vq = view(-150, 30, 4, 1440, 900);
  const m = new CrestMarks(f, mulberry32(8));
  m.setCount(vq, 1);
  m.reset(vq);
  let ended = 0;
  for (let k = 0; k < 300; k++) {
    const age0 = Float32Array.from(m.age);
    const life0 = Float32Array.from(m.life);
    const alive0 = Uint8Array.from(m.alive);
    m.step(vq);
    for (let i = 0; i < m.count; i++) {
      if (!alive0[i]) continue;
      // A life ends when its set respawns (the age drops) or finds no new place (it dies): only at its own end.
      if (!m.alive[i] || m.age[i] < age0[i]) {
        assert.ok(age0[i] >= life0[i] - 1e-5, `a set ended at age ${age0[i]} of a ${life0[i]} s life`);
        ended++;
      }
    }
  }
  assert.ok(ended > 300, `${ended} lives ended`);
  for (let i = 0; i < m.count; i++) {
    if (m.alive[i]) assert.ok(m.life[i] >= MARK_MIN_LIFE_S - 1e-6 && m.life[i] <= MARK_LIFE_S + 1e-6, 'lives from 1 to 2 s');
  }
});

test('the direction low-pass: energy-weighted 5x5 node mean, agreement as its length, masks kept', () => {
  assert.equal(MARK_SMOOTH_NODES, 2);
  const grid = { lon0: -160, lat0: 40, dlon: 0.25, dlat: 0.25, nx: 12, ny: 12, wrapsLon: false };
  // Uniform: unchanged, R = 1.
  const uni = waveDirections(gridField('waves', grid, () => [0.6, 0.8, 2]));
  for (let i = 0; i < uni.u.length; i++) {
    assert.ok(Math.abs(uni.u[i] - 0.6) < 1e-6 && Math.abs(uni.v[i] - 0.8) < 1e-6, 'a uniform field is returned unchanged');
  }
  // 350 and 10 degrees average to 0, never 180.
  const split = waveDirections(gridField('waves', grid, (_lon, _lat, c) => {
    const deg = c % 2 ? 350 : 10;
    return [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 2];
  }));
  for (let i = 0; i < split.u.length; i++) {
    const b = (Math.atan2(split.u[i], split.v[i]) * 180) / Math.PI;
    assert.ok(Math.abs(b) < 5 && split.v[i] > 0.98, `350 and 10 average to ${b.toFixed(2)}, not 180`);
  }
  // Equal opposing halves: no agreement on the line between them.
  const opposed = waveDirections(gridField('waves', grid, (_lon, _lat, c) => (c < 6 ? [0, 1, 2] : [0, -1, 2])));
  const onLine = sampleField(opposed, -160 + 5.5 * 0.25, 40 - 5 * 0.25, newSample());
  assert.ok(onLine && Math.hypot(onLine.u, onLine.v) < 1e-6, 'R = 0 on the line');
  // A masked node stays NaN and masked; the others keep a direction.
  const holed = waveDirections(gridField('waves', grid, (_lon, _lat, c, r) => [0, 1, 2, !(c === 4 && r === 4)]));
  assert.equal(holed.mask[4 * 12 + 4], 0);
  assert.ok(Number.isNaN(holed.u[4 * 12 + 4]));
  assert.ok(Math.abs(holed.v[4 * 12 + 5] - 1) < 1e-6);
  // Energy weights: a 4 m node outweighs a 2 m node 4 to 1.
  const two = { lon0: -160, lat0: 40, dlon: 0.25, dlat: 0.25, nx: 2, ny: 2, wrapsLon: false };
  const w = waveDirections(gridField('waves', two, (_lon, _lat, c) => (c === 0 ? [1, 0, 4] : [0, 1, 2])));
  assert.ok(Math.abs(w.u[0] - 0.8) < 1e-6 && Math.abs(w.v[0] - 0.2) < 1e-6, `(${w.u[0]}, ${w.v[0]}) is (0.8, 0.2)`);
  for (const g of [uni, split, opposed, holed, w]) {
    for (let i = 0; i < g.u.length; i++) if (g.mask[i]) assert.ok(Math.hypot(g.u[i], g.v[i]) <= 1 + 1e-6, 'R <= 1');
  }
  // Heights are the field's own, for the classes.
  assert.equal(w.magnitude[0], 4);
});

test('no crest line crosses a masked cell (property test, 300 seeds)', () => {
  let drawn = 0;
  let refused = 0;
  const probe = newSample();
  for (let seed = 1; seed <= 300; seed++) {
    const rng = mulberry32(seed * 104729);
    const grid = { lon0: -150, lat0: 50, dlon: 1, dlat: 1, nx: 16, ny: 16, wrapsLon: false };
    // A random smoothly turning direction (directions random node by node never agree, so nothing would draw),
    // random heights, and land as random islands plus scattered single masked nodes.
    const [a0, ax, ay] = [rng() * 360, (rng() - 0.5) * 40, (rng() - 0.5) * 40];
    const islands = Array.from({ length: 3 }, () => [rng() * 16, rng() * 16, 0.5 + rng() * 2]);
    const f = gridField('waves', grid, (_lon, _lat, c, r) => {
      const a = ((a0 + ax * c + ay * r) * Math.PI) / 180;
      const land = islands.some(([ic, ir, rad]) => Math.hypot(c - ic, r - ir) < rad) || rng() < 0.03;
      return [Math.sin(a), Math.cos(a), rng() * 6, !land];
    });
    const zoom = 3 + rng() * 3;
    const vq = view(-142, 42, zoom, 320, 320);
    const m = new CrestMarks(f, mulberry32(seed));
    m.setCount(vq, 1);
    m.reset(vq);
    for (let i = 0; i < 12; i++) {
      m.step(vq);
      for (const c of crestsOf(m)) {
        drawn++;
        for (let j = 1; j < c.pts.length; j++) {
          for (let k = 0; k <= 16; k++) {
            const t = k / 16;
            const x = c.pts[j - 1][0] + (c.pts[j][0] - c.pts[j - 1][0]) * t;
            const y = c.pts[j - 1][1] + (c.pts[j][1] - c.pts[j - 1][1]) * t;
            assert.ok(sampleField(f, lonOf(x), latOf(y), probe), `seed ${seed}: a crest touches a masked or out-of-grid cell`);
          }
        }
      }
      refused += m.count - m.segCount / MARK_SEGS_PER_SET;
    }
  }
  assert.ok(drawn > 10000, `the property saw ${drawn} crests`);
  assert.ok(refused > 1000, `the masks refused ${refused} sets`);
});

test('wave sets: one per 6,144 CSS px squared, at most 600, covering no more than 8 percent', (tc) => {
  assert.equal(markCount(view(0, 0, 3), 1), 211, 'Standard at 1440x900');
  assert.equal(markCount(view(0, 0, 3), 0.5), 105, 'half density (the phone rail)');
  assert.equal(markCount(view(0, 0, 3, 3840, 2160), 1), MAX_MARKS, 'a 4K view is capped');
  assert.equal(MAX_MARKS, 600);
  // Every class at its longest (5 m everywhere), on a 1440x900 view wholly inside the crop.
  const vq = view(-150, 30, 4);
  const { m } = runMarks(waveField(() => 5), 9, vq, 30);
  let area = 0;
  for (const c of crestsOf(m)) {
    area += crestLengthPx(c, vq.worldSize) * (FLOW_CORE_WIDTH_PX[c.cls] + 2 * FLOW_CASING_WIDTH_PX) * c.weight;
  }
  const cover = area / (vq.cssW * vq.cssH);
  tc.diagnostic(`crest coverage at the top class ${(cover * 100).toFixed(2)} percent (taper ignored, so this overstates)`);
  assert.ok(cover > 0.01, `coverage ${cover} shows crests drew`);
  assert.ok(cover <= MAX_COVERAGE, `crest coverage ${(cover * 100).toFixed(2)} percent exceeds 8 percent`);
});

test('jet-level wind draws as 10 m wind does, with bins and pace scaled to its speeds', () => {
  const { FLOW_BINS } = field;
  const { paceFor } = advect;
  assert.deepEqual(FLOW_BINS.jet, [20, 40]);
  assert.deepEqual([19.9, 20, 39.9, 40, 92].map((speed) => classOf('jet', speed)), [0, 1, 1, 2, 2]);
  // A wind at the jet-level upper bin crosses the screen as fast as a 10 m wind at its own upper bin.
  assert.equal(paceFor('jet').pxPerSecPerUnit * FLOW_BINS.jet[1], WIND_PACE.pxPerSecPerUnit * FLOW_BINS.wind[1]);
  assert.equal(paceFor('wind'), WIND_PACE);
  // Waves are not paced by the field: CrestMarks moves them at WAVE_RATE_PX_PER_S.
  for (const kind of Object.keys(FLOW_BINS).filter((k) => k !== 'waves')) assert.ok(paceFor(kind).pxPerSecPerUnit > 0, `${kind} has a pace`);
  // The moving form is the wind ribbons, never the wave crest marks.
  const jet = gridField('jet', GLOBAL_1P00, (lon, lat) => [45 * Math.cos((lat * Math.PI) / 90), 5]);
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: jet, now: () => 0 });
  assert.ok(layer.particles, 'particles advect the jet-level field');
  assert.equal(layer.marks, null);
});

test('every wave mark moves at 24 px/s', () => {
  const vq = view(-150, 30, 4, 1440, 900);
  const f = waveField((lon, lat) => 0.5 + Math.abs(Math.sin(lon / 7 + lat / 3)) * 7); // all three classes
  const { track } = runMarks(f, 3, vq, 75); // 75 steps: about 211 sets, so the sample stays above 10,000
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
  assert.equal(WAVE_RATE_PX_PER_S, 24);
});

test('density is capped at 4,096 and coverage at 8 percent', () => {
  assert.equal(particleCount(view(0, 0, 3), 1), 1266, 'Standard at 1440x900');
  assert.equal(particleCount(view(0, 0, 3), 0.5), 633, 'half density (the phone rail)');
  assert.equal(particleCount(view(0, 0, 3, 3840, 2160), 1), MAX_PARTICLES, 'a 4K view is capped');
  assert.equal(MAX_PARTICLES, 4096);
  const big = new Particles(windField(), WIND_PACE, mulberry32(1));
  big.setCount(view(-145, 26, 3, 3840, 2160), 1);
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

/** The view as the app builds it (viewQuadOf): corners unwrapped near the map's own wrapped centre. */
function appView(lon, lat, zoom, w = 1440, h = 900) {
  const ws = 512 * 2 ** zoom;
  const hx = (w / 2 / ws) * 360;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const yC = mercY(lat);
  const hy = h / 2 / ws;
  const n = latOf(yC - hy);
  const s = latOf(yC + hy);
  return advect.viewQuadFromCorners([[wrapped - hx, n], [wrapped + hx, n], [wrapped + hx, s], [wrapped - hx, s]], zoom, w, h, mercX(wrapped));
}

/** Trail segments of `p` that start inside `vq`. */
function segmentsInView(p, vq) {
  let k = 0;
  p.forEachSegment((_p, ax, ay) => {
    if (advect.insideView(vq, ax, ay)) k++;
  });
  return k;
}

test('a pan across 180 keeps every wave set and wind trail (the wrapped centre jumps a whole world)', () => {
  // 179.9 E to 180.1 is 0.2 degrees east; MapLibre's centre wraps to 179.9 W.
  const m = new CrestMarks(gridField('waves', WAVE_CROP, () => [1, 0, 2.5]), mulberry32(7));
  let vq = appView(179.9, 20, 4);
  m.setCount(vq, 1);
  m.reset(vq);
  for (let i = 0; i < 40; i++) m.step(vq);
  const sets = m.segCount;
  vq = appView(180.1, 20, 4);
  m.step(vq);
  assert.ok(sets > 1000 && m.segCount >= sets * 0.95, `wave segments ${sets} before the pan, ${m.segCount} after`);
  const p = new Particles(windField(), WIND_PACE, mulberry32(5));
  vq = appView(179.9, 20, 4);
  p.setCount(vq, 1);
  p.reset(vq);
  for (let i = 0; i < 30; i++) p.step(vq);
  const trails = segmentsInView(p, vq);
  vq = appView(180.1, 20, 4);
  p.step(vq);
  const after = segmentsInView(p, vq);
  assert.ok(trails > 10000 && after >= trails * 0.95, `wind segments ${trails} in view before the pan, ${after} after`);
});

test('a long pan that crosses no seam keeps the wind trails (the lagging origin is no wrap)', () => {
  // 0.6 of a world east at zoom 3, about 600 CSS px/s: the ring origin lags more than half a world before it rebases.
  const p = new Particles(windField(), WIND_PACE, mulberry32(5));
  let lon = -170;
  let vq = appView(lon, 20, 3);
  p.setCount(vq, 1);
  p.reset(vq);
  for (let i = 0; i < 30; i++) p.step(vq);
  const steady = segmentsInView(p, vq);
  let least = Infinity;
  for (let i = 0; i < 120; i++) {
    lon += 1.8;
    vq = appView(lon, 20, 3);
    p.step(vq);
    least = Math.min(least, segmentsInView(p, vq));
  }
  assert.ok(lon > 40 && least >= steady * 0.5, `trails ${steady} before the pan, at least ${least} during it`);
});

test('a window shrunk and regrown brings back no set or trail mid-life: the regained slots start over and fade in', () => {
  const big = view(-150, 20, 4, 1440, 900);
  const small = view(-150, 20, 4, 720, 450);
  const m = new CrestMarks(gridField('waves', WAVE_CROP, () => [1, 0, 2.5]), mulberry32(3));
  const p = new Particles(windField(), WIND_PACE, mulberry32(3));
  for (const s of [m, p]) {
    s.setCount(big, 1);
    s.reset(big);
    for (let i = 0; i < 60; i++) s.step(big);
    s.setCount(small, 1);
    const kept = s.count;
    let hidden = 0;
    for (let i = kept; i < 1266; i++) if (s.alive[i] && s.age[i] > FADE_S) hidden++;
    for (let i = 0; i < 5; i++) s.step(small);
    s.setCount(big, 1);
    s.step(big);
    assert.ok(hidden > 50, `${hidden} slots were mid-life when the window shrank`);
    for (let i = kept; i < s.count; i++) {
      if (s.alive[i]) assert.ok(s.age[i] <= STEP_S + 1e-6, `slot ${i} came back at age ${s.age[i]}`);
    }
    if (s === p) {
      let stale = 0;
      p.forEachSegment((q) => { if (q >= kept) stale++; });
      assert.equal(stale, 0, `${stale} old trail segments came back with the regained particles`);
    }
  }
});

// ---------------------------------------------------------------------------
// The ribbon layer against a recording fake WebGL2 context and a fake map
// ---------------------------------------------------------------------------

function fakeGl({ fbStatus = 'FRAMEBUFFER_COMPLETE' } = {}) {
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
        if (prop === 'getParameter') return null; // FRAMEBUFFER_BINDING: MapLibre draws to the canvas
        if (prop === 'checkFramebufferStatus') return fbStatus;
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

test('Ocean currents lay their pale blue light ink over the map plainly, never as the inverse of the ground', () => {
  let t = 0;
  const currents = gridField('currents', GLOBAL_1P00, (lon, lat) =>
    [0.4 * Math.sin((lon * Math.PI) / 30), 0.3 * Math.cos((lat * Math.PI) / 30)]);
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: currents, now: () => t });
  const map = fakeMap(-145, 0, 3);
  const gl = fakeGl();
  layer.onAdd(map, gl);
  layer.setRunning(true);
  for (let i = 0; i < 5; i++) {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  }
  const ink0 = gl.calls.findLast((c) => c[0] === 'uniform3fv' && c[1]?.uniform === 'u_ink0');
  assert.deepEqual(ink0[2], inkRgb('#99CCFF'), 'the slow core is the palest step of the blue ramp');
  const back = gl.calls.findLastIndex((c) => c[0] === 'bindFramebuffer' && c[2] === null);
  const composite = gl.calls.findIndex((c, i) => i > back && c[0] === 'drawArrays');
  assert.deepEqual(gl.calls[composite].slice(1), ['TRIANGLES', 0, 3], 'the full-screen composite still draws');
  assert.ok(!gl.calls.some((c) => c.includes('ONE_MINUS_DST_COLOR')), 'currents never invert the ground');
  assert.deepEqual(gl.calls.findLast((c) => c[0].startsWith('blendFunc')).slice(1), ['ONE', 'ONE_MINUS_SRC_ALPHA'],
    'plain premultiplied over');
});

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
  // The trails settle in the layer's own target, then one full-screen pass lays
  // light ink over the map as the inverse of the ground beneath.
  const toTarget = gl.calls.slice(0, draw).findLastIndex((c) => c[0] === 'bindFramebuffer');
  assert.equal(gl.calls[toTarget][2].kind, 'Framebuffer', 'the trails draw into the layer target');
  assert.ok(gl.calls.slice(toTarget, draw).some((c) => c[0] === 'clear'), 'the target is cleared before the trails');
  assert.equal(gl.calls.filter((c) => c[0] === 'createFramebuffer').length, 1, 'one target, reused each frame');
  const back = gl.calls.findIndex((c, i) => i > draw && c[0] === 'bindFramebuffer');
  assert.equal(gl.calls[back][2], null, 'then the map framebuffer again');
  const invert = gl.calls.findIndex((c, i) => i > back && c[0] === 'blendFuncSeparate');
  assert.deepEqual(gl.calls[invert].slice(1), ['ONE_MINUS_DST_COLOR', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'],
    'colour inverts the ground at the line alpha; alpha stays plain over');
  const composite = gl.calls.findIndex((c, i) => i > invert && c[0] === 'drawArrays');
  assert.deepEqual(gl.calls[composite].slice(1), ['TRIANGLES', 0, 3], 'one full-screen triangle');
  assert.deepEqual(gl.calls.findLast((c) => c[0].startsWith('blendFunc')).slice(1), ['ONE', 'ONE_MINUS_SRC_ALPHA'],
    'MapLibre custom-layer blend is restored');
  assert.match(ribbon.RIBBON_SHADERS.FRAG_COMPOSITE, /texelFetch\(u_trails, ivec2\(gl_FragCoord\.xy\), 0\)/);
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

test('the wave layer uploads whole crest sets and draws one instance per crest segment, weighted back to front', () => {
  let t = 0;
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: waveField(() => 2.5), now: () => t });
  assert.equal(layer.particles, null);
  const map = fakeMap(-150, 30, 4);
  const gl = fakeGl();
  layer.onAdd(map, gl);
  layer.setRunning(true);
  for (let i = 0; i < 5; i++) {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  }
  const stride = MARK_SEG_FLOATS * 4;
  assert.deepEqual(gl.calls.find((c) => c[0] === 'bufferData').slice(2, 3), [MAX_MARKS * MARK_SEGS_PER_SET * stride]);
  const pointers = gl.calls.filter((c) => c[0] === 'vertexAttribPointer').map((c) => c.slice(2));
  assert.deepEqual(pointers, [[4, 'FLOAT', false, stride, 0], [4, 'FLOAT', false, stride, 16]],
    'ends, then class, alpha and the width factor at each end');
  const upload = gl.calls.findLast((c) => c[0] === 'bufferSubData');
  assert.equal(upload[3], layer.marks.segs);
  assert.equal(upload[5], layer.marks.segCount * MARK_SEG_FLOATS);
  const draw = gl.calls.findLast((c) => c[0] === 'drawArraysInstanced');
  assert.ok(layer.marks.segCount > 0 && layer.marks.segCount % MARK_SEGS_PER_SET === 0);
  assert.equal(draw[4], layer.marks.segCount, 'one instance per crest segment');
  // The width factors set width and alpha at each end, as the ribbon taper does.
  assert.match(ribbon.RIBBON_SHADERS.VERT_MARKS,
    /emit\(a_seg\.xy, a_seg\.zw, int\(a_meta\.x\), a_meta\.z, a_meta\.w, u_head_alpha \* a_meta\.y\)/);
  assert.ok(MARK_END_TAPER > 0 && MARK_END_TAPER < 1);
  assert.equal(MARK_SEG_FLOATS, 8);
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
  assert.ok(restored.calls.some((c) => c[0] === 'createFramebuffer'), 'the trails target is rebuilt on the restored context');
  assert.equal(layer.particles.count, count, 'the same particle count');
  assert.equal(layer.field, f, 'the same field: no refetch');
  assert.ok(restored.calls.some((c) => c[0] === 'drawArraysInstanced'));
});

test('dark ink composites with plain over; the trails target follows the drawing buffer and is released', () => {
  let t = 0;
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: windField(), now: () => t, ink: 'dark' });
  const map = fakeMap(-145, 26, 3);
  const gl = fakeGl();
  const frame = () => {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  };
  layer.onAdd(map, gl);
  layer.setRunning(true);
  frame();
  assert.ok(gl.calls.some((c) => c[0] === 'drawArrays' && c[1] === 'TRIANGLES' && c[3] === 3), 'dark ink composites too');
  assert.ok(!gl.calls.some((c) => c[0] === 'blendFuncSeparate'), 'dark ink is never inverted');
  layer.setInk('light');
  frame();
  assert.ok(gl.calls.some((c) => c[0] === 'blendFuncSeparate'), 'the ink select switches the inversion live');
  const targets = () => [...new Set(gl.calls.filter((c) => c[0] === 'bindFramebuffer' && c[2]).map((c) => c[2]))];
  gl.drawingBufferWidth = 1200;
  frame();
  assert.equal(targets().length, 2, 'a resized drawing buffer gets a new target');
  assert.ok(gl.calls.some((c) => c[0] === 'deleteFramebuffer' && c[1] === targets()[0]), 'the old target is released');
  assert.deepEqual(gl.calls.findLast((c) => c[0] === 'texStorage2D').slice(1), ['TEXTURE_2D', 1, 'RGBA8', 1200, 900]);
  const composite = gl.calls.findLast((c) => c[0] === 'useProgram')[1];
  layer.onRemove(map, gl);
  assert.ok(gl.calls.some((c) => c[0] === 'deleteFramebuffer' && c[1] === targets()[1]), 'removal releases the target');
  assert.ok(gl.calls.some((c) => c[0] === 'deleteProgram' && c[1] === composite), 'and the composite program');
});

test('a trails target that cannot complete stops the moving form once and rebinds the map framebuffer', () => {
  let t = 0;
  let failures = 0;
  const layer = new ribbon.FlowRibbonLayer({
    id: 'flow-paths', field: windField(), now: () => t, onRebuildFailed: () => failures++
  });
  const map = fakeMap(-145, 26, 3);
  const gl = fakeGl({ fbStatus: 'FRAMEBUFFER_UNSUPPORTED' });
  layer.onAdd(map, gl);
  layer.setRunning(true);
  for (let i = 0; i < 3; i++) {
    t += STEP_S;
    layer.render(gl, RENDER_INPUT);
  }
  assert.equal(failures, 1);
  assert.equal(layer.rebuildFailed, true);
  assert.equal(layer.isRunning, false);
  assert.equal(gl.calls.findLast((c) => c[0] === 'bindFramebuffer')[2], null, 'the map framebuffer is bound again');
  assert.ok(!gl.calls.some((c) => c[0] === 'drawArraysInstanced' || c[0] === 'drawArrays'), 'nothing draws');
  const fbo = gl.calls.find((c) => c[0] === 'bindFramebuffer' && c[2])[2];
  const storage = gl.calls.findIndex((c) => c[0] === 'texStorage2D');
  const texture = gl.calls.slice(0, storage).findLast((c) => c[0] === 'bindTexture')[2];
  layer.onRemove(map, gl);
  assert.ok(gl.calls.some((c) => c[0] === 'deleteFramebuffer' && c[1] === fbo), 'the incomplete target is released');
  assert.ok(gl.calls.some((c) => c[0] === 'deleteTexture' && c[1] === texture), 'with its texture');
});

test('after the centre wraps across the date line the particles sit in the view the map reports', () => {
  let t = 0;
  const layer = new ribbon.FlowRibbonLayer({ id: 'flow-paths', field: windField(), now: () => t });
  const map = fakeMap(179, 26, 3);
  const gl = fakeGl();
  layer.onAdd(map, gl);
  layer.setRunning(true);
  const run = () => {
    for (let i = 0; i < 5; i++) {
      t += STEP_S;
      layer.render(gl, RENDER_INPUT);
    }
  };
  run();
  // MapLibre wraps the centre to -180..180, and its matrix follows the wrapped centre.
  map.state.lon = -179;
  run();
  const vq = ribbon.viewQuadOf(map);
  const p = layer.particles;
  let alive = 0;
  for (let i = 0; i < p.count; i++) {
    if (!p.alive[i]) continue;
    alive++;
    assert.ok(advect.insideView(vq, p.x[i], p.y[i]), `particle ${i} at x ${p.x[i]} is outside the reported view`);
  }
  assert.ok(alive > 1000, `${alive} particles alive`);
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
