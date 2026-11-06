/**
 * The Canadian Drought Monitor is a committed monthly snapshot
 * (public/data/cdm-drought-areas.json, rebuilt only by `npm run build:cdm`),
 * not a live feed. The look of 2026-11-05 read "Current Conditions · now"
 * over "Month June 2026" in September with nothing saying the month was a
 * bundled file. The time statement must name the snapshot in the words the
 * layer's own source line already uses. Drives the shipped `activate` with
 * a fake map and the committed artifact. Browser-free.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

const artifact = readFileSync(new URL('../public/data/cdm-drought-areas.json', import.meta.url), 'utf8');
globalThis.fetch = async () => new Response(artifact, { status: 200 });
// No legend panel and no time-bar host: the legend and the bar render nothing.
globalThis.document = { getElementById: () => null };

const { activate } = await import('../src/layers/cdm-drought.ts');
const { getTimeBarSpec } = await import('../src/ui/time-bar.ts');
const { LAYER_DEFS } = await import('../src/config/layers.ts');

function fakeMap() {
  const sources = new Set();
  const layers = new Set();
  return {
    getSource: (id) => (sources.has(id) ? {} : undefined),
    getLayer: (id) => (layers.has(id) ? {} : undefined),
    addSource: (id) => sources.add(id),
    addLayer: (layer) => layers.add(layer.id)
  };
}

test('the time statement names the committed monthly snapshot beside its month', async () => {
  await activate(fakeMap());
  const spec = getTimeBarSpec();
  assert.ok(spec, 'the layer installed a time statement');
  const snapshotWords = LAYER_DEFS.find((d) => d.key === 'cdm-drought').source.split(' · ').pop();
  assert.equal(snapshotWords, 'committed monthly snapshot');
  const month = JSON.parse(artifact).month;
  const [year, monthNumber] = month.split('-').map(Number);
  const monthName = new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en-CA', {
    month: 'long',
    timeZone: 'UTC'
  });
  assert.match(spec.stamp.headline, new RegExp(`${monthName} ${year}`));
  assert.match(spec.stamp.headline, new RegExp(snapshotWords));
});
