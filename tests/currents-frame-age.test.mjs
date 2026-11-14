/**
 * The Ocean currents frame (public/data/rtofs-surface-currents.json and its
 * two grid files) is a landing fixture (DR-116): nothing rebuilds it but
 * `node scripts/build-rtofs-currents.mjs`, and the app refuses a frame valid
 * more than 14 days ago (CURRENTS_MAX_AGE_MS). Twice the live layer read
 * "unavailable" because no landing had rebuilt it. This guard runs in
 * check:all before every landing push: a frame more than 7 days old fails
 * locally, so the frame a landing ships has at least a week left. In CI it
 * only warns, so a pull request is never red for the calendar alone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FRAME = JSON.parse(readFileSync(new URL('../public/data/rtofs-surface-currents.json', import.meta.url), 'utf8'));
const LANDING_MAX_AGE_DAYS = 7;

test('the committed currents frame is young enough to land', () => {
  const valid = Date.parse(FRAME.valid);
  assert.ok(Number.isFinite(valid), 'the frame header carries a valid instant');
  const ageDays = (Date.now() - valid) / 86_400_000;
  if (ageDays <= LANDING_MAX_AGE_DAYS) return;
  const message =
    `The Ocean currents frame is ${ageDays.toFixed(1)} days old (valid ${FRAME.valid}); the app refuses it after 14. ` +
    'Rebuild it before landing: node scripts/build-rtofs-currents.mjs, then commit the three public/data/rtofs-surface-currents* files.';
  if (process.env['CI']) {
    console.log(`::warning title=Ocean currents frame::${message}`);
    return;
  }
  assert.fail(message);
});
