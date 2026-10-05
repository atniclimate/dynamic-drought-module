/**
 * E1-1 GRIB-DECODE (ENSO-FLOW-PLAN section 3, block E1): DDM's own GRIB2
 * decoder (src/layers/flow/grib2.ts) and its JPEG 2000 subset
 * (src/layers/flow/jpx.ts).
 *
 * The oracle is eccodes 2.49.0. tests/fixtures/flow/ holds five real NODD
 * messages of the 2026-10-05 06Z cycle, forecast hour 6, each cut by one
 * Range GET from its .idx line: the 1p00 10 m UGRD/VGRD pair (DRT 5.3, a
 * negative reference value, no bitmap), the GFS-Wave wcoast.0p16 HTSGW and
 * DIRPW pair (DRT 5.40 with a bitmap, its own grid header) and one
 * global.0p25 HTSGW (DRT 5.40, a 568,995-wide single-row codestream).
 * eccodes values are kept as sampled points (every 97th point, float64),
 * never whole arrays, with the masked count and a SHA-256 of the full
 * validity mask (reference.json says how each was made).
 *
 * Every corrupted, truncated or crafted message is decoded in a worker
 * thread under a wall-clock cap, so a decoder that spins fails the case
 * instead of hanging the suite. Nothing here touches the network.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

globalThis.fetch = () => {
  throw new Error('unexpected network call from a node test');
};

// src/ imports are extensionless (the bundler resolves them); map them to
// the .ts file the same way fire3d-ribbon-read.test.mjs does.
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
const { decodeGrib2, readGrib2Header, GribError } = await import(GRIB2_URL);
const { decodeJpeg2000 } = await import('../src/layers/flow/jpx.ts');

// ---------------------------------------------------------------------------
// Fixtures and the eccodes oracle
// ---------------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/flow/', import.meta.url);
const REF = JSON.parse(readFileSync(new URL('reference.json', FIXTURES), 'utf8'));

function fixture(name) {
  const bytes = new Uint8Array(readFileSync(new URL(`${name}.grib2`, FIXTURES)));
  const info = REF[name];
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    info.sha256,
    `${name}.grib2 is not the message the eccodes reference was made from`
  );
  const raw = readFileSync(new URL(info.sampledFile, FIXTURES));
  const sampled = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  return { bytes, info, sampled };
}

const CYCLE = Date.UTC(2026, 9, 5, 6);
const GLOBAL_1P00 = { ni: 360, nj: 181, la1: 90, lo1: 0 };
const GLOBAL_0P25 = { ni: 1440, nj: 721, la1: 90, lo1: 0 };
const WCOAST_0P16 = { ni: 241, nj: 151, la1: 50, lo1: 210 };

/** Compare a decoded field with eccodes at the sampled points. */
function compareSampled(values, fx) {
  const { info, sampled } = fx;
  assert.equal(values.length, info.numberOfDataPoints);
  assert.equal(sampled.length, Math.ceil(info.numberOfDataPoints / info.stride));
  let maxDiff = 0;
  let nanMismatch = 0;
  let compared = 0;
  for (let s = 0; s < sampled.length; s++) {
    const a = values[s * info.stride];
    const r = sampled[s];
    if (Number.isNaN(r) !== Number.isNaN(a)) {
      nanMismatch++;
      continue;
    }
    if (!Number.isNaN(r)) {
      compared++;
      const d = Math.abs(a - r);
      if (d > maxDiff) maxDiff = d;
    }
  }
  return { maxDiff, nanMismatch, compared };
}

function maskSha256(values) {
  const bits = new Uint8Array(Math.ceil(values.length / 8));
  for (let k = 0; k < values.length; k++) {
    if (!Number.isNaN(values[k])) bits[k >> 3] |= 0x80 >> (k & 7);
  }
  return createHash('sha256').update(bits).digest('hex');
}

