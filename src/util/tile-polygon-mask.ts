/**
 * How much of each pixel of one Web Mercator tile lies inside a set of polygons.
 *
 * Used by the Wildfire 3D fuel-risk drape (`src/layers/whp-shade-protocol.ts`)
 * to fade fuel risk out across a fire perimeter and draw none inside it. Pure
 * and dependency-free (no MapLibre, no DOM), so the fill is unit-testable in
 * Node without a browser.
 *
 * Even-odd scanline fill, the rule of `src/util/point-in-polygon.ts` (which is
 * the test's oracle), on `LINES` sample lines through each pixel row. Along a
 * line the filled span is exact, so the pixel a span ends in gets the part of
 * its width the span covers; down a row the share is a count of lines, so an
 * edge across a pixel is placed to within half a line. Each polygon's rings
 * toggle one another (a hole is outside); separate polygons add, up to the
 * whole pixel, so ground inside two overlapping perimeters is inside. Edges
 * are straight in Web Mercator, as the map draws them. Antimeridian-naive,
 * like the point test.
 */

import type { Position } from 'geojson';

/** Sample lines per pixel row. A polygon thinner than a line's spacing can fall between two and count for nothing. */
const LINES = 4;

/**
 * One byte per pixel of the tile `[z, x, y]`, row by row: the share of the
 * pixel inside a polygon, 0 for none of it to 255 for all of it. Null when no
 * polygon comes near the tile; null and a mask of zeros mean the same.
 * `polygons` are GeoJSON polygon coordinates (an outer ring, then its holes)
 * in `[lon, lat]`; `size` is the tile's width and height in pixels.
 */
export function tilePolygonMask(
  polygons: readonly Position[][][],
  [z, x, y]: readonly number[],
  size: number
): Uint8ClampedArray | null {
  const scale = size * 2 ** z;
  const column = (lon: number): number => ((lon + 180) / 360) * scale - x * size;
  /** In sample lines from the tile's north edge, not pixels. */
  const line = (lat: number): number =>
    ((0.5 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / (2 * Math.PI)) * scale - y * size) * LINES;
  const within = (value: number, most: number): number => Math.min(most, Math.max(0, value));
  /** The first sample line whose centre is at or past `edge`, kept within the tile. */
  const first = (edge: number): number => within(Math.ceil(edge - 0.5), size * LINES);
  /** A crossing is one number, `line * stride + column`: one sort then orders every line's crossings. */
  const stride = size + 1;
  let shares: Float32Array | null = null;
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

    // Where each sample line crosses the polygon's edges, kept within the tile's columns.
    const crossings: number[] = [];
    for (const ring of polygon) {
      const last = ring.at(-1);
      if (!last) continue;
      let ax = column(last[0]!);
      let ay = line(last[1]!);
      for (const point of ring) {
        const bx = column(point[0]!);
        const by = line(point[1]!);
        // Half-open, so a vertex on a sample line counts for one edge only.
        const end = first(Math.max(ay, by));
        for (let l = first(Math.min(ay, by)); l < end; l += 1) {
          crossings.push(l * stride + within(ax + ((l + 0.5 - ay) * (bx - ax)) / (by - ay), size));
        }
        ax = bx;
        ay = by;
      }
    }
    // A closed ring crosses a line an even number of times, so sorted crossings pair up line by line.
    const sorted = new Float64Array(crossings).sort();
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      const l = Math.floor(sorted[i]! / stride);
      const from = sorted[i]! - l * stride;
      const to = sorted[i + 1]! - l * stride;
      shares ??= new Float32Array(size * size);
      for (let c = Math.floor(from); c < to; c += 1) {
        shares[Math.floor(l / LINES) * size + c]! += ((Math.min(to, c + 1) - Math.max(from, c)) * 255) / LINES;
      }
    }
  }
  // Rounds, and stops overlapping polygons at the whole pixel.
  return shares && new Uint8ClampedArray(shares);
}
