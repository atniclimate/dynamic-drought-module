/**
 * The ENSO camera rule (src/map/enso-camera.ts): entering fits the Pacific,
 * leaving restores the view from before entering. Browser-free.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HAZARD_CLUSTER_KEYS } from '../src/config/clusters.ts';
import { ensoBootFitsPacific, ensoCameraAction } from '../src/map/enso-camera.ts';

test('entering ENSO with no ocean captures the camera and fits the Pacific', () => {
  assert.deepEqual(ensoCameraAction('drought', 'enso', false, false), {
    capture: true,
    fitPacific: true,
    restore: false
  });
});

test('entering ENSO with an ocean set captures but leaves the fit to the dropdown', () => {
  assert.deepEqual(ensoCameraAction('wildfire', 'enso', false, true), {
    capture: true,
    fitPacific: false,
    restore: false
  });
});

test('leaving ENSO with a captured camera restores it', () => {
  assert.deepEqual(ensoCameraAction('enso', 'drought', true, false), {
    capture: false,
    fitPacific: false,
    restore: true
  });
});

test('re-entering ENSO with a capture still held keeps the earlier view as the one to restore', () => {
  assert.deepEqual(ensoCameraAction('drought', 'enso', true, false), {
    capture: false,
    fitPacific: true,
    restore: false
  });
});

test('a custom layer set in ENSO is not a leave: the view stays', () => {
  assert.deepEqual(ensoCameraAction('enso', 'drought', true, false, true), {
    capture: false,
    fitPacific: false,
    restore: false
  });
});

test('leaving ENSO with nothing captured, or any other change, does nothing', () => {
  const none = { capture: false, fitPacific: false, restore: false };
  assert.deepEqual(ensoCameraAction('enso', 'heat', false, false), none);
  assert.deepEqual(ensoCameraAction('drought', 'wildfire', true, false), none);
  assert.deepEqual(ensoCameraAction('enso', 'enso', true, true), none);
});

test('a boot into ENSO fits the Pacific only when the URL names no camera of its own', () => {
  // ?region=national&cluster=enso, and the same with no region= at all.
  assert.equal(ensoBootFitsPacific('enso', false, false, true, false), true);
  assert.equal(ensoBootFitsPacific('enso', true, false, true, false), false, 'ocean= fits its own ocean');
  assert.equal(ensoBootFitsPacific('enso', false, true, true, false), false, 'framing= keeps its camera');
  assert.equal(ensoBootFitsPacific('enso', false, false, false, false), false, 'a chosen region= keeps its camera');
  assert.equal(ensoBootFitsPacific('enso', false, false, true, true), false, 'select= fits its own place');
  for (const cluster of HAZARD_CLUSTER_KEYS.filter((key) => key !== 'enso')) {
    assert.equal(ensoBootFitsPacific(cluster, false, false, true, false), false, `${cluster} boots on its region`);
  }
});

/**
 * Audit round 6, R6-8: entering ENSO from Wildfire 3D. The 3D scene's own ease
 * back to its pre-3D camera ran after the Pacific fit and cancelled it, and the
 * camera held for leaving ENSO kept the 3D tilt. Pinned from source (the map
 * wiring needs maplibre-gl). Red on f27a23c: the entry never ends the scene first.
 */
test('entering ENSO ends the 3D Fire view before the Pacific fit, and holds a flat camera for the way back', () => {
  const sidebar = readFileSync(new URL('../src/ui/sidebar.ts', import.meta.url), 'utf8');
  const start = sidebar.indexOf('onHazardClusterChange(() => {');
  const block = sidebar.slice(start, sidebar.indexOf('previousCluster = next;', start));
  assert.ok(start > 0 && block.length > 0);
  const drop = block.indexOf('setFire3DPreference(false)');
  assert.ok(drop > 0, 'the entry ends the 3D scene');
  assert.ok(drop < block.indexOf('holdEnsoCamera('), 'before the camera is held');
  assert.ok(drop < block.indexOf("fitOcean(map, 'pacific')"), 'before the Pacific fit');
  assert.ok(block.includes('{ ...camera, pitch: 0, bearing: 0 }'), 'the held camera is flat and north-up');
});

test('Reset is the bare link: default region, the Pacific in ENSO, base map, desktop sidebar reopened', () => {
  const sidebar = readFileSync(new URL('../src/ui/sidebar.ts', import.meta.url), 'utf8');
  const start = sidebar.indexOf("getElementById('reset-btn')");
  const reset = sidebar.slice(start, sidebar.indexOf('// Debounced resize handler', start));
  assert.ok(start > 0 && reset.length > 0);
  assert.ok(!reset.includes('STATE.currentRegion'), 'Reset never returns to the last chosen region');
  assert.ok(reset.includes('STATE.embed ? embedHomeRegion : DEFAULT_REGION'));
  assert.ok(reset.includes('selectRegion(map, home)'));
  assert.ok(reset.includes('ensoBootFitsPacific(cluster, false, false, home === DEFAULT_REGION, false)'));
  // The person's hazard: the store reads Drought for a custom set made in ENSO or Wildfire.
  assert.ok(reset.includes('const cluster = getSelectedHazard();') && !reset.includes('getHazardCluster()'));
  assert.ok(reset.includes("fitOcean(map, 'pacific')"));
  assert.ok(
    reset.indexOf('selectRegion(map, home)') < reset.indexOf("fitOcean(map, 'pacific')"),
    'the Pacific fit follows the region fit, or the national fit wins'
  );
  assert.ok(sidebar.includes('if (params.embed) embedHomeRegion = params.region;'), 'an embed remembers its link region');
  assert.ok(reset.includes('STATE.desktopSidebarClosed = false'));
});
