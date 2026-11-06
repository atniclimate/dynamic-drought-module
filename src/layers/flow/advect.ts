/**
 * CPU particle state for the flow paths (design/moving-paths.md sections 3,
 * 4, 5 and 9; DR-116; block E1 unit E1-3). Pure: no DOM, no GL, so Node tests
 * drive it directly. The ribbon layer uploads what this module writes, and
 * the still form integrates with the same `advance()`, so the moving and
 * still forms carry the same meaning.
 *
 * - Positions are Mercator world units (MapLibre's 0..1 square, x east,
 *   y south), x unwrapped so a path across 180 degrees stays continuous.
 * - A fixed 1/30 s step with at most 2 catch-up steps, so pace never depends
 *   on the display rate.
 * - Pace is linear in the field's own speed for wind (4 CSS px/s per m/s at
 *   10 m, 1 at 250 hPa, `JET_PACE`) and
 *   one uniform display rate for waves (24 CSS px/s; ruling R5 a). Wave
 *   height sets only the class and the mark length, never the rate.
 * - A step is sub-stepped when it would move more than half a cell. It is
 *   refused, and the particle respawns, when any sub-step or the drawn chord
 *   touches a cell without four valid corners: kill before commit, so no
 *   drawn segment crosses a masked cell.
 */
import {
  type FlowClass, type FlowField, type FlowKind, type FlowSample,
  FLOW_BINS, cellValid, classOf, createFlowField, gridPosition, latOf, lonOf, newSample, sampleField
} from './field';

export const STEP_S = 1 / 30;
export const MAX_CATCH_UP_STEPS = 2;
/** Trail ring slots: 0.6 s at 30 Hz. */
export const SLOTS = 18;
export const MAX_PARTICLES = 4096;
/** Standard density: one particle per this many CSS px squared. */
export const CSS_PX2_PER_PARTICLE = 1024;
export const FADE_S = 0.3;
export const LIFE_MIN_S = 2;
export const LIFE_MAX_S = 4;
/** Coverage bar at Standard (moving-paths section 5). */
export const MAX_COVERAGE = 0.08;
/** Past this many CSS px per model cell, nodes draw arrows and nothing advects. */
export const PAST_GRID_CELL_PX = 384;
/** A view this wide or narrower is the phone rail: still first, half density. */
export const PHONE_MAX_WIDTH_PX = 720;
export const PHONE_DENSITY_FACTOR = 0.5;

/**
 * Wave crest sets (moving-paths section 9; redrawn 2026-11-06 by the ray rule of
 * the waves-dynamics design: the bar-and-head marks read as birds, and sets
 * re-aimed every step spun where the primary direction flips between systems).
 */
export const MAX_MARKS = 600;
/** The longest life of a set; its spawn check cuts it shorter before land, the view edge or turning water. */
export const MARK_LIFE_S = 2;
/** A set whose clear path is shorter than this does not appear. */
export const MARK_MIN_LIFE_S = 1;
/** Front crest length in CSS px by height class; the whole set scales with it. */
export const MARK_LENGTH_PX: readonly [number, number, number] = [20, 28, 36];
export const MARK_CRESTS = 3;
/** The angle every crest arc spans: a drawing convention, not the shape of real wave fronts. */
export const MARK_ARC = (40 * Math.PI) / 180;
/** Gap between crest midpoints along the travel, as a fraction of the front length: a drawing convention, not a wavelength. */
export const MARK_GAP_RATIO = 0.25;
/** Crest lengths back to front as fractions of the front: with that gap, all three arcs share one centre. */
export const MARK_CREST_RATIO: readonly [number, number, number] = [1 - MARK_ARC / 2, 1 - MARK_ARC / 4, 1];
/** Width and alpha factor of each crest, back to front: the wind ribbons' tail-to-head taper. */
export const MARK_CREST_WEIGHT: readonly [number, number, number] = [0.5, 0.75, 1];
/** Width and alpha at a crest's ends, as a fraction of its centre. */
export const MARK_END_TAPER = 0.5;
/** The direction low-pass window: (2r + 1) squared nodes, r = 2 (1.25 degrees on the 0.25 degree grid). */
export const MARK_SMOOTH_NODES = 2;
/** Least agreement of neighbouring primary directions (the low-pass mean's length) where a set may appear or travel. */
export const MARK_MIN_AGREEMENT = 0.8;
/** A set's path ends before water whose averaged direction differs from its own by more than this. */
export const MARK_MAX_TURN_DEG = 20;
/**
 * Floats per drawn segment: x0, y0 (inner) and x1, y1 (outer), relative to the
 * origin, then class, alpha, and the width factor at each end. A crest is four
 * segments drawn from its centre out: centre to mid to end, on each side.
 */
export const MARK_SEG_FLOATS = 8;
const CREST_SEGS = 4;
export const MARK_SEGS_PER_SET = MARK_CRESTS * CREST_SEGS;
const CSS_PX2_PER_MARK = 6144;

