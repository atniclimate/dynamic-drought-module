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

test('Reset in ENSO asks the boot rule and fits the Pacific; the other modes keep the region fit', () => {
  const sidebar = readFileSync(new URL('../src/ui/sidebar.ts', import.meta.url), 'utf8');
  const reset = sidebar.slice(sidebar.indexOf("getElementById('reset-btn')"), sidebar.indexOf('// The refit on a sidebar toggle'));
  assert.ok(reset.includes('ensoBootFitsPacific(getHazardCluster(), false, false, STATE.currentRegion === DEFAULT_REGION, false)'));
  assert.ok(reset.includes("fitOcean(map, 'pacific')"));
  assert.ok(reset.includes('selectRegion(map, STATE.currentRegion)'));
});
