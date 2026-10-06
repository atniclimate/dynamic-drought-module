/**
 * The still form and the past-grid arrows (design/moving-paths.md sections 3
 * and 4; block E1 unit E1-3), as GeoJSON for three native MapLibre line
 * layers on one source: `flow-still-casing` (every feature), `flow-still`
 * (paths) and `flow-still-marks` (crest marks and node arrows). Native lines
 * drape under terrain 3D, print, and need no WebGL2 of their own.
 *
 * - Seeds come from a jittered grid at the moving form's density, drawn from
 *   a seeded PRNG keyed by field, valid time and view, so one seed and view
 *   always give the same lines.
 * - Each seed is integrated forward 1.2 s of display pace with the moving
 *   form's own `advance()` (same pace, same mask, same kill before commit),
 *   then cut into 3 pieces of stepped width, tail to head, with a 6 px
 *   chevron head. Same ink, classes and widths as the moving form.
 * - Waves draw as static crest marks, the same marks the moving form draws.
 * - Past 384 CSS px per model cell, one 18 px arrow (6 px head) per valid
 *   grid node in view replaces the paths: nothing is interpolated there.
 */
import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import { type FlowClass, type FlowField, type FlowSample, classOf, latOf, lonOf, mercX, mercY, newSample, nodeLonLat, sampleField } from './field';
import {
  type FlowForm, type ViewQuad, CrestMarks, STEP_S, advance, insideView, mulberry32, paceFor, viewPoint, CSS_PX2_PER_PARTICLE
} from './advect';
import { FLOW_CASING_ALPHA, FLOW_CASING_WIDTH_PX, FLOW_CORE_WIDTH_PX, FLOW_INK, type FlowInkName } from './ink';

export const STILL_SOURCE_ID = 'flow-still';
export const STILL_LAYER_IDS = {
  casing: 'flow-still-casing',
  paths: 'flow-still',
  marks: 'flow-still-marks'
} as const;

/** Seconds of display pace each still path integrates. */
export const STILL_SECONDS = 1.2;
/** Width factor of the three pieces, tail to head. */
export const STILL_PIECE_WIDTH: readonly [number, number, number] = [0.5, 0.75, 1];
export const CHEVRON_PX = 6;
export const NODE_ARROW_PX = 18;
export const NODE_ARROW_HEAD_PX = 6;
/** A past-grid view never draws more node arrows than this. */
export const MAX_NODE_ARROWS = 400;

export type StillRole = 'path' | 'mark';

export interface StillProperties {
  readonly role: StillRole;
  readonly cls: FlowClass;
  /** 0..2 the three path pieces tail to head, 3 the chevron; marks are 2. */
  readonly piece: number;
  /** Core width, CSS px. */
  readonly w: number;
}

export type StillFeature = GeoJSON.Feature<GeoJSON.LineString, StillProperties>;
export type StillCollection = GeoJSON.FeatureCollection<GeoJSON.LineString, StillProperties>;

/** FNV-1a over the field's identity and the view, so the seed is stable for one frame and view. */
export function stillSeed(field: FlowField, view: ViewQuad): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    const s = String(n);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(field.meta.validTime);
  mix(field.kind === 'waves' ? 2 : 1);
  for (let i = 0; i < 8; i++) mix(Math.round((view.c[i] as number) * 1e7));
  mix(Math.round(view.worldSize));
  mix(view.cssW);
  mix(view.cssH);
  return h >>> 0;
}

function feature(coordinates: number[][], properties: StillProperties): StillFeature {
  return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates } };
}

const scratch: FlowSample = newSample();