function nanCount(values) {
  let n = 0;
  for (let k = 0; k < values.length; k++) if (Number.isNaN(values[k])) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Message surgery: sections, rebuilds, the JPEG 2000 codestream
// ---------------------------------------------------------------------------

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const putU32 = (b, o, v) => {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
};
const putU16 = (b, o, v) => {
  b[o] = (v >>> 8) & 255;
  b[o + 1] = v & 255;
};

/** Sections 1 to 7 of a well-formed message: number, start offset, length. */
function sections(msg) {
  const out = [];
  for (let i = 16; i < msg.length - 4; ) {
    const len = u32(msg, i);
    out.push({ number: msg[i + 4], start: i, length: len });
    i += len;
  }
  return out;
}

function sectionOf(msg, number) {
  const s = sections(msg).find((x) => x.number === number);
  assert.ok(s, `section ${number} present`);
  return s;
}

/** Rebuild a message with section `number` replaced by `body` (bytes after the 5-byte section head). */
function withSection(msg, number, body) {
  const parts = [msg.subarray(0, 16)];
  for (const s of sections(msg)) {
    if (s.number === number) {
      const head = new Uint8Array(5);
      putU32(head, 0, 5 + body.length);
      head[4] = number;
      parts.push(head, body);
    } else {
      parts.push(msg.subarray(s.start, s.start + s.length));
    }
  }
  parts.push(new Uint8Array([0x37, 0x37, 0x37, 0x37]));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  putU32(out, 8, 0);
  putU32(out, 12, total);
  return out;
}

/** A copy with one byte changed (offset within the message). */
function patched(msg, edits) {
  const out = msg.slice();
  for (const [offset, value] of edits) out[offset] = value;
  return out;
}

/** The raw JPEG 2000 codestream of a 5.40 message (section 7 after its head). */
function codestreamOf(msg) {
  const s7 = sectionOf(msg, 7);
  return msg.slice(s7.start + 5, s7.start + s7.length);
}

/** Locate SIZ, the first SOT and its SOD in a codestream. */
function codestreamLayout(cs) {
  let p = 2;
  let siz = -1;
  while (((cs[p] << 8) | cs[p + 1]) !== 0xff90) {
    if (((cs[p] << 8) | cs[p + 1]) === 0xff51) siz = p;
    p += 2 + ((cs[p + 2] << 8) | cs[p + 3]);
  }
  const sot = p;
  p += 12;
  while (((cs[p] << 8) | cs[p + 1]) !== 0xff93) p += 2 + ((cs[p + 2] << 8) | cs[p + 3]);
  return { siz, sot, sodEnd: p + 2 };
}

/** Replace the single tile-part's body, fixing Psot and closing with EOC. */
function withTileBody(cs, body) {
  const { sot, sodEnd } = codestreamLayout(cs);
  const out = new Uint8Array(sodEnd + body.length + 2);
  out.set(cs.subarray(0, sodEnd), 0);
  out.set(body, sodEnd);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  putU32(out, sot + 6, sodEnd - sot + body.length);
  return out;
}

/** Packet-header bits as bytes, with T.800 bit stuffing after any 0xFF. */
function stuffedBits(bits) {
  const out = [];
  let cur = 0;
  let n = 0;
  let width = 8;
  for (const bit of bits) {
    cur = (cur << 1) | bit;
    n++;
    if (n === width) {
      out.push(cur);
      width = cur === 0xff ? 7 : 8;
      cur = 0;
      n = 0;
    }
  }
  if (n > 0) out.push(cur << (width - n));
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Isolated decode: a worker thread under a wall-clock cap
// ---------------------------------------------------------------------------

const ISOLATION_CAP_MS = 20_000;

const WORKER_SOURCE = `${HOOK_SOURCE}
const { parentPort, workerData } = await import('node:worker_threads');
const { decodeGrib2 } = await import(workerData.url);
const results = [];
for (const job of workerData.jobs) {
  try {
    const f = decodeGrib2(new Uint8Array(job.bytes), job.expect);
    results.push({ ok: true, points: f.values.length });
  } catch (e) {
    results.push({ ok: false, name: e && e.name, code: e && e.code, message: String(e && e.message) });
  }
}
parentPort.postMessage(results);
`;

/** Decode each job in one worker; resolves { hung } or { results }. */
function decodeIsolated(jobs, capMs = ISOLATION_CAP_MS) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
      workerData: {
        url: GRIB2_URL,
        jobs: jobs.map((j) => ({ bytes: j.bytes, expect: j.expect }))
      }
    });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ hung: true, results: [] });
    }, capMs);
    worker.once('message', (results) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ hung: false, results });
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Every job must end in a GribError (never another error, never a hang). */
async function assertAllRefused(jobs, label) {
  const { hung, results } = await decodeIsolated(jobs);
  assert.equal(hung, false, `${label}: the decoder did not finish within ${ISOLATION_CAP_MS} ms`);
  results.forEach((r, i) => {
    assert.equal(r.ok, false, `${label} [${jobs[i].label}] decoded instead of throwing`);
    assert.equal(r.name, 'GribError', `${label} [${jobs[i].label}] threw ${r.name}: ${r.message}`);
  });
  return results;
}

