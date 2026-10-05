/**
 * DDM's own JPEG 2000 (ITU-T T.800, Part 1) decoder for exactly the subset
 * NCEP's GFS-Wave GRIB2 messages carry under data representation template
 * 5.40 (ENSO-FLOW-PLAN section 2.2; B-grib.md section 2.2): a raw codestream
 * written by JasPer with one unsigned component, one tile, one quality
 * layer, the reversible 5/3 wavelet, no quantization, code-block style 0, no
 * SOP or EPH markers, and an LRCP (or equivalent) progression. The image is
 * one row of the packed sea points, up to 568,995 samples wide, so widths
 * are 32-bit throughout.
 *
 * Written from T.800 (Annex A codestream, B packets and tag trees, C the MQ
 * decoder, D EBCOT tier-1, F the inverse 5/3 transform). It copies no code
 * from pdf.js, OpenJPEG, JasPer or any other decoder.
 *
 * Every codestream feature outside the subset is refused with a JpxError
 * that names it; a malformed codestream throws JpxError rather than looping
 * or allocating without bound (ENSO-FLOW-PLAN section 2.3, hardening).
 */

export type JpxErrorCode = 'truncated' | 'unsupported' | 'size' | 'corrupt';

export class JpxError extends Error {
  readonly code: JpxErrorCode;
  constructor(code: JpxErrorCode, message: string) {
    super(message);
    this.name = 'JpxError';
    this.code = code;
  }
}

export interface JpxImage {
  width: number;
  height: number;
  /** One sample per pixel, row-major, after the DC level shift. */
  data: Int32Array;
}

/** Upper bounds on structure counts, far above what any GFS-Wave grid needs. */
export const JPX_MAX_CODE_BLOCKS = 1 << 17;
export const JPX_MAX_PRECINCTS = 1 << 16;
const MAX_LEVELS = 15;
const MAX_PRECISION = 24;
const MAX_PLANES = 30;

const fail = (code: JpxErrorCode, message: string): never => {
  throw new JpxError(code, `JPEG 2000: ${message}`);
};

function u16(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) fail('truncated', 'codestream ends inside a marker segment');
  return ((b[o] as number) << 8) | (b[o + 1] as number);
}

function u32(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) fail('truncated', 'codestream ends inside a marker segment');
  return (
    (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0
  );
}

/** A marker segment's parameters (after the marker and its length field). */
function segment(cs: Uint8Array, p: number, min: number): Uint8Array {
  const len = u16(cs, p + 2);
  if (len < 2 + min || p + 2 + len > cs.length) fail('truncated', `marker segment at ${p} overruns the codestream`);
  return cs.subarray(p + 4, p + 2 + len);
}

// ---------------------------------------------------------------------------
// MQ arithmetic decoder (T.800 Annex C)
// ---------------------------------------------------------------------------

// Table C.2: Qe, NMPS, NLPS and SWITCH for each of the 47 states.
const QE = [
  0x5601, 0x3401, 0x1801, 0x0ac1, 0x0521, 0x0221, 0x5601, 0x5401, 0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601,
  0x5601, 0x5401, 0x5101, 0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401, 0x2201, 0x1c01, 0x1801, 0x1601, 0x1401,
  0x1201, 0x1101, 0x0ac1, 0x09c1, 0x08a1, 0x0521, 0x0441, 0x02a1, 0x0221, 0x0141, 0x0111, 0x0085, 0x0049, 0x0025,
  0x0015, 0x0009, 0x0005, 0x0001, 0x5601
];
const NMPS = [
  1, 2, 3, 4, 5, 38, 7, 8, 9, 10, 11, 12, 13, 29, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 45, 46
];
const NLPS = [
  1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18, 20, 21, 14, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46
];
const SWITCH = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1];

type MqDecode = (cx: number) => number;

