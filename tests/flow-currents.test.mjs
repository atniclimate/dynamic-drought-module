/**
 * The ENSO "Ocean currents" frame (admission rtofs-currents-producer; DR-116):
 * what scripts/build-rtofs-currents.mjs does to NOAA RTOFS values, how the
 * browser reads the committed frame (src/layers/flow/currents.ts), and the
 * words that date it (src/layers/enso-flow-data.ts).
 *
 * The real bytes are the two RTOFS messages in tests/fixtures/flow/ (u and v
 * at forecast hour 1 of the 2026-10-13 00Z run, 1.0 degree tropical Pacific
 * grid; tests/flow-grib-decode.test.mjs holds their decode to ecCodes) and
 * the committed frame under public/data/, which a later landing replaces: so
 * nothing here pins the frame's run, only its shape. Nothing touches the
 * network.
 *
 * Runs under plain `node --test` (Node 24 strips types), like its neighbours.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

globalThis.fetch = () => {
  throw new Error('unexpected network call from a node test');
};

// src/ imports are extensionless (the bundler resolves them).
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

const { decodeGrib2 } = await import('../src/layers/flow/grib2.ts');
const {
  CURRENT_COMPONENT_MAX_MS, CURRENTS_HEADER_FILE, decodeCurrentsFrame, fieldNearestLatitude, parseCurrentsHeader
} = await import('../src/layers/flow/currents.ts');
const { FLOW_BINS, classOf, newSample, sampleField } = await import('../src/layers/flow/field.ts');
const { WIND_PACE, paceFor } = await import('../src/layers/flow/advect.ts');
const { FLOW_WORDS, currentsBoxNote, flowAgeWords, flowLiveLine, gridBoxWords } = await import('../src/layers/enso-flow-data.ts');
const { encodeGrid } = await import('../scripts/build-rtofs-currents.mjs');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIXTURES = new URL('./fixtures/flow/', import.meta.url);
const DATA = new URL('../public/data/', import.meta.url);
const TROP = { ni: 120, nj: 80, la1: -40, lo1: 130, di: 1, dj: 1 };

/** The fixture pair, decoded the way the producer decodes it (scan order: south to north). */
function fixturePair() {
  const decode = (name, number) => decodeGrib2(new Uint8Array(readFileSync(new URL(`${name}.grib2`, FIXTURES))), {
    grid: TROP, surface: { type: 160, value: 0 }, parameter: { discipline: 10, category: 1, number },
    forecastHours: 1, packing: 0, bitmap: true, scanMode: 0x40
  });
  return { u: decode('rtofs-trop-UOGRD-0m-f001', 2), v: decode('rtofs-trop-VOGRD-0m-f001', 3) };
}

/** A header for one 1.0 degree grid, as the producer writes it. */
function headerFor(run, overrides = {}) {
  return {
    format: 'ddm-flow-frame/1', units: 'm s-1', level: '0 m below sea level',
    run: new Date(run).toISOString(), forecastHour: 1, valid: new Date(run + HOUR).toISOString(),
    encoding: { type: 'int16', endian: 'little', layout: 'planar-u-then-v', rowOrder: 'north-to-south', scale: 0.01, noData: -32768 },
    grids: [{ id: 'trop_paci_lowres', file: 'grid.i16.gz', lon0: 130, lat0: 39, dlon: 1, dlat: 1, nx: 120, ny: 80 }],
    ...overrides
  };
}