// ---------------------------------------------------------------------------
// The plan's cases
// ---------------------------------------------------------------------------

test('decodes 1p00 10 m UGRD with a negative reference value to eccodes within 2e-5', () => {
  for (const [name, number] of [
    ['gfs1p00-UGRD-10m-f006', 2],
    ['gfs1p00-VGRD-10m-f006', 3]
  ]) {
    const fx = fixture(name);
    const f = decodeGrib2(fx.bytes, {
      grid: GLOBAL_1P00,
      parameter: { discipline: 0, category: 2, number },
      refTime: CYCLE,
      forecastHours: 6,
      packing: 3,
      bitmap: false
    });
    // The grib2class failure mode: R is an IEEE float that can be negative.
    assert.ok(f.packing.reference < 0, `${name}: the fixture carries a negative reference value`);
    assert.equal(f.packing.reference, fx.info.referenceValue);
    assert.equal(f.packing.template, 3);
    assert.equal(f.packing.bitsPerValue, fx.info.bitsPerValue);
    assert.equal(f.bitmap, false);
    assert.deepEqual(
      [f.grid.ni, f.grid.nj, f.grid.la1, f.grid.lo1, f.grid.la2, f.grid.lo2, f.grid.di, f.grid.dj, f.grid.scanMode],
      [360, 181, 90, 0, -90, 359, 1, 1, 0]
    );
    assert.equal(f.refTime, CYCLE);
    assert.equal(f.forecastHours, 6);
    assert.equal(f.validTime, CYCLE + 6 * 3600_000);
    assert.equal(f.missingCount, 0);
    assert.equal(nanCount(f.values), 0);
    const { maxDiff, nanMismatch, compared } = compareSampled(f.values, fx);
    assert.equal(nanMismatch, 0);
    assert.equal(compared, fx.info.sampledCount);
    assert.ok(maxDiff <= 2e-5, `${name}: max |decoded - eccodes| = ${maxDiff}`);
  }
});

test('decodes HTSGW and DIRPW 5.40 with bitmap to eccodes, masked points NaN', () => {
  for (const [name, number] of [
    ['wcoast0p16-HTSGW-f006', 3],
    ['wcoast0p16-DIRPW-f006', 10]
  ]) {
    const fx = fixture(name);
    const f = decodeGrib2(fx.bytes, {
      grid: WCOAST_0P16,
      parameter: { discipline: 10, category: 0, number },
      refTime: CYCLE,
      forecastHours: 6,
      packing: 40,
      bitmap: true
    });
    assert.equal(f.packing.template, 40);
    assert.equal(f.bitmap, true);
    assert.equal(f.missingCount, fx.info.numberOfMissing);
    assert.equal(nanCount(f.values), fx.info.nanCount, `${name}: every masked point is NaN`);
    assert.equal(maskSha256(f.values), fx.info.maskSha256, `${name}: the mask matches eccodes point for point`);
    const { maxDiff, nanMismatch, compared } = compareSampled(f.values, fx);
    assert.equal(nanMismatch, 0);
    assert.ok(compared > 0 && compared < fx.info.sampledCount, `${name}: samples cover sea and land`);
    assert.ok(maxDiff <= 2e-5, `${name}: max |decoded - eccodes| = ${maxDiff}`);
  }
});

