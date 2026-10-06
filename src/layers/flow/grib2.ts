/**
 * DDM's own GRIB2 (WMO FM 92 GRIB edition 2) decoder for the two NODD
 * products the ENSO flow paths read (ENSO-FLOW-PLAN sections 2.2 and 2.3):
 *
 * - GFS 10 m UGRD/VGRD (`gfs.tHHz.pgrb2.1p00.fFFF`): grid 3.0, product 4.0,
 *   data representation template 5.3 (complex packing with 2nd-order
 *   spatial differencing), no bitmap;
 * - GFS-Wave HTSGW and DIRPW (`gfswave.tHHz.global.0p25.fFFF.grib2` and the
 *   regional grids): grid 3.0, product 4.0, template 5.40 (JPEG 2000, see
 *   ./jpx), with a section 6 bitmap.
 *
 * Values are Y = (R + X * 2^E) * 10^-D (GRIB2 regulation 92.9.4), with every
 * point the bitmap masks set to NaN. Direction fields are returned exactly
 * as the issuer encodes them: this module never rotates a direction.
 *
 * Anything else is refused loudly with a GribError that names it (another
 * template, a second field in one message, a predefined bitmap, a
 * truncated or inconsistent message, a data section not consumed to its
 * last byte), so a change at NCEP reads as unavailable rather than drawing
 * wrong values. The decoder refuses structurally invalid messages; GRIB2
 * has no checksum, so a damaged message that stays structurally valid is
 * not detected here (the decode Worker's plausibility bounds are the next
 * check). Grid expectations are parameters of each call, never fixed to
 * one grid.
 *
 * Verified against eccodes 2.49.0 on real NODD messages
 * (tests/flow-grib-decode.test.mjs). It copies no code from any other
 * decoder.
 */

import { decodeJpeg2000, JpxError } from './jpx';

export type GribErrorCode =
  /** Section 0 is absent, not GRIB, or not edition 2. */
  | 'not-grib2'
  /** Section 0's total length differs from the bytes held. */
  | 'length-mismatch'
  /** The message does not close with 7777. */
  | 'no-end-marker'
  /** A section is too short for its template or runs past the message. */
  | 'section-bounds'
  /** Sections out of order, repeated (more than one field), or missing. */
  | 'section-order'
  /** A grid, product or data representation template this decoder does not implement. */
  | 'unsupported-template'
  /** A feature inside a supported template that this decoder does not implement. */
  | 'unsupported-feature'
  /** The message is well formed but is not what the call asked for. */
  | 'expectation'
  /** A count or dimension outside the decoder's bounds, refused before allocation. */
  | 'size'
  /** The bitmap and the packed-point count disagree. */
  | 'bitmap'
  /** Template 5.3 data runs out, is left over, or contradicts its own group descriptors. */
  | 'data'
  /** The template 5.40 JPEG 2000 codestream is refused (the message says why). */
  | 'jpeg2000';

// Class fields in src/layers/flow/ are `declare`d and set in the constructor,
// so the es2020 build lowers no class field and needs no class-field helper
// (block E2 E2-1: such a helper split out of the eager chunks without a
// sourcemap). nodd.ts, which the Playwright specs import, types its one
// field through a merged interface instead, since their transform refuses
// `declare` fields; a module a spec starts importing must do the same.
export class GribError extends Error {
  declare readonly code: GribErrorCode;
  constructor(code: GribErrorCode, message: string) {
    super(message);
    this.name = 'GribError';
    this.code = code;
  }
}

/** Grid definition template 3.0 (regular latitude/longitude), in degrees. */
export interface GribGrid {
  ni: number;
  nj: number;
  /** First grid point. Rows run north to south when scanMode is 0. */
  la1: number;
  lo1: number;
  la2: number;
  lo2: number;
  di: number;
  dj: number;
  /** Flag table 3.4; only 0 (i east, j south, rows consecutive) is accepted. */
  scanMode: number;
  /** Code table 3.2 (6 = sphere of radius 6,371,229 m for GFS). */
  shapeOfEarth: number;
}

/** Discipline (code table 0.0), parameter category and number (table 4.2). */
export interface GribParameter {
  discipline: number;
  category: number;
  number: number;
}