test('the producer writes the issuer values unchanged, north first, and the reader gives them back', async () => {
  const { u, v } = fixturePair();
  const { raw, masked, fastest } = encodeGrid(u.values, v.values, TROP);
  assert.equal(raw.length, 120 * 80 * 4, 'all u then all v, two bytes each');
  assert.equal(masked, u.missingCount);
  assert.ok(fastest > 1 && fastest < CURRENT_COMPONENT_MAX_MS, `fastest component ${fastest} m/s`);
  const header = parseCurrentsHeader(headerFor(u.refTime));
  // The committed files are gzip; a host that inflates them in transit hands over the same bytes.
  for (const body of [new Uint8Array(gzipSync(raw)), raw]) {
    const [field] = await decodeCurrentsFrame(header, [body]);
    assert.equal(field.kind, 'currents');
    assert.deepEqual(field.grid, { lon0: 130, lat0: 39, dlon: 1, dlat: 1, nx: 120, ny: 80, wrapsLon: false });
    assert.deepEqual(
      [field.meta.cycle, field.meta.forecastHour, field.meta.validTime, field.meta.staleAfter, field.meta.units],
      [u.refTime, 1, u.refTime + HOUR, null, 'm s-1'],
      'a dated frame: run, valid instant, and no age limit'
    );
    let valid = 0;
    for (let row = 0; row < 80; row++) {
      for (let col = 0; col < 120; col++) {
        const i = row * 120 + col;
        const from = (79 - row) * 120 + col; // the message's rows run south to north
        if (Number.isNaN(u.values[from])) {
          assert.equal(field.mask[i], 0);
          assert.ok(Number.isNaN(field.u[i]) && Number.isNaN(field.v[i]) && Number.isNaN(field.magnitude[i]), 'land is never still water');
          continue;
        }
        valid++;
        assert.equal(field.mask[i], 1);
        assert.ok(Math.abs(field.u[i] - u.values[from]) <= 1e-6 && Math.abs(field.v[i] - v.values[from]) <= 1e-6, `node ${i}`);
      }
    }
    assert.equal(valid, 9600 - u.missingCount);
    // Bitmap-masked cells draw nothing: no sample inside Australia, a sample on the equator at the date line.
    assert.equal(sampleField(field, 135, -25, newSample()), null);
    const sea = sampleField(field, 180, 0, newSample());
    assert.ok(sea && Number.isFinite(sea.u) && Number.isFinite(sea.v) && sea.m >= 0);
    // Off the grid nothing is extrapolated: north of the last row (39 N) and east of the last column (249 E).
    assert.equal(sampleField(field, 180, 39.5, newSample()), null);
    assert.equal(sampleField(field, 249.5, 0, newSample()), null);
  }
});

test('the producer refuses a value it would have to change, and a mask that differs between u and v', () => {
  const grid = { ni: 2, nj: 2 };
  const calm = () => Float32Array.of(0, 0.01, -0.02, 0.5);
  assert.doesNotThrow(() => encodeGrid(calm(), calm(), grid));
  const withValue = (x) => { const a = calm(); a[1] = x; return a; };
  assert.throws(() => encodeGrid(withValue(CURRENT_COMPONENT_MAX_MS + 0.01), calm(), grid), /beyond the plausible/);
  assert.throws(() => encodeGrid(calm(), withValue(-(CURRENT_COMPONENT_MAX_MS + 0.01)), grid), /beyond the plausible/);
  assert.throws(() => encodeGrid(withValue(0.015), calm(), grid), /not on the 0\.01 m\/s step/);
  assert.throws(() => encodeGrid(withValue(Number.NaN), calm(), grid), /mask different nodes/);
  assert.throws(() => encodeGrid(calm(), new Float32Array(3), grid), /expected two fields/);
  // Rows turn north first; u fills the first half, v the second; a masked node is -32768 in both.
  const u = Float32Array.of(0.01, 0.02, Number.NaN, 0.04);
  const v = Float32Array.of(-0.01, -0.02, Number.NaN, -0.04);
  const { raw, masked } = encodeGrid(u, v, grid);
  assert.deepEqual([...new Int16Array(raw.buffer)], [-32768, 4, 1, 2, -32768, -4, -1, -2]);
  assert.equal(masked, 1);
});

test('a frame the reader cannot trust is refused: a wrong header, a short body, a speed no ocean has', async () => {
  const run = Date.UTC(2026, 9, 13);
  const body = new Uint8Array(new Int16Array(120 * 80 * 2).buffer);
  const good = parseCurrentsHeader(headerFor(run));
  assert.equal((await decodeCurrentsFrame(good, [body])).length, 1);
  const bad = [
    null,
    [],
    headerFor(run, { format: 'ddm-flow-frame/2' }),
    headerFor(run, { units: 'km/h' }),
    headerFor(run, { valid: new Date(run).toISOString() }),
    headerFor(run, { run: 'yesterday' }),
    headerFor(run, { grids: [] }),
    headerFor(run, { grids: [{ ...headerFor(run).grids[0], file: '../grid.i16.gz' }] }),
    headerFor(run, { grids: [{ ...headerFor(run).grids[0], nx: '120' }] }),
    headerFor(run, { encoding: { ...headerFor(run).encoding, scale: 0 } }),
    headerFor(run, { encoding: { ...headerFor(run).encoding, rowOrder: 'south-to-north' } }),
    headerFor(run, { encoding: { ...headerFor(run).encoding, noData: 0 } })
  ];
  for (const json of bad) assert.throws(() => parseCurrentsHeader(json), /currents frame/, JSON.stringify(json)?.slice(0, 80));
  await assert.rejects(decodeCurrentsFrame(good, []), /a grid file is missing/);
  await assert.rejects(decodeCurrentsFrame(good, [body.subarray(0, body.length - 2)]), /bytes; 38400 expected/);
  await assert.rejects(decodeCurrentsFrame(good, [new Uint8Array(gzipSync(body)).subarray(0, 40)]), 'a truncated gzip file');
  const fast = new Int16Array(120 * 80 * 2);
  fast[7] = (CURRENT_COMPONENT_MAX_MS + 1) * 100;
  await assert.rejects(decodeCurrentsFrame(good, [new Uint8Array(fast.buffer)]), /beyond the plausible 5 m\/s/);
  // A grid the field contract refuses (rows past the pole) is refused too.
  const polar = parseCurrentsHeader(headerFor(run, { grids: [{ ...headerFor(run).grids[0], lat0: 95 }] }));
  await assert.rejects(decodeCurrentsFrame(polar, [body]), /90 N to 90 S/);
});

