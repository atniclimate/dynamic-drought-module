import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The SPI legend's valid date is read once per hour, the issuer's own
// max-age=3600, so a daily product's new date reaches the legend on the next
// toggle after the hour instead of never in the session.

let clock = Date.now();
// Before the import: the cache captures Date.now when the module builds it.
Date.now = () => clock;

globalThis.window = globalThis;
globalThis.document = {
  documentElement: { dataset: {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  hidden: false
};
globalThis.location = new URL('https://ddm.test/?view=console');
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

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

class FakeMap {
  sources = new Map();
  layers = new Map();
  getSource(id) { return this.sources.get(id); }
  addSource(id, spec) { this.sources.set(id, spec); }
  removeSource(id) { this.sources.delete(id); }
  getLayer(id) { return this.layers.get(id); }
  addLayer(spec) { this.layers.set(spec.id, spec); }
  removeLayer(id) { this.layers.delete(id); }
  getStyle() { return { layers: [...this.layers.values()] }; }
  isSourceLoaded() { return false; }
  on() { return this; }
  off() { return this; }
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('the SPI valid date is re-read after the issuer\'s hour, not kept for the session', async () => {
  const infoReads = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.endsWith('/info.json')) throw new Error(`unexpected egress from a node test: ${url}`);
    infoReads.push(url);
    return new Response(JSON.stringify({ date: '2026-11-05', tilezmax: '6' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const mod = await import('../src/layers/gridded-index.ts');
  const map = new FakeMap();
  try {
    await mod.activate(map);
    await settle();
    assert.equal(infoReads.length, 1);

    mod.deactivate(map);
    await mod.activate(map);
    await settle();
    assert.equal(infoReads.length, 1, 'a toggle within the hour reuses the read');

    clock += 61 * 60 * 1000;
    mod.deactivate(map);
    await mod.activate(map);
    await settle();
    assert.equal(infoReads.length, 2, 'a toggle after the hour reads the product date again');
  } finally {
    mod.deactivate(map);
    globalThis.fetch = original;
  }
});