export interface GribPacking {
  /** Data representation template: 3 (complex, spatial differencing) or 40 (JPEG 2000). */
  template: 3 | 40;
  /** Number of packed values (section 5); equals the grid points when there is no bitmap. */
  packedCount: number;
  /** R, the IEEE float reference value (may be negative). */
  reference: number;
  /** E, the binary scale factor. */
  binaryScale: number;
  /** D, the decimal scale factor. */
  decimalScale: number;
  bitsPerValue: number;
}

export interface GribHeader {
  parameter: GribParameter;
  /** Section 1 reference time (the model cycle), ms since the epoch, UTC. */
  refTime: number;
  /** Product template 4.0 forecast time, in hours. */
  forecastHours: number;
  /** refTime + forecastHours. */
  validTime: number;
  /** First fixed surface (code table 4.5) and its value after scaling. */
  surface: { type: number; value: number };
  grid: GribGrid;
  /** Grid points (section 3), ni * nj. */
  points: number;
  packing: GribPacking;
  /** True when section 6 carries a bitmap (indicator 0). */
  bitmap: boolean;
}

export interface GribField extends GribHeader {
  /** One value per grid point in scan order; NaN where the bitmap masks it. */
  values: Float32Array;
  /** Number of NaN (masked) points. */
  missingCount: number;
}

/** What the caller asked for; anything that differs is refused. */
export interface GribExpect {
  /** The grid header to accept (longitudes compare modulo 360). */
  grid: { ni: number; nj: number; la1: number; lo1: number; la2?: number; lo2?: number; di?: number; dj?: number };
  surface?: { type: number; value: number };
  parameter?: GribParameter;
  /** Reference time (cycle), ms since the epoch, UTC. */
  refTime?: number;
  forecastHours?: number;
  /** Data representation template. */
  packing?: 3 | 40;
  bitmap?: boolean;
}

/** Largest grid accepted (a 0.25 degree global grid is 1,038,240 points). */
export const GRIB_MAX_POINTS = 1 << 22;

const TEMPLATE_NAMES: Record<string, string> = {
  '3.1': 'rotated latitude/longitude',
  '3.10': 'Mercator',
  '3.20': 'polar stereographic',
  '3.30': 'Lambert conformal',
  '3.40': 'Gaussian latitude/longitude',
  '5.0': 'simple packing',
  '5.1': 'matrix packing',
  '5.2': 'complex packing without spatial differencing',
  '5.4': 'IEEE floating point',
  '5.41': 'PNG',
  '5.42': 'CCSDS',
  '5.50': 'spectral simple packing',
  '5.61': 'simple packing with logarithm pre-processing',
  '5.200': 'run length packing'
};

const fail = (code: GribErrorCode, message: string): never => {
  throw new GribError(code, `GRIB2: ${message}`);
};

const unsupportedTemplate = (id: string): never => {
  const name = TEMPLATE_NAMES[id];
  return fail('unsupported-template', `template ${id}${name ? ` (${name})` : ''} is not supported`);
};

const u8 = (b: Uint8Array, o: number): number => b[o] as number;
const u16 = (b: Uint8Array, o: number): number => (u8(b, o) << 8) | u8(b, o + 1);
const u32 = (b: Uint8Array, o: number): number =>
  ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;
// GRIB2 signed integers are sign and magnitude, not two's complement.
const s16 = (b: Uint8Array, o: number): number => {
  const v = u16(b, o);
  return v & 0x8000 ? -(v & 0x7fff) : v;
};
const s32 = (b: Uint8Array, o: number): number => {
  const v = u32(b, o);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
};
const f32 = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);

const MISSING32 = 0xffffffff;

/** Minimum section lengths before any field of the template is read. */
const MIN_LENGTH: Record<number, number> = { 1: 21, 3: 72, 4: 34, 6: 6, 7: 5 };

interface Sections {
  /** Section 0 octet 7: the discipline (code table 0.0). */
  discipline: number;
  s1: Uint8Array;
  s3: Uint8Array;
  s4: Uint8Array;
  s5: Uint8Array;
  s6: Uint8Array;
  s7: Uint8Array;
}