test('decodes a 568,995-wide single-row codestream with no width truncation', () => {
  const fx = fixture('global0p25-HTSGW-f006');
  const packed = fx.info.numberOfValues;
  assert.equal(packed, 568_995);
  // The codestream alone: one 568,995 x 1 image, every sample returned.
  const img = decodeJpeg2000(codestreamOf(fx.bytes), packed);
  assert.equal(img.width, 568_995);
  assert.equal(img.height, 1);
  assert.equal(img.data.length, 568_995);
  // The whole message against eccodes.
  const f = decodeGrib2(fx.bytes, {
    grid: GLOBAL_0P25,
    parameter: { discipline: 10, category: 0, number: 3 },
    refTime: CYCLE,
    forecastHours: 6,
    packing: 40,
    bitmap: true
  });
  assert.equal(f.packing.packedCount, 568_995);
  assert.equal(f.values.length, 1440 * 721);
  assert.equal(f.missingCount, fx.info.numberOfMissing);
  assert.equal(maskSha256(f.values), fx.info.maskSha256);
  const { maxDiff, nanMismatch } = compareSampled(f.values, fx);
  assert.equal(nanMismatch, 0);
  assert.ok(maxDiff <= 2e-5, `max |decoded - eccodes| = ${maxDiff}`);
  // The tail of the row decodes too (a 16-bit width would stop at 44,707).
  let lastValid = -1;
  for (let k = f.values.length - 1; k >= 0; k--) {
    if (!Number.isNaN(f.values[k])) {
      lastValid = k;
      break;
    }
  }
  assert.ok(lastValid > 1440 * 600, 'sea points in the southern rows carry values');
});

test('a wcoast.0p16 5.40 message decodes to eccodes within 2e-5 (sampled points)', () => {
  const fx = fixture('wcoast0p16-HTSGW-f006');
  // The grid is a parameter of the call: this regional grid has its own header.
  const header = readGrib2Header(fx.bytes);
  assert.deepEqual(
    [header.grid.ni, header.grid.nj, header.grid.la1, header.grid.lo1, header.grid.la2, header.grid.lo2],
    [
      fx.info.Ni,
      fx.info.Nj,
      fx.info.latitudeOfFirstGridPointInDegrees,
      fx.info.longitudeOfFirstGridPointInDegrees,
      fx.info.latitudeOfLastGridPointInDegrees,
      fx.info.longitudeOfLastGridPointInDegrees
    ]
  );
  assert.ok(Math.abs(header.grid.di - fx.info.iDirectionIncrementInDegrees) < 1e-6);
  assert.ok(Math.abs(header.grid.dj - fx.info.jDirectionIncrementInDegrees) < 1e-6);
  assert.equal(header.points, 241 * 151);
  const f = decodeGrib2(fx.bytes, { grid: WCOAST_0P16 });
  const { maxDiff, nanMismatch } = compareSampled(f.values, fx);
  assert.equal(nanMismatch, 0);
  assert.ok(maxDiff <= 2e-5, `max |decoded - eccodes| = ${maxDiff}`);
  // A west-negative longitude names the same first point.
  assert.doesNotThrow(() => decodeGrib2(fx.bytes, { grid: { ...WCOAST_0P16, lo1: -150 } }));
  // The global grid's expectations are refused for this message.
  assert.throws(
    () => decodeGrib2(fx.bytes, { grid: GLOBAL_0P25 }),
    (e) => e instanceof GribError && e.code === 'expectation'
  );
});

