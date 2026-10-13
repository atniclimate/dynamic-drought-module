import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Extensionless relative `.ts` imports (see tests/briefing-truth.test.mjs).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { dailyFreshness } = await import('../src/util/awdb.ts');

/** `dailyFreshness(day)` with the clock fixed at a local date and time. */
function at(clock, day) {
  test.mock.timers.enable({ apis: ['Date'], now: clock });
  try {
    return dailyFreshness(day);
  } finally {
    test.mock.timers.reset();
  }
}

test('a daily reading is fresh up to about 60 hours old, on either side of local midnight', () => {
  // A reading dated Oct 10 is 47h50m old before midnight and 48h10m after.
  assert.equal(at(new Date(2026, 9, 11, 23, 50), '2026-10-10'), 'fresh');
  assert.equal(at(new Date(2026, 9, 12, 0, 10), '2026-10-10'), 'fresh');
  // Today's day, however late, is fresh.
  assert.equal(at(new Date(2026, 9, 12, 0, 10), '2026-10-12'), 'fresh');
});

test('a daily reading older than about 60 hours is stale', () => {
  assert.equal(at(new Date(2026, 9, 12, 13, 0), '2026-10-10'), 'stale');
  assert.equal(at(new Date(2026, 9, 12, 0, 10), '2026-10-09'), 'stale');
});