function splitSections(b: Uint8Array): Sections {
  if (b.length < 16 || u32(b, 0) !== 0x47524942) fail('not-grib2', 'no GRIB indicator');
  if (u8(b, 7) !== 2) fail('not-grib2', `edition ${u8(b, 7)} (2 is supported)`);
  if (u32(b, 8) !== 0 || u32(b, 12) !== b.length) {
    fail('length-mismatch', `section 0 gives ${u32(b, 8) * 2 ** 32 + u32(b, 12)} bytes; ${b.length} were read`);
  }
  if (b.length < 20 || u32(b, b.length - 4) !== 0x37373737) fail('no-end-marker', 'the message does not end with 7777');
  const found: Partial<Record<number, Uint8Array>> = {};
  let previous = 0;
  for (let i = 16; i < b.length - 4; ) {
    if (i + 5 > b.length - 4) fail('section-bounds', `a section header at ${i} runs into 7777`);
    const len = u32(b, i);
    const n = u8(b, i + 4);
    if (len < 5 || i + len > b.length - 4) fail('section-bounds', `section ${n} at ${i} has length ${len}`);
    if (n < 1 || n > 7) fail('section-order', `section number ${n}`);
    // One field per message: each section once, in order (2 is optional).
    if (n <= previous) fail('section-order', `section ${n} after section ${previous} (one field per message is supported)`);
    const min = MIN_LENGTH[n] ?? 5;
    if (len < min) fail('section-bounds', `section ${n} is ${len} bytes; at least ${min} are needed`);
    found[n] = b.subarray(i, i + len);
    previous = n;
    i += len;
  }
  const { 1: s1, 3: s3, 4: s4, 5: s5, 6: s6, 7: s7 } = found;
  if (!s1 || !s3 || !s4 || !s5 || !s6 || !s7) return fail('section-order', 'a required section (1, 3, 4, 5, 6 or 7) is missing');
  return { discipline: u8(b, 6), s1, s3, s4, s5, s6, s7 };
}