test('an off-by-one bitmap control differs from eccodes', () => {
  const fx = fixture('global0p25-HTSGW-f006');
  const s6 = sectionOf(fx.bytes, 6);
  const points = fx.info.numberOfDataPoints;
  const first = s6.start + 6;
  const lastByte = first + Math.ceil(points / 8) - 1;
  // The last grid point (90 S, 359.75 E) is land, so shifting the whole
  // bitmap one point east keeps the count and decodes cleanly.
  assert.equal(fx.bytes[lastByte] & 1, 0);
  const shifted = fx.bytes.slice();
  for (let o = lastByte; o >= first; o--) {
    shifted[o] = (fx.bytes[o] >> 1) | (o > first ? (fx.bytes[o - 1] & 1) << 7 : 0);
  }
  const f = decodeGrib2(shifted, { grid: GLOBAL_0P25 });
  assert.equal(f.missingCount, fx.info.numberOfMissing, 'the control keeps the masked count');
  assert.notEqual(maskSha256(f.values), fx.info.maskSha256, 'the control mask differs');
  const { maxDiff, nanMismatch } = compareSampled(f.values, fx);
  assert.ok(nanMismatch > 0 || maxDiff > 0.01, `the control matched eccodes (max ${maxDiff}, ${nanMismatch} mask flips)`);
  // And the true message matches, so the comparison is what fails the control.
  const good = decodeGrib2(fx.bytes, { grid: GLOBAL_0P25 });
  assert.equal(maskSha256(good.values), fx.info.maskSha256);
});

test('ignoring the bitmap is refused', () => {
  for (const name of ['wcoast0p16-HTSGW-f006', 'global0p25-HTSGW-f006']) {
    const fx = fixture(name);
    const s6 = sectionOf(fx.bytes, 6);
    assert.equal(fx.bytes[s6.start + 5], 0, 'the message carries a bitmap');
    const ignored = patched(fx.bytes, [[s6.start + 5, 255]]);
    const grid = name.startsWith('wcoast') ? WCOAST_0P16 : GLOBAL_0P25;
    assert.throws(
      () => decodeGrib2(ignored, { grid }),
      (e) => e instanceof GribError && e.code === 'bitmap',
      `${name}: a bitmap indicator of 255 over packed sea points is refused`
    );
    assert.throws(
      () => decodeGrib2(ignored, { grid, bitmap: true }),
      (e) => e instanceof GribError
    );
    // A predefined or previously defined bitmap (indicator 254) is refused too.
    assert.throws(
      () => decodeGrib2(patched(fx.bytes, [[s6.start + 5, 254]]), { grid }),
      (e) => e instanceof GribError && e.code === 'unsupported-feature'
    );
  }
});

test('refuses DRT 5.0, 5.41, 5.42 and grid 3.20 by name', () => {
  const wind = fixture('gfs1p00-UGRD-10m-f006').bytes;
  const wave = fixture('wcoast0p16-HTSGW-f006').bytes;
  const s5w = sectionOf(wind, 5);
  const s5v = sectionOf(wave, 5);
  const s3 = sectionOf(wind, 3);
  const s4 = sectionOf(wind, 4);
  const set16 = (msg, offset, v) => {
    const out = msg.slice();
    putU16(out, offset, v);
    return out;
  };
  const cases = [
    ['5.0', set16(wind, s5w.start + 9, 0)],
    ['5.0', set16(wave, s5v.start + 9, 0)],
    ['5.2', set16(wind, s5w.start + 9, 2)],
    ['5.41', set16(wave, s5v.start + 9, 41)],
    ['5.42', set16(wave, s5v.start + 9, 42)],
    ['3.20', set16(wind, s3.start + 12, 20)],
    ['3.30', set16(wind, s3.start + 12, 30)],
    ['4.8', set16(wind, s4.start + 7, 8)]
  ];
  for (const [template, msg] of cases) {
    assert.throws(
      () => decodeGrib2(msg, { grid: GLOBAL_1P00 }),
      (e) =>
        e instanceof GribError &&
        e.code === 'unsupported-template' &&
        new RegExp(`template ${template.replace('.', '\\.')}\\b`).test(e.message),
      `template ${template} is refused by name`
    );
  }
});