export interface Pace {
  /** CSS px/s per field unit (m/s), or the uniform rate when `uniform`. */
  readonly pxPerSecPerUnit: number;
  /** True: every mark moves at the one rate, whatever the magnitude. */
  readonly uniform: boolean;
}

export const WIND_PACE: Pace = { pxPerSecPerUnit: 4, uniform: false };
/**
 * The one illustrative wave rate (R5 a). A ruling for another rate or for
 * trails is a change to this constant only.
 */
export const WAVE_RATE_PX_PER_S = 24;
export const WAVE_PACE: Pace = { pxPerSecPerUnit: WAVE_RATE_PX_PER_S, uniform: true };

/**
 * Jet-level wind is several times faster than 10 m wind, and a surface
 * current far slower, so each pace is scaled by the upper bins of the two
 * kinds: a flow at its own upper bin crosses the screen as fast as a 10 m
 * wind at its upper bin. The pace stays linear in the speed of the field.
 */
const scaledPace = (kind: FlowKind): Pace => ({
  pxPerSecPerUnit: (WIND_PACE.pxPerSecPerUnit * FLOW_BINS.wind[1]) / FLOW_BINS[kind][1],
  uniform: false
});
export const JET_PACE: Pace = scaledPace('jet');
export const CURRENT_PACE: Pace = scaledPace('currents');
const PACES: Readonly<Record<FlowKind, Pace>> = {
  wind: WIND_PACE, jet: JET_PACE, waves: WAVE_PACE, currents: CURRENT_PACE
};

export function paceFor(kind: FlowKind): Pace {
  return PACES[kind];
}

/** The view as the Mercator positions of its four screen corners (TL, TR, BR, BL), x unwrapped. */
export interface ViewQuad {
  /** x0, y0, x1, y1, x2, y2, x3, y3. */
  readonly c: Float64Array;
  /** CSS px per Mercator unit: 512 * 2^zoom. */
  readonly worldSize: number;
  readonly cssW: number;
  readonly cssH: number;
}

/**
 * A ViewQuad from the longitude/latitude of the four screen corners (TL, TR,
 * BR, BL). Each corner's x is unwrapped to lie within half a world of
 * `nearX` (the view centre), so a view across the antimeridian is one
 * continuous quad.
 */
export function viewQuadFromCorners(
  corners: readonly (readonly [number, number])[], zoom: number, cssW: number, cssH: number, nearX: number
): ViewQuad {
  const c = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const corner = corners[i] as readonly [number, number];
    let x = (corner[0] + 180) / 360;
    while (x - nearX > 0.5) x -= 1;
    while (nearX - x > 0.5) x += 1;
    const lat = Math.max(-85.051129, Math.min(85.051129, corner[1]));
    const s = Math.sin((lat * Math.PI) / 180);
    c[i * 2] = x;
    c[i * 2 + 1] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  return { c, worldSize: 512 * 2 ** zoom, cssW, cssH };
}

export function viewCenter(view: ViewQuad): [number, number] {
  const c = view.c;
  return [
    ((c[0] as number) + (c[2] as number) + (c[4] as number) + (c[6] as number)) / 4,
    ((c[1] as number) + (c[3] as number) + (c[5] as number) + (c[7] as number)) / 4
  ];
}

export type Rng = () => number;

/** Seeded PRNG (mulberry32), so the still form is deterministic for one seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The Mercator point at screen fraction (sx, sy) of the view, written into out[0..1]. */
export function viewPoint(view: ViewQuad, sx: number, sy: number, out: Float64Array): void {
  const c = view.c;
  const topX = (c[0] as number) * (1 - sx) + (c[2] as number) * sx;
  const topY = (c[1] as number) * (1 - sx) + (c[3] as number) * sx;
  const botX = (c[6] as number) * (1 - sx) + (c[4] as number) * sx;
  const botY = (c[7] as number) * (1 - sx) + (c[5] as number) * sx;
  out[0] = topX * (1 - sy) + botX * sy;
  out[1] = topY * (1 - sy) + botY * sy;
}