function parseHeader(sec: Sections): GribHeader {
  const { s1, s3, s4, s5, s6 } = sec;

  // Section 1: reference time.
  const month = u8(s1, 14);
  const day = u8(s1, 15);
  if (month < 1 || month > 12 || day < 1 || day > 31 || u8(s1, 16) > 23 || u8(s1, 17) > 59 || u8(s1, 18) > 60) {
    fail('section-bounds', 'section 1 reference time is not a date');
  }
  const refTime = Date.UTC(u16(s1, 12), month - 1, day, u8(s1, 16), u8(s1, 17), u8(s1, 18));

  // Section 3: grid definition template 3.0 only.
  if (u8(s3, 5) !== 0) fail('unsupported-feature', `grid definition source ${u8(s3, 5)}`);
  if (u8(s3, 10) !== 0) fail('unsupported-feature', 'an optional list of points per row');
  const gridTemplate = u16(s3, 12);
  if (gridTemplate !== 0) unsupportedTemplate(`3.${gridTemplate}`);
  if (u8(s3, 14) !== 6) fail('unsupported-feature', `earth shape ${u8(s3, 14)} (6 is supported)`);
  // Flag table 3.3: both increments supplied, earth-relative components.
  if (u8(s3, 54) !== 48) fail('unsupported-feature', `resolution and component flags ${u8(s3, 54)}`);
  const points = u32(s3, 6);
  const ni = u32(s3, 30);
  const nj = u32(s3, 34);
  if (ni === MISSING32 || nj === MISSING32 || ni === 0 || nj === 0) fail('unsupported-feature', 'a quasi-regular grid');
  if (ni * nj !== points) fail('size', `section 3 gives ${points} points for a ${ni} x ${nj} grid`);
  if (points > GRIB_MAX_POINTS) fail('size', `${points} grid points (at most ${GRIB_MAX_POINTS})`);
  const basicAngle = u32(s3, 38);
  const subdivisions = u32(s3, 42);
  if ((basicAngle !== 0 && basicAngle !== MISSING32) || (subdivisions !== 0 && subdivisions !== MISSING32)) {
    fail('unsupported-feature', 'a basic angle other than micro-degrees');
  }
  const scanMode = u8(s3, 71);
  if (scanMode !== 0) fail('unsupported-feature', `scanning mode 0x${scanMode.toString(16)}`);
  const grid: GribGrid = {
    ni,
    nj,
    la1: s32(s3, 46) / 1e6,
    lo1: s32(s3, 50) / 1e6,
    la2: s32(s3, 55) / 1e6,
    lo2: s32(s3, 59) / 1e6,
    di: u32(s3, 63) / 1e6,
    dj: u32(s3, 67) / 1e6,
    scanMode,
    shapeOfEarth: u8(s3, 14)
  };

  // Section 4: product definition template 4.0 only, forecast time in hours.
  if (u16(s4, 5) !== 0) fail('unsupported-feature', 'coordinate values after the product template');
  const productTemplate = u16(s4, 7);
  if (productTemplate !== 0) unsupportedTemplate(`4.${productTemplate}`);
  if (u8(s4, 28) !== 255) fail('unsupported-feature', 'a layer between two fixed surfaces');
  if (u8(s4, 17) !== 1) fail('unsupported-feature', `time unit indicator ${u8(s4, 17)} in section 4 (1 = hour is supported)`);
  const forecastHours = u32(s4, 18);
  const surfaceScale = u8(s4, 23);
  const surface = {
    type: u8(s4, 22),
    value:
      surfaceScale === 255 || u32(s4, 24) === MISSING32
        ? Number.NaN
        : s32(s4, 24) / 10 ** (surfaceScale & 0x80 ? -(surfaceScale & 0x7f) : surfaceScale)
  };

  // Section 5: data representation template 5.3 or 5.40.
  if (s5.length < 11) fail('section-bounds', 'section 5 is too short');
  const packingTemplate = u16(s5, 9);
  if (packingTemplate !== 3 && packingTemplate !== 40) unsupportedTemplate(`5.${packingTemplate}`);
  const need = packingTemplate === 3 ? 49 : 23;
  if (s5.length < need) fail('section-bounds', `section 5 is ${s5.length} bytes; template 5.${packingTemplate} needs ${need}`);
  if (u8(s5, 20) !== 0) fail('unsupported-feature', `original field type ${u8(s5, 20)} (0 = floating point is supported)`);
  const packing: GribPacking = {
    template: packingTemplate as 3 | 40,
    packedCount: u32(s5, 5),
    reference: f32(s5, 11),
    binaryScale: s16(s5, 15),
    decimalScale: s16(s5, 17),
    bitsPerValue: u8(s5, 19)
  };
  if (!Number.isFinite(packing.reference)) fail('data', 'the packing reference is not finite');
  for (const scale of [2 ** packing.binaryScale, 10 ** -packing.decimalScale]) {
    if (!Number.isFinite(scale) || scale === 0) fail('data', 'the packing scale overflows or underflows');
  }
  if (packing.packedCount > points) fail('size', `${packing.packedCount} packed values for ${points} grid points`);
  if (packing.bitsPerValue > 31) fail('unsupported-feature', `${packing.bitsPerValue} bits per value`);

  // Section 6: a bitmap (0) or none (255); predefined or reused bitmaps are refused.
  const indicator = u8(s6, 5);
  if (indicator !== 0 && indicator !== 255) fail('unsupported-feature', `bitmap indicator ${indicator}`);
  if (indicator === 0 && s6.length < 6 + Math.ceil(points / 8)) fail('section-bounds', 'the bitmap is shorter than the grid');

  return {
    parameter: { discipline: sec.discipline, category: u8(s4, 9), number: u8(s4, 10) },
    refTime,
    forecastHours,
    validTime: refTime + forecastHours * 3_600_000,
    surface,
    grid,
    points,
    packing,
    bitmap: indicator === 0
  };
}

/**
 * Parse and check sections 0 to 6 without unpacking any data: the grid,
 * parameter, clocks and packing of one message. Throws GribError on any
 * structural fault or unsupported template.
 */
export function readGrib2Header(bytes: Uint8Array): GribHeader {
  return parseHeader(splitSections(bytes));
}

const sameLongitude = (a: number, b: number): boolean => {
  const d = (((Math.round(a * 1e6) - Math.round(b * 1e6)) % 360e6) + 360e6) % 360e6;
  return d === 0;
};

