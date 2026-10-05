/**
 * The FlowField contract (design/moving-paths.md section 3, DR-116; block E1
 * unit E1-3). Every flow adapter produces one of these, so the renderer, the
 * still form and the tests never know the transport.
 *
 * - The grid is regular latitude/longitude in GRIB scan order: row 0 sits at
 *   `lat0` and rows run south by `dlat`; column 0 sits at `lon0` and columns
 *   run east by `dlon`. A global grid (`wrapsLon`) joins its last column to
 *   column 0. A regional box may cross the antimeridian (the wave crop runs
 *   from 165 E to 100 W); longitudes are measured east of `lon0`, so the box
 *   needs no special case.
 * - `u` and `v` are display velocity, east and north, pointing the way the
 *   field moves (TO). This module NEVER rotates: a FROM-to-TO turn (GFS-Wave
 *   DIRPW + 180) belongs to the source adapter (`flow/source.ts`), once. For
 *   waves the adapter ships the unit vector (sin TO, cos TO) so a blend across
 *   350 and 10 degrees passes through 0, never 180. Components are
 *   interpolated, never angles.
 * - `magnitude` is in real units (m/s for wind, m of significant height for
 *   waves) and only picks the display class.
 * - `mask` is 1 for a valid node and 0 for a masked or missing one. It is
 *   never zero-filled: the constructor writes NaN into every masked node's
 *   u, v and magnitude, so a masked node can never be read back as calm.
 */

export type FlowKind = 'wind' | 'waves';
export type FlowInterpolation = 'bilinear-valid' | 'nearest-sample';

export interface FlowGrid {
  /** Longitude of column 0, degrees east (any range; it is normalized on read). */
  readonly lon0: number;
  /** Latitude of row 0, degrees north; rows run south. */
  readonly lat0: number;
  /** Column spacing, degrees, positive. */
  readonly dlon: number;
  /** Row spacing, degrees, positive (rows run south). */
  readonly dlat: number;
  readonly nx: number;
  readonly ny: number;
  /** True only for a global grid whose last column joins column 0. */
  readonly wrapsLon: boolean;
}

export interface FlowMeta {
  /** Issuer words, verbatim (for example "NOAA"). */
  readonly issuer: string;
  /** Issuer model words, verbatim (for example "GFS", "GFS-Wave"). */
  readonly model: string;
  /** How the bytes arrived (for example "nodd-range"). */
  readonly transport: string;
  /** Model cycle (run) time, epoch ms, or null for a source with no stated run. */
  readonly cycle: number | null;
  /** Forecast hour of the message, or null for a source with none. */
  readonly forecastHour: number | null;
  /** The one dated instant the frame is valid at, epoch ms. Never "now". */
  readonly validTime: number;
  /** Epoch ms after which the frame must not be drawn, or null. */
  readonly staleAfter: number | null;
  /** Issuer level words, verbatim (for example "10 m above ground", "surface"). */
  readonly level: string;
  /** Units of `magnitude` ("m s-1" for wind, "m" for wave height). */
  readonly units: string;
  readonly sourceUrl: string;
  readonly productKey: string;
}

export interface FlowField {
  readonly kind: FlowKind;
  readonly grid: FlowGrid;
  /** East component of display velocity (TO); NaN where masked. Waves: a unit vector. */
  readonly u: Float32Array;
  /** North component of display velocity (TO); NaN where masked. */
  readonly v: Float32Array;
  /** Real units, display classes only; NaN where masked. */
  readonly magnitude: Float32Array;
  /** 1 valid, 0 masked or missing. */
  readonly mask: Uint8Array;
  readonly interpolation: FlowInterpolation;
  readonly meta: FlowMeta;
}

export interface FlowFieldInput {
  readonly kind: FlowKind;
  readonly grid: FlowGrid;
  readonly u: Float32Array;
  readonly v: Float32Array;
  /** Defaults to hypot(u, v) for wind. Waves must pass significant height. */
  readonly magnitude?: Float32Array;
  /** Optional issuer mask (bitmap). A node is valid only if this is 1 AND u, v and magnitude are finite. */
  readonly mask?: Uint8Array;
  readonly interpolation?: FlowInterpolation;
  readonly meta: FlowMeta;
}

/**
 * Display bins (moving-paths section 6), not thresholds: class index is the
 * number of bins the magnitude reaches. Wind 5 and 10 m/s; wave significant
 * height 2 and 4 m.
 */
export const FLOW_BINS: Readonly<Record<FlowKind, readonly [number, number]>> = {
  wind: [5, 10],
  waves: [2, 4]
};

