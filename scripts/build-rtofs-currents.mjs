/**
 * Build the committed NOAA RTOFS surface-current frame the ENSO "Ocean
 * currents" paths draw (admission rtofs-currents-producer; DR-116).
 *
 * Run by hand at a landing, from the repository root, then commit the three
 * files it writes under public/data/:
 *
 *     node scripts/build-rtofs-currents.mjs
 *
 * No schedule, no workflow, no credential, no proxy. NOMADS keeps two days
 * and sends no CORS header, which is why this is a landing-time script and
 * the browser reads only its same-origin output. With a directory as the one
 * argument (`node scripts/build-rtofs-currents.mjs <dir>`) the two source
 * GRIB2 files are kept there, and read from there when already present, so
 * a second decoder (ecCodes, GDAL) can be run over the same bytes.
 *
 * What it does to the issuer's values, all of it:
 *   1. downloads the two regional files of the newest 00Z run (today's UTC
 *      folder, else yesterday's) and takes the surface u and v messages
 *      (discipline 10, category 1, numbers 2 and 3, depth 0 m) of one
 *      forecast hour;
 *   2. unpacks them with the project's own GRIB2 decoder
 *      (src/layers/flow/grib2.ts: template 5.0 simple packing, the section 6
 *      bitmap, scanning mode 0x40), which tests/flow-currents.test.mjs holds
 *      to ecCodes on two committed messages;
 *   3. writes each grid on its native spacing as Int16 little-endian counts
 *      of 0.01 m/s (the issuer's own precision, so no value changes; a value
 *      off that step is refused), all u then all v, rows turned north to
 *      south, -32768 at every node the issuer's bitmap masks, then gzip.
 * Nothing is interpolated, resampled, smoothed, rotated, filled or joined
 * across the two grids. A check that fails writes nothing.
 *
 * The grids (settled from the bytes on 2026-10-13). Each message states a
 * first point, a last point, counts and increments that disagree by one
 * step: 120 x 80 at 1.0 degree "from 40 S, 130 E to 40 N, 250 E", and
 * 350 x 150 at 0.3 degree "from 40 N, 140 E to 85 N, 245 E". The nodes are
 * first point + k * increment: the land mask each message carries agrees
 * with an independent 0.25 degree sea mask (GFS-Wave) best at exactly that
 * registration (39 of 9,600 nodes differ on the 1.0 degree grid, against
 * 113 or more at any half-step shift and 160 if the rows and columns are
 * stretched to reach the stated last point), and its 39 N row differs from
 * the northern grid's 40 N row by one row's worth of temperature. So the
 * tropical grid ends at 39 N and 249 E (111 W) and the northern one at
 * 84.7 N and 244.7 E (115.3 W); the stated last points are one step beyond
 * the last node, and this script never reads them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// src/ imports are extensionless (the bundler resolves them); map them to
// the .ts file, as the Node tests do.
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

const { decodeGrib2, readGrib2Header } = await import('../src/layers/flow/grib2.ts');
const {
  CURRENTS_FORMAT, CURRENTS_HEADER_FILE, CURRENTS_NO_DATA, CURRENT_COMPONENT_MAX_MS, decodeCurrentsFrame, parseCurrentsHeader
} = await import('../src/layers/flow/currents.ts');

/**
 * THE ONE ROW a rename or another step edits. NWS Public Information
 * Statement 26-17 proposes `rtofs_glo.t00z.f024.<region>.std.grib2` for RTOFS
 * v3.0 (not adopted as of 2026-10-13); that cut-over also changes the ocean
 * model behind the field, so it is a point to verify the decode again.
 *
 * `step` is the forecast hour taken from the f024 file, which holds hours 1
 * to 24 of the 00Z run: hour 1 is valid at run + 1 h, in the past whenever
 * the file exists. The n024 (nowcast) file is not read: its messages state
 * steps 1 to 24 from the same reference time, which are not their valid
 * instants (admission, section of 2026-10-13).
 */
const SOURCE = {
  origin: 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod',
  folder: (day) => `rtofs.${day}`,
  file: (region) => `rtofs_glo.t00z.f024_${region}_std.grb2`,
  step: 1
};

/** The two grids of the admission, each on its native spacing; `expect` is what the messages must state. */
const GRIDS = [
  { region: 'trop_paci_lowres', file: 'rtofs-surface-currents-trop-paci.i16.gz', expect: { ni: 120, nj: 80, la1: -40, lo1: 130, di: 1, dj: 1 } },
  { region: 'alaska', file: 'rtofs-surface-currents-alaska.i16.gz', expect: { ni: 350, nj: 150, la1: 40, lo1: 140, di: 0.3, dj: 0.3 } }
];

