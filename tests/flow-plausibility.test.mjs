/**
 * E2a-3 (REGISTER found-148): the decode Worker refuses a frame with any
 * unmasked value outside its kind's physical bound, so wind or wave paths
 * are never drawn from a damaged message that still parses
 * (src/layers/flow/decode-worker.ts). GRIB2 carries no checksum; the bytes
 * arrive over TLS with an exact-length 206, so this is defence in depth.
 *
 * The decoder refuses structurally invalid messages (tests/flow-grib-decode.test.mjs);
 * these cases cover the values that pass it. Damaged variants are built here
 * from the committed fixtures (tests/fixtures/flow/, the 2026-10-05 06Z
 * cycle, f006); the corrupted-byte sweep runs in a worker thread under a
 * wall-clock cap. Nothing touches the network.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const HOOK_SOURCE = `
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))
    ) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  }
});
`;

// src/ imports are extensionless (the bundler resolves them); map them to
// the .ts file, as tests/flow-grib-decode.test.mjs does.
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

const GRIB2_URL = new URL('../src/layers/flow/grib2.ts', import.meta.url).href;
const WORKER_URL = new URL('../src/layers/flow/decode-worker.ts', import.meta.url).href;
const { decodeGrib2 } = await import(GRIB2_URL);
const worker = await import(WORKER_URL);
const { readFlowFrame, FlowUnavailableError } = await import('../src/layers/flow/nodd.ts');
const { NODD_ORIGIN } = await import('../src/layers/flow/source.ts');
const { decodeFrame, buildPacket, checkPlausible, PLAUSIBLE_RANGE } = worker;

const HOUR = 3_600_000;
const CYCLE = Date.UTC(2026, 9, 5, 6);
const NOW = Date.UTC(2026, 9, 5, 12, 30);
const GLOBAL_1P00 = { ni: 360, nj: 181, la1: 90, lo1: 0 };
const GLOBAL_0P25 = { ni: 1440, nj: 721, la1: 90, lo1: 0 };
const WCOAST_0P16 = { ni: 241, nj: 151, la1: 50, lo1: 210 };
const WIND_POINTS = 360 * 181;
const WAVE_POINTS = 1440 * 721;

const FIXTURES = new URL('./fixtures/flow/', import.meta.url);
const fixture = (name) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));

// ---------------------------------------------------------------------------
// Message surgery
// ---------------------------------------------------------------------------

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function sectionOf(msg, number) {
  for (let i = 16; i < msg.length - 4; ) {
    const len = u32(msg, i);
    if (msg[i + 4] === number) return { start: i, length: len };
    i += len;
  }
  throw new Error(`section ${number} not found`);
}

/** A copy whose section 5 reference value R (an IEEE float) is R + delta. */
function shiftedReference(msg, delta) {
  const out = msg.slice();
  const o = sectionOf(msg, 5).start + 11;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setFloat32(o, view.getFloat32(o, false) + delta, false);
  return out;
}

/** A copy whose section 4 parameter number (code table 4.2) is `number`. */
function withParameterNumber(msg, number) {
  const out = msg.slice();
  out[sectionOf(msg, 4).start + 10] = number;
  return out;
}

const buffer = (bytes) => bytes.slice().buffer;

// The Worker-core cases below pair HTSGW with a DIRPW of the same grid made by
// relabelling it 10.0.10 (its 0 to 14.7 values are in range as degrees), so a
// bound shift is measured against known values. The real global0p25 DIRPW
// fixture (found-146) is checked in 'the committed fixtures pass the
// plausibility bounds', where it exercises the inclusive 360 bound.
const WAVE_HTSGW = fixture('global0p25-HTSGW-f006.grib2');
const WAVE_DIRPW = withParameterNumber(WAVE_HTSGW, 10);
const UGRD = fixture('gfs1p00-UGRD-10m-f006.grib2');
const VGRD = fixture('gfs1p00-VGRD-10m-f006.grib2');

const refusedByBound = (variable) => (e) =>
  e instanceof RangeError && new RegExp(`^${variable} `).test(e.message) && /outside the plausible range/.test(e.message);

// ---------------------------------------------------------------------------
// The reader, for "not drawn": a NODD stand-in serving one wind frame
// ---------------------------------------------------------------------------

const WIND_KEY = 'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006';
const WIND_IDX = new TextDecoder().decode(fixture('gfs.t06z.pgrb2.1p00.f006.idx'));

