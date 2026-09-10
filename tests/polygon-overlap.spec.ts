import { test, expect } from '@playwright/test';
import type { Geometry } from 'geojson';

import { geometriesOverlap } from '../src/util/polygon-overlap';

/**
 * Pure-logic coverage for the spatial predicate that stops the place-conditions
 * card from attributing another place's warning to the clicked place (Codex
 * adversarial review 2026-09-10, finding 3; `src/util/polygon-overlap.ts`).
 *
 * The card retrieves NWS alert and NIFC perimeter candidates with the clicked
 * boundary's screen-space bounding BOX, deliberately, because both layers
 * outrank every boundary kind in the click precedence and a bare point query
 * makes their rows unreachable from a boundary popup. The box is therefore the
 * right retrieval shape and the wrong attribution shape, and this is the test
 * that has to tell those apart. No page and no map: synthetic geometries in
 * Node, so the concavity, hole, MultiPolygon-gap and crossing cases are pinned
 * deterministically.
 */

const square = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0]
];

const polygon = (...rings: number[][][]): Geometry => ({ type: 'Polygon', coordinates: rings });

test.describe('geometriesOverlap', () => {
  test('the review\'s own failure case: inside the bounding box, outside the polygon', () => {
    // The nonsovereign triangle and the Red Flag square from finding 3. The
    // square sits wholly below the hypotenuse (which runs lat = lng + 156, so
    // it is at lat 40 where the square's west edge is) and therefore outside
    // the triangle, while sitting squarely inside the triangle's bounding
    // rectangle of lng -124..-114 by lat 32..42. A rectangle query finds it;
    // the place does not contain it.
    const boundary = polygon([
      [-124, 42],
      [-114, 42],
      [-124, 32],
      [-124, 42]
    ]);
    const warningOutside = polygon(square(-116, 33, -115, 34));
    expect(geometriesOverlap(boundary, warningOutside)).toBe(false);

    // A warning that genuinely covers part of the triangle still reads as
    // overlapping, so the fix narrows the claim without silencing the row.
    const warningInside = polygon(square(-123, 40, -122, 41));
    expect(geometriesOverlap(boundary, warningInside)).toBe(true);
  });

  test('a warning inside a hole does not overlap the place around it', () => {
    const donut = polygon(square(0, 0, 10, 10), square(4, 4, 6, 6));
    expect(geometriesOverlap(donut, polygon(square(4.5, 4.5, 5.5, 5.5)))).toBe(false);
    // Straddling the hole's edge puts part of the warning on solid ground.
    expect(geometriesOverlap(donut, polygon(square(5, 5, 7, 7)))).toBe(true);
  });

  test('a warning in the gap between two components of a MultiPolygon does not overlap', () => {
    const twoIslands: Geometry = {
      type: 'MultiPolygon',
      coordinates: [[square(0, 0, 4, 10)], [square(6, 0, 10, 10)]]
    };
    expect(geometriesOverlap(twoIslands, polygon(square(4.5, 4, 5.5, 6)))).toBe(false);
    expect(geometriesOverlap(twoIslands, polygon(square(3, 4, 5, 6)))).toBe(true);
  });

  test('crossing areas overlap even when no vertex of either lies inside the other', () => {
    // The plus sign: two rectangles overlapping at the centre with all eight
    // corners outside the other shape. Vertex containment alone answers false
    // here, which is why the edge test exists.
    const vertical = polygon(square(4, 0, 6, 10));
    const horizontal = polygon(square(0, 4, 10, 6));
    expect(geometriesOverlap(vertical, horizontal)).toBe(true);
    expect(geometriesOverlap(horizontal, vertical)).toBe(true);
  });

  test('containment reads the same in both directions', () => {
    const big = polygon(square(0, 0, 10, 10));
    const small = polygon(square(4, 4, 6, 6));
    expect(geometriesOverlap(big, small)).toBe(true);
    expect(geometriesOverlap(small, big)).toBe(true);
  });

  test('touching edges count as overlapping', () => {
    // Two boundaries digitised from the same source share an edge exactly.
    const west = polygon(square(0, 0, 5, 10));
    const east = polygon(square(5, 0, 10, 10));
    expect(geometriesOverlap(west, east)).toBe(true);
  });

  test('separated areas do not overlap', () => {
    expect(geometriesOverlap(polygon(square(0, 0, 1, 1)), polygon(square(5, 5, 6, 6)))).toBe(false);
  });

  test('a non-areal or missing geometry never asserts overlap', () => {
    const area = polygon(square(0, 0, 10, 10));
    const point: Geometry = { type: 'Point', coordinates: [5, 5] };
    const line: Geometry = { type: 'LineString', coordinates: [[0, 0], [10, 10]] };
    expect(geometriesOverlap(area, point)).toBe(false);
    expect(geometriesOverlap(area, line)).toBe(false);
    expect(geometriesOverlap(area, null)).toBe(false);
    expect(geometriesOverlap(null, area)).toBe(false);
    expect(geometriesOverlap(undefined, undefined)).toBe(false);
  });

  test('a degenerate ring is ignored rather than throwing', () => {
    const degenerate: Geometry = { type: 'Polygon', coordinates: [[[0, 0]]] };
    expect(geometriesOverlap(degenerate, polygon(square(0, 0, 10, 10)))).toBe(false);
  });
});
