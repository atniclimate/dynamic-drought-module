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
    if (specifier === './enso' && typeof context.parentURL === 'string' && context.parentURL.endsWith('/hydrate.ts')) {
      return { url: 'stub:enso', shortCircuit: true };
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
          'export const fetchWaterSupplyClaims = async () => { if (globalThis.waterSupplyAnswers) return { claims: [], ok: true }; throw new RangeError("bad claim date"); };'
      };
    }
    if (url === 'stub:enso') {
      // The ENSO snapshot answers only when a test hands it claims; otherwise it fails as the network does.
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const fetchEnsoClaims = async () => { if (globalThis.ensoClaims) return { claims: globalThis.ensoClaims, ok: true }; throw new TypeError("network down"); };'
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
    // The Seasonal Drought Outlook is categorical: its fixed sentence states no odds.
    const outlook = cell.claims.find((claim) => claim.product === 'cpcSeasonal');
    assert.ok(outlook, 'the fixed CPC Seasonal Drought Outlook claim stands in the cell');
    assert.doesNotMatch(outlook.text, /odds|probability/);
  } finally {
    globalThis.fetch = original;
    console.warn = warn;
    console.error = error;
  }
});

/** Hydrate one place with every network read failing, and return the settled briefing. */
async function hydrateOffline(context) {
  const original = globalThis.fetch;
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  const warn = console.warn;
  const error = console.error;
  console.warn = console.error = () => {};
  try {
    const briefing = createBriefingSkeleton(context);
    await Promise.race([
      hydrateBriefing(briefing, new AbortController().signal, () => {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hydration did not finish')), 5000).unref())
    ]);
    return briefing;
  } finally {
    globalThis.fetch = original;
    console.warn = warn;
    console.error = error;
  }
}

const allCells = (briefing) =>
  Object.values(briefing.horizons).flatMap((horizon) => Object.values(horizon.cells));

const stateContext = (code, lng, lat) => ({
  kind: 'state',
  title: `${code} test place`,
  properties: { STUSPS: code },
  lngLat: { lng, lat },
  regionKey: 'national',
  containing: { state: code, basis: 'feature-property' }
});

test('DR-256: a place outside the Northwest gets the matrix cell by cell, never the regional gate', async () => {
  const briefing = await hydrateOffline(stateContext('AZ', -111.7, 34.3));
  for (const cell of allCells(briefing)) {
    assert.notEqual(cell.status, 'loading', `${cell.horizon} ${cell.hazard}`);
    assert.doesNotMatch(cell.note ?? '', /not validated outside|Pacific Northwest/, `${cell.horizon} ${cell.hazard}`);
  }
  const outlook = briefing.horizons.longRange.cells.drought.claims.find((claim) => claim.product === 'cpcSeasonal');
  assert.ok(outlook, 'the drought cells read in Arizona too');
  assert.equal(briefing.resources.length, 0, 'Northwest resources keep their data limit');
});

test('a source that does not cover the place leaves the cell body', async () => {
  const briefing = await hydrateOffline(stateContext('AK', -150.0, 64.0));
  const fire = briefing.horizons.nearTerm.cells.fire;
  assert.equal(fire.status, 'unavailable');
  assert.doesNotMatch(fire.note ?? '', /service extent|No briefing support/, 'the SPC coverage note reads in Technical information, not here');
  // The near-term heat cell reads its covering source and is not held partial by HeatRisk, which does not cover Alaska.
  assert.doesNotMatch(briefing.horizons.nearTerm.cells.heat.note ?? '', /HeatRisk raster/);
});

test('the Pacific Northwest ENSO tendency stays with Northwest places', async () => {
  globalThis.ensoClaims = [
    { text: 'state', product: 'ensoState', horizon: 'current', source: 's', sourceUrl: 'https://example.org/', evidence: 'analyzed', dates: { retrieved: '2026-11-13' } },
    { text: 'tendency', product: 'ensoTendency', horizon: 'longRange', source: 's', sourceUrl: 'https://example.org/', evidence: 'derived', dates: { retrieved: '2026-11-13' } }
  ];
  try {
    const arizona = await hydrateOffline(stateContext('AZ', -111.7, 34.3));
    assert.equal(arizona.horizons.current.cells.enso.claims.length, 1, 'the index state reads everywhere');
    assert.equal(arizona.horizons.longRange.cells.enso.claims.length, 0, 'no Northwest tendency in Arizona');
    const washington = await hydrateOffline(stateContext('WA', -120.5, 47.4));
    assert.equal(washington.horizons.longRange.cells.enso.claims.length, 1);
  } finally {
    delete globalThis.ensoClaims;
  }
});

test('a repaint that throws after a lane answered does not mark that lane as failed', async () => {
  const original = globalThis.fetch;
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  globalThis.waterSupplyAnswers = true;
  const warnings = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args) => warnings.push(String(args[0]));
  console.error = () => {};
  try {
    const briefing = createBriefingSkeleton({
      kind: 'state',
      title: 'Lane repaint throw test place',
      properties: null,
      lngLat: { lng: -120.5, lat: 47.5 },
      regionKey: 'washington_state',
      containing: {}
    });
    let armed = false; // the first paint runs synchronously, before any lane settles
    const finished = hydrateBriefing(briefing, new AbortController().signal, () => {
      if (armed) throw new Error('repaint fault');
    });
    armed = true;
    await assert.rejects(finished, /repaint fault/);
    assert.ok(!warnings.some((w) => w.includes('waterSupply lane failed')));
    assert.ok(!warnings.some((w) => w.includes('point heat hydration failed')));
  } finally {
    delete globalThis.waterSupplyAnswers;
    globalThis.fetch = original;
    console.warn = warn;
    console.error = error;
  }
});