function mqDecoder(d: Uint8Array): MqDecode {
  const state = new Uint8Array(19);
  const mps = new Uint8Array(19);
  // Initial states (T.800 Table D.7): uniform 46, run-length 3, all-zero 4.
  state[0] = 4;
  state[17] = 3;
  state[18] = 46;
  let bp = 0;
  let c = 0;
  let a = 0;
  let ct = 0;
  // Past the end the coder reads 0xFF, as T.800 C.3.4 specifies.
  const at = (i: number): number => (i < d.length ? (d[i] as number) : 0xff);
  const byteIn = (): void => {
    if (at(bp) === 0xff) {
      if (at(bp + 1) > 0x8f) {
        c += 0xff00;
        ct = 8;
      } else {
        bp++;
        c += at(bp) << 9;
        ct = 7;
      }
    } else {
      bp++;
      c += at(bp) << 8;
      ct = 8;
    }
  };
  c = at(0) << 16;
  byteIn();
  c = (c << 7) >>> 0;
  ct -= 7;
  a = 0x8000;
  return (cx: number): number => {
    const s = state[cx] as number;
    const qe = QE[s] as number;
    let bit: number;
    a -= qe;
    if (c >>> 16 < qe) {
      if (a < qe) {
        a = qe;
        bit = mps[cx] as number;
        state[cx] = NMPS[s] as number;
      } else {
        a = qe;
        bit = 1 - (mps[cx] as number);
        if (SWITCH[s]) mps[cx] = 1 - (mps[cx] as number);
        state[cx] = NLPS[s] as number;
      }
    } else {
      c = (c - (qe << 16)) >>> 0;
      if (a & 0x8000) return mps[cx] as number;
      if (a < qe) {
        bit = 1 - (mps[cx] as number);
        if (SWITCH[s]) mps[cx] = 1 - (mps[cx] as number);
        state[cx] = NLPS[s] as number;
      } else {
        bit = mps[cx] as number;
        state[cx] = NMPS[s] as number;
      }
    }
    do {
      if (ct === 0) byteIn();
      a = (a << 1) & 0xffff;
      c = (c << 1) >>> 0;
      ct--;
    } while ((a & 0x8000) === 0);
    return bit;
  };
}

// ---------------------------------------------------------------------------
// EBCOT tier-1 (T.800 Annex D), code-block style 0
// ---------------------------------------------------------------------------

const LL = 0;
const HL = 1;
const LH = 2;
const HH = 3;

/** Zero-coding context (T.800 Table D.1) from neighbour significance counts. */
function zeroContext(hIn: number, vIn: number, d: number, band: number): number {
  let h = hIn;
  let v = vIn;
  if (band === HH) {
    const hv = h + v;
    if (d >= 3) return 8;
    if (d === 2) return hv >= 1 ? 7 : 6;
    if (d === 1) return hv >= 2 ? 5 : hv === 1 ? 4 : 3;
    return hv >= 2 ? 2 : hv;
  }
  if (band === HL) {
    const t = h;
    h = v;
    v = t;
  }
  if (h === 2) return 8;
  if (h === 1) return v >= 1 ? 7 : d >= 1 ? 6 : 5;
  if (v >= 1) return v === 2 ? 4 : 3;
  return d >= 2 ? 2 : d;
}

// Zero-coding context tables by band, indexed (h * 3 + v) * 5 + d.
const ZC: Uint8Array[] = [LL, HL, LH, HH].map((band) => {
  const t = new Uint8Array(45);
  for (let h = 0; h < 3; h++) {
    for (let v = 0; v < 3; v++) for (let d = 0; d < 5; d++) t[(h * 3 + v) * 5 + d] = zeroContext(h, v, d, band);
  }
  return t;
});

