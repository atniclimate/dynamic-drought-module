/**
 * The Pacific fit on a small map: when the fit would need a zoom below the
 * map's floor, the camera keeps the floor and centres on the Nino 3.4 box
 * instead of the bounds' centre; a large map fits as before. Browser-free.
 * (src/map/camera-fit.ts needs maplibre-gl, so the decision lives in
 * src/map/enso-camera.ts and the wiring is pinned from source.)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { OCEANS } from '../src/config/oceans.ts';
import { floorCentreOrNull } from '../src/map/enso-camera.ts';

test('a Pacific fit below the zoom floor centres on the Nino 3.4 box with the equator in frame', () => {
  const centre = floorCentreOrNull(1.1, 2, OCEANS.pacific.floorCentre);
  assert.deepEqual(centre, [-145, 8]);
  const [south, north] = OCEANS.pacific.bounds.map((corner) => corner[0]);
  assert.ok(centre[1] > south && centre[1] < north, 'inside the Pacific bounds');
  assert.ok(centre[0] < -120 && centre[0] > -170, 'inside the Nino 3.4 longitudes');
});

test('a fit that clears the floor, or reports no zoom, and every ocean without a floor centre, fit as before', () => {
  assert.equal(floorCentreOrNull(3.2, 2, OCEANS.pacific.floorCentre), null);
  assert.equal(floorCentreOrNull(2, 2, OCEANS.pacific.floorCentre), null);
  assert.equal(floorCentreOrNull(undefined, 2, OCEANS.pacific.floorCentre), null);
  assert.equal(OCEANS.arctic.floorCentre, undefined);
  assert.equal(OCEANS.atlantic.floorCentre, undefined);
});

test('every Pacific fit goes through the shared target fit', () => {
  const sidebar = readFileSync(new URL('../src/ui/sidebar.ts', import.meta.url), 'utf8');
  assert.ok(sidebar.includes('fitCameraTarget(map, oceanTarget(oceanBoot), false)'), 'boot');
  assert.equal((sidebar.match(/fitOcean\(map, /g) ?? []).length, 3, 'dropdown, Reset, mode press');
  const fit = readFileSync(new URL('../src/map/camera-fit.ts', import.meta.url), 'utf8');
  assert.ok(fit.includes('floorCentreFor(map, target)'));
});