/** Wind still paths: seeded jittered grid, 1.2 s forward with the moving form's step. */
function stillPaths(field: FlowField, view: ViewQuad, seed: number, densityFactor: number): StillFeature[] {
  const rng = mulberry32(seed);
  const pace = paceFor(field.kind);
  const spacing = Math.sqrt(CSS_PX2_PER_PARTICLE / Math.max(densityFactor, 1e-3));
  const cols = Math.max(1, Math.floor(view.cssW / spacing));
  const rows = Math.max(1, Math.floor(view.cssH / spacing));
  const steps = Math.round(STILL_SECONDS / STEP_S);
  const out: StillFeature[] = [];
  const p = new Float64Array(2);
  const next = new Float64Array(4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      viewPoint(view, (c + rng()) / cols, (r + rng()) / rows, p);
      let x = p[0] as number;
      let y = p[1] as number;
      const lon0 = lonOf(x);
      const lat0 = latOf(y);
      const s0 = sampleField(field, lon0, lat0, scratch);
      if (!s0) continue;
      const cls = classOf(field.kind, s0.m);
      const xs: number[] = [x];
      const ys: number[] = [y];
      const coords: number[][] = [[lon0, lat0]];
      for (let i = 0; i < steps; i++) {
        if (!advance(field, pace, view.worldSize, x, y, STEP_S, next)) break; // never cross a mask
        if (!insideView(view, next[0] as number, next[1] as number)) break;
        x = next[0] as number;
        y = next[1] as number;
        xs.push(x);
        ys.push(y);
        coords.push([next[2] as number, next[3] as number]);
      }
      if (xs.length < 4) continue;
      const third = Math.floor((coords.length - 1) / 3);
      for (let piece = 0; piece < 3; piece++) {
        const a = piece * third;
        const b = piece === 2 ? coords.length - 1 : (piece + 1) * third;
        out.push(feature(coords.slice(a, b + 1), {
          role: 'path', cls, piece, w: FLOW_CORE_WIDTH_PX[cls] * (STILL_PIECE_WIDTH[piece] as number)
        }));
      }
      // Chevron head: two 6 CSS px strokes back from the head at +-30 degrees.
      const n = xs.length - 1;
      const hx = xs[n] as number;
      const hy = ys[n] as number;
      const dx = hx - (xs[n - 1] as number);
      const dy = hy - (ys[n - 1] as number);
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const L = CHEVRON_PX / view.worldSize;
      const wing = (ang: number): number[] => {
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        return [lonOf(hx - (ux * ca - uy * sa) * L), latOf(hy - (ux * sa + uy * ca) * L)];
      };
      out.push(feature([wing(Math.PI / 6), [lonOf(hx), latOf(hy)], wing(-Math.PI / 6)], {
        role: 'path', cls, piece: 3, w: FLOW_CORE_WIDTH_PX[cls]
      }));
    }
  }
  return out;
}

/** Wave still: the moving form's crest marks, placed by the seeded PRNG and not moved. */
function stillMarks(field: FlowField, view: ViewQuad, seed: number, densityFactor: number): StillFeature[] {
  const marks = new CrestMarks(field, mulberry32(seed));
  marks.setCount(view, densityFactor);
  marks.reset(view);
  marks.step(view, 0);
  const out: StillFeature[] = [];
  const s = marks.segs;
  for (let i = 0; i < marks.segCount; i++) {
    const o = i * 6;
    const cls = s[o + 4] as FlowClass;
    out.push(feature([
      [lonOf((s[o] as number) + marks.originX), latOf((s[o + 1] as number) + marks.originY)],
      [lonOf((s[o + 2] as number) + marks.originX), latOf((s[o + 3] as number) + marks.originY)]
    ], { role: 'mark', cls, piece: 2, w: FLOW_CORE_WIDTH_PX[cls] }));
  }
  return out;
}

/** Grid nodes inside the actual view, before any mask or direction filtering. */
function* modelNodesInView(field: FlowField, view: ViewQuad): Generator<readonly [number, number, number]> {
  const g = field.grid;
  const c = view.c;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    minX = Math.min(minX, c[i * 2] as number);
    maxX = Math.max(maxX, c[i * 2] as number);
    minY = Math.min(minY, c[i * 2 + 1] as number);
    maxY = Math.max(maxY, c[i * 2 + 1] as number);
  }
  const lonMin = lonOf(minX);
  const lonMax = lonOf(maxX);
  const latMax = latOf(minY);
  const latMin = latOf(maxY);
  const rowFirst = Math.max(0, Math.ceil((g.lat0 - latMax) / g.dlat - 1e-9));
  const rowLast = Math.min(g.ny - 1, Math.floor((g.lat0 - latMin) / g.dlat + 1e-9));
  const kFirst = Math.ceil((lonMin - g.lon0) / g.dlon - 1e-9);
  const kLast = Math.floor((lonMax - g.lon0) / g.dlon + 1e-9);
  for (let row = rowFirst; row <= rowLast; row++) {
    for (let k = kFirst; k <= kLast; k++) {
      let column = k;
      if (g.wrapsLon) column = ((k % g.nx) + g.nx) % g.nx;
      else {
        // A box measures columns east of its origin, across 180 when it crosses it.
        column = ((k % Math.round(360 / g.dlon)) + Math.round(360 / g.dlon)) % Math.round(360 / g.dlon);
        if (column > g.nx - 1) continue;
      }
      const [lonNode, lat] = nodeLonLat(g, column, row);
      // Unwrap the node's x into the view's range.
      let x = mercX(lonNode);
      while (x < minX - 1e-9) x += 1;
      while (x > maxX + 1e-9) x -= 1;
      const y = mercY(lat);
      if (!insideView(view, x, y)) continue;
      yield [row * g.nx + column, x, y];
    }
  }
}