export function insideView(view: ViewQuad, x: number, y: number): boolean {
  const c = view.c;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = c[i * 2] as number;
    const ay = c[i * 2 + 1] as number;
    const bx = c[((i + 1) % 4) * 2] as number;
    const by = c[((i + 1) % 4) * 2 + 1] as number;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/** CSS px of one model cell at the view centre (the larger of its two sides). */
export function cellPx(field: FlowField, view: ViewQuad): number {
  const lat = latOf(viewCenter(view)[1]);
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const xPx = (field.grid.dlon / 360) * view.worldSize;
  const yPx = (field.grid.dlat / 360 / cos) * view.worldSize;
  return Math.max(xPx, yPx);
}

export type FlowForm = 'moving' | 'still' | 'arrows';

export interface FormOptions {
  /** False under Pause, reduced motion, a hidden tab, SST playback, 3D or no WebGL2. */
  readonly motionAllowed: boolean;
}

export interface FormPlan {
  readonly form: FlowForm;
  /** Density factor (1 = one particle per 1,024 CSS px squared). */
  readonly densityFactor: number;
}

/**
 * Which form draws for this field and view (moving-paths sections 4, 5, 13).
 * Past 384 CSS px per cell it is always arrows at the nodes. A phone-width
 * view draws at half density.
 */
export function planForm(field: FlowField, view: ViewQuad, options: FormOptions): FormPlan {
  const densityFactor = view.cssW <= PHONE_MAX_WIDTH_PX ? PHONE_DENSITY_FACTOR : 1;
  if (cellPx(field, view) > PAST_GRID_CELL_PX) return { form: 'arrows', densityFactor };
  if (!options.motionAllowed) return { form: 'still', densityFactor };
  return { form: 'moving', densityFactor };
}

export function particleCount(view: ViewQuad, densityFactor: number): number {
  const want = Math.round(((view.cssW * view.cssH) / CSS_PX2_PER_PARTICLE) * densityFactor);
  return Math.max(0, Math.min(MAX_PARTICLES, want));
}

export function markCount(view: ViewQuad, densityFactor: number): number {
  const want = Math.round(((view.cssW * view.cssH) / CSS_PX2_PER_MARK) * densityFactor);
  return Math.max(0, Math.min(MAX_MARKS, want));
}

/**
 * The fixed-step clock: at most 2 catch-up steps, and a resume starts over,
 * so time spent paused or hidden never comes back as a burst of steps.
 */
export class FlowClock {
  // Fields are `declare`d and set in the constructor, so no class field is
  // lowered and no class-field helper is bundled (see grib2.ts GribError).
  declare private last: number;

  constructor() {
    this.last = -1;
  }

  /** Steps due at `nowS` (seconds). The first call after a resume returns 1. */
  due(nowS: number): number {
    if (this.last < 0) {
      this.last = nowS;
      return 1;
    }
    let n = Math.floor((nowS - this.last) / STEP_S);
    if (n <= 0) return 0;
    if (n > MAX_CATCH_UP_STEPS) {
      n = MAX_CATCH_UP_STEPS;
      this.last = nowS - n * STEP_S;
    }
    this.last += n * STEP_S;
    return n;
  }

  resume(): void {
    this.last = -1;
  }
}

const tmpSample = newSample();
const posA = { x: 0, y: 0 };
const posB = { x: 0, y: 0 };
/** A chord spanning more cells than this per axis is refused outright. */
const MAX_CHORD_CELLS = 8;

/**
 * True when every cell the straight chord (x0, y0) to (x1, y1) can touch has
 * four valid corners. Longitude depends on Mercator x alone and latitude on y
 * alone, so the chord lies within the column and row ranges of its ends.
 */
export function chordClear(field: FlowField, x0: number, y0: number, x1: number, y1: number): boolean {
  return chordClearLonLat(field, lonOf(x0), latOf(y0), lonOf(x1), latOf(y1));
}

/** chordClear with the ends already converted to longitude and latitude. */
function chordClearLonLat(field: FlowField, lon0: number, lat0: number, lon1: number, lat1: number): boolean {
  const a = gridPosition(field, lon0, lat0, posA);
  const b = gridPosition(field, lon1, lat1, posB);
  if (!a || !b) return false;
  return cellsClear(field, a, b);
}

/** Every cell in the column and row ranges of grid positions a and b has four valid corners. */
function cellsClear(field: FlowField, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const nx = field.grid.nx;
  const ax = a.x;
  let bx = b.x;
  if (field.grid.wrapsLon) {
    // Columns on a global grid are measured the short way round.
    if (bx - ax > nx / 2) bx -= nx;
    else if (ax - bx > nx / 2) bx += nx;
  }
  const c0 = Math.floor(Math.min(ax, bx));
  const c1 = Math.floor(Math.max(ax, bx));
  const r0 = Math.floor(Math.min(a.y, b.y));
  const r1 = Math.floor(Math.max(a.y, b.y));
  if (c1 - c0 > MAX_CHORD_CELLS || r1 - r0 > MAX_CHORD_CELLS) return false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!cellValid(field, c, r)) return false;
    }
  }
  return true;
}

/**
 * One display step from (x, y) over `dt` seconds, sub-stepped above half a
 * cell. Writes the new position into out[0..1] (and, when `out` has four
 * slots, its longitude and latitude into out[2..3]) and returns the field sample
 * there, or null (kill before commit) when a sub-step leaves the valid field,
 * the chord crosses a cell without four valid corners, or a uniform-rate
 * field has no direction (opposite unit vectors blended to nothing).
 */
