/**
 * The scalar drawing path of the ENSO "Ocean & atmosphere" control
 * (admission gfs-runtime-nodd, 2026-10-13, product (b)): a field with one
 * value at each node and no direction, drawn as a still shade and never as
 * paths. The one scalar kind is NOAA GFS precipitable water.
 *
 * - The shade is one hue, white, whose opacity rises in steps with the
 *   value and is nothing under the first bin, so dry air shows the map and
 *   the sea surface temperature colours beneath it. White is in no class of
 *   the SST anomaly scale (src/config/palette.ts SST_ANOMALY_SCALE runs
 *   purple through green and yellow to maroon), and the deepest step covers
 *   less than half of what lies under it.
 * - The picture is DDM's drawing of the decoded values, not an issuer image.
 * - It is made once from a frame (`shadePixels`), never on a pan: a square
 *   image whose rows are evenly spaced in Web Mercator, each pixel the
 *   bilinear value of the four grid nodes around its centre, classed after
 *   the blend. MapLibre stretches an image source linearly between its
 *   corners in Mercator, so a latitude/longitude grid handed over as it is
 *   would sit at the wrong latitudes.
 * - The date line: columns wrap (the grid's last column joins its first),
 *   and the image's first and last columns both take the value at 180
 *   itself, so neighbouring world copies meet at one value.
 * - The poles: Web Mercator ends at 85.05 degrees and the image ends with
 *   it. The rows at 90 N and 90 S, where every node is one point, are never
 *   drawn.
 */

import { MERCATOR_MAX_LAT, latOf, type FlowGrid, type FlowMeta } from './field';

/** `pwat` is NOAA GFS precipitable water. Every table keyed by ScalarKind needs a row per kind. */
export type ScalarKind = 'pwat';

export interface ScalarField {
  readonly kind: ScalarKind;
  /** A global grid (`wrapsLon`), in GRIB scan order as FlowField's is. */
  readonly grid: FlowGrid;
  /** Real units (`meta.units`), one value at each node; every node holds one. */
  readonly values: Float32Array;
  readonly meta: FlowMeta;
}

/**
 * Display bins, not thresholds and not issuer classes (the `.idx` carries
 * none): the number of bins a value reaches picks its step. Precipitable
 * water 15, 30 and 45 kg m-2, even slices of a field that ran 0.1 to 83.9
 * kg m-2 on the 2026-10-05 06Z fixture. By area the four steps hold 35, 26,
 * 20 and 19 percent of the globe there (35, 28, 19 and 18 on 2026-10-13
 * 12Z), so a third of the globe, and half of 30 N to 60 N, carries no shade.
 * A design choice: no number is taken from a definition of any weather
 * feature (admission gfs-runtime-nodd, 2026-10-13, (b) line 12).
 */
export const SHADE_BINS: Readonly<Record<ScalarKind, readonly number[]>> = { pwat: [15, 30, 45] };

/** The opacity of each step, none first. The deepest stays under half, so what lies beneath still reads. */
export const SHADE_ALPHA: readonly number[] = [0, 0.14, 0.28, 0.42];

/** The one hue, as red, green and blue bytes. */
export const SHADE_RGB: readonly [number, number, number] = [255, 255, 255];

/** True for a kind drawn as a shade: it has a row of bins. */
export const isScalarKind = (kind: string): kind is ScalarKind => Object.hasOwn(SHADE_BINS, kind);

/** The step of `value`: the number of the kind's bins it reaches, 0 (no shade) to the bin count. */
export function shadeClass(kind: ScalarKind, value: number): number {
  let reached = 0;
  for (const bin of SHADE_BINS[kind]) if (value >= bin) reached++;
  return reached;
}

/** The image's side in pixels: half a degree of longitude each, twice the 1.0 degree grid. */
export const SHADE_IMAGE_SIZE = 720;

/** The image's corners, clockwise from the north-west: the whole Web Mercator world. */
export const SHADE_COORDINATES: [[number, number], [number, number], [number, number], [number, number]] = [
  [-180, MERCATOR_MAX_LAT], [180, MERCATOR_MAX_LAT], [180, -MERCATOR_MAX_LAT], [-180, -MERCATOR_MAX_LAT]
];

/**
 * The shade of `field` as `size` x `size` RGBA bytes (straight alpha), rows
 * north to south and evenly spaced in Web Mercator between its two limits,
 * columns west to east from 180 W. Nothing is extrapolated: every pixel lies
 * between four nodes of the grid.
 */
export function shadePixels(field: ScalarField, size: number = SHADE_IMAGE_SIZE): Uint8ClampedArray<ArrayBuffer> {
  const { grid: g, kind, values } = field;
  if (!g.wrapsLon || g.ny < 2 || values.length !== g.nx * g.ny) throw new Error('shade: the field is not a whole global grid');
  const alpha = SHADE_ALPHA.map((a) => Math.round(a * 255));
  // Each image column's two grid columns and the weight of the eastern one.
  const west = new Int32Array(size);
  const east = new Int32Array(size);
  const weight = new Float64Array(size);
  for (let px = 0; px < size; px++) {
    // Both edge columns read 180 itself, so the world copies on either side meet at one value.
    const lon = px === 0 || px === size - 1 ? 180 : ((px + 0.5) / size) * 360 - 180;
    const fx = ((((lon - g.lon0) % 360) + 360) % 360) / g.dlon;
    const column = Math.floor(fx);
    west[px] = column % g.nx;
    east[px] = (column + 1) % g.nx;
    weight[px] = fx - column;
  }
  const out = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    const fy = Math.min(Math.max((g.lat0 - latOf((py + 0.5) / size)) / g.dlat, 0), g.ny - 1);
    const row = Math.min(Math.floor(fy), g.ny - 2);
    const south = fy - row;
    const r0 = row * g.nx;
    const r1 = r0 + g.nx;
    for (let px = 0; px < size; px++) {
      const a = west[px] as number;
      const b = east[px] as number;
      const t = weight[px] as number;
      const top = (values[r0 + a] as number) * (1 - t) + (values[r0 + b] as number) * t;
      const bottom = (values[r1 + a] as number) * (1 - t) + (values[r1 + b] as number) * t;
      const step = alpha[shadeClass(kind, top * (1 - south) + bottom * south)] as number;
      if (step === 0) continue;
      const o = (py * size + px) * 4;
      out[o] = SHADE_RGB[0];
      out[o + 1] = SHADE_RGB[1];
      out[o + 2] = SHADE_RGB[2];
      out[o + 3] = step;
    }
  }
  return out;
}