/** m/s per Int16 count: the issuer's own precision (decimal scale 2, binary scale 0). */
const SCALE = 0.01;
const HOUR = 3_600_000;
const SURFACE = { type: 160, value: 0 };
const ALLOW = { packing: 0, scanMode: 0x40 };
const OUT_DIR = fileURLToPath(new URL('../public/data/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dayOf = (time) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');

/**
 * The Int16 planar body of one grid from its decoded u and v (scan order,
 * south to north, NaN where masked). Exported for tests/flow-currents.test.mjs.
 */
export function encodeGrid(u, v, { ni, nj }) {
  const n = ni * nj;
  if (u.length !== n || v.length !== n) throw new Error(`expected two fields of ${ni} x ${nj}`);
  const view = new DataView(new ArrayBuffer(n * 4));
  let masked = 0;
  let fastest = 0;
  for (let row = 0; row < nj; row++) {
    for (let col = 0; col < ni; col++) {
      const from = (nj - 1 - row) * ni + col; // the message runs south to north, the frame north to south
      const to = row * ni + col;
      const pair = [u[from], v[from]];
      if (Number.isNaN(pair[0]) !== Number.isNaN(pair[1])) throw new Error(`u and v mask different nodes (node ${from})`);
      pair.forEach((x, k) => {
        let q = CURRENTS_NO_DATA;
        if (!Number.isNaN(x)) {
          if (!(Math.abs(x) <= CURRENT_COMPONENT_MAX_MS)) {
            throw new Error(`${x} m/s at node ${from} is beyond the plausible ${CURRENT_COMPONENT_MAX_MS} m/s; nothing is written`);
          }
          q = Math.round(x / SCALE);
          if (Math.abs(q * SCALE - x) > 1e-4) throw new Error(`${x} m/s is not on the ${SCALE} m/s step: the issuer's precision changed`);
          fastest = Math.max(fastest, Math.abs(x));
        }
        view.setInt16((k * n + to) * 2, q, true);
      });
      if (Number.isNaN(pair[0])) masked++;
    }
  }
  return { raw: new Uint8Array(view.buffer), masked, fastest };
}

/** The surface u and v messages of `step` in one regional file, decoded. */
function surfaceCurrent(bytes, expect) {
  const found = {};
  for (let offset = 0; offset < bytes.length; ) {
    if (bytes.length - offset < 16 || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'GRIB') {
      throw new Error(`no GRIB message at byte ${offset}`);
    }
    const length = Number(new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8).getBigUint64(0, false));
    const message = bytes.subarray(offset, offset + length);
    const h = readGrib2Header(message, ALLOW);
    const { discipline, category, number } = h.parameter;
    if (discipline === 10 && category === 1 && (number === 2 || number === 3) && h.forecastHours === SOURCE.step &&
        h.surface.type === SURFACE.type && h.surface.value === SURFACE.value) {
      const name = number === 2 ? 'u' : 'v';
      if (found[name]) throw new Error(`two surface ${name} messages at step ${SOURCE.step}`);
      found[name] = decodeGrib2(message, {
        grid: expect, surface: SURFACE, parameter: h.parameter, forecastHours: SOURCE.step, bitmap: true, ...ALLOW
      });
    }
    offset += length;
  }
  if (!found.u || !found.v) throw new Error(`no surface current pair at step ${SOURCE.step}`);
  if (found.u.refTime !== found.v.refTime) throw new Error('u and v are of different runs');
  return found;
}