export function advance(
  field: FlowField, pace: Pace, worldSize: number, x: number, y: number, dt: number, out: Float64Array
): FlowSample | null {
  const cellX = field.grid.dlon / 360;
  const lonStart = lonOf(x);
  const latStart = latOf(y);
  let s = sampleField(field, lonStart, latStart, tmpSample);
  if (!s) return null;
  const k = pace.pxPerSecPerUnit / worldSize;
  const speed0 = Math.hypot(s.u, s.v);
  if (pace.uniform && speed0 < 1e-6) return null;
  const distance = (pace.uniform ? 1 : speed0) * k * dt;
  const n = Math.max(1, Math.ceil(distance / (0.5 * cellX)));
  const h = dt / n;
  let px = x;
  let py = y;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      s = sampleField(field, lonOf(px), latOf(py), tmpSample);
      if (!s) return null;
    }
    let du = s.u;
    let dv = s.v;
    if (pace.uniform) {
      const norm = Math.hypot(du, dv);
      if (norm < 1e-6) return null;
      du /= norm;
      dv /= norm;
    }
    px += du * k * h;
    py -= dv * k * h; // north is -y in Mercator
  }
  const lonEnd = lonOf(px);
  const latEnd = latOf(py);
  const end = sampleField(field, lonEnd, latEnd, tmpSample);
  if (!end) return null;
  // The chord check uses its own scratch records, so `end` is intact.
  if (!chordClearLonLat(field, lonStart, latStart, lonEnd, latEnd)) return null;
  out[0] = px;
  out[1] = py;
  if (out.length >= 4) {
    out[2] = lonEnd;
    out[3] = latEnd;
  }
  return end;
}

function fadeAlpha(age: number, life: number): number {
  return Math.max(0, Math.min(1, age / FADE_S, (life - age) / FADE_S));
}

const spawnPoint = new Float64Array(2);
const stepPoint = new Float64Array(2);

/**
 * Wind particles: the moving form's state. The ring is slot-major: slot s,
 * particle p at ((s * capacity) + p) * 4, holding x and y relative to the
 * origin, the particle generation, and class * 2 + alpha (or -1 when empty).
 * A segment joins two slots only when their generations match, so a respawn
 * never draws a line across the view.
 */
export class Particles {
  // `declare`d and set in the constructor: no lowered class field (FlowClock).
  declare readonly field: FlowField;
  declare readonly pace: Pace;
  declare private readonly rng: Rng;
  declare capacity: number;
  declare count: number;
  declare x: Float64Array;
  declare y: Float64Array;
  declare age: Float32Array;
  declare life: Float32Array;
  declare gen: Uint32Array;
  declare cls: Uint8Array;
  declare alive: Uint8Array;
  declare ring: Float32Array;
  /** The slot the last step wrote. */
  declare head: number;
  /** The Mercator origin the ring positions are relative to. */
  declare originX: number;
  declare originY: number;
  /** Set when the whole ring must be uploaded (reset, rebase, growth). */
  declare ringDirty: boolean;
  declare private nextGen: number;

  constructor(field: FlowField, pace: Pace, rng: Rng = Math.random) {
    this.field = field;
    this.pace = pace;
    this.rng = rng;
    this.capacity = 0;
    this.count = 0;
    this.x = new Float64Array(0);
    this.y = new Float64Array(0);
    this.age = new Float32Array(0);
    this.life = new Float32Array(0);
    this.gen = new Uint32Array(0);
    this.cls = new Uint8Array(0);
    this.alive = new Uint8Array(0);
    this.ring = new Float32Array(0);
    this.head = SLOTS - 1;
    this.originX = 0;
    this.originY = 0;
    this.ringDirty = true;
    this.nextGen = 1;
  }

  /** Set the count for the view and density; capacity grows in powers of two up to 4,096. */
  setCount(view: ViewQuad, densityFactor: number): void {
    this.count = particleCount(view, densityFactor);
    if (this.count > this.capacity) {
      let cap = 256;
      while (cap < this.count) cap *= 2;
      this.grow(Math.min(MAX_PARTICLES, cap));
    }
  }

  private grow(cap: number): void {
    const n = this.capacity;
    const copy = <T extends Float64Array | Float32Array | Uint32Array | Uint8Array>(old: T, fresh: T): T => {
      fresh.set(old.subarray(0, n));
      return fresh;
    };
    this.x = copy(this.x, new Float64Array(cap));
    this.y = copy(this.y, new Float64Array(cap));
    this.age = copy(this.age, new Float32Array(cap));
    this.life = copy(this.life, new Float32Array(cap));
    this.gen = copy(this.gen, new Uint32Array(cap));
    this.cls = copy(this.cls, new Uint8Array(cap));
    this.alive = copy(this.alive, new Uint8Array(cap));
    this.capacity = cap;
    this.ring = new Float32Array(cap * SLOTS * 4);
    this.clearRing();
  }

  private clearRing(): void {
    for (let i = 3; i < this.ring.length; i += 4) this.ring[i] = -1;
    this.ringDirty = true;
  }

  /**
   * Start over in this view (first run, resume, a zoom change): every
   * particle is young and fades in, lives are staggered, and the ring is
   * empty, so nothing bursts.
   */
  reset(view: ViewQuad): void {
    const [cx, cy] = viewCenter(view);
    this.originX = cx;
    this.originY = cy;
    this.clearRing();
    for (let i = 0; i < this.capacity; i++) this.alive[i] = 0;
    for (let i = 0; i < this.count; i++) this.spawn(i, view);
  }

