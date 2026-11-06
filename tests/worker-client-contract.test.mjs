import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Since Worker revision v7 the proxy accepts only the query names the site
 * sends, route by route. This test calls the real client builders under a
 * stubbed fetch and runs every proxied URL they build through the real Worker
 * policy, so a builder that gains a query name turns this red before a publish.
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

const { parseAndValidateUpstream } = await import('../workers/proxy/src/index.ts');
const { URLS } = await import('../src/config/urls.ts');
const { fetchAwdbDailySeries } = await import('../src/util/awdb.ts');
const { fetchHydrometDaily } = await import('../src/util/hydromet.ts');
const { fetchWaterSupplyClaims } = await import('../src/impact/water-supply.ts');
const { fetchDsciTrendClaims, fetchNwsAlertClaims } = await import('../src/impact/sources.ts');
const { createNwsRequestSession, fetchNwsPointMetadata } = await import('../src/impact/nws-point.ts');

const selection = {
  kind: 'ecoregion',
  title: 'Test selection',
  properties: null,
  lngLat: { lng: -120.5, lat: 47.2 },
  place: null,
  containing: { state: 'WA', basis: 'point-in-polygon' },
  regionKey: 'washington_state'
};
const signal = () => new AbortController().signal;

const builders = {
  // AWDB goes direct first; the proxy is the fallback after a failed direct fetch.
  awdb: () => fetchAwdbDailySeries('679:WA:SNTL', ['WTEQ', 'SNWD', 'PREC', 'SMS'], 7, null),
  hydromet: () => fetchHydrometDaily(['OWY AF', 'OWY QD'], 7, null),
  nwrfc: () => fetchWaterSupplyClaims(selection, signal()),
  dsci: () => fetchDsciTrendClaims(selection, signal()),
  'nws points': () => fetchNwsPointMetadata(-120.5, 47.2, createNwsRequestSession(signal())),
  'nws alerts': () => fetchNwsAlertClaims(selection, signal())
};

/** Runs one NWS session read with the proxied URL failing; returns every URL fetched. */
async function nwsReadWithFailedWorker(upstream, onProxied) {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  const controller = new AbortController();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    if (url.startsWith(`${URLS.workerProxy}/proxy`)) return onProxied(controller);
    return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await createNwsRequestSession(controller.signal).fetchJson(upstream, 1000).catch((e) => e);
    return { fetched, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a failed Worker NWS read is retried direct once', async () => {
  assert.equal(URLS.nwsApiUseWorker, true, 'this case needs the proxied transport');
  const upstream = `${URLS.nwsApi}/points/45.52,-122.68`;
  const { fetched, result } = await nwsReadWithFailedWorker(upstream, () => new Response('', { status: 429 }));
  assert.deepEqual(fetched, [`${URLS.workerProxy}/proxy?url=${encodeURIComponent(upstream)}`, upstream]);
  assert.deepEqual(result, { ok: 1 });
});

test('an abandoned NWS read is not retried direct', async () => {
  const upstream = `${URLS.nwsApi}/points/45.53,-122.68`;
  const { fetched, result } = await nwsReadWithFailedWorker(upstream, (controller) => {
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  assert.equal(fetched.length, 1);
  assert.equal(result?.name, 'AbortError');
});

for (const [label, build] of Object.entries(builders)) {
  test(`the Worker accepts every proxied URL the ${label} client builds`, async () => {
    const originalFetch = globalThis.fetch;
    const proxied = [];
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${URLS.workerProxy}/proxy`)) throw new TypeError('direct fetch refused in test');
      proxied.push(url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      await build().catch(() => {});
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(proxied.length > 0, `${label} built no proxied request`);
    for (const url of proxied) {
      assert.ok(parseAndValidateUpstream(new Request(url)) instanceof URL, `Worker refused ${url}`);
      // Control: the same URL with one extra query name must be refused, so this assert can fail.
      const target = new URL(new URL(url).searchParams.get('url'));
      target.searchParams.set('ddmExtra', '1');
      const drifted = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(target.href)}`;
      assert.ok(!(parseAndValidateUpstream(new Request(drifted)) instanceof URL), `Worker accepted ${drifted}`);
    }
  });
}
