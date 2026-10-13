/**
 * The ENSO camera rule (src/map/enso-camera.ts): entering fits the Pacific,
 * leaving restores the view from before entering. Browser-free.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ensoCameraAction } from '../src/map/enso-camera.ts';

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