  /** Move the origin to the view centre when it has drifted far, keeping every stored trail. */
  rebaseIfFar(view: ViewQuad): void {
    const [cx, cy] = viewCenter(view);
    const span = Math.max(view.cssW, view.cssH) / view.worldSize;
    if (Math.abs(cx - this.originX) < 4 * span && Math.abs(cy - this.originY) < 4 * span) return;
    const dx = this.originX - cx;
    const dy = this.originY - cy;
    for (let i = 0; i < this.ring.length; i += 4) {
      this.ring[i] = (this.ring[i] as number) + dx;
      this.ring[i + 1] = (this.ring[i + 1] as number) + dy;
    }
    this.originX = cx;
    this.originY = cy;
    this.ringDirty = true;
  }

  private spawn(i: number, view: ViewQuad): void {
    for (let tries = 0; tries < 4; tries++) {
      viewPoint(view, this.rng(), this.rng(), spawnPoint);
      const s = sampleField(this.field, lonOf(spawnPoint[0] as number), latOf(spawnPoint[1] as number), tmpSample);
      if (!s) continue;
      this.x[i] = spawnPoint[0] as number;
      this.y[i] = spawnPoint[1] as number;
      this.life[i] = LIFE_MIN_S + (LIFE_MAX_S - LIFE_MIN_S) * this.rng();
      this.age[i] = 0;
      this.gen[i] = this.nextGen;
      this.nextGen = (this.nextGen % 0xfffff) + 1; // exact in float32
      this.cls[i] = classOf(this.field.kind, s.m);
      this.alive[i] = 1;
      return;
    }
    this.alive[i] = 0;
  }

  /** One fixed step; writes the next ring slot. */
  step(view: ViewQuad): void {
    this.rebaseIfFar(view);
    const slot = (this.head + 1) % SLOTS;
    const base = slot * this.capacity * 4;
    for (let i = 0; i < this.count; i++) {
      let committed = false;
      if (this.alive[i] && (this.age[i] as number) < (this.life[i] as number)) {
        const s = advance(this.field, this.pace, view.worldSize, this.x[i] as number, this.y[i] as number, STEP_S, stepPoint);
        if (s && insideView(view, stepPoint[0] as number, stepPoint[1] as number)) {
          this.x[i] = stepPoint[0] as number;
          this.y[i] = stepPoint[1] as number;
          this.cls[i] = classOf(this.field.kind, s.m);
          this.age[i] = (this.age[i] as number) + STEP_S;
          committed = true;
        }
      }
      if (!committed) this.spawn(i, view);
      const o = base + i * 4;
      if (this.alive[i]) {
        this.ring[o] = (this.x[i] as number) - this.originX;
        this.ring[o + 1] = (this.y[i] as number) - this.originY;
        this.ring[o + 2] = this.gen[i] as number;
        this.ring[o + 3] = (this.cls[i] as number) * 2 + fadeAlpha(this.age[i] as number, this.life[i] as number) * 0.999;
      } else {
        this.ring[o + 3] = -1;
      }
    }
    for (let i = this.count; i < this.capacity; i++) this.ring[base + i * 4 + 3] = -1;
    this.head = slot;
  }

  /** Ring offset of particle p in the slot `back` steps before the head (0 = newest). */
  slotOffset(p: number, back: number): number {
    const slot = (this.head - back + SLOTS * 2) % SLOTS;
    return (slot * this.capacity + p) * 4;
  }

  /**
   * Visit every drawable trail segment, newest first, with absolute Mercator
   * ends: (ax, ay) older, (bx, by) newer.
   */
  forEachSegment(visit: (p: number, ax: number, ay: number, bx: number, by: number, cls: FlowClass) => void): void {
    const r = this.ring;
    for (let p = 0; p < this.count; p++) {
      for (let k = 0; k < SLOTS - 1; k++) {
        const b = this.slotOffset(p, k);
        const a = this.slotOffset(p, k + 1);
        if ((r[a + 3] as number) < 0 || (r[b + 3] as number) < 0 || r[a + 2] !== r[b + 2]) continue;
        const cls = Math.floor((r[b + 3] as number) / 2) as FlowClass;
        visit(p, (r[a] as number) + this.originX, (r[a + 1] as number) + this.originY,
          (r[b] as number) + this.originX, (r[b + 1] as number) + this.originY, cls);
      }
    }
  }
}

/**
 * Share of the view the ribbons cover: each segment's CSS length times its
 * full cased width (core plus casing on both sides, ignoring the taper, so
 * this overstates), over the view's CSS area.
 */
