/**
 * The phone Alerts pane says "in the current map view", so it lists only the
 * alerts drawn in that view, the way the desktop conditions strip counts them
 * (src/ui/island/strip-metrics.ts alertsMetric: queryRenderedFeatures on the
 * alerts fill). The look of 2026-11-05 found it listing Montana and Arizona
 * alerts over a Southeast framing: querySourceFeatures returns every loaded
 * tile's features, including those outside the view. Drives the shipped
 * openSheetAlerts with a fake map and a two-element fake DOM. Browser-free.
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

const body = { innerHTML: '' };
const appAttributes = { 'data-sheet-tab': 'alerts', 'data-sheet-detent': 'half' };
const app = { getAttribute: (name) => appAttributes[name] ?? null };
globalThis.document = {
  getElementById: (id) => (id === 'sheet-alerts-body' ? body : id === 'app' ? app : null)
};

const { registry } = await import('../src/state/registry.ts');
const { openSheetAlerts } = await import('../src/ui/sheet-alerts.ts');

const alert = (event, issuer) => ({ properties: { event, issuer, onset: '2026-11-05T12:00:00Z', ends: null } });
const inView = alert('Coastal Flood Advisory', 'KTBW');
const offView = alert('Winter Storm Warning', 'KTFX');

let drawn = [inView];
const handlers = new Map();
const emit = (type, event) => handlers.get(type)?.forEach((fn) => fn(event));
const map = {
  getSource: (id) => (id === 'nws-alerts' ? {} : undefined),
  getLayer: (id) => (id === 'nws-alerts-fill' ? {} : undefined),
  // Every loaded tile, the view's neighbours included.
  querySourceFeatures: () => [...drawn, offView],
  // What the view draws.
  queryRenderedFeatures: (options) =>
    options?.layers?.includes('nws-alerts-fill') ? drawn : [],
  on: (type, fn) => handlers.set(type, [...(handlers.get(type) ?? []), fn])
};

test('the Alerts pane lists the alerts drawn in the view and no others', () => {
  registry.activate('nws-alerts');
  registry.setStatus('nws-alerts', 'ready');
  openSheetAlerts(map);
  assert.match(body.innerHTML, /in the current map view/);
  assert.match(body.innerHTML, /Coastal Flood Advisory/);
  assert.doesNotMatch(body.innerHTML, /Winter Storm Warning/);
});

test('arriving alert data is read on the frame that draws it', () => {
  drawn = [inView, alert('Rip Current Statement', 'KTBW')];
  emit('sourcedata', { sourceId: 'nws-alerts' });
  assert.doesNotMatch(body.innerHTML, /Rip Current Statement/, 'not before the frame draws');
  emit('render');
  assert.match(body.innerHTML, /Rip Current Statement/);
  assert.doesNotMatch(body.innerHTML, /Winter Storm Warning/);
});