function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes);
      controller.close();
    }
  });
}

function windStub(ugrd) {
  const ranges = new Map([
    [34998139, ugrd],
    [35077225, VGRD]
  ]);
  return async (url, init = {}) => {
    const range = new Headers(init.headers ?? {}).get('range') ?? '';
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (String(url) === `${NODD_ORIGIN}/${WIND_KEY}.idx`) {
      const body = new TextEncoder().encode(WIND_IDX);
      return new Response(streamOf(body.subarray(0, Math.min(Number(m[2]), body.byteLength - 1) + 1)), { status: 206 });
    }
    if (String(url) === `${NODD_ORIGIN}/${WIND_KEY}` && m) {
      const bytes = ranges.get(Number(m[1]));
      if (bytes && Number(m[1]) + bytes.byteLength - 1 === Number(m[2])) return new Response(streamOf(bytes), { status: 206 });
    }
    return new Response(streamOf(new Uint8Array(0)), { status: 404 });
  };
}

/** An in-process stand-in for the module Worker that runs the real worker core. */
function inProcessWorker() {
  const w = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      setTimeout(() => {
        let data;
        try {
          data = { ok: true, packet: decodeFrame(message) };
        } catch (e) {
          data = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        }
        w.onmessage?.({ data });
      }, 0);
    },
    terminate() {}
  };
  return w;
}