/** Decode one code-block's passes; returns signed magnitudes, row-major. */
function decodeBlock(w: number, h: number, band: number, planes: number, passes: number, data: Uint8Array): Int32Array {
  const mag = new Int32Array(w * h);
  if (passes === 0) return mag;
  const W = w + 2;
  const N = W * (h + 2);
  const sig = new Uint8Array(N);
  const neg = new Uint8Array(N);
  const vis = new Uint8Array(N);
  const refined = new Uint8Array(N);
  const hc = new Uint8Array(N);
  const vc = new Uint8Array(N);
  const dc = new Uint8Array(N);
  const zc = ZC[band] as Uint8Array;
  const dec = mqDecoder(data);
  const sgn = (q: number): number => (sig[q] ? (neg[q] ? -1 : 1) : 0);
  const becomeSignificant = (p: number, i: number, bp: number): void => {
    let H = sgn(p - 1) + sgn(p + 1);
    let V = sgn(p - W) + sgn(p + W);
    H = H > 0 ? 1 : H < 0 ? -1 : 0;
    V = V > 0 ? 1 : V < 0 ? -1 : 0;
    let ctx: number;
    let xr: number;
    // Sign coding (T.800 Table D.3).
    if (H === 0) {
      ctx = V === 0 ? 9 : 10;
      xr = V < 0 ? 1 : 0;
    } else {
      ctx = 12 + (V === 0 ? 0 : H === V ? 1 : -1);
      xr = H < 0 ? 1 : 0;
    }
    neg[p] = dec(ctx) ^ xr;
    sig[p] = 1;
    mag[i] = 1 << bp;
    hc[p - 1] = (hc[p - 1] as number) + 1;
    hc[p + 1] = (hc[p + 1] as number) + 1;
    vc[p - W] = (vc[p - W] as number) + 1;
    vc[p + W] = (vc[p + W] as number) + 1;
    dc[p - W - 1] = (dc[p - W - 1] as number) + 1;
    dc[p - W + 1] = (dc[p - W + 1] as number) + 1;
    dc[p + W - 1] = (dc[p + W - 1] as number) + 1;
    dc[p + W + 1] = (dc[p + W + 1] as number) + 1;
  };
  let bp = planes - 1;
  // 2 = cleanup, 0 = significance propagation, 1 = magnitude refinement.
  let type = 2;
  for (let k = 0; k < passes; k++) {
    for (let y0 = 0; y0 < h; y0 += 4) {
      const y1 = y0 + 4 < h ? y0 + 4 : h;
      const full = y1 - y0 === 4;
      for (let x = 0; x < w; x++) {
        let y = y0;
        if (type === 2 && full) {
          const p0 = (y0 + 1) * W + x + 1;
          let runLength = true;
          for (let j = 0, q = p0; j < 4; j++, q += W) {
            if (sig[q] || vis[q] || hc[q] || vc[q] || dc[q]) {
              runLength = false;
              break;
            }
          }
          if (runLength) {
            if (!dec(17)) continue;
            y = y0 + ((dec(18) << 1) | dec(18));
            becomeSignificant((y + 1) * W + x + 1, y * w + x, bp);
            y++;
          }
        }
        for (; y < y1; y++) {
          const p = (y + 1) * W + x + 1;
          if (type === 0) {
            if (sig[p]) continue;
            if (!(hc[p] || vc[p] || dc[p])) continue;
            vis[p] = 1;
            if (dec(zc[((hc[p] as number) * 3 + (vc[p] as number)) * 5 + (dc[p] as number)] as number)) {
              becomeSignificant(p, y * w + x, bp);
            }
          } else if (type === 1) {
            if (!sig[p] || vis[p]) continue;
            let ctx = 16;
            if (!refined[p]) {
              ctx = hc[p] || vc[p] || dc[p] ? 15 : 14;
              refined[p] = 1;
            }
            if (dec(ctx)) mag[y * w + x] = (mag[y * w + x] as number) | (1 << bp);
          } else {
            if (sig[p] || vis[p]) continue;
            if (dec(zc[((hc[p] as number) * 3 + (vc[p] as number)) * 5 + (dc[p] as number)] as number)) {
              becomeSignificant(p, y * w + x, bp);
            }
          }
        }
      }
    }
    if (type === 2) {
      vis.fill(0);
      bp--;
      type = 0;
    } else {
      type++;
    }
  }
  // Reconstruct at the midpoint of the remaining uncertainty interval.
  const last = type === 0 ? bp + 1 : bp;
  if (last > 0) {
    const half = 1 << (last - 1);
    for (let i = 0; i < mag.length; i++) if (mag[i]) mag[i] = (mag[i] as number) + half;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (neg[(y + 1) * W + x + 1]) mag[y * w + x] = -(mag[y * w + x] as number);
  }
  return mag;
}

// ---------------------------------------------------------------------------
// Packet headers (T.800 Annex B)
// ---------------------------------------------------------------------------

interface BitSource {
  bit(): number;
  bits(n: number): number;
  /** Byte position after the header (skipping a stuffed byte). */
  align(): number;
}