test('a truncated message, a missing 7777 or a section-0 length mismatch throws and does not hang', async () => {
  const jobs = [];
  for (const name of ['gfs1p00-UGRD-10m-f006', 'wcoast0p16-HTSGW-f006', 'global0p25-HTSGW-f006']) {
    const msg = fixture(name).bytes;
    const grid = name.startsWith('gfs') ? GLOBAL_1P00 : name.startsWith('wcoast') ? WCOAST_0P16 : GLOBAL_0P25;
    const secs = sections(msg);
    // Cut inside each section, and one byte short of the end.
    for (const s of secs) jobs.push({ label: `${name} cut in section ${s.number}`, bytes: msg.slice(0, s.start + 3), expect: { grid } });
    jobs.push({ label: `${name} one byte short`, bytes: msg.slice(0, msg.length - 1), expect: { grid } });
    jobs.push({ label: `${name} empty`, bytes: new Uint8Array(0), expect: { grid } });
    jobs.push({ label: `${name} header only`, bytes: msg.slice(0, 16), expect: { grid } });
    // The closing 7777 overwritten.
    jobs.push({ label: `${name} no 7777`, bytes: patched(msg, [[msg.length - 1, 0x36]]), expect: { grid } });
    // Section 0's total length one more and one less than the bytes held.
    for (const delta of [1, -1]) {
      const bad = msg.slice();
      putU32(bad, 12, msg.length + delta);
      jobs.push({ label: `${name} section-0 length ${delta > 0 ? '+' : ''}${delta}`, bytes: bad, expect: { grid } });
    }
    // A section length that runs past the message.
    const s3 = secs.find((s) => s.number === 3);
    const long3 = msg.slice();
    putU32(long3, s3.start, msg.length);
    jobs.push({ label: `${name} section 3 overruns`, bytes: long3, expect: { grid } });
    // Section 7 cut short with every length kept consistent: the data runs out.
    const s7 = secs.find((s) => s.number === 7);
    for (const keep of [0.5, 0.95]) {
      const body = msg.slice(s7.start + 5, s7.start + 5 + Math.floor((s7.length - 5) * keep));
      jobs.push({ label: `${name} section 7 at ${keep}`, bytes: withSection(msg, 7, body), expect: { grid } });
      if (!name.startsWith('gfs')) {
        // The same cut inside the tile data, with Psot and EOC kept consistent.
        const cs = codestreamOf(msg);
        const { sodEnd } = codestreamLayout(cs);
        const tile = cs.slice(sodEnd, cs.length - 2);
        const cut = withTileBody(cs, tile.slice(0, Math.floor(tile.length * keep)));
        jobs.push({ label: `${name} tile data at ${keep}`, bytes: withSection(msg, 7, cut), expect: { grid } });
      }
    }
  }
  const results = await assertAllRefused(jobs, 'truncation');
  // The structural cases name what is wrong.
  const byLabel = new Map(jobs.map((j, i) => [j.label, results[i]]));
  assert.equal(byLabel.get('gfs1p00-UGRD-10m-f006 no 7777').code, 'no-end-marker');
  assert.equal(byLabel.get('gfs1p00-UGRD-10m-f006 section-0 length +1').code, 'length-mismatch');
  assert.equal(byLabel.get('gfs1p00-UGRD-10m-f006 one byte short').code, 'length-mismatch');
});

