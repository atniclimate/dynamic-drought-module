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
 * - Pace is linear in the field's own speed for wind (4 CSS px/s per m/s) and
 *   one uniform display rate for waves (24 CSS px/s; ruling R5 a). Wave
 *   height sets only the class and the mark length, never the rate.
 * - A step is sub-stepped when it would move more than half a cell. It is
 *   refused, and the particle respawns, when any sub-step or the drawn chord
 *   touches a cell without four valid corners: kill before commit, so no
 *   drawn segment crosses a masked cell.
 */
import {
  type FlowClass, type FlowField, type FlowKind, type FlowSample,
  cellValid, classOf, gridPosition, latOf, lonOf, newSample, sampleField
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

export const DENSITY_FACTORS = { sparse: 0.5, standard: 1, dense: 2 } as const;
export type FlowDensity = keyof typeof DENSITY_FACTORS;

/** Wave crest marks (moving-paths section 9). */
export const MAX_MARKS = 600;
export const MARK_LIFE_S = 2;
/** Crest length in CSS px by height class. */
export const MARK_LENGTH_PX: readonly [number, number, number] = [6, 9, 12];
/** Head length in CSS px, on the travel side. */
export const MARK_HEAD_PX = 3;
const CSS_PX2_PER_MARK = 2048;

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

export function paceFor(kind: FlowKind): Pace {
  return kind === 'waves' ? WAVE_PACE : WIND_PACE;
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
 * `nearX` (the previous origin, or the view centre), so a view across the
 * antimeridian is one continuous quad.
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
  /** The viewer pressed Play (the phone rail starts still until then). */
  readonly playPressed?: boolean;
  readonly density?: FlowDensity;
}

export interface FormPlan {
  readonly form: FlowForm;
  /** Density factor (1 = one particle per 1,024 CSS px squared). */
  readonly densityFactor: number;
}

/**
 * Which form draws for this field and view (moving-paths sections 4, 5, 13).
 * Past 384 CSS px per cell it is always arrows at the nodes. On a phone-width
 * view it is still, at half density, until Play is pressed.
 */
export function planForm(field: FlowField, view: ViewQuad, options: FormOptions): FormPlan {
  const phone = view.cssW <= PHONE_MAX_WIDTH_PX;
  const densityFactor = DENSITY_FACTORS[options.density ?? 'standard'] * (phone ? PHONE_DENSITY_FACTOR : 1);
  if (cellPx(field, view) > PAST_GRID_CELL_PX) return { form: 'arrows', densityFactor };
  if (!options.motionAllowed) return { form: 'still', densityFactor };
  if (phone && !options.playPressed) return { form: 'still', densityFactor };
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
  private last = -1;

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
  readonly field: FlowField;
  readonly pace: Pace;
  private readonly rng: Rng;
  capacity = 0;
  count = 0;
  x = new Float64Array(0);
  y = new Float64Array(0);
  age = new Float32Array(0);
  life = new Float32Array(0);
  gen = new Uint32Array(0);
  cls = new Uint8Array(0);
  alive = new Uint8Array(0);
  ring = new Float32Array(0);
  /** The slot the last step wrote. */
  head = SLOTS - 1;
  /** The Mercator origin the ring positions are relative to. */
  originX = 0;
  originY = 0;
  /** Set when the whole ring must be uploaded (reset, rebase, growth). */
  ringDirty = true;
  private nextGen = 1;

  constructor(field: FlowField, pace: Pace, rng: Rng = Math.random) {
    this.field = field;
    this.pace = pace;
    this.rng = rng;
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

/**
 * Wave crest marks (R5 a): short crests perpendicular to travel with a small
 * head on the travel side, no trail, a 2 s life with 0.3 s fades, at most
 * 600. Every mark moves at the one uniform rate; height sets only the class,
 * which sets brightness and crest length. A crest whose ends leave the valid
 * field is not drawn that step.
 *
 * `segs` holds two segments per drawn mark (crest, then head): x0, y0, x1,
 * y1 relative to the origin, class, alpha.
 */
export class CrestMarks {
  readonly field: FlowField;
  private readonly rng: Rng;
  readonly x = new Float64Array(MAX_MARKS);
  readonly y = new Float64Array(MAX_MARKS);
  readonly age = new Float32Array(MAX_MARKS);
  readonly alive = new Uint8Array(MAX_MARKS);
  /** The travel direction (Mercator, unit) and class of each mark at its last committed step. */
  readonly dirX = new Float32Array(MAX_MARKS);
  readonly dirY = new Float32Array(MAX_MARKS);
  readonly cls = new Uint8Array(MAX_MARKS);
  readonly segs = new Float32Array(MAX_MARKS * 2 * 6);
  count = 0;
  segCount = 0;
  originX = 0;
  originY = 0;

  constructor(field: FlowField, rng: Rng = Math.random) {
    this.field = field;
    this.rng = rng;
  }

  setCount(view: ViewQuad, densityFactor: number): void {
    this.count = markCount(view, densityFactor);
  }

  private spawn(i: number, view: ViewQuad): void {
    for (let t = 0; t < 4; t++) {
      viewPoint(view, this.rng(), this.rng(), spawnPoint);
      if (!sampleField(this.field, lonOf(spawnPoint[0] as number), latOf(spawnPoint[1] as number), tmpSample)) continue;
      this.x[i] = spawnPoint[0] as number;
      this.y[i] = spawnPoint[1] as number;
      // Staggered ages keep the 2 s lives from ending together.
      this.age[i] = -this.rng() * MARK_LIFE_S * 0.5;
      this.alive[i] = 1;
      return;
    }
    this.alive[i] = 0;
  }

  /** Start over in this view: every mark young (fading in), lives staggered. */
  reset(view: ViewQuad): void {
    const [cx, cy] = viewCenter(view);
    this.originX = cx;
    this.originY = cy;
    this.alive.fill(0);
    for (let i = 0; i < this.count; i++) this.spawn(i, view);
    this.segCount = 0;
  }

  /** One fixed step; `dt` is STEP_S in the moving form and 0 for the still marks. */
  step(view: ViewQuad, dt: number = STEP_S): void {
    const [cx, cy] = viewCenter(view);
    this.originX = cx;
    this.originY = cy;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i] || (this.age[i] as number) >= MARK_LIFE_S) this.spawn(i, view);
      if (!this.alive[i]) continue;
      let s: FlowSample | null;
      if (dt > 0) {
        s = advance(this.field, WAVE_PACE, view.worldSize, this.x[i] as number, this.y[i] as number, dt, stepPoint);
      } else {
        stepPoint[0] = this.x[i] as number;
        stepPoint[1] = this.y[i] as number;
        s = sampleField(this.field, lonOf(this.x[i] as number), latOf(this.y[i] as number), tmpSample);
      }
      if (!s || !insideView(view, stepPoint[0] as number, stepPoint[1] as number)) {
        this.alive[i] = 0;
        continue;
      }
      const norm = Math.hypot(s.u, s.v);
      if (norm < 1e-6) {
        this.alive[i] = 0;
        continue;
      }
      const px = stepPoint[0] as number;
      const py = stepPoint[1] as number;
      this.x[i] = px;
      this.y[i] = py;
      this.age[i] = (this.age[i] as number) + dt;
      const cls = classOf(this.field.kind, s.m);
      const tx = s.u / norm;
      const ty = -s.v / norm; // travel in Mercator axes (y south)
      this.dirX[i] = tx;
      this.dirY[i] = ty;
      this.cls[i] = cls;
      const age = Math.max(0, this.age[i] as number);
      const a = fadeAlpha(age, MARK_LIFE_S);
      // Mercator is conformal: the screen perpendicular is the Mercator perpendicular.
      const half = MARK_LENGTH_PX[cls] / 2 / view.worldSize;
      const head = MARK_HEAD_PX / view.worldSize;
      const ex0 = px - ty * half;
      const ey0 = py + tx * half;
      const ex1 = px + ty * half;
      const ey1 = py - tx * half;
      if (!chordClear(this.field, ex0, ey0, ex1, ey1) || !chordClear(this.field, px, py, px + tx * head, py + ty * head)) continue;
      const o = n * 6;
      const segs = this.segs;
      segs[o] = ex0 - cx; segs[o + 1] = ey0 - cy; segs[o + 2] = ex1 - cx; segs[o + 3] = ey1 - cy;
      segs[o + 4] = cls; segs[o + 5] = a;
      segs[o + 6] = px - cx; segs[o + 7] = py - cy; segs[o + 8] = px + tx * head - cx; segs[o + 9] = py + ty * head - cy;
      segs[o + 10] = cls; segs[o + 11] = a;
      n += 2;
    }
    this.segCount = n;
  }
}