/** Whether a model node exists in view, including calm and masked nodes. */
export function hasModelNodeInView(field: FlowField, view: ViewQuad): boolean {
  return modelNodesInView(field, view).next().done === false;
}

/**
 * Past the grid: one arrow per valid node in view, anchored on the node and
 * pointing the way the field moves (TO), in the class ink and width. The
 * node's own values, nothing interpolated.
 */
export function nodeArrows(field: FlowField, view: ViewQuad): StillFeature[] {
  const out: StillFeature[] = [];
  const half = NODE_ARROW_PX / 2 / view.worldSize;
  const head = NODE_ARROW_HEAD_PX / view.worldSize;
  for (const [i, x, y] of modelNodesInView(field, view)) {
    if (out.length >= MAX_NODE_ARROWS) return out;
    if (field.mask[i] !== 1) continue;
    const u = field.u[i] as number;
    const v = field.v[i] as number;
    const norm = Math.hypot(u, v);
    if (norm < 1e-6) continue;
    const tx = u / norm;
    const ty = -v / norm;
    const cls = classOf(field.kind, field.magnitude[i] as number);
    const tipX = x + tx * half;
    const tipY = y + ty * half;
    const wing = (ang: number): number[] => {
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      return [lonOf(tipX - (tx * ca - ty * sa) * head), latOf(tipY - (tx * sa + ty * ca) * head)];
    };
    const w = FLOW_CORE_WIDTH_PX[cls];
    out.push(feature([[lonOf(x - tx * half), latOf(y - ty * half)], [lonOf(tipX), latOf(tipY)]], { role: 'mark', cls, piece: 2, w }));
    out.push(feature([wing(Math.PI / 6), [lonOf(tipX), latOf(tipY)], wing(-Math.PI / 6)], { role: 'mark', cls, piece: 3, w }));
  }
  return out;
}

export interface StillOptions {
  /** Defaults to stillSeed(field, view). */
  readonly seed?: number;
  /** Density factor from planForm (1 = Standard). */
  readonly densityFactor?: number;
}

/**
 * The GeoJSON for the still layers in one form: still paths (wind), static
 * crest marks (waves), or node arrows past the grid. The moving form draws
 * nothing here.
 */
export function buildStillForm(field: FlowField, view: ViewQuad, form: FlowForm, options: StillOptions = {}): StillCollection {
  if (form === 'moving') return { type: 'FeatureCollection', features: [] };
  if (form === 'arrows') return { type: 'FeatureCollection', features: nodeArrows(field, view) };
  const seed = options.seed ?? stillSeed(field, view);
  const density = options.densityFactor ?? 1;
  const features = field.kind === 'waves' ? stillMarks(field, view, seed, density) : stillPaths(field, view, seed, density);
  return { type: 'FeatureCollection', features };
}

/** The three native layers for the still source, in draw order (casing first). */
export function stillLayers(ink: FlowInkName, sourceId: string = STILL_SOURCE_ID): LayerSpecification[] {
  const t = FLOW_INK[ink];
  const color: ExpressionSpecification = ['match', ['get', 'cls'], 0, t.core[0], 1, t.core[1], t.core[2]];
  const width: ExpressionSpecification = ['get', 'w'];
  const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  return [
    {
      id: STILL_LAYER_IDS.casing, type: 'line', source: sourceId, layout,
      paint: {
        'line-color': t.casing,
        'line-opacity': FLOW_CASING_ALPHA,
        'line-width': ['+', ['get', 'w'], 2 * FLOW_CASING_WIDTH_PX]
      }
    },
    {
      id: STILL_LAYER_IDS.paths, type: 'line', source: sourceId, layout,
      filter: ['==', ['get', 'role'], 'path'],
      paint: { 'line-color': color, 'line-width': width }
    },
    {
      id: STILL_LAYER_IDS.marks, type: 'line', source: sourceId, layout,
      filter: ['==', ['get', 'role'], 'mark'],
      paint: { 'line-color': color, 'line-width': width }
    }
  ];
}