export function ribbonCoverage(particles: Particles, view: ViewQuad, coreWidths: readonly number[], casingPx: number): number {
  let area = 0;
  particles.forEachSegment((_p, ax, ay, bx, by, cls) => {
    const len = Math.hypot(bx - ax, by - ay) * view.worldSize;
    area += len * ((coreWidths[cls] as number) + 2 * casingPx);
  });
  return area / (view.cssW * view.cssH);
}

const directionCache = new WeakMap<FlowField, FlowField>();

/**
 * The direction field the wave sets read (waves-dynamics design 3.3), once per
 * field: at each valid node, the mean of the unit travel vectors over the valid
 * nodes of a (2r + 1) squared window, weighted by height squared (energy). It
 * is not normalized: its length R (0 to 1) is how well neighbouring primary
 * directions agree, and sampling it bilinearly gives the agreement at a point.
 * Masked nodes stay masked; the magnitude stays the field's own height, so the
 * classes are unchanged. Summed-area tables make it one pass over the grid.
 * shortcut: the window does not wrap across a global grid's seam; waves read the regional crop only.
 */
export function waveDirections(field: FlowField): FlowField {
  const cached = directionCache.get(field);
  if (cached) return cached;
  const { nx, ny } = field.grid;
  const r = MARK_SMOOTH_NODES;
  const w1 = nx + 1;
  const su = new Float64Array(w1 * (ny + 1));
  const sv = new Float64Array(w1 * (ny + 1));
  const sw = new Float64Array(w1 * (ny + 1));
  for (let y = 0; y < ny; y++) {
    let ru = 0;
    let rv = 0;
    let rw = 0;
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (field.mask[i] === 1) {
        const w = (field.magnitude[i] as number) ** 2;
        ru += w * (field.u[i] as number);
        rv += w * (field.v[i] as number);
        rw += w;
      }
      const o = (y + 1) * w1 + x + 1;
      su[o] = (su[o - w1] as number) + ru;
      sv[o] = (sv[o - w1] as number) + rv;
      sw[o] = (sw[o - w1] as number) + rw;
    }
  }
  const box = (t: Float64Array, x0: number, y0: number, x1: number, y1: number): number =>
    (t[y1 * w1 + x1] as number) - (t[y0 * w1 + x1] as number) - (t[y1 * w1 + x0] as number) + (t[y0 * w1 + x0] as number);
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(nx, x + r + 1);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(ny, y + r + 1);
      const w = box(sw, x0, y0, x1, y1);
      const valid = field.mask[i] === 1 && w > 0;
      u[i] = valid ? box(su, x0, y0, x1, y1) / w : Number.NaN;
      v[i] = valid ? box(sv, x0, y0, x1, y1) / w : Number.NaN;
    }
  }
  const out = createFlowField({
    kind: field.kind, grid: field.grid, u, v, magnitude: Float32Array.from(field.magnitude), mask: Uint8Array.from(field.mask), meta: field.meta
  });
  directionCache.set(field, out);
  return out;
}

const crestA = { x: 0, y: 0 };
const crestB = { x: 0, y: 0 };
/** One crest's five arc points end to end (x, y pairs). */
const crestPts = new Float64Array((CREST_SEGS + 1) * 2);
/** Cosine and sine of each arc point's angle from the travel: -ARC/2 to ARC/2 in quarters. */
const ARC_COS = Array.from({ length: CREST_SEGS + 1 }, (_, j) => Math.cos(MARK_ARC * (j / CREST_SEGS - 0.5)));
const ARC_SIN = Array.from({ length: CREST_SEGS + 1 }, (_, j) => Math.sin(MARK_ARC * (j / CREST_SEGS - 0.5)));
const LIFE_STEPS = Math.round(MARK_LIFE_S / STEP_S);
const COS_MAX_TURN = Math.cos((MARK_MAX_TURN_DEG * Math.PI) / 180);

/**
 * Crest k (0 back, 2 front) of a set whose front midpoint is (px, py),
 * travelling (tx, ty), front length `front` (Mercator units), into crestPts.
 * The three arcs share one centre, the front arc's radius behind the mark, so
 * they are concentric fronts opening the way the set travels.
 */
function setCrest(px: number, py: number, tx: number, ty: number, front: number, k: number): void {
  const reach = front / MARK_ARC;
  const cx = px - tx * reach;
  const cy = py - ty * reach;
  const rho = (MARK_CREST_RATIO[k] as number) * reach;
  for (let j = 0; j <= CREST_SEGS; j++) {
    const c = (ARC_COS[j] as number) * rho;
    const s = (ARC_SIN[j] as number) * rho;
    crestPts[j * 2] = cx + c * tx - s * ty;
    crestPts[j * 2 + 1] = cy + c * ty + s * tx;
  }
}

/**
 * True when every cell the crest polyline in crestPts can touch has four valid
 * corners: each drawn chord is checked, its ends placed on the grid once.
 */