test('the committed frame is the two grids of the admission, dated, inside the bound and small', async () => {
  const json = JSON.parse(readFileSync(new URL(CURRENTS_HEADER_FILE, DATA), 'utf8'));
  const header = parseCurrentsHeader(json);
  const bodies = header.grids.map((grid) => new Uint8Array(readFileSync(new URL(grid.file, DATA))));
  const fields = await decodeCurrentsFrame(header, bodies);
  assert.deepEqual(
    fields.map((f) => f.grid),
    [
      // Nodes are first point + k * step: the tropical grid ends at 39 N and 249 E, the northern one at 84.7 N and 244.7 E.
      { lon0: 130, lat0: 39, dlon: 1, dlat: 1, nx: 120, ny: 80, wrapsLon: false },
      { lon0: 140, lat0: 84.7, dlon: 0.3, dlat: 0.3, nx: 350, ny: 150, wrapsLon: false }
    ]
  );
  assert.equal(header.run % DAY, 0, 'a 00Z run');
  assert.equal(header.valid, header.run + header.forecastHour * HOUR);
  assert.ok(header.forecastHour >= 1 && header.forecastHour <= 24, 'an hour of the f024 file');
  assert.equal(header.scale, 0.01, "the issuer's own precision");
  assert.match(json.note, /not an official NOAA product/);
  assert.equal(json.licence, 'https://www.weather.gov/disclaimer');
  fields.forEach((field, k) => {
    const n = field.grid.nx * field.grid.ny;
    let valid = 0;
    let fastest = 0;
    for (let i = 0; i < n; i++) {
      if (field.mask[i] !== 1) continue;
      valid++;
      fastest = Math.max(fastest, Math.abs(field.u[i]), Math.abs(field.v[i]));
    }
    assert.equal(valid, n - json.grids[k].maskedNodes, `${json.grids[k].id}: every unmasked node holds a value`);
    assert.ok(valid > n / 2 && json.grids[k].maskedNodes > 0, `${json.grids[k].id}: sea and land`);
    assert.ok(fastest > 0.5 && fastest <= CURRENT_COMPONENT_MAX_MS, `${json.grids[k].id}: fastest component ${fastest} m/s`);
    assert.equal(bodies[k].length, json.grids[k].gzipBytes);
    assert.equal(field.meta.staleAfter, null);
  });
  const gzip = bodies.reduce((sum, body) => sum + body.length, 0);
  assert.ok(gzip < 100_000, `the frame is ${gzip} B gzip`);
});

test('the grid under the view centre is the one whose rows are nearest; grids are never joined', () => {
  const grid = (lat0, ny, dlat) => ({ grid: { lon0: 130, lat0, dlon: dlat, dlat, nx: 2, ny, wrapsLon: false } });
  const tropics = grid(39, 80, 1);
  const north = grid(84.7, 150, 0.3);
  const pick = (lat) => fieldNearestLatitude([tropics, north], lat);
  assert.equal(pick(0), tropics);
  assert.equal(pick(-60), tropics);
  assert.equal(pick(39.4), tropics);
  assert.equal(pick(39.5), tropics, 'the first on a tie');
  assert.equal(pick(39.6), north);
  assert.equal(pick(55), north);
  assert.equal(pick(89), north);
  assert.equal(fieldNearestLatitude([north], -10), north);
});