function checkExpect(h: GribHeader, expect: GribExpect): void {
  const g = expect.grid;
  if (h.grid.ni !== g.ni || h.grid.nj !== g.nj) {
    fail('expectation', `grid ${h.grid.ni} x ${h.grid.nj}, expected ${g.ni} x ${g.nj}`);
  }
  if (Math.round(h.grid.la1 * 1e6) !== Math.round(g.la1 * 1e6) || !sameLongitude(h.grid.lo1, g.lo1)) {
    fail('expectation', `first grid point (${h.grid.la1}, ${h.grid.lo1}), expected (${g.la1}, ${g.lo1})`);
  }
  for (const key of ['la2', 'di', 'dj'] as const) {
    if (g[key] !== undefined && Math.round(h.grid[key] * 1e6) !== Math.round(g[key] * 1e6)) {
      fail('expectation', `grid ${key} ${h.grid[key]}, expected ${g[key]}`);
    }
  }
  if (g.lo2 !== undefined && !sameLongitude(h.grid.lo2, g.lo2)) {
    fail('expectation', `last longitude ${h.grid.lo2}, expected ${g.lo2}`);
  }
  if (expect.surface && (h.surface.type !== expect.surface.type || h.surface.value !== expect.surface.value)) {
    fail('expectation', `surface ${h.surface.type}:${h.surface.value}, expected ${expect.surface.type}:${expect.surface.value}`);
  }
  const p = expect.parameter;
  if (p && (h.parameter.discipline !== p.discipline || h.parameter.category !== p.category || h.parameter.number !== p.number)) {
    const got = `${h.parameter.discipline}.${h.parameter.category}.${h.parameter.number}`;
    fail('expectation', `parameter ${got}, expected ${p.discipline}.${p.category}.${p.number}`);
  }
  if (expect.refTime !== undefined && h.refTime !== expect.refTime) {
    fail('expectation', `reference time ${new Date(h.refTime).toISOString()}, expected ${new Date(expect.refTime).toISOString()}`);
  }
  if (expect.forecastHours !== undefined && h.forecastHours !== expect.forecastHours) {
    fail('expectation', `lead time ${h.forecastHours} h, expected ${expect.forecastHours} h`);
  }
  if (expect.packing !== undefined && h.packing.template !== expect.packing) {
    fail('expectation', `template 5.${h.packing.template}, expected 5.${expect.packing}`);
  }
  if (expect.bitmap !== undefined && h.bitmap !== expect.bitmap) {
    fail('expectation', h.bitmap ? 'a bitmap where none was expected' : 'no bitmap where one was expected');
  }
}

// ---------------------------------------------------------------------------
// Template 5.3: complex packing with spatial differencing (template 7.3)
// ---------------------------------------------------------------------------

interface BitReader {
  read(n: number): number;
  align(): void;
  /** Bits consumed, counted from the first byte of `b`. */
  position(): number;
}

function bitReader(b: Uint8Array, start: number): BitReader {
  let byte = start;
  let bit = 0;
  return {
    position(): number {
      return byte * 8 + bit;
    },
    read(nIn: number): number {
      let n = nIn;
      let v = 0;
      while (n > 0) {
        if (byte >= b.length) fail('data', 'section 7 ends before its packed values');
        const avail = 8 - bit;
        const take = avail < n ? avail : n;
        v = v * 2 ** take + ((u8(b, byte) >> (avail - take)) & ((1 << take) - 1));
        bit += take;
        n -= take;
        if (bit === 8) {
          bit = 0;
          byte++;
        }
      }
      return v;
    },
    align(): void {
      if (bit) {
        bit = 0;
        byte++;
      }
    }
  };
}

