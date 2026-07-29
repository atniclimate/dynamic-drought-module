import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test, expect } from '@playwright/test';
import type { FeatureCollection, Geometry } from 'geojson';

import { pointInPolygonGeometry } from '../src/util/point-in-polygon';

/**
 * Pure-logic coverage for the point-in-polygon test that backs the location
 * identity stack's state fallback (src/state/location-identity.ts). No page or
 * map is needed; this runs in Node against synthetic geometries so the even-odd
 * rule, hole handling, and MultiPolygon dispatch are pinned deterministically.
 */

const square = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0]
];

test.describe('pointInPolygonGeometry', () => {
  test('a point inside a simple polygon is inside; outside points are outside', () => {
    const geom: Geometry = { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] };
    expect(pointInPolygonGeometry(5, 5, geom)).toBe(true);
    expect(pointInPolygonGeometry(15, 5, geom)).toBe(false);
    expect(pointInPolygonGeometry(5, 15, geom)).toBe(false);
    expect(pointInPolygonGeometry(-1, 5, geom)).toBe(false);
  });

  test('a hole is excluded (even-odd across rings)', () => {
    const geom: Geometry = {
      type: 'Polygon',
      coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)]
    };
    // Inside the outer ring but inside the hole: outside.
    expect(pointInPolygonGeometry(5, 5, geom)).toBe(false);
    // Inside the outer ring, outside the hole: inside.
    expect(pointInPolygonGeometry(2, 2, geom)).toBe(true);
  });

  test('a MultiPolygon is inside if the point is in any component', () => {
    const geom: Geometry = {
      type: 'MultiPolygon',
      coordinates: [[square(0, 0, 5, 5)], [square(10, 10, 15, 15)]]
    };
    expect(pointInPolygonGeometry(2, 2, geom)).toBe(true);
    expect(pointInPolygonGeometry(12, 12, geom)).toBe(true);
    expect(pointInPolygonGeometry(7, 7, geom)).toBe(false);
  });

  test('a concave polygon respects its notch', () => {
    // An L-shape: the notch is the top-right quadrant (5..10, 5..10).
    const geom: Geometry = {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0]]]
    };
    expect(pointInPolygonGeometry(2, 2, geom)).toBe(true); // in the stem
    expect(pointInPolygonGeometry(2, 8, geom)).toBe(true); // in the arm
    expect(pointInPolygonGeometry(8, 8, geom)).toBe(false); // in the notch
  });

  test('non-areal and empty geometries are never inside', () => {
    expect(pointInPolygonGeometry(0, 0, null)).toBe(false);
    expect(pointInPolygonGeometry(0, 0, undefined)).toBe(false);
    expect(pointInPolygonGeometry(0, 0, { type: 'Point', coordinates: [0, 0] })).toBe(false);
    expect(
      pointInPolygonGeometry(0, 0, { type: 'LineString', coordinates: [[0, 0], [1, 1]] })
    ).toBe(false);
  });

  // End-to-end against the real bundled boundaries: this is the location
  // identity state fallback (src/state/location-identity.ts) that replaces the
  // old default-to-Washington behavior, so a click resolves to the correct
  // state even when the state layer is off. Well-interior points stay correct
  // at the 1:20,000,000 generalization the file ships at.
  test('known points resolve to the correct state in the bundled us-states.geojson', () => {
    const fc = JSON.parse(
      readFileSync(resolve(process.cwd(), 'public/data/us-states.geojson'), 'utf8')
    ) as FeatureCollection;

    const stateAt = (lng: number, lat: number): string | null => {
      for (const f of fc.features) {
        if (pointInPolygonGeometry(lng, lat, f.geometry)) {
          const code = f.properties?.['STUSPS'];
          return typeof code === 'string' ? code : null;
        }
      }
      return null;
    };

    expect(stateAt(-122.33, 47.61)).toBe('WA'); // Seattle
    expect(stateAt(-112.03, 46.6)).toBe('MT'); // Helena, Montana (not a WA default)
    expect(stateAt(-97.74, 30.27)).toBe('TX'); // Austin
    expect(stateAt(-105.0, 39.74)).toBe('CO'); // Denver
    expect(stateAt(-140.0, 40.0)).toBeNull(); // mid-Pacific: no state
  });
});