test('the state line dates the frame and states its age, and never calls it now', () => {
  const run = Date.UTC(2026, 9, 13);
  const valid = run + HOUR;
  assert.equal(
    flowLiveLine('live', 'currents', run, valid, valid + 3.5 * DAY),
    'live · NOAA RTOFS surface currents · Model run Oct 13, 12:00 AM UTC · Model valid Oct 13, 1:00 AM UTC · frame 3 days old'
  );
  // Every kind's line names its own source, so the wind at 10 m and at 250 hPa never read alike.
  const lines = Object.keys(FLOW_WORDS.source).map((kind) => flowLiveLine('live (partial)', kind, run, valid));
  assert.equal(new Set(lines).size, lines.length, 'two kinds share a live line');
  assert.ok(lines.includes('live (partial) · NOAA GFS 250 hPa wind · Model run Oct 13, 12:00 AM UTC · Model valid Oct 13, 1:00 AM UTC'));
  assert.ok(lines.includes('live (partial) · NOAA GFS 10 m wind · Model run Oct 13, 12:00 AM UTC · Model valid Oct 13, 1:00 AM UTC'));
  // So does every kind's credit.
  assert.deepEqual(Object.keys(FLOW_WORDS.provenance).sort(), Object.keys(FLOW_WORDS.source).sort());
  assert.equal(new Set(Object.values(FLOW_WORDS.provenance)).size, lines.length, 'two kinds share a credit');
  assert.equal(flowAgeWords(valid, valid + 5 * HOUR), 'frame under 1 day old');
  assert.equal(flowAgeWords(valid, valid + DAY), 'frame 1 day old');
  assert.equal(flowAgeWords(valid, valid + 40 * DAY), 'frame 40 days old', 'weeks old still draws, with its age');
  assert.equal(flowAgeWords(valid, valid - HOUR), 'frame under 1 day old', 'a clock behind the frame claims no negative age');
  const tropics = { lon0: 130, lat0: 39, dlon: 1, dlat: 1, nx: 120, ny: 80 };
  const north = { lon0: 140, lat0: 84.7, dlon: 0.3, dlat: 0.3, nx: 350, ny: 150 };
  assert.equal(gridBoxWords(tropics), '40 S to 39 N and 130 E to 111 W');
  assert.equal(gridBoxWords(north), '40 N to 84.7 N and 140 E to 115.3 W');
  assert.equal(currentsBoxNote(tropics), 'Ocean current lines in this view cover 40 S to 39 N and 130 E to 111 W only; nothing is drawn outside that area.');
  const words = [
    FLOW_WORDS.source.currents, FLOW_WORDS.unavailable.currents, FLOW_WORDS.bins.currents, FLOW_WORDS.provenance.currents,
    FLOW_WORDS.currentsOutside, currentsBoxNote(north), flowLiveLine('live', 'currents', run, valid, valid + DAY)
  ];
  for (const text of words) assert.doesNotMatch(text, /\b(?:now|currently|current conditions|real-time|latest|today)\b/i, text);
  assert.equal(FLOW_WORDS.staleModel.currents, undefined, 'the dated frame has no 24-hour limit to name');
});

test('the currents reader and the panel name no host: the frame is read beside the app', () => {
  // The frame is a file of the app's own origin; the only host the flow chunk names is NOAA's NODD bucket (flow/source.ts).
  for (const file of ['src/layers/flow/currents.ts', 'src/layers/enso-flow.ts', 'src/layers/enso-flow-data.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /https?:\/\//, file);
  }
  assert.match(CURRENTS_HEADER_FILE, /^[\w.-]+\.json$/);
});

test('current bins are 0.25 and 0.5 m/s, and the pace is scaled like jet-level wind', () => {
  assert.deepEqual(FLOW_BINS.currents, [0.25, 0.5]);
  assert.deepEqual([0.1, 0.25, 0.49, 0.5, 1.4].map((speed) => classOf('currents', speed)), [0, 1, 1, 2, 2]);
  assert.equal(FLOW_WORDS.bins.currents, 'Line width and brightness: under 0.25, 0.25 to 0.5, 0.5 or more m/s.');
  const pace = paceFor('currents');
  assert.equal(pace.uniform, false, 'pace follows the speed of the field');
  assert.equal(pace.pxPerSecPerUnit * FLOW_BINS.currents[1], WIND_PACE.pxPerSecPerUnit * FLOW_BINS.wind[1]);
});