export type FlowClass = 0 | 1 | 2;

export function classOf(kind: FlowKind, magnitude: number): FlowClass {
  const bins = FLOW_BINS[kind];
  return magnitude < bins[0] ? 0 : magnitude < bins[1] ? 1 : 2;
}

function checkGrid(grid: FlowGrid): void {
  const { nx, ny, dlon, dlat, lon0, lat0 } = grid;
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2) {
    throw new Error(`FlowField: grid ${nx}x${ny} is not at least 2x2`);
  }
  if (!(dlon > 0) || !(dlat > 0) || !Number.isFinite(lon0) || !Number.isFinite(lat0)) {
    throw new Error('FlowField: grid spacing must be positive and the origin finite');
  }
  if (lat0 > 90 || lat0 - (ny - 1) * dlat < -90) {
    throw new Error('FlowField: grid rows leave the range 90 N to 90 S');
  }
  if (grid.wrapsLon && Math.abs(nx * dlon - 360) > 1e-6) {
    throw new Error(`FlowField: wrapsLon needs nx * dlon = 360, got ${nx * dlon}`);
  }
  if (!grid.wrapsLon && (nx - 1) * dlon >= 360) {
    throw new Error('FlowField: a regional grid spans 360 degrees or more; mark it wrapsLon');
  }
}

/**
 * Build a FlowField from TO components. It takes ownership of the arrays
 * (no copy) and writes NaN into every masked node. It never rotates and
 * never adds 180.
 */
export function createFlowField(input: FlowFieldInput): FlowField {
  const { kind, grid, u, v, meta } = input;
  checkGrid(grid);
  const n = grid.nx * grid.ny;
  if (u.length !== n || v.length !== n) {
    throw new Error(`FlowField: u/v length ${u.length}/${v.length} does not match the ${grid.nx}x${grid.ny} grid`);
  }
  if (input.magnitude && input.magnitude.length !== n) {
    throw new Error('FlowField: magnitude length does not match the grid');
  }
  if (input.mask && input.mask.length !== n) {
    throw new Error('FlowField: mask length does not match the grid');
  }
  if (kind === 'waves' && !input.magnitude) {
    throw new Error('FlowField: a wave field needs its significant height as magnitude');
  }
  if (!Number.isFinite(meta.validTime)) throw new Error('FlowField: meta.validTime must be a dated instant');
  const magnitude = input.magnitude ?? new Float32Array(n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const issuerValid = input.mask ? input.mask[i] === 1 : true;
    const ui = u[i] as number;
    const vi = v[i] as number;
    if (!input.magnitude && Number.isFinite(ui) && Number.isFinite(vi)) magnitude[i] = Math.hypot(ui, vi);
    const ok = issuerValid && Number.isFinite(ui) && Number.isFinite(vi) && Number.isFinite(magnitude[i] as number);
    if (ok) {
      mask[i] = 1;
    } else {
      u[i] = Number.NaN;
      v[i] = Number.NaN;
      magnitude[i] = Number.NaN;
    }
  }
  return {
    kind, grid, u, v, magnitude, mask,
    interpolation: input.interpolation ?? 'bilinear-valid',
    meta
  };
}

/** True when the frame is past its staleAfter at `time` (epoch ms) and must not draw. */
export function isStale(field: FlowField, time: number): boolean {
  return field.meta.staleAfter !== null && time > field.meta.staleAfter;
}

export interface FlowSample {
  u: number;
  v: number;
  /** Magnitude in real units (classes only). */
  m: number;
}

/** A reusable sample record, so hot loops allocate nothing. */
export function newSample(): FlowSample {
  return { u: 0, v: 0, m: 0 };
}

/** Fractional column of `lon` east of the grid origin, or -1 when outside a regional box. */
function columnOf(grid: FlowGrid, lon: number): number {
  let dx = (lon - grid.lon0) % 360;
  if (dx < 0) dx += 360;
  const fx = dx / grid.dlon;
  if (grid.wrapsLon) return fx >= grid.nx ? fx - grid.nx : fx;
  // A point a hair west of lon0 measures as almost 360 east of it: outside.
  if (fx > grid.nx - 1 + 1e-9) return -1;
  return Math.min(fx, grid.nx - 1);
}

/**
 * Sample the field at (lon, lat), writing into `out`.
 *
 * - 'bilinear-valid': bilinear over the cell's four corners, and only when
 *   all four are valid; otherwise null (the caller kills the particle).
 * - 'nearest-sample': the nearest node's values, or null when it is masked.
 *
 * Off the grid (a regional box, or beyond the first or last row) it returns
 * null: nothing is extrapolated. Components are blended, never angles.
 */