async function readWind(ugrd) {
  const original = globalThis.fetch;
  globalThis.fetch = windStub(ugrd);
  try {
    return await readFlowFrame('wind', { signal: new AbortController().signal, now: () => NOW, createWorker: inProcessWorker });
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

test('a wind frame with |u| over the bound is refused, not drawn', async () => {
  const calm = () => new Float32Array(WIND_POINTS).fill(5);
  // At the bound is accepted; one step past it, either sign, either component, is refused.
  const edge = calm();
  edge[123] = 100;
  edge[124] = -100;
  assert.doesNotThrow(() => buildPacket('wind', [edge, calm()], CYCLE, 6));
  for (const [k, x] of [
    [0, 100.01],
    [1, -100.01],
    [0, 1.3e7],
    [1, Number.POSITIVE_INFINITY]
  ]) {
    const bad = calm();
    bad[40_000] = x;
    const values = k === 0 ? [bad, calm()] : [calm(), bad];
    assert.throws(() => buildPacket('wind', values, CYCLE, 6), refusedByBound(k === 0 ? 'UGRD' : 'VGRD'), `${k === 0 ? 'u' : 'v'} = ${x}`);
  }
  // A real UGRD message whose values all moved up 80 m/s still parses, and the Worker refuses it.
  const shifted = shiftedReference(UGRD, 8000); // D = 2: R is in hundredths of m/s
  const decoded = decodeGrib2(shifted, { grid: GLOBAL_1P00 }).values;
  assert.ok(decoded.some((x) => x > 100), 'the shifted message decodes to values above 100 m/s');
  assert.throws(
    () => decodeFrame({ kind: 'wind', cycle: CYCLE, forecastHour: 6, messages: [buffer(shifted), buffer(VGRD)] }),
    refusedByBound('UGRD')
  );
  // Through the reader: the kind reads as refused and no FlowField is built.
  await assert.rejects(readWind(shifted), (e) => e instanceof FlowUnavailableError && e.reason === 'refused' && /UGRD/.test(e.message));
  // The untouched pair through the same reader is drawn.
  const field = await readWind(UGRD);
  assert.equal(field.meta.validTime, CYCLE + 6 * HOUR);
  assert.deepEqual(PLAUSIBLE_RANGE.UGRD, [-100, 100]);
  assert.deepEqual(PLAUSIBLE_RANGE.VGRD, [-100, 100]);
});

test('an HTSGW value over 30 m is refused', () => {
  const dir = () => new Float32Array(WAVE_POINTS).fill(270);
  const hs = () => new Float32Array(WAVE_POINTS).fill(1.5);
  const edge = hs();
  edge[500_000] = 30;
  edge[500_001] = 0;
  assert.doesNotThrow(() => buildPacket('waves', [dir(), edge], CYCLE, 6));
  // Inside the crop (row 200, column 800) and outside it (row 0, column 0): the message is damaged either way.
  for (const [at, x] of [
    [200 * 1440 + 800, 30.01],
    [0, 31],
    [200 * 1440 + 800, -0.01]
  ]) {
    const bad = hs();
    bad[at] = x;
    assert.throws(() => buildPacket('waves', [dir(), bad], CYCLE, 6), refusedByBound('HTSGW'), `HTSGW ${x} at ${at}`);
  }
  // A real HTSGW message whose values all moved up 31 m still parses, and the Worker refuses it.
  const shifted = shiftedReference(WAVE_HTSGW, 3100);
  assert.throws(
    () => decodeFrame({ kind: 'waves', cycle: CYCLE, forecastHour: 6, messages: [buffer(WAVE_DIRPW), buffer(shifted)] }),
    refusedByBound('HTSGW')
  );
  assert.deepEqual(PLAUSIBLE_RANGE.HTSGW, [0, 30]);
});

test('a DIRPW value over 360 is refused', () => {
  const dir = () => new Float32Array(WAVE_POINTS).fill(270);
  const hs = () => new Float32Array(WAVE_POINTS).fill(1.5);
  // 0 and 360 both name north and are accepted.
  const edge = dir();
  edge[500_000] = 360;
  edge[500_001] = 0;
  assert.doesNotThrow(() => buildPacket('waves', [edge, hs()], CYCLE, 6));
  for (const x of [360.01, 400, -0.01]) {
    const bad = dir();
    bad[200 * 1440 + 800] = x;
    assert.throws(() => buildPacket('waves', [bad, hs()], CYCLE, 6), refusedByBound('DIRPW'), `DIRPW ${x}`);
  }
  const shifted = shiftedReference(WAVE_DIRPW, 36_100); // D = 2: 361 degrees
  assert.throws(
    () => decodeFrame({ kind: 'waves', cycle: CYCLE, forecastHour: 6, messages: [buffer(shifted), buffer(WAVE_HTSGW)] }),
    refusedByBound('DIRPW')
  );
  assert.deepEqual(PLAUSIBLE_RANGE.DIRPW, [0, 360]);
});

test('the committed fixtures pass the plausibility bounds', (t) => {
  const cases = [
    ['gfs1p00-UGRD-10m-f006.grib2', 'UGRD', GLOBAL_1P00],
    ['gfs1p00-VGRD-10m-f006.grib2', 'VGRD', GLOBAL_1P00],
    ['wcoast0p16-HTSGW-f006.grib2', 'HTSGW', WCOAST_0P16],
    ['wcoast0p16-DIRPW-f006.grib2', 'DIRPW', WCOAST_0P16],
    ['global0p25-HTSGW-f006.grib2', 'HTSGW', GLOBAL_0P25],
    ['global0p25-DIRPW-f006.grib2', 'DIRPW', GLOBAL_0P25]
  ];
  // The real global DIRPW carries points at exactly 360, so the inclusive
  // upper bound is exercised by an issuer value, not only by a synthetic one.
  const globalDirpw = decodeGrib2(fixture('global0p25-DIRPW-f006.grib2'), { grid: GLOBAL_0P25 }).values;
  assert.ok(globalDirpw.some((x) => x === 360), 'the global DIRPW fixture holds a value of exactly 360');
  for (const [name, variable, grid] of cases) {
    const { values } = decodeGrib2(fixture(name), { grid });
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of values) {
      if (Number.isNaN(x)) continue;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    t.diagnostic(`${name}: ${variable} ${lo} to ${hi}, bound ${PLAUSIBLE_RANGE[variable].join(' to ')}`);
    assert.doesNotThrow(() => checkPlausible(variable, values), name);
  }
  // The whole wind frame through the Worker core.
  const packet = decodeFrame({ kind: 'wind', cycle: CYCLE, forecastHour: 6, messages: [buffer(UGRD), buffer(VGRD)] });
  assert.equal(packet.u.length, WIND_POINTS);
  // A variable with no bound is refused rather than passed unchecked.
  assert.throws(() => checkPlausible('PERPW', new Float32Array(4)), /no plausibility bound/);
});

// ---------------------------------------------------------------------------
// The corrupted-byte sweep
// ---------------------------------------------------------------------------

const SWEEP_FLIPS = 300;
const SWEEP_CAP_MS = 120_000;

const SWEEP_SOURCE = `${HOOK_SOURCE}
const { parentPort, workerData } = await import('node:worker_threads');
const { decodeGrib2 } = await import(workerData.grib2);
const { checkPlausible } = await import(workerData.worker);
const { name, variable, grid, bytes, flips, seed } = workerData;
const msg = new Uint8Array(bytes);
let a = seed >>> 0;
const rand = () => {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
let s7 = 0;
for (let i = 16; i < msg.length - 4; i += u32(msg, i)) if (msg[i + 4] === 7) s7 = i;
const s7len = u32(msg, s7);
const clean = decodeGrib2(msg, { grid }).values;
const out = { name, flips, refusedByDecoder: 0, refusedByBound: 0, identical: 0, differing: 0, maxDiff: 0, worst: null };
for (let i = 0; i < flips; i++) {
  const bad = msg.slice();
  const offset = s7 + 5 + Math.floor(rand() * (s7len - 5));
  bad[offset] ^= 1 + Math.floor(rand() * 255);
  let values;
  try {
    values = decodeGrib2(bad, { grid }).values;
  } catch (e) {
    if (e && e.name === 'GribError') { out.refusedByDecoder++; continue; }
    throw e;
  }
  try {
    checkPlausible(variable, values);
  } catch (e) {
    if (e instanceof RangeError) { out.refusedByBound++; continue; }
    throw e;
  }
  let diff = 0;
  for (let k = 0; k < values.length; k++) {
    const x = values[k];
    const y = clean[k];
    if (Number.isNaN(x) !== Number.isNaN(y)) diff = Infinity;
    else if (!Number.isNaN(x)) diff = Math.max(diff, Math.abs(x - y));
  }
  if (diff === 0) out.identical++;
  else {
    out.differing++;
    if (diff > out.maxDiff) { out.maxDiff = diff; out.worst = { flip: i, offset: offset - s7 }; }
  }
}
parentPort.postMessage(out);
`;

function sweep(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(SWEEP_SOURCE)}`), {
      workerData: { ...job, grib2: GRIB2_URL, worker: WORKER_URL }
    });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`${job.name}: the sweep did not finish within ${SWEEP_CAP_MS} ms`));
    }, SWEEP_CAP_MS);
    w.once('message', (out) => {
      clearTimeout(timer);
      w.terminate();
      resolve(out);
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

test('a corrupted-byte sweep: across N seeded single-byte flips of section 7 of the UGRD and DIRPW fixtures, no frame that passes decode and bounds differs from the clean decode by more than the bound', async (t) => {
  // minRefused: the share of flips that must be refused. Measured 2026-10-05 at N = 300: UGRD 299 refused
  // (13 by the decoder, 286 by the bound), 1 passed differing by 13.66 m/s; DIRPW 14 refused (7 and 7),
  // 285 passed differing by up to 122.3 degrees, 1 identical. A flip inside JPEG 2000 code-block data leaves
  // the codestream structurally valid and its values in range, so no share is required of DIRPW: the
  // decoder refuses structurally invalid messages and values outside physical bounds, nothing stronger.
  const jobs = [
    { name: 'gfs1p00-UGRD-10m-f006', variable: 'UGRD', grid: GLOBAL_1P00, seed: 20261005, minRefused: 0.98 },
    { name: 'wcoast0p16-DIRPW-f006', variable: 'DIRPW', grid: WCOAST_0P16, seed: 20261006, minRefused: 0 }
  ];
  const results = await Promise.all(
    jobs.map((j) => sweep({ ...j, bytes: fixture(`${j.name}.grib2`), flips: SWEEP_FLIPS }))
  );
  for (const [i, r] of results.entries()) {
    const [lo, hi] = PLAUSIBLE_RANGE[jobs[i].variable];
    const bound = Math.max(-lo, hi);
    t.diagnostic(
      `${r.name}: N = ${r.flips}; refused by the decoder ${r.refusedByDecoder}, refused by the bound ${r.refusedByBound}, ` +
        `passed identical ${r.identical}, passed differing ${r.differing} (max |diff| ${r.maxDiff}${r.worst ? ` at flip ${r.worst.flip}, section 7 byte ${r.worst.offset}` : ''})`
    );
    assert.equal(r.refusedByDecoder + r.refusedByBound + r.identical + r.differing, r.flips);
    assert.ok(r.maxDiff <= bound, `${r.name}: a passing frame differs from the clean decode by ${r.maxDiff}, more than the bound ${bound}`);
    const refused = r.refusedByDecoder + r.refusedByBound;
    assert.ok(refused >= jobs[i].minRefused * r.flips, `${r.name}: ${refused} of ${r.flips} flips refused`);
  }
});