function crestClear(field: FlowField): boolean {
  let a = gridPosition(field, lonOf(crestPts[0] as number), latOf(crestPts[1] as number), crestA);
  if (!a) return false;
  for (let k = 1; k <= CREST_SEGS; k++) {
    const b = gridPosition(field, lonOf(crestPts[k * 2] as number), latOf(crestPts[k * 2 + 1] as number), a === crestA ? crestB : crestA);
    if (!b || !cellsClear(field, a, b)) return false;
    a = b;
  }
  return true;
}

/** The width factor at fraction f (-1 to 1) across a crest of weight w: full at the centre, MARK_END_TAPER at the ends. */
function crestWidth(w: number, f: number): number {
  return w * (1 - (1 - MARK_END_TAPER) * Math.abs(f));
}

/**
 * Wave crest sets, by the ray rule (R5 a; waves-dynamics design 3.2 to 3.5).
 * Each set reads its direction once, where it appears, from waveDirections
 * (the energy-weighted 5 by 5 node mean of the primary direction), and only
 * where neighbouring directions agree (R at least 0.8); it reads its height
 * class there once too. It then travels straight at the one uniform rate,
 * holding that orientation and size, so it never turns. Before it appears its
 * whole path is checked, and its life is cut so it fades out before land (a
 * cell without four valid corners), the view edge, or water whose averaged
 * direction differs from its own by more than 20 degrees; a path clear for
 * less than 1 s is refused. Its shape: three concentric arcs across the
 * travel, 40 degrees wide, the front one longest and boldest (weights 0.5,
 * 0.75, 1 back to front), a quarter of the front length apart. No head and no
 * trail; 0.3 s fades; at most 600.
 *
 * `segs` holds MARK_SEGS_PER_SET segments per drawn set, crest by crest from
 * the back, each crest drawn from its centre out (see MARK_SEG_FLOATS).
 */
export class CrestMarks {
  // `declare`d and set in the constructor: no lowered class field (FlowClock).
  declare readonly field: FlowField;
  /** The direction field the sets read (waveDirections of `field`). */
  declare readonly directions: FlowField;
  declare private readonly rng: Rng;
  declare readonly x: Float64Array;
  declare readonly y: Float64Array;
  declare readonly age: Float32Array;
  /** Each set's life, cut at spawn: MARK_MIN_LIFE_S to MARK_LIFE_S. */
  declare readonly life: Float32Array;
  declare readonly alive: Uint8Array;
  /** Steps a set waits, unplaced, before it first appears after a reset (the stagger). */
  declare readonly wait: Uint8Array;
  /** The travel direction (Mercator axes, unit) each set holds for its life. */
  declare readonly dirX: Float64Array;
  declare readonly dirY: Float64Array;
  /** The height class each set holds for its life. */
  declare readonly cls: Uint8Array;
  /** Mercator units per CSS px when the set appeared: its path and shape were checked at that scale. */
  declare readonly unit: Float64Array;
  declare readonly segs: Float32Array;
  declare count: number;
  declare segCount: number;
  declare originX: number;
  declare originY: number;

  constructor(field: FlowField, rng: Rng = Math.random) {
    this.field = field;
    this.directions = waveDirections(field);
    this.rng = rng;
    this.x = new Float64Array(MAX_MARKS);
    this.y = new Float64Array(MAX_MARKS);
    this.age = new Float32Array(MAX_MARKS);
    this.life = new Float32Array(MAX_MARKS);
    this.alive = new Uint8Array(MAX_MARKS);
    this.wait = new Uint8Array(MAX_MARKS);
    this.dirX = new Float64Array(MAX_MARKS);
    this.dirY = new Float64Array(MAX_MARKS);
    this.cls = new Uint8Array(MAX_MARKS);
    this.unit = new Float64Array(MAX_MARKS);
    this.segs = new Float32Array(MAX_MARKS * MARK_SEGS_PER_SET * MARK_SEG_FLOATS);
    this.count = 0;
    this.segCount = 0;
    this.originX = 0;
    this.originY = 0;
  }

  setCount(view: ViewQuad, densityFactor: number): void {
    this.count = markCount(view, densityFactor);
  }

  /**
   * Steps along the straight path from (x0, y0) that stay clear, up to a full
   * life and one more: every position inside the view, on water that agrees
   * (R at least 0.8) and turns no more than 20 degrees from the set's own
   * direction, with all three crests on cells of four valid corners. -1 when
   * the set cannot stand where it starts.
   */
  private clearSteps(x0: number, y0: number, tx: number, ty: number, front: number, unit: number, view: ViewQuad): number {
    const d = WAVE_RATE_PX_PER_S * STEP_S * unit;
    for (let n = 0; n <= LIFE_STEPS + 1; n++) {
      const x = x0 + tx * d * n;
      const y = y0 + ty * d * n;
      if (n > 0) {
        if (!insideView(view, x, y)) return n - 1;
        const s = sampleField(this.directions, lonOf(x), latOf(y), tmpSample);
        if (!s) return n - 1;
        const agreement = Math.hypot(s.u, s.v);
        if (agreement < MARK_MIN_AGREEMENT || (s.u * tx - s.v * ty) / agreement < COS_MAX_TURN) return n - 1;
      }
      for (let k = 0; k < MARK_CRESTS; k++) {
        // Once the set has gone a front length, the shorter crests behind lie on ground the front crest has
        // already cleared (they need 0.56 of it: two gaps plus their deeper bow), so only the front is checked.
        if (k < MARK_CRESTS - 1 && n * d >= front) continue;
        setCrest(x, y, tx, ty, front, k);
        if (!crestClear(this.field)) return n - 1;
      }
    }
    return LIFE_STEPS + 1;
  }

