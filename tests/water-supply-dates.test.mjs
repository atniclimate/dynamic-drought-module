import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The NWRFC `FcstDate` column echoes the requested `WyrDate` (we send today),
 * so the briefing never states it as an issue date: no "issued" in the claim
 * text and no `dates.issued` on either claim, only the retrieval day.
 */

// Same extensionless-specifier hook as tests/briefing-truth.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { fetchWaterSupplyClaims } = await import('../src/impact/water-supply.ts');

test('water-supply claims never present the echoed FcstDate as an issue date', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    requested.push(decodeURIComponent(String(input)));
    return new Response(
      'ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n' +
        'BONO3,COLUMBIA - BONNEVILLE DAM,APR-SEP,88,95,2026-10-08'
    );
  };
  try {
    const selection = {
      kind: 'ecoregion',
      title: 'Test selection',
      properties: null,
      lngLat: { lng: -120.5, lat: 47.2 },
      place: null,
      containing: { state: 'WA', basis: 'point-in-polygon' },
      regionKey: 'washington_state'
    };
    const result = await fetchWaterSupplyClaims(selection, new AbortController().signal);
    assert.equal(result.claims.length, 2);
    for (const claim of result.claims) {
      assert.doesNotMatch(claim.text, /issued/i);
      assert.equal(claim.dates.issued, undefined);
      assert.match(claim.dates.retrieved, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.match(result.claims[1].text, /\(50 percent exceedance\)\./);
    // The forecast names its water year: from October it is the coming season.
    assert.match(result.claims[1].text, /April-September 20\d\d water-supply forecast/);
    // The request date and the claim's retrieval date are the same local day.
    assert.ok(requested[0].includes(`WyrDate=${result.claims[0].dates.retrieved}&`));

    // A second briefing reuses the day's report instead of downloading it again.
    const again = await fetchWaterSupplyClaims(selection, new AbortController().signal);
    assert.equal(again.claims.length, 2);
    assert.equal(requested.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
