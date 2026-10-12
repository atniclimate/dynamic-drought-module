/**
 * Which pixels of one Web Mercator tile lie inside a set of polygons.
 *
 * Used by the Wildfire 3D fuel-risk drape (`src/layers/whp-shade-protocol.ts`)
 * to draw nothing inside a fire perimeter. Pure and dependency-free (no
 * MapLibre, no DOM), so the fill is unit-testable in Node without a browser.
 *
 * Even-odd scanline fill, sampled at pixel centres: the rule of
 * `src/util/point-in-polygon.ts`, which is the test's oracle, without asking
 * every edge about every pixel. Each polygon's rings toggle one another (a
 * hole is outside); separate polygons add, so ground inside two overlapping
 * perimeters is inside. Edges are straight in Web Mercator, as the map draws
 * them. Antimeridian-naive, like the point test.
 */

import type { Position } from 'geojson';

/**
 * One byte per pixel of the tile `[z, x, y]`, row by row, 1 where the pixel's
 * centre is inside a polygon. Null when no polygon comes near the tile; null
 * and a mask of zeros mean the same. `polygons` are GeoJSON polygon
 * coordinates (an outer ring, then its holes) in `[lon, lat]`; `size` is the
 * tile's width and height in pixels.
 */
export function tilePolygonMask(
  polygons: readonly Position[][][],
  [z, x, y]: readonly number[],
  size: number
): Uint8Array | null {
  const scale = size * 2 ** z;
  const column = (lon: number): number => ((lon + 180) / 360) * scale - x * size;
  const row = (lat: number): number =>
    (0.5 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / (2 * Math.PI)) * scale - y * size;
  /** The first pixel whose centre is at or past `edge`, kept within the tile. */
  const first = (edge: number): number => Math.min(size, Math.max(0, Math.ceil(edge - 0.5)));
  let mask: Uint8Array | null = null;
  for (const polygon of polygons) {
    // Most perimeters miss most tiles. The outer ring's span of columns
    // decides first: longitude is linear, so this costs no trigonometry.
    // shortcut: a polygon due north or south of the tile is still projected
    // in full; test its rows too if perimeter sets grow past ~100,000 vertices.
    let west = size;
    let east = 0;
    for (const point of polygon[0] ?? []) {
      const c = column(point[0]!);
      west = Math.min(west, c);
      east = Math.max(east, c);
    }
    if (east <= 0 || west >= size) continue;

    // Where each pixel row's centre line crosses the polygon's edges.
    const crossings: number[][] = [];
    for (const ring of polygon) {
      const last = ring.at(-1);
      if (!last) continue;
      let ax = column(last[0]!);
      let ay = row(last[1]!);
      for (const point of ring) {
        const bx = column(point[0]!);
        const by = row(point[1]!);
        // Half-open, so a vertex on a centre line counts for one edge only.
        const end = first(Math.max(ay, by));
        for (let r = first(Math.min(ay, by)); r < end; r += 1) {
          const columns = crossings[r] ?? [];
          crossings[r] = columns;
          columns.push(ax + ((r + 0.5 - ay) * (bx - ax)) / (by - ay));
        }
        ax = bx;
        ay = by;
      }
    }
    crossings.forEach((columns, r) => {
      columns.sort((a, b) => a - b);
      for (let i = 0; i + 1 < columns.length; i += 2) {
        mask ??= new Uint8Array(size * size);
        mask.fill(1, r * size + first(columns[i]!), r * size + first(columns[i + 1]!));
      }
    });
  }
  return mask;
}