test('Xsiz×Ysiz not equal to the packed-point count is refused before allocation', () => {
  const fx = fixture('wcoast0p16-HTSGW-f006');
  const cs = codestreamOf(fx.bytes);
  const { siz } = codestreamLayout(cs);
  const packed = fx.info.numberOfValues;
  assert.equal(u32(cs, siz + 6), packed, 'the fixture is one row of the packed points');
  const variants = [
    ['Xsiz + 1', packed + 1, 1],
    ['Xsiz - 1', packed - 1, 1],
    ['Ysiz 2', packed, 2],
    // A product near 2^62: allocating it would throw RangeError, not GribError.
    ['huge', 0x7fffffff, 0x7fffffff]
  ];
  for (const [label, x, y] of variants) {
    const bad = cs.slice();
    putU32(bad, siz + 6, x);
    putU32(bad, siz + 10, y);
    assert.throws(
      () => decodeJpeg2000(bad, packed),
      (e) => e.name === 'JpxError' && e.code === 'size',
      `${label}: decodeJpeg2000 refuses before allocating`
    );
    assert.throws(
      () => decodeGrib2(withSection(fx.bytes, 7, bad), { grid: WCOAST_0P16 }),
      (e) => e instanceof GribError && e.code === 'jpeg2000' && /Xsiz/.test(e.message),
      `${label}: decodeGrib2 refuses before allocating`
    );
  }
});

test('the tag-tree loop is bounded on exhausted data', async () => {
  const fx = fixture('wcoast0p16-HTSGW-f006');
  const cs = codestreamOf(fx.bytes);
  const jobs = [];
  // A packet header that says "non-empty", includes the first code-block
  // through k tag-tree levels, then supplies only zero bits (or nothing).
  // One of these k reaches the zero-bit-plane tag tree, whose loop must stop
  // at the band's bit-plane count instead of counting forever.
  for (let k = 0; k <= 12; k++) {
    const ones = new Array(1 + k).fill(1);
    for (const [tail, zeros] of [
      ['exhausted', 0],
      ['zeros', 8 * 4096]
    ]) {
      const body = stuffedBits([...ones, ...new Array(zeros).fill(0)]);
      jobs.push({
        label: `k=${k} ${tail}`,
        bytes: withSection(fx.bytes, 7, withTileBody(cs, body)),
        expect: { grid: WCOAST_0P16 }
      });
    }
  }
  // A body of all-ones bytes (the Lblock and pass-count loops).
  jobs.push({
    label: 'all ones',
    bytes: withSection(fx.bytes, 7, withTileBody(cs, new Uint8Array(4096).fill(0xff))),
    expect: { grid: WCOAST_0P16 }
  });
  const { hung, results } = await decodeIsolated(jobs);
  assert.equal(hung, false, `the decoder did not finish ${jobs.length} crafted bodies within ${ISOLATION_CAP_MS} ms`);
  results.forEach((r, i) => {
    // A crafted body may decode to garbage of the right length; it must
    // never throw anything but GribError.
    if (!r.ok) assert.equal(r.name, 'GribError', `${jobs[i].label}: ${r.name}: ${r.message}`);
  });
  assert.ok(
    results.some((r) => !r.ok && r.code === 'jpeg2000' && /zero bit-plane/.test(r.message)),
    'a crafted body reaches the zero-bit-plane tag tree and is stopped at the band bit-plane count'
  );
  assert.ok(
    results.some((r) => !r.ok && r.code === 'jpeg2000' && /packet header runs past/.test(r.message)),
    'an exhausted packet header is refused'
  );
});

// ---------------------------------------------------------------------------
// Hardening beyond the titles: structure caps, fuzzing, the call's expectations
// ---------------------------------------------------------------------------

test('a code-block count above the cap is refused before allocation', () => {
  const fx = fixture('global0p25-HTSGW-f006');
  const cs = codestreamOf(fx.bytes);
  let p = 2;
  while (((cs[p] << 8) | cs[p + 1]) !== 0xff52) p += 2 + ((cs[p + 2] << 8) | cs[p + 3]);
  // COD SPcod: xcb - 2 at offset 4 + 6. 4-wide code-blocks over 568,995 samples.
  const small = cs.slice();
  small[p + 4 + 6] = 0;
  assert.throws(
    () => decodeJpeg2000(small, fx.info.numberOfValues),
    (e) => e.name === 'JpxError' && e.code === 'size' && /code-blocks/.test(e.message)
  );
});

