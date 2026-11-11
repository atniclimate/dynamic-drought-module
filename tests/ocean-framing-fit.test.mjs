/**
 * Where the ocean framings land on real map canvases, computed with the same
 * Web Mercator fit MapLibre's cameraForBounds makes (512px world tiles, the
 * shared 20px inset of src/map/camera-fit.ts). Browser-free.
 *
 * - The Arctic Ocean view stays in the high latitudes on landscape canvases.
 * - The Pacific view keeps the Nino 3.4 box clear of the bottom dock, where
 *   the desktop toast and the other notices sit; the look of 2026-11-05 found
 *   a toast over the box's label.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { OCEANS } from '../src/config/oceans.ts';
import { framingFitBounds } from '../src/config/framings.ts';

const INSET_PX = 20;
const TILE = 512;

/** Normalised Web Mercator, 0..1 from west and from north. */
const mx = (lng) => (lng + 180) / 360;
const my = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90;

/** The fitted camera: scale in px per normalised unit and the centre. */
function fit(bounds, width, height) {
  const [[west, south], [east, north]] = bounds;
  const dx = mx(east) - mx(west);
  const dy = my(south) - my(north);
  const scale = Math.min((width - 2 * INSET_PX) / dx, (height - 2 * INSET_PX) / dy);
  return { scale, cx: (mx(west) + mx(east)) / 2, cy: (my(north) + my(south)) / 2, width, height };
}

/** Screen y of a latitude under a fitted camera. */
const yPx = (cam, lat) => cam.height / 2 + (my(lat) - cam.cy) * cam.scale;

// The map canvas beside the 340px sidebar at 1440x900 and 1280x800, and two embeds.
const LANDSCAPE_CANVASES = [
  [1100, 900],
  [940, 800],
  [820, 615],
  [1440, 900]
];

// regions.ts does not load under node (extensionless imports), so read the floor from its source.
const regionsSource = readFileSync(new URL('../src/config/regions.ts', import.meta.url), 'utf8');
const MAP_MIN_ZOOM = Number(/export const MAP_MIN_ZOOM = ([\d.]+);/.exec(regionsSource)?.[1]);

test('the Arctic Ocean view stays in the high latitudes on landscape canvases', () => {
  const bounds = framingFitBounds(OCEANS.arctic);
  for (const [width, height] of LANDSCAPE_CANVASES) {
    const cam = fit(bounds, width, height);
    const bottom = latOf(cam.cy + height / 2 / cam.scale);
    assert.ok(bottom >= 50, `${width}x${height}: frame bottom ${bottom.toFixed(2)} N leaves the high latitudes`);
  }
});

test('the Pacific view holds the Nino 3.4 box above the bottom dock on the desktop map', () => {
  const bounds = framingFitBounds(OCEANS.pacific);
  // --map-dock-bottom (34px) plus one notice row and the dock foot: the
  // look measured the toast's top edge 100px above the canvas bottom.
  const DOCK_BAND_PX = 100;
  for (const [width, height] of [[1100, 900], [940, 800]]) {
    const cam = fit(bounds, width, height);
    const boxTop = yPx(cam, 5);
    const boxBottom = yPx(cam, -5);
    assert.ok(boxTop >= 0, `${width}x${height}: box top ${boxTop.toFixed(0)}px is off the frame`);
    assert.ok(
      boxBottom <= height - DOCK_BAND_PX,
      `${width}x${height}: box bottom ${boxBottom.toFixed(0)}px reaches the dock band below ${height - DOCK_BAND_PX}px`
    );
  }
});

test('the Pacific view stays a plain fit above the zoom floor on the 820x615 embed', () => {
  // Below MAP_MIN_ZOOM the camera takes the floor path and the frame top
  // drops from about 63 N to 52.6 N, losing the Gulf of Alaska.
  const cam = fit(framingFitBounds(OCEANS.pacific), 820, 615);
  const zoom = Math.log2(cam.scale / TILE);
  assert.ok(zoom >= MAP_MIN_ZOOM + 0.02, `820x615: fit zoom ${zoom.toFixed(2)} is at or under the floor ${MAP_MIN_ZOOM}`);
});