/** The two regional files of one run: from `keep` when both are there, else today's UTC folder, else yesterday's. */
async function sourceFiles(keep) {
  const kept = GRIDS.map((grid) => (keep ? join(keep, SOURCE.file(grid.region)) : null));
  if (kept.every((path) => path && existsSync(path))) {
    console.log(`reading the source files kept in ${keep}`);
    return kept.map((path) => new Uint8Array(readFileSync(path)));
  }
  const tried = [];
  for (const day of [dayOf(Date.now()), dayOf(Date.now() - 24 * HOUR)]) {
    const files = [];
    for (const grid of GRIDS) {
      const url = `${SOURCE.origin}/${SOURCE.folder(day)}/${SOURCE.file(grid.region)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) {
        tried.push(`${url}: HTTP ${response.status}`);
        break;
      }
      files.push(new Uint8Array(await response.arrayBuffer()));
      console.log(`downloaded ${url} (${files.at(-1).length.toLocaleString('en-US')} B)`);
    }
    if (files.length !== GRIDS.length) continue;
    if (keep) {
      mkdirSync(keep, { recursive: true });
      kept.forEach((path, k) => writeFileSync(path, files[k]));
    }
    return files;
  }
  throw new Error(`NOMADS has neither day's files:\n  ${tried.join('\n  ')}`);
}

async function main() {
  const files = await sourceFiles(process.argv[2]);
  const decoded = GRIDS.map((grid, k) => surfaceCurrent(files[k], grid.expect));
  const run = decoded[0].u.refTime;
  if (decoded.some((pair) => pair.u.refTime !== run) || run % (24 * HOUR) !== 0) {
    throw new Error('the two files are not of one 00Z run');
  }
  const valid = run + SOURCE.step * HOUR;
  const bodies = GRIDS.map((grid, k) => encodeGrid(decoded[k].u.values, decoded[k].v.values, grid.expect));
  const assets = bodies.map((body) => gzipSync(body.raw, { level: 9 }));
  const header = {
    format: CURRENTS_FORMAT,
    issuer: 'NOAA/NWS/NCEP',
    model: 'Global RTOFS',
    product: 'surface current, u (east) and v (north)',
    level: '0 m below sea level',
    units: 'm s-1',
    run: new Date(run).toISOString(),
    forecastHour: SOURCE.step,
    valid: new Date(valid).toISOString(),
    encoding: {
      type: 'int16', endian: 'little', layout: 'planar-u-then-v', rowOrder: 'north-to-south',
      scale: SCALE, noData: CURRENTS_NO_DATA, compression: 'gzip'
    },
    grids: GRIDS.map(({ region, file, expect }, k) => ({
      id: region,
      file,
      // Node (0, 0) is the north-west node; columns run east and rows south.
      lon0: expect.lo1,
      lat0: Math.round((expect.la1 + (expect.nj - 1) * expect.dj) * 1e6) / 1e6,
      dlon: expect.di,
      dlat: expect.dj,
      nx: expect.ni,
      ny: expect.nj,
      maskedNodes: bodies[k].masked,
      bytes: bodies[k].raw.length,
      gzipBytes: assets[k].length,
      source: {
        url: `${SOURCE.origin}/${SOURCE.folder(dayOf(run))}/${SOURCE.file(region)}`,
        bytes: files[k].length,
        sha256: sha256(files[k])
      }
    })),
    licence: 'https://www.weather.gov/disclaimer',
    note: 'Re-encoded by DDM from NOAA/NCEP Global RTOFS model output; not an official NOAA product.',
    producer: {
      script: 'scripts/build-rtofs-currents.mjs',
      // Of the script's text with LF line endings, so every checkout gives the same hash.
      sha256: sha256(readFileSync(fileURLToPath(import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
    }
  };
  const headerText = `${JSON.stringify(header, null, 1)}\n`;

  // Read the frame back the way the browser will, and hold it to the decoded messages.
  const fields = await decodeCurrentsFrame(parseCurrentsHeader(JSON.parse(headerText)), assets);
  fields.forEach((field, k) => {
    const { ni, nj } = GRIDS[k].expect;
    for (let i = 0; i < ni * nj; i++) {
      const from = (nj - 1 - Math.floor(i / ni)) * ni + (i % ni);
      for (const [got, want] of [[field.u[i], decoded[k].u.values[from]], [field.v[i], decoded[k].v.values[from]]]) {
        if (Number.isNaN(got) !== Number.isNaN(want) || Math.abs(got - want) > 1e-6) {
          throw new Error(`${GRIDS[k].region}: node ${i} reads back ${got}, the message holds ${want}`);
        }
      }
    }
  });

  writeFileSync(join(OUT_DIR, CURRENTS_HEADER_FILE), headerText);
  GRIDS.forEach((grid, k) => writeFileSync(join(OUT_DIR, grid.file), assets[k]));
  const count = (n) => n.toLocaleString('en-US');
  console.log(`run ${header.run}, forecast hour ${SOURCE.step}, valid ${header.valid}`);
  GRIDS.forEach((grid, k) => console.log(
    `  ${grid.file}: ${count(bodies[k].raw.length)} B raw, ${count(assets[k].length)} B gzip; ` +
    `${count(bodies[k].masked)} of ${count(grid.expect.ni * grid.expect.nj)} nodes masked; fastest component ${bodies[k].fastest.toFixed(2)} m/s`
  ));
  console.log(
    `  ${CURRENTS_HEADER_FILE}: ${count(Buffer.byteLength(headerText))} B; frame ` +
    `${count(bodies.reduce((a, b) => a + b.raw.length, 0))} B raw, ${count(assets.reduce((a, b) => a + b.length, 0))} B gzip`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