function unpackComplex(s5: Uint8Array, s7: Uint8Array, n: number, nbits: number): Int32Array {
  if (u8(s5, 21) !== 1) fail('unsupported-feature', `group splitting method ${u8(s5, 21)}`);
  if (u8(s5, 22) !== 0) fail('unsupported-feature', `missing value management ${u8(s5, 22)}`);
  const ng = u32(s5, 31);
  const widthRef = u8(s5, 35);
  const widthBits = u8(s5, 36);
  const lengthRef = u32(s5, 37);
  const lengthInc = u8(s5, 41);
  const lengthLast = u32(s5, 42);
  const lengthBits = u8(s5, 46);
  const order = u8(s5, 47);
  const extra = u8(s5, 48);
  if (order !== 1 && order !== 2) fail('unsupported-feature', `spatial differencing order ${order}`);
  if (extra < 1 || extra > 4) fail('unsupported-feature', `${extra} octets of extra descriptors`);
  if (ng < 1 || ng > n) fail('data', `${ng} groups for ${n} values`);
  if (widthBits > 31 || lengthBits > 31) fail('data', 'group descriptor widths');
  // A lower bound on the bits the descriptors need, checked before allocation.
  const descriptorBits = 8 * extra * (order + 1) + ng * (nbits + widthBits + lengthBits);
  if (descriptorBits > 8 * (s7.length - 5)) fail('data', 'section 7 is shorter than its group descriptors');

  const br = bitReader(s7, 5);
  const signMagnitude = (): number => {
    const v = br.read(8 * extra);
    const top = 2 ** (8 * extra - 1);
    return v >= top ? -(v - top) : v;
  };
  const first = signMagnitude();
  const second = order === 2 ? signMagnitude() : 0;
  const minimum = signMagnitude();

  const groupRef = new Int32Array(ng);
  const groupWidth = new Int32Array(ng);
  const groupLength = new Int32Array(ng);
  for (let g = 0; g < ng; g++) groupRef[g] = br.read(nbits);
  br.align();
  for (let g = 0; g < ng; g++) {
    const w = br.read(widthBits) + widthRef;
    if (w > 31) fail('data', `group width ${w}`);
    groupWidth[g] = w;
  }
  br.align();
  for (let g = 0; g < ng; g++) groupLength[g] = br.read(lengthBits) * lengthInc + lengthRef;
  br.align();
  groupLength[ng - 1] = lengthLast;

  const v = new Int32Array(n);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    const len = groupLength[g] as number;
    if (len < 0 || k + len > n) fail('data', 'group lengths exceed the packed values');
    const ref = groupRef[g] as number;
    const w = groupWidth[g] as number;
    if (w === 0) {
      v.fill(ref, k, k + len);
      k += len;
    } else {
      for (let j = 0; j < len; j++) v[k++] = ref + br.read(w);
    }
  }
  if (k !== n) fail('data', `groups hold ${k} values; section 5 gives ${n}`);
  // The packed values end in section 7's last byte; only that byte's padding bits may follow.
  const leftover = 8 * s7.length - br.position();
  if (leftover >= 8) {
    fail('data', `structurally invalid: section 7 holds ${Math.floor(leftover / 8)} byte(s) after its packed values`);
  }

  // Undo the spatial differencing (regulation 92.9.4, template 7.3).
  if (order === 1) {
    v[0] = first;
    for (let i = 1; i < n; i++) v[i] = (v[i] as number) + minimum + (v[i - 1] as number);
  } else {
    v[0] = first;
    if (n > 1) v[1] = second;
    for (let i = 2; i < n; i++) v[i] = (v[i] as number) + minimum + 2 * (v[i - 1] as number) - (v[i - 2] as number);
  }
  return v;
}

/**
 * Decode one GRIB2 message (the bytes of one Range GET) into a field of
 * Float32 values, NaN where masked. The message must match `expect`.
 */
export function decodeGrib2(bytes: Uint8Array, expect: GribExpect): GribField {
  const sec = splitSections(bytes);
  const header = parseHeader(sec);
  checkExpect(header, expect);

  const { packing, points } = header;
  const n = packing.packedCount;
  if (!header.bitmap && n !== points) {
    fail('bitmap', `${n} packed values for ${points} grid points with no bitmap`);
  }

  let ints: Int32Array;
  if (packing.bitsPerValue === 0) {
    ints = new Int32Array(n);
  } else if (packing.template === 3) {
    ints = unpackComplex(sec.s5, sec.s7, n, packing.bitsPerValue);
  } else {
    if (u8(sec.s5, 21) !== 0) fail('unsupported-feature', 'lossy JPEG 2000 compression');
    try {
      ints = decodeJpeg2000(sec.s7.subarray(5), n).data;
    } catch (e) {
      if (e instanceof JpxError) return fail('jpeg2000', `${e.message} (${e.code})`);
      throw e;
    }
  }

  const R = packing.reference;
  const scale = 2 ** packing.binaryScale;
  const decimal = 10 ** -packing.decimalScale;
  const values = new Float32Array(points);
  let missingCount = 0;
  if (!header.bitmap) {
    for (let k = 0; k < points; k++) {
      values[k] = (R + (ints[k] as number) * scale) * decimal;
      if (!Number.isFinite(values[k])) fail('data', `nonfinite decoded value at point ${k}`);
    }
  } else {
    const map = sec.s6;
    let j = 0;
    for (let k = 0; k < points; k++) {
      if ((u8(map, 6 + (k >> 3)) >> (7 - (k & 7))) & 1) {
        if (j >= n) fail('bitmap', `the bitmap marks more than the ${n} packed values`);
        values[k] = (R + (ints[j++] as number) * scale) * decimal;
        if (!Number.isFinite(values[k])) fail('data', `nonfinite decoded value at point ${k}`);
      } else {
        values[k] = Number.NaN;
        missingCount++;
      }
    }
    if (j !== n) fail('bitmap', `the bitmap marks ${j} points; section 5 packs ${n}`);
  }
  return { ...header, values, missingCount };
}