/** Packet-header bit reader with bit stuffing; reading past the end throws. */
function headerReader(b: Uint8Array, start: number): BitSource {
  let pos = start;
  let buf = 0;
  let ct = 0;
  let last = 0;
  const reader: BitSource = {
    bit(): number {
      if (ct === 0) {
        if (pos >= b.length) fail('truncated', 'packet header runs past the tile data');
        const stuffed = last === 0xff;
        buf = b[pos] as number;
        last = buf;
        pos++;
        ct = stuffed ? 7 : 8;
      }
      ct--;
      return (buf >> ct) & 1;
    },
    bits(n: number): number {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + reader.bit();
      return v;
    },
    align(): number {
      ct = 0;
      if (last === 0xff) {
        last = 0;
        pos++;
      }
      return pos;
    }
  };
  return reader;
}

interface TagTree {
  /** T.800 B.10.2: true when the leaf's value is below `threshold`. */
  decode(rd: BitSource, x: number, y: number, threshold: number): boolean;
  value(x: number, y: number): number;
}

function tagTree(width: number, height: number): TagTree {
  const levels: { w: number; val: Float64Array; low: Int32Array }[] = [];
  let w = width;
  let h = height;
  for (;;) {
    levels.push({ w, val: new Float64Array(w * h).fill(Number.POSITIVE_INFINITY), low: new Int32Array(w * h) });
    if (w * h <= 1) break;
    w = (w + 1) >> 1;
    h = (h + 1) >> 1;
  }
  return {
    decode(rd, x, y, threshold) {
      let low = 0;
      let leaf = 0;
      for (let l = levels.length - 1; l >= 0; l--) {
        const lv = levels[l] as (typeof levels)[number];
        const idx = (y >> l) * lv.w + (x >> l);
        if (low > (lv.low[idx] as number)) lv.low[idx] = low;
        else low = lv.low[idx] as number;
        // Bounded by `threshold`: each pass either fixes the value or raises low.
        while (low < threshold && low < (lv.val[idx] as number)) {
          if (rd.bit()) lv.val[idx] = low;
          else low++;
        }
        lv.low[idx] = low;
        leaf = l === 0 ? (lv.val[idx] as number) : leaf;
      }
      return leaf < threshold;
    },
    value(x, y) {
      const lv = levels[0] as (typeof levels)[number];
      return lv.val[y * lv.w + x] as number;
    }
  };
}

// ---------------------------------------------------------------------------
// Geometry: resolutions, sub-bands, precincts and code-blocks
// ---------------------------------------------------------------------------

interface CodeBlock {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  lblock: number;
  seen: boolean;
  zeroPlanes: number;
  passes: number;
  length: number;
  data: Uint8Array | null;
}

interface Precinct {
  blocks: CodeBlock[];
  cw: number;
  inclusion: TagTree | null;
  zero: TagTree | null;
}

interface Band {
  type: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  planes: number;
  coef: Int32Array;
  precincts: Precinct[];
}

interface Resolution {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  npx: number;
  npy: number;
  bands: Band[];
}

const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);

/**
 * Decode a raw JPEG 2000 codestream of one unsigned component.
 * `expectedSamples` is the number of samples the caller will accept
 * (the GRIB packed-point count); a codestream whose Xsiz x Ysiz differs is
 * refused before anything of that size is allocated.
 */
