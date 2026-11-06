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

const { fetchWaterSupplyClaims, clearWaterSupplyRowsCache } = await import('../src/impact/water-supply.ts');

const WA_SELECTION = {
  kind: 'ecoregion',
  title: 'Test selection',
  properties: null,
  lngLat: { lng: -120.5, lat: 47.2 },
  place: null,
  containing: { state: 'WA', basis: 'point-in-polygon' },
  regionKey: 'washington_state'
};

async function twoBriefings(body) {
  clearWaterSupplyRowsCache();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(body);
  };
  try {
    await fetchWaterSupplyClaims(WA_SELECTION, new AbortController().signal);
    const second = await fetchWaterSupplyClaims(WA_SELECTION, new AbortController().signal);
    return { requests, second };
  } finally {
    globalThis.fetch = originalFetch;
    clearWaterSupplyRowsCache();
  }
}

test('a header-only NWRFC report (no forecast yet this water year) is cached: the next briefing asks again for nothing', async () => {
  const { requests, second } = await twoBriefings('ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n');
  assert.equal(requests, 1);
  assert.match(second.note, /carried no APR-SEP forecast/);
});

test('a 200 answer with no report header is a failed read, never cached', async () => {
  const { requests, second } = await twoBriefings('<html><body>Service unavailable</body></html>');
  assert.equal(requests, 2);
  assert.match(second.note, /did not respond/);
});

test('the forecast claim states the number and its 50 percent exceedance only: no DDM band sentence (DR-046 a)', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const pct of [20, 74, 88, 100, 130]) {
      clearWaterSupplyRowsCache();
      globalThis.fetch = async () =>
        new Response(
          'ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n' +
            `BONO3,COLUMBIA - BONNEVILLE DAM,APR-SEP,${pct},95,2026-10-08`
        );
      const result = await fetchWaterSupplyClaims(WA_SELECTION, new AbortController().signal);
      const forecast = result.claims.at(-1);
      assert.match(forecast.text, new RegExp(`is ${pct} percent of the 1991-2020 normal \\(50 percent exceedance\\)\\.`));
      assert.ok(forecast.text.endsWith('not a site-specific value.'), `${pct} percent: ${forecast.text}`);
      assert.match(forecast.uncertainty.text, /50 percent exceedance/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearWaterSupplyRowsCache();
  }
});

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