  private spawn(i: number, view: ViewQuad): void {
    const unit = 1 / view.worldSize;
    for (let t = 0; t < 4; t++) {
      viewPoint(view, this.rng(), this.rng(), spawnPoint);
      const x = spawnPoint[0] as number;
      const y = spawnPoint[1] as number;
      const s = sampleField(this.directions, lonOf(x), latOf(y), tmpSample);
      if (!s) continue;
      const agreement = Math.hypot(s.u, s.v);
      if (agreement < MARK_MIN_AGREEMENT) continue;
      const tx = s.u / agreement;
      const ty = -s.v / agreement; // travel in Mercator axes (y south)
      const cls = classOf(this.field.kind, s.m);
      // One step short of the clear path, so float rounding of the age never moves a set past it.
      const life = Math.min(MARK_LIFE_S, (this.clearSteps(x, y, tx, ty, MARK_LENGTH_PX[cls] * unit, unit, view) - 1) * STEP_S);
      if (life < MARK_MIN_LIFE_S) continue;
      this.x[i] = x;
      this.y[i] = y;
      this.dirX[i] = tx;
      this.dirY[i] = ty;
      this.cls[i] = cls;
      this.unit[i] = unit;
      this.life[i] = life;
      this.age[i] = 0;
      this.alive[i] = 1;
      return;
    }
    this.alive[i] = 0;
  }

  /**
   * Start over in this view: every set young (fading in). In motion, first
   * appearances are staggered over a second, and each set is placed (its path
   * checked) only when its wait ends, so a start spreads its spawn work.
   */
  reset(view: ViewQuad): void {
    const [cx, cy] = viewCenter(view);
    this.originX = cx;
    this.originY = cy;
    this.alive.fill(0);
    for (let i = 0; i < this.count; i++) this.wait[i] = Math.floor(this.rng() * (LIFE_STEPS / 2));
    this.segCount = 0;
  }

  /** One fixed step; `dt` is STEP_S in the moving form and 0 for the still marks (no motion, every set drawn). */
  step(view: ViewQuad, dt: number = STEP_S): void {
    const [cx, cy] = viewCenter(view);
    this.originX = cx;
    this.originY = cy;
    const segs = this.segs;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i] || (this.age[i] as number) >= (this.life[i] as number)) {
        if (dt > 0 && (this.wait[i] as number) > 0) {
          this.wait[i] = (this.wait[i] as number) - 1;
          continue;
        }
        this.spawn(i, view);
      }
      if (!this.alive[i]) continue;
      const tx = this.dirX[i] as number;
      const ty = this.dirY[i] as number;
      const unit = this.unit[i] as number;
      if (dt > 0) {
        const d = WAVE_RATE_PX_PER_S * dt * unit;
        this.x[i] = (this.x[i] as number) + tx * d;
        this.y[i] = (this.y[i] as number) + ty * d;
        this.age[i] = (this.age[i] as number) + dt;
        // The path was checked in the view the set appeared in; a pan that leaves it behind ends it.
        if (!insideView(view, this.x[i] as number, this.y[i] as number)) {
          this.alive[i] = 0;
          continue;
        }
      }
      const a = fadeAlpha(this.age[i] as number, this.life[i] as number);
      const cls = this.cls[i] as FlowClass;
      const front = MARK_LENGTH_PX[cls] * unit;
      for (let k = 0; k < MARK_CRESTS; k++) {
        setCrest(this.x[i] as number, this.y[i] as number, tx, ty, front, k);
        const w = MARK_CREST_WEIGHT[k] as number;
        const centre = CREST_SEGS / 2;
        // Drawn from the centre out, each side to its end.
        for (let side = -1; side <= 1; side += 2) {
          for (let j = 0; j < centre; j++) {
            const inner = centre + side * j;
            const outer = inner + side;
            const o = n * MARK_SEG_FLOATS;
            segs[o] = (crestPts[inner * 2] as number) - cx;
            segs[o + 1] = (crestPts[inner * 2 + 1] as number) - cy;
            segs[o + 2] = (crestPts[outer * 2] as number) - cx;
            segs[o + 3] = (crestPts[outer * 2 + 1] as number) - cy;
            segs[o + 4] = cls;
            segs[o + 5] = a;
            segs[o + 6] = crestWidth(w, j / centre);
            segs[o + 7] = crestWidth(w, (j + 1) / centre);
            n++;
          }
        }
      }
    }
    this.segCount = n;
  }
}