export function decodeJpeg2000(cs: Uint8Array, expectedSamples: number): JpxImage {
  if (cs.length < 2 || u16(cs, 0) !== 0xff4f) fail('corrupt', 'no SOC marker');
  let p = 2;
  let siz: Uint8Array | null = null;
  let cod: Uint8Array | null = null;
  let qcd: Uint8Array | null = null;
  // Main header: SIZ, COD, QCD, plus COM, TLM and PLM, which carry nothing needed.
  for (;;) {
    const mk = u16(cs, p);
    if (mk === 0xff90) break;
    if (mk === 0xff51) siz = segment(cs, p, 38);
    else if (mk === 0xff52) cod = segment(cs, p, 10);
    else if (mk === 0xff5c) qcd = segment(cs, p, 1);
    else if (mk === 0xff64 || mk === 0xff55 || mk === 0xff57) segment(cs, p, 0);
    else fail('unsupported', `main-header marker 0x${mk.toString(16)}`);
    p += 2 + u16(cs, p + 2);
  }
  if (!siz || !cod || !qcd) return fail('corrupt', 'main header lacks SIZ, COD or QCD');

  // SIZ (T.800 A.5.1)
  const X1 = u32(siz, 2);
  const Y1 = u32(siz, 6);
  const X0 = u32(siz, 10);
  const Y0 = u32(siz, 14);
  if (u16(siz, 34) !== 1) fail('unsupported', `${u16(siz, 34)} components (one is supported)`);
  if (X0 !== 0 || Y0 !== 0) fail('unsupported', 'an image offset');
  // Xsiz x Ysiz must be the packed-point count before any allocation.
  if (X1 * Y1 !== expectedSamples || X1 === 0 || Y1 === 0) {
    fail('size', `Xsiz x Ysiz = ${X1} x ${Y1} does not equal the ${expectedSamples} packed points`);
  }
  if (u32(siz, 26) !== 0 || u32(siz, 30) !== 0 || u32(siz, 18) < X1 || u32(siz, 22) < Y1) {
    fail('unsupported', 'more than one tile');
  }
  const ssiz = siz[36] as number;
  if (ssiz & 0x80) fail('unsupported', 'a signed component');
  if (siz[37] !== 1 || siz[38] !== 1) fail('unsupported', 'component subsampling');
  const precision = (ssiz & 0x7f) + 1;
  if (precision > MAX_PRECISION) fail('unsupported', `${precision}-bit samples`);

  // COD (T.800 A.6.1)
  const scod = cod[0] as number;
  const progression = cod[1] as number;
  const layers = u16(cod, 2);
  const levels = cod[5] as number;
  const xcb = (cod[6] as number) + 2;
  const ycb = (cod[7] as number) + 2;
  if (scod & ~1) fail('unsupported', 'SOP or EPH markers');
  // With one layer and one component, LRCP, RLCP and RPCL visit packets in the same order.
  if (progression > 2) fail('unsupported', `progression order ${progression}`);
  if (layers !== 1) fail('unsupported', `${layers} quality layers`);
  if (cod[4] !== 0) fail('unsupported', 'a multiple component transform');
  if (levels > MAX_LEVELS) fail('unsupported', `${levels} decomposition levels`);
  if (xcb > 10 || ycb > 10 || xcb + ycb > 12) fail('corrupt', 'code-block size');
  if (cod[8] !== 0) fail('unsupported', `code-block style 0x${(cod[8] as number).toString(16)}`);
  if (cod[9] !== 1) fail('unsupported', 'the irreversible 9/7 transform');
  if (scod & 1 && cod.length < 10 + levels + 1) fail('corrupt', 'precinct sizes');

  // QCD (T.800 A.6.4): no quantization, one exponent per sub-band.
  if (((qcd[0] as number) & 0x1f) !== 0) fail('unsupported', 'quantization');
  let guard = (qcd[0] as number) >> 5;
  let exponents = Array.from(qcd.subarray(1), (v) => v >> 3);

  // The tile-parts of the single tile.
  const bodies: Uint8Array[] = [];
  while (p + 2 <= cs.length && u16(cs, p) === 0xff90) {
    const sot = segment(cs, p, 8);
    const start = p;
    if (u16(sot, 0) !== 0) fail('unsupported', 'a tile index other than 0');
    const psot = u32(sot, 2);
    p += 2 + u16(cs, p + 2);
    for (;;) {
      const mk = u16(cs, p);
      if (mk === 0xff93) break;
      const seg = segment(cs, p, 0);
      // JasPer writes a QCC for component 0 in every tile header.
      if (mk === 0xff5d && seg.length >= 2 && seg[0] === 0 && ((seg[1] as number) & 0x1f) === 0) {
        guard = (seg[1] as number) >> 5;
        exponents = Array.from(seg.subarray(2), (v) => v >> 3);
      } else if (mk !== 0xff58 && mk !== 0xff64) {
        fail('unsupported', `tile-header marker 0x${mk.toString(16)}`);
      }
      p += 2 + u16(cs, p + 2);
    }
    const end = psot ? start + psot : cs.length - 2;
    if (end > cs.length || end < p + 2) fail('truncated', 'tile-part length overruns the codestream');
    bodies.push(cs.subarray(p + 2, end));
    p = end;
  }
  if (bodies.length === 0) fail('corrupt', 'no tile-part');
  if (exponents.length !== 3 * levels + 1) fail('corrupt', 'quantization exponents do not match the levels');
  let body = bodies[0] as Uint8Array;
  if (bodies.length > 1) {
    body = new Uint8Array(bodies.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const b of bodies) {
      body.set(b, o);
      o += b.length;
    }
  }

  // Count precincts and code-blocks before allocating any of them.
  let precinctCount = 0;
  let blockCount = 0;
  const plan: { PPx: number; PPy: number; cbw: number; cbh: number; pw: number; ph: number }[] = [];
  for (let r = 0; r <= levels; r++) {
    const sh = 2 ** (levels - r);
    const rx0 = ceilDiv(X0, sh);
    const rx1 = ceilDiv(X1, sh);
    const ry0 = ceilDiv(Y0, sh);
    const ry1 = ceilDiv(Y1, sh);
    const sp = cod[10 + r] as number;
    const PPx = scod & 1 ? sp & 15 : 15;
    const PPy = scod & 1 ? sp >> 4 : 15;
    if (r > 0 && (PPx === 0 || PPy === 0)) fail('corrupt', 'precinct size');
    const px = r ? PPx - 1 : PPx;
    const py = r ? PPy - 1 : PPy;
    const cbw = 2 ** Math.min(xcb, px);
    const cbh = 2 ** Math.min(ycb, py);
    const npx = rx1 > rx0 ? Math.ceil(rx1 / 2 ** PPx) - Math.floor(rx0 / 2 ** PPx) : 0;
    const npy = ry1 > ry0 ? Math.ceil(ry1 / 2 ** PPy) - Math.floor(ry0 / 2 ** PPy) : 0;
    precinctCount += npx * npy;
    const bandsHere = r ? 3 : 1;
    const bw = ceilDiv(rx1 - rx0, r ? 2 : 1);
    const bh = ceilDiv(ry1 - ry0, r ? 2 : 1);
    blockCount += bandsHere * (ceilDiv(bw, cbw) + npx) * (ceilDiv(bh, cbh) + npy);
    plan.push({ PPx, PPy, cbw, cbh, pw: 2 ** px, ph: 2 ** py });
  }
  if (precinctCount > JPX_MAX_PRECINCTS) fail('size', `${precinctCount} precincts`);
  if (blockCount > JPX_MAX_CODE_BLOCKS) fail('size', `about ${blockCount} code-blocks`);

  const res: Resolution[] = [];
  for (let r = 0; r <= levels; r++) {
    const sh = 2 ** (levels - r);
    const { PPx, PPy, cbw, cbh, pw, ph } = plan[r] as (typeof plan)[number];
    const R: Resolution = {
      x0: ceilDiv(X0, sh),
      x1: ceilDiv(X1, sh),
      y0: ceilDiv(Y0, sh),
      y1: ceilDiv(Y1, sh),
      npx: 0,
      npy: 0,
      bands: []
    };
    R.npx = R.x1 > R.x0 ? Math.ceil(R.x1 / 2 ** PPx) - Math.floor(R.x0 / 2 ** PPx) : 0;
    R.npy = R.y1 > R.y0 ? Math.ceil(R.y1 / 2 ** PPy) - Math.floor(R.y0 / 2 ** PPy) : 0;
    const types = r ? [HL, LH, HH] : [LL];
    for (const t of types) {
      const nb = r ? levels - r + 1 : levels;
      const xo = t & 1;
      const yo = t >> 1;
      const s2 = 2 ** nb;
      const h2 = nb > 0 ? 2 ** (nb - 1) : 0;
      const exponent = exponents[r ? 3 * (r - 1) + t : 0] as number;
      const B: Band = {
        type: t,
        x0: ceilDiv(X0 - h2 * xo, s2),
        x1: ceilDiv(X1 - h2 * xo, s2),
        y0: ceilDiv(Y0 - h2 * yo, s2),
        y1: ceilDiv(Y1 - h2 * yo, s2),
        planes: guard + exponent - 1,
        coef: new Int32Array(0),
        precincts: []
      };
      if (B.planes > MAX_PLANES) fail('unsupported', `${B.planes} bit-planes`);
      B.coef = new Int32Array(Math.max(0, B.x1 - B.x0) * Math.max(0, B.y1 - B.y0));
      const bpx0 = Math.floor(R.x0 / 2 ** PPx) * pw;
      const bpy0 = Math.floor(R.y0 / 2 ** PPy) * ph;
      for (let j = 0; j < R.npy; j++) {
        for (let i = 0; i < R.npx; i++) {
          const qx0 = Math.max(B.x0, bpx0 + i * pw);
          const qx1 = Math.min(B.x1, bpx0 + (i + 1) * pw);
          const qy0 = Math.max(B.y0, bpy0 + j * ph);
          const qy1 = Math.min(B.y1, bpy0 + (j + 1) * ph);
          const P: Precinct = { blocks: [], cw: 0, inclusion: null, zero: null };
          if (qx1 > qx0 && qy1 > qy0) {
            const cx0 = Math.floor(qx0 / cbw);
            const cx1 = Math.ceil(qx1 / cbw);
            const cy0 = Math.floor(qy0 / cbh);
            const cy1 = Math.ceil(qy1 / cbh);
            P.cw = cx1 - cx0;
            for (let cy = cy0; cy < cy1; cy++) {
              for (let cx = cx0; cx < cx1; cx++) {
                P.blocks.push({
                  x0: Math.max(qx0, cx * cbw),
                  x1: Math.min(qx1, (cx + 1) * cbw),
                  y0: Math.max(qy0, cy * cbh),
                  y1: Math.min(qy1, (cy + 1) * cbh),
                  lblock: 3,
                  seen: false,
                  zeroPlanes: 0,
                  passes: 0,
                  length: 0,
                  data: null
                });
              }
            }
            P.inclusion = tagTree(P.cw, cy1 - cy0);
            P.zero = tagTree(P.cw, cy1 - cy0);
          }
          B.precincts.push(P);
        }
      }
      R.bands.push(B);
    }
    res.push(R);
  }

  // Packets: one layer and one component, so resolution, then precinct.
  let pos = 0;
  for (const R of res) {
    for (let pi = 0; pi < R.npx * R.npy; pi++) {
      const rd = headerReader(body, pos);
      const included: CodeBlock[] = [];
      if (rd.bit()) {
        for (const B of R.bands) {
          const P = B.precincts[pi] as Precinct;
          if (!P.inclusion || !P.zero) continue;
          for (let k = 0; k < P.blocks.length; k++) {
            const cb = P.blocks[k] as CodeBlock;
            const x = k % P.cw;
            const y = Math.floor(k / P.cw);
            const isIn = cb.seen ? rd.bit() === 1 : P.inclusion.decode(rd, x, y, 1);
            if (!isIn) continue;
            if (!cb.seen) {
              // The zero-bit-plane count can never exceed the band's planes (Mb),
              // so the threshold search stops there on exhausted or corrupt data.
              let threshold = 1;
              while (!P.zero.decode(rd, x, y, threshold)) {
                threshold++;
                if (threshold > B.planes + 1) fail('corrupt', 'zero bit-plane count exceeds the band');
              }
              cb.zeroPlanes = P.zero.value(x, y);
              cb.seen = true;
            }
            let n = 1;
            if (rd.bit()) {
              n = 2;
              if (rd.bit()) {
                const a = rd.bits(2);
                n = 3 + a;
                if (a === 3) {
                  const b = rd.bits(5);
                  n = 6 + b;
                  if (b === 31) n = 37 + rd.bits(7);
                }
              }
            }
            const remaining = B.planes - cb.zeroPlanes;
            if (remaining <= 0 || n > 3 * remaining - 2) fail('corrupt', 'more coding passes than bit-planes');
            while (rd.bit()) {
              cb.lblock++;
              if (cb.lblock > 32) fail('corrupt', 'code-block length indicator');
            }
            const lengthBits = cb.lblock + Math.floor(Math.log2(n));
            cb.passes = n;
            cb.length = rd.bits(lengthBits);
            if (cb.length > body.length) fail('truncated', 'code-block data runs past the tile data');
            included.push(cb);
          }
        }
      }
      pos = rd.align();
      for (const cb of included) {
        const len = cb.length;
        if (pos + len > body.length) fail('truncated', 'code-block data runs past the tile data');
        cb.data = body.subarray(pos, pos + len);
        pos += len;
      }
    }
  }

  // Tier-1 into each sub-band.
  for (const R of res) {
    for (const B of R.bands) {
      const bw = B.x1 - B.x0;
      for (const P of B.precincts) {
        for (const cb of P.blocks) {
          if (!cb.data) continue;
          const w = cb.x1 - cb.x0;
          const h = cb.y1 - cb.y0;
          const v = decodeBlock(w, h, B.type, B.planes - cb.zeroPlanes, cb.passes, cb.data);
          for (let y = 0; y < h; y++) B.coef.set(v.subarray(y * w, y * w + w), (cb.y0 - B.y0 + y) * bw + (cb.x0 - B.x0));
        }
      }
    }
  }

  // Inverse reversible 5/3 transform (T.800 F.3: interleave, then HOR_SR and VER_SR).
  let cur = (res[0] as Resolution).bands[0]?.coef ?? new Int32Array(0);
  const lift = (Y: Int32Array, n: number, i0: number): void => {
    // In place on Y[0..n), T.800 F.3.8, with symmetric extension at both ends.
    if (n === 1) {
      if (i0 & 1) Y[0] = Math.trunc((Y[0] as number) / 2);
      return;
    }
    const e = i0 & 1;
    for (let i = e; i < n; i += 2) {
      const left = (i ? Y[i - 1] : Y[1]) as number;
      const right = (i + 1 < n ? Y[i + 1] : Y[n - 2]) as number;
      Y[i] = (Y[i] as number) - ((left + right + 2) >> 2);
    }
    for (let i = 1 - e; i < n; i += 2) {
      const left = (i ? Y[i - 1] : Y[1]) as number;
      const right = (i + 1 < n ? Y[i + 1] : Y[n - 2]) as number;
      Y[i] = (Y[i] as number) + ((left + right) >> 1);
    }
  };
  for (let r = 1; r <= levels; r++) {
    const R = res[r] as Resolution;
    const Q = res[r - 1] as Resolution;
    const w = R.x1 - R.x0;
    const h = R.y1 - R.y0;
    const out = new Int32Array(w * h);
    const [b0, b1, b2] = R.bands as [Band, Band, Band];
    const srcs = [cur, b0.coef, b1.coef, b2.coef];
    const bx = [Q.x0, b0.x0, b1.x0, b2.x0];
    const bww = [Q.x1 - Q.x0, b0.x1 - b0.x0, b1.x1 - b1.x0, b2.x1 - b2.x0];
    const by = [Q.y0, b0.y0, b1.y0, b2.y0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = R.x0 + x;
        const v = R.y0 + y;
        const t = (u & 1) | ((v & 1) << 1);
        const src = srcs[t] as Int32Array;
        out[y * w + x] = src[((v >> 1) - (by[t] as number)) * (bww[t] as number) + ((u >> 1) - (bx[t] as number))] as number;
      }
    }
    for (let y = 0; y < h; y++) lift(out.subarray(y * w, y * w + w), w, R.x0);
    if (h > 1) {
      const column = new Int32Array(h);
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) column[y] = out[y * w + x] as number;
        lift(column, h, R.y0);
        for (let y = 0; y < h; y++) out[y * w + x] = column[y] as number;
      }
    } else if (R.y0 & 1) {
      for (let x = 0; x < w; x++) out[x] = Math.trunc((out[x] as number) / 2);
    }
    cur = out;
  }
  if (cur.length !== expectedSamples) fail('corrupt', 'decoded sample count');
  // DC level shift for an unsigned component (T.800 G.1.2).
  const shift = 1 << (precision - 1);
  for (let i = 0; i < cur.length; i++) cur[i] = (cur[i] as number) + shift;
  return { width: X1 - X0, height: Y1 - Y0, data: cur };
}
