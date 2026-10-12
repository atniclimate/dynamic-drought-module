import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A briefing lane whose fetcher rejects (here the water-supply reader, as a
 * claim date outside YYYY-MM-DD makes it) settles as "did not respond"; its
 * cells never stay loading. Every other lane's fetch fails at the network.
 */

// Extensionless relative `.ts` imports (see tests/briefing-truth.test.mjs),
// and one replaced module: the water-supply reader, which rejects.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './water-supply' && typeof context.parentURL === 'string') {
      return { url: 'rejecting:water-supply', shortCircuit: true };
    }
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'rejecting:water-supply') {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const fetchWaterSupplyClaims = async () => { throw new RangeError("bad claim date"); };'
      };
    }
    return nextLoad(url, context);
  }
});

const { hydrateBriefing } = await import('../src/impact/hydrate.ts');
const { createBriefingSkeleton } = await import('../src/impact/briefing.ts');

test('a lane whose fetch rejects settles as did-not-respond and the hydration finishes', async () => {
  const original = globalThis.fetch;
  globalThis.window = new EventTarget(); // the HeatRisk frame listener
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  const warn = console.warn;
  const error = console.error;
  console.warn = console.error = () => {};
  try {
    const briefing = createBriefingSkeleton({
      kind: 'state',
      title: 'Lane reject test place',
      properties: null,
      lngLat: { lng: -120.5, lat: 47.5 },
      regionKey: 'washington_state',
      containing: {}
    });
    const finished = hydrateBriefing(briefing, new AbortController().signal, () => {});
    await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hydration did not finish')), 5000).unref())
    ]);
    const cell = briefing.horizons.longRange.cells.drought;
    assert.notEqual(cell.status, 'loading');
    assert.match(JSON.stringify(cell), /did not respond/);
  } finally {
    globalThis.fetch = original;
    console.warn = warn;
    console.error = error;
  }
});