export function sampleField(field: FlowField, lon: number, lat: number, out: FlowSample): FlowSample | null {
  const g = field.grid;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const fy = (g.lat0 - lat) / g.dlat;
  if (fy < -1e-9 || fy > g.ny - 1 + 1e-9) return null;
  const fx = columnOf(g, lon);
  if (fx < 0) return null;
  const y = Math.min(Math.max(fy, 0), g.ny - 1);
  const { u, v, magnitude, mask } = field;
  if (field.interpolation === 'nearest-sample') {
    let xi = Math.round(fx);
    if (xi >= g.nx) xi = g.wrapsLon ? 0 : g.nx - 1;
    const i = Math.round(y) * g.nx + xi;
    if (mask[i] !== 1) return null;
    out.u = u[i] as number;
    out.v = v[i] as number;
    out.m = magnitude[i] as number;
    return out;
  }
  const x0 = Math.floor(fx);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < g.nx ? x0 + 1 : g.wrapsLon ? 0 : x0;
  const y1 = y0 + 1 < g.ny ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = y - y0;
  const r0 = y0 * g.nx;
  const r1 = y1 * g.nx;
  const i00 = r0 + x0;
  const i10 = r0 + x1;
  const i01 = r1 + x0;
  const i11 = r1 + x1;
  if (mask[i00] !== 1 || mask[i10] !== 1 || mask[i01] !== 1 || mask[i11] !== 1) return null;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  out.u = (u[i00] as number) * w00 + (u[i10] as number) * w10 + (u[i01] as number) * w01 + (u[i11] as number) * w11;
  out.v = (v[i00] as number) * w00 + (v[i10] as number) * w10 + (v[i01] as number) * w01 + (v[i11] as number) * w11;
  out.m = (magnitude[i00] as number) * w00 + (magnitude[i10] as number) * w10
    + (magnitude[i01] as number) * w01 + (magnitude[i11] as number) * w11;
  return out;
}

/**
 * The fractional (x = column, y = row) position of (lon, lat) on the grid,
 * written into `out`, or null off the grid. Columns of a global grid are in
 * 0..nx; a regional box measures columns east of its origin, across the
 * antimeridian when it crosses it.
 */
export function gridPosition(field: FlowField, lon: number, lat: number, out: { x: number; y: number }): { x: number; y: number } | null {
  const g = field.grid;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const fy = (g.lat0 - lat) / g.dlat;
  if (fy < -1e-9 || fy > g.ny - 1 + 1e-9) return null;
  const fx = columnOf(g, lon);
  if (fx < 0) return null;
  out.x = fx;
  out.y = Math.min(Math.max(fy, 0), g.ny - 1);
  return out;
}

/**
 * True when the cell whose north-west node is (column, row) has four valid
 * corners, so the bilinear sampler reads it. Columns wrap on a global grid;
 * the last row and (on a box) the last column fold into the cell before them.
 */
export function cellValid(field: FlowField, column: number, row: number): boolean {
  const g = field.grid;
  let c = column;
  if (g.wrapsLon) c = ((c % g.nx) + g.nx) % g.nx;
  else if (c < 0 || c > g.nx - 1) return false;
  else if (c === g.nx - 1) c = g.nx - 2;
  let r = row;
  if (r < 0 || r > g.ny - 1) return false;
  if (r === g.ny - 1) r = g.ny - 2;
  const c1 = c + 1 < g.nx ? c + 1 : 0;
  const m = field.mask;
  const r0 = r * g.nx;
  const r1 = r0 + g.nx;
  return m[r0 + c] === 1 && m[r0 + c1] === 1 && m[r1 + c] === 1 && m[r1 + c1] === 1;
}

/** The longitude and latitude of node (column, row). */
export function nodeLonLat(grid: FlowGrid, column: number, row: number): [number, number] {
  let lon = grid.lon0 + column * grid.dlon;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return [lon, grid.lat0 - row * grid.dlat];
}

// Web Mercator in MapLibre's world square: x east 0..1 from 180 W, y south 0..1.
export const MERCATOR_MAX_LAT = 85.051129;

export function mercX(lon: number): number {
  return (lon + 180) / 360;
}

export function mercY(lat: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Longitude of Mercator x; x may be unwrapped (outside 0..1), so the result may lie outside -180..180. */
export function lonOf(x: number): number {
  return x * 360 - 180;
}

export function latOf(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}
