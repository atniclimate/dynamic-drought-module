/**
 * The conditions strip's Alerts and Fires tiles never read a failed or
 * cut-off read as a count of zero (src/ui/island/strip-metrics.ts; the tile
 * guardrail "a failed activation must not read as 0"). After a later read
 * fails, the layer stays registered active with its fill still on the map,
 * but the fill draws nothing in this view: the tile reads the pending
 * "unavailable" state, not "0". A clean empty read still reads "0".
 * Drives the shipped alertsMetric and firesMetric with a fake map.
 * Browser-free.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

const { registry } = await import('../src/state/registry.ts');
const { alertsMetric, firesMetric, isDroughtStale } = await import('../src/ui/island/strip-metrics.ts');

// Both fills exist; nothing is drawn in this view.
const map = {
  getLayer: (id) => (id === 'nws-alerts-fill' || id === 'nifc-fires-fill' ? {} : undefined),
  queryRenderedFeatures: () => []
};

registry.activate('nws-alerts');
registry.activate('nifc-fires');

for (const [name, key, metric] of [
  ['Alerts', 'nws-alerts', alertsMetric],
  ['Fires', 'nifc-fires', firesMetric]
]) {
  test(`the ${name} tile reads unavailable, not 0, after a failed read`, () => {
    registry.setStatus(key, 'error');
    const tile = metric(map);
    assert.equal(tile.value, '-');
    assert.equal(tile.sublabel, 'unavailable');
  });

  test(`the ${name} tile still reads 0 after a clean empty read`, () => {
    registry.setStatus(key, 'no-data');
    assert.equal(metric(map).value, '0');
  });
}

test('the Alerts tile reads partial, not 0, when the read was cut off', () => {
  registry.setStatus('nws-alerts', 'degraded');
  const tile = alertsMetric(map);
  assert.equal(tile.value, '-');
  assert.equal(tile.sublabel, 'live (partial)');
});

test('a frozen NADM month reads stale, like a frozen USDM week (R6-13)', () => {
  const now = Date.UTC(2026, 10, 6);
  // NADM dates are the consensus month's first day; the newest month is up to about 80 days old.
  assert.equal(isDroughtStale('nadm-drought', Date.UTC(2026, 8, 1), now), false, 'September is current on Nov 6');
  assert.equal(isDroughtStale('nadm-drought', Date.UTC(2026, 6, 1), now), true, 'July has stopped updating');
  assert.equal(isDroughtStale('nadm-drought', null, now), false);
  // The USDM rule is unchanged: two weekly cycles.
  assert.equal(isDroughtStale('usdm', now - 13 * 86400000, now), false);
  assert.equal(isDroughtStale('usdm', now - 15 * 86400000, now), true);
});
