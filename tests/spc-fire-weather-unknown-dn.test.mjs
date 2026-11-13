import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The SPC Day 1 map layer applies the briefing's rule (sources.ts
 * `spcCategoryWord`): an outlined area whose `dn` is none of the outlook's
 * categories is dropped, never drawn and labelled with an invented
 * "Category n", and the layer reads degraded, not ready and not no-data.
 * Drives the shipped `activate` with a fake map and a stubbed fetch.
 * Browser-free.
 */

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

// No time-bar host and no refresh timer: the bar renders nothing, the timer never fires.
globalThis.document = { getElementById: () => null };

const spc = await import('../src/layers/spc-fire-weather.ts');
const { registry } = await import('../src/state/registry.ts');
const { getTimeBarSpec } = await import('../src/ui/time-bar.ts');
const { isSpcNoArea } = await import('../src/state/spc-no-area.ts');
// After the imports: modules that probe `window` at load (mobile-sheet) see none.
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} };

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    sources,
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource(id, source) {
      sources.set(id, { ...source, setData(data) { this.data = data; } });
    },
    addLayer: (layer) => layers.set(layer.id, layer),
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id)
  };
}

const square = {
  type: 'Polygon',
  coordinates: [[[-120, 45], [-119, 45], [-119, 46], [-120, 46], [-120, 45]]]
};
const later = '209901011200';
const area = (dn) => ({
  type: 'Feature',
  geometry: square,
  properties: { dn, valid: '209812311200', expire: later }
});

async function activateWith(features) {
  const original = globalThis.fetch;
  const warn = console.warn;
  const warnings = [];
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
      headers: { 'content-type': 'application/json' }
    });
  console.warn = (...args) => warnings.push(args.join(' '));
  const map = fakeMap();
  try {
    await spc.activate(map);
    return {
      drawn: map.sources.get('spc-fire-weather')?.data,
      status: registry.getStatus('spc-fire-weather'),
      headline: getTimeBarSpec()?.stamp.headline,
      noAreaAnswer: isSpcNoArea(),
      warnings
    };
  } finally {
    globalThis.fetch = original;
    console.warn = warn;
    spc.deactivate(map);
  }
}

test('an area with an unrecognized dn is not drawn, and the layer reads degraded', async () => {
  const { drawn, status, warnings } = await activateWith([area(8), area(6)]);
  assert.deepEqual(drawn.features.map((f) => f.properties.dn), [8]);
  assert.equal(status, 'degraded');
  assert.ok(warnings.some((w) => /unrecognized dn/.test(w)));
});

test('a response of only unrecognized areas is degraded, never a false no-data', async () => {
  const { drawn, status } = await activateWith([area(6)]);
  assert.equal(drawn.features.length, 0);
  assert.equal(status, 'degraded');
});

test("the issuer's no-area answer leads the stamp headline with SPC's own term and reads no-data", async () => {
  const noArea = { type: 'Feature', geometry: null, properties: { dn: 0, valid: '202609261200', expire: '202609271200' } };
  const { status, headline } = await activateWith([noArea]);
  assert.equal(status, 'no-data');
  assert.equal(headline, 'No Risk Areas Forecast · valid Sep 26, 2026, 12:00 UTC to Sep 27, 2026, 12:00 UTC');
});

test("the Key's no-risk wording holds only for the issuer's own no-area answer inside its period", async () => {
  const noArea = (expire) => ({ type: 'Feature', geometry: null, properties: { dn: 0, valid: '209812311200', expire } });
  // The issuer's no-area answer, still valid.
  assert.equal((await activateWith([noArea(later)])).noAreaAnswer, true);
  // The same answer past its expire time is not today's answer.
  assert.equal((await activateWith([noArea('202609271200')])).noAreaAnswer, false);
  // An empty collection is no-data too, but SPC said nothing of the kind.
  const empty = await activateWith([]);
  assert.equal(empty.status, 'no-data');
  assert.equal(empty.noAreaAnswer, false);
  // An outlined area is not a no-area answer.
  assert.equal((await activateWith([area(5)])).noAreaAnswer, false);
  // Deactivation clears it.
  assert.equal(isSpcNoArea(), false);
});

test('an outlined area keeps the Outlook headline', async () => {
  const { headline } = await activateWith([area(5)]);
  assert.match(headline, /^Outlook valid /);
});

test('known categories draw as before and read ready', async () => {
  const { drawn, status, warnings } = await activateWith([area(5), area(10)]);
  assert.deepEqual(drawn.features.map((f) => f.properties.dn), [5, 10]);
  assert.equal(status, 'ready');
  assert.deepEqual(warnings, []);
});