// ---------------------------------------------------------------------------
// Hardening beyond the titles: fuzzing and the call's expectations
// ---------------------------------------------------------------------------

/** mulberry32: a seeded generator, so a failing fuzz case can be replayed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('seeded corruption of the fixtures throws GribError or decodes, never anything else, and never hangs', async () => {
  const rand = mulberry32(20261005);
  const jobs = [];
  for (const name of ['gfs1p00-UGRD-10m-f006', 'wcoast0p16-HTSGW-f006', 'wcoast0p16-DIRPW-f006']) {
    const msg = fixture(name).bytes;
    const grid = name.startsWith('gfs') ? GLOBAL_1P00 : WCOAST_0P16;
    const secs = sections(msg);
    const s7 = secs.find((s) => s.number === 7);
    for (let i = 0; i < 80; i++) {
      const bad = msg.slice();
      // Half the cases hit the headers (sections 1 to 6 and the codestream's
      // marker segments); the rest anywhere in section 7.
      const inHeaders = i % 2 === 0;
      const lo = inHeaders ? 16 : s7.start + 5;
      const hi = inHeaders ? Math.min(s7.start + 5 + 200, msg.length - 4) : msg.length - 4;
      const flips = 1 + Math.floor(rand() * 4);
      for (let f = 0; f < flips; f++) {
        const o = lo + Math.floor(rand() * (hi - lo));
        bad[o] = Math.floor(rand() * 256);
      }
      jobs.push({ label: `${name} #${i}`, bytes: bad, expect: { grid } });
    }
    for (let i = 0; i < 20; i++) {
      const cut = 16 + Math.floor(rand() * (msg.length - 16));
      jobs.push({ label: `${name} cut ${cut}`, bytes: msg.slice(0, cut), expect: { grid } });
    }
  }
  const { hung, results } = await decodeIsolated(jobs, 60_000);
  assert.equal(hung, false, `${jobs.length} corrupted messages did not finish within 60 s`);
  results.forEach((r, i) => {
    if (r.ok) assert.equal(r.points, jobs[i].expect.grid.ni * jobs[i].expect.grid.nj, jobs[i].label);
    else assert.equal(r.name, 'GribError', `${jobs[i].label}: ${r.name}: ${r.message}`);
  });
});

test('the call refuses a parameter, clock, packing or grid it did not ask for', () => {
  const fx = fixture('gfs1p00-UGRD-10m-f006');
  const ok = { grid: GLOBAL_1P00, parameter: { discipline: 0, category: 2, number: 2 }, refTime: CYCLE, forecastHours: 6, packing: 3, bitmap: false };
  assert.doesNotThrow(() => decodeGrib2(fx.bytes, ok));
  const wrong = [
    { ...ok, parameter: { discipline: 0, category: 2, number: 3 } },
    { ...ok, refTime: CYCLE - 6 * 3600_000 },
    { ...ok, forecastHours: 3 },
    { ...ok, packing: 40 },
    { ...ok, bitmap: true },
    { ...ok, grid: { ...GLOBAL_1P00, nj: 180 } },
    { ...ok, grid: { ...GLOBAL_1P00, la1: -90 } }
  ];
  for (const expect of wrong) {
    assert.throws(
      () => decodeGrib2(fx.bytes, expect),
      (e) => e instanceof GribError && e.code === 'expectation',
      JSON.stringify(expect)
    );
  }
  // The header read checks structure and templates without unpacking data.
  const h = readGrib2Header(fx.bytes);
  assert.deepEqual(h.parameter, { discipline: 0, category: 2, number: 2 });
  assert.equal(h.surface.type, 103);
  assert.equal(h.surface.value, 10);
  assert.equal(h.packing.packedCount, 65_160);
  assert.equal('values' in h, false);
});
