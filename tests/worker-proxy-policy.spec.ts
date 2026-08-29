import { expect, test } from '@playwright/test';

import worker, {
  buildCacheKey,
  buildUpstreamRequest,
  fetchUpstreamWithTimeout,
  isAllowedRoute,
  normalizeAccept,
  parseAndValidateUpstream,
  permitsEdgeCaching,
  prepareResponseForEdgeCache,
  restoreResponseFromEdgeCache
} from '../workers/proxy/src/index';

const WORKER_ORIGIN = 'https://worker.example';

function proxyRequest(
  targets: readonly string[],
  init?: RequestInit
): Request {
  const url = new URL('/proxy', WORKER_ORIGIN);
  for (const target of targets) url.searchParams.append('url', target);
  return new Request(url, init);
}

async function expectPolicyError(
  request: Request,
  status: number,
  code: string
): Promise<void> {
  const result = parseAndValidateUpstream(request);
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: code });
}

type WorkerContext = Parameters<typeof worker.fetch>[2];

/**
 * Drive the Worker's default export the way the runtime would. The Worker is
 * imported and called in this Node process; nothing here starts miniflare or
 * `wrangler dev`, so the dispatch logic, route policy, and header contract are
 * covered but the platform bindings around them are not (see the note below
 * the last test).
 */
async function fetchWorker(
  request: Request,
  ctx: Partial<WorkerContext> = {}
): Promise<Response> {
  return worker.fetch(request, {}, ctx as WorkerContext);
}

test('the Worker health response identifies the reviewed revision', async () => {
  const response = await worker.fetch(
    new Request(`${WORKER_ORIGIN}/healthz`),
    {},
    {} as Parameters<typeof worker.fetch>[2]
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  await expect(response.json()).resolves.toMatchObject({
    status: 'ok',
    worker: 'ddm-proxy',
    revision: '2026-08-29-options-policy-v4'
  });
});

test('the exact current DDM read routes are allowed', () => {
  const allowed = [
    'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=679%3AWA%3ASNTL',
    'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stationTriplets=*%3AWA%3ASNTL',
    'https://www.usbr.gov/gp/agrimet/data_files/AgrimetSites.js',
    'https://www.usbr.gov/pn-bin/webarccsv.pl?parameter=OWY%20AF',
    'https://www.nwrfc.noaa.gov/water_supply/ws_report_csv.cgi?Type=ALL',
    'https://usdmdataservices.unl.edu/api/StateStatistics/GetDSCI?aoi=53',
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage?f=image',
    'https://api.weather.gov/points/38.5,-97.5',
    'https://api.weather.gov/gridpoints/TOP/31,80',
    'https://api.weather.gov/gridpoints/TOP/31,80/stations',
    'https://api.weather.gov/gridpoints/TOP/31,80/forecast',
    'https://api.weather.gov/stations/KSEA/observations/latest',
    'https://api.weather.gov/alerts/active?point=38.5%2C-97.5'
  ];

  for (const target of allowed) {
    const parsed = new URL(target);
    expect(isAllowedRoute(parsed), target).toBe(true);
    const result = parseAndValidateUpstream(proxyRequest([target]));
    expect(result, target).toBeInstanceOf(URL);
    expect((result as URL).toString()).toBe(parsed.toString());
  }
});

test('former host-wide and off-path routes are rejected', async () => {
  const disallowed = [
    'https://other.sc.egov.usda.gov/awdbRestApi/services/v1/data',
    'https://cwms-data.usace.army.mil/cwms-data/timeseries',
    'https://www.usbr.gov/robots.txt',
    'https://usbr.gov/pn-bin/webarccsv.pl',
    'https://nwrfc.noaa.gov/water_supply/ws_report_csv.cgi',
    'https://www.cpc.ncep.noaa.gov/products/example',
    'https://biamaps.geoplatform.gov/server/rest/services/example',
    'https://usdmdataservices.unl.edu/api/USStatistics/GetDroughtSeverityStatisticsByArea',
    'https://imagery.geoplatform.gov/iipp/rest/services/other/ImageServer/exportImage',
    'https://api.weather.gov/offices/TOP',
    'https://api.weather.gov/stations/KSEA'
  ];

  for (const target of disallowed) {
    expect(isAllowedRoute(new URL(target)), target).toBe(false);
    await expectPolicyError(
      proxyRequest([target]),
      403,
      'route_not_allowed'
    );
  }
});

test('the proxy requires exactly one URL and rejects unsafe URL components', async () => {
  await expectPolicyError(proxyRequest([]), 400, 'missing_url');
  await expectPolicyError(proxyRequest(['']), 400, 'invalid_url_count');
  await expectPolicyError(
    proxyRequest([
      'https://api.weather.gov/points/38.5,-97.5',
      'https://api.weather.gov/alerts/active?point=38.5,-97.5'
    ]),
    400,
    'invalid_url_count'
  );
  await expectPolicyError(
    proxyRequest(['http://api.weather.gov/points/38.5,-97.5']),
    400,
    'unsupported_scheme'
  );
  await expectPolicyError(
    proxyRequest(['https://user:secret@api.weather.gov/points/38.5,-97.5']),
    400,
    'credentials_not_allowed'
  );
  await expectPolicyError(
    proxyRequest(['https://api.weather.gov:444/points/38.5,-97.5']),
    400,
    'port_not_allowed'
  );

  const defaultPort = parseAndValidateUpstream(
    proxyRequest(['https://api.weather.gov:443/points/38.5,-97.5'])
  );
  expect(defaultPort).toBeInstanceOf(URL);
  expect((defaultPort as URL).port).toBe('');
});

test('only GET, HEAD, and OPTIONS are exposed through CORS', async () => {
  const post = await fetchWorker(
    proxyRequest(['https://api.weather.gov/points/38.5,-97.5'], {
      method: 'POST',
      body: 'unused'
    })
  );
  expect(post.status).toBe(405);
  expect(post.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  expect(post.headers.get('Access-Control-Allow-Origin')).toBe('*');
  await expect(post.json()).resolves.toMatchObject({
    error: 'method_not_allowed'
  });

  const options = await fetchWorker(
    proxyRequest(['https://api.weather.gov/points/38.5,-97.5'], {
      method: 'OPTIONS'
    })
  );
  expect(options.status).toBe(204);
  expect(options.headers.get('Access-Control-Allow-Methods')).toBe(
    'GET, HEAD, OPTIONS'
  );
  expect(options.headers.get('Access-Control-Allow-Headers')).toBe('Accept');
  expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(options.headers.get('Access-Control-Max-Age')).toBe('86400');
});

test('every mutating method is refused with the allowed set named', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await fetchWorker(
      proxyRequest(['https://api.weather.gov/points/38.5,-97.5'], { method })
    );
    expect(response.status, method).toBe(405);
    expect(response.headers.get('Allow'), method).toBe('GET, HEAD, OPTIONS');
    await expect(response.json()).resolves.toMatchObject({
      error: 'method_not_allowed'
    });
  }
});

test('a preflight is refused for an off-route path on an allowed host', async () => {
  const response = await fetchWorker(
    proxyRequest(['https://www.usbr.gov/robots.txt'], { method: 'OPTIONS' })
  );
  expect(response.status).toBe(403);
  // The browser must be able to READ the refusal, so the CORS headers stay on
  // it; what it must not receive is a 204 that says the route is usable.
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.get('Access-Control-Max-Age')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await expect(response.json()).resolves.toMatchObject({
    error: 'route_not_allowed'
  });
});

test('a preflight is refused for a host that is not on the allow-list', async () => {
  for (const target of [
    'https://example.com/anything',
    'https://biamaps.geoplatform.gov/server/rest/services/example',
    'https://www.cpc.ncep.noaa.gov/products/example'
  ]) {
    const response = await fetchWorker(
      proxyRequest([target], { method: 'OPTIONS' })
    );
    expect(response.status, target).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin'), target).toBe(
      '*'
    );
    await expect(response.json()).resolves.toMatchObject({
      error: 'route_not_allowed'
    });
  }
});

test('a preflight with a missing or malformed target is refused, not answered 204', async () => {
  const cases: readonly [Request, number, string][] = [
    [new Request(`${WORKER_ORIGIN}/proxy`, { method: 'OPTIONS' }), 400, 'missing_url'],
    [proxyRequest([''], { method: 'OPTIONS' }), 400, 'invalid_url_count'],
    [
      proxyRequest(
        [
          'https://api.weather.gov/points/38.5,-97.5',
          'https://api.weather.gov/alerts/active'
        ],
        { method: 'OPTIONS' }
      ),
      400,
      'invalid_url_count'
    ],
    [
      proxyRequest(['http://api.weather.gov/points/38.5,-97.5'], {
        method: 'OPTIONS'
      }),
      400,
      'unsupported_scheme'
    ],
    [proxyRequest(['not-a-url'], { method: 'OPTIONS' }), 400, 'invalid_url']
  ];

  for (const [request, status, code] of cases) {
    const response = await fetchWorker(request);
    expect(response.status, code).toBe(status);
    expect(response.headers.get('Access-Control-Allow-Origin'), code).toBe('*');
    await expect(response.json()).resolves.toMatchObject({ error: code });
  }
});

test('a preflight for an unknown path is a 404, matching what a GET would return', async () => {
  for (const method of ['OPTIONS', 'GET']) {
    const response = await fetchWorker(
      new Request(`${WORKER_ORIGIN}/nope`, { method })
    );
    expect(response.status, method).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin'), method).toBe(
      '*'
    );
    await expect(response.json()).resolves.toMatchObject({
      error: 'not_found'
    });
  }
});

test('the health endpoint answers its own preflight and refuses HEAD', async () => {
  const options = await fetchWorker(
    new Request(`${WORKER_ORIGIN}/healthz`, { method: 'OPTIONS' })
  );
  expect(options.status).toBe(204);
  expect(options.headers.get('Access-Control-Allow-Methods')).toBe(
    'GET, OPTIONS'
  );
  expect(options.headers.get('Access-Control-Max-Age')).toBe('86400');

  const head = await fetchWorker(
    new Request(`${WORKER_ORIGIN}/healthz`, { method: 'HEAD' })
  );
  expect(head.status).toBe(405);
  expect(head.headers.get('Allow')).toBe('GET, OPTIONS');
});

test('HEAD is refused on a route the allow-list does not carry', async () => {
  const response = await fetchWorker(
    proxyRequest(['https://www.usbr.gov/robots.txt'], { method: 'HEAD' })
  );
  expect(response.status).toBe(403);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
});

test('HEAD on an allowed route matches GET without returning a body', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 10]);
  const background: Promise<unknown>[] = [];
  const upstreamMethods: string[] = [];

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: { match: async () => undefined, put: async () => undefined }
    }
  });
  globalThis.fetch = (async (request: Request) => {
    upstreamMethods.push(request.method.toUpperCase());
    return new Response(bytes, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': 'image/png'
      }
    });
  }) as typeof fetch;

  const target =
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage?f=image';
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    }
  };

  try {
    const get = await fetchWorker(proxyRequest([target]), ctx);
    const head = await fetchWorker(
      proxyRequest([target], { method: 'HEAD' }),
      ctx
    );

    expect(upstreamMethods).toEqual(['GET', 'HEAD']);
    expect(head.status).toBe(get.status);
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toBe(
      get.headers.get('Content-Type')
    );
    expect(head.headers.get('Cache-Control')).toBe(
      get.headers.get('Cache-Control')
    );
    expect(head.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(head.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, HEAD, OPTIONS'
    );
    expect(head.body).toBeNull();
    expect(
      Array.from(new Uint8Array(await get.arrayBuffer()))
    ).toEqual(Array.from(bytes));
    await expect(Promise.all(background)).resolves.toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) {
      Object.defineProperty(globalThis, 'caches', originalCaches);
    } else {
      Reflect.deleteProperty(globalThis, 'caches');
    }
  }
});

test('the upstream request forwards only normalized Accept and the fixed User-Agent', () => {
  const inbound = proxyRequest(
    ['https://api.weather.gov/points/38.5,-97.5'],
    {
      headers: {
        Accept: '  application/geo+json, application/json  ',
        Authorization: 'Bearer must-not-cross',
        Cookie: 'session=must-not-cross',
        Host: 'attacker.example',
        'Proxy-Authorization': 'Basic must-not-cross',
        'X-Api-Key': 'must-not-cross',
        'X-Forwarded-For': '192.0.2.1'
      }
    }
  );
  const upstream = buildUpstreamRequest(
    inbound,
    new URL('https://api.weather.gov/points/38.5,-97.5')
  );

  expect(normalizeAccept(inbound)).toBe(
    'application/geo+json, application/json'
  );
  expect([...upstream.headers.keys()].sort()).toEqual(['accept', 'user-agent']);
  expect(upstream.headers.get('Accept')).toBe(
    'application/geo+json, application/json'
  );
  expect(upstream.headers.get('User-Agent')).toBe(
    'DDM-Proxy/0.1.0 (+https://github.com/atniclimate/dynamic-drought-module)'
  );
  expect(upstream.redirect).toBe('manual');

  const defaultAccept = buildUpstreamRequest(
    proxyRequest(['https://api.weather.gov/points/38.5,-97.5']),
    new URL('https://api.weather.gov/points/38.5,-97.5')
  );
  expect(defaultAccept.headers.get('Accept')).toBe('*/*');

  const oversizedAccept = proxyRequest(
    ['https://api.weather.gov/points/38.5,-97.5'],
    { headers: { Accept: `application/json,${'x'.repeat(600)}` } }
  );
  expect(normalizeAccept(oversizedAccept)).toBe('*/*');
});

test('allowed redirects are followed with exact bytes and safe headers', async () => {
  const requests: Request[] = [];
  const bytes = new Uint8Array([0, 255, 13, 10, 123, 125]);
  const initial = buildUpstreamRequest(
    proxyRequest(['https://api.weather.gov/points/38.5,-97.5'], {
      headers: { Accept: 'application/json', 'X-Api-Key': 'must-not-cross' }
    }),
    new URL('https://api.weather.gov/points/38.5,-97.5')
  );

  const response = await fetchUpstreamWithTimeout(
    initial,
    1000,
    (async (request: Request) => {
      requests.push(request);
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/gridpoints/TOP/31,80' }
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
    }) as typeof fetch
  );

  expect(requests.map((request) => request.url)).toEqual([
    'https://api.weather.gov/points/38.5,-97.5',
    'https://api.weather.gov/gridpoints/TOP/31,80'
  ]);
  for (const request of requests) {
    expect([...request.headers.keys()].sort()).toEqual(['accept', 'user-agent']);
  }
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(bytes)
  );
});

test('redirects fail closed on an off-route target or HTTPS downgrade', async () => {
  for (const location of [
    'https://api.weather.gov/offices/TOP',
    'https://example.com/anything',
    'http://api.weather.gov/gridpoints/TOP/31,80',
    'https://api.weather.gov:444/gridpoints/TOP/31,80'
  ]) {
    let calls = 0;
    const response = await fetchUpstreamWithTimeout(
      new Request('https://api.weather.gov/points/38.5,-97.5'),
      1000,
      (async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: location }
        });
      }) as typeof fetch
    );
    expect(calls, location).toBe(1);
    expect(response.status, location).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'redirect_not_allowed'
    });
  }
});

test('the upstream deadline remains active through body consumption', async () => {
  const pending = fetchUpstreamWithTimeout(
    new Request('https://api.weather.gov/points/38.5,-97.5'),
    25,
    (async (_request: Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error('expected an upstream AbortSignal');
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener(
              'abort',
              () => controller.error(signal.reason),
              { once: true }
            );
          }
        })
      );
    }) as typeof fetch
  );

  await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
});

test('a full proxy read preserves bytes and swallows cache.put rejection', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 10]);
  const background: Promise<unknown>[] = [];
  let upstreamRequest: Request | null = null;
  let cachedKey: Request | null = null;
  let cachedResponse: Response | null = null;

  const fakeCache = {
    match: async () => undefined,
    put: async (key: Request, response: Response) => {
      cachedKey = key;
      cachedResponse = response;
      throw new Error('simulated cache rejection');
    }
  };

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: fakeCache }
  });
  globalThis.fetch = (async (request: Request) => {
    upstreamRequest = request;
    return new Response(bytes, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Origin': 'https://upstream.example',
        'Content-Type': 'image/png',
        'Set-Cookie': 'must-not-cross=true'
      }
    });
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      proxyRequest([
        'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage?f=image'
      ], {
        headers: {
          Accept: 'image/png',
          Authorization: 'Bearer must-not-cross',
          'X-Api-Key': 'must-not-cross'
        }
      }),
      {},
      {
        waitUntil(promise: Promise<unknown>) {
          background.push(promise);
        }
      } as Parameters<typeof worker.fetch>[2]
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(bytes)
    );
    expect(upstreamRequest).not.toBeNull();
    expect([...(upstreamRequest as Request).headers.keys()].sort()).toEqual([
      'accept',
      'user-agent'
    ]);
    expect(cachedKey?.headers.get('Accept')).toBe('image/png');
    expect(cachedResponse?.headers.get('Cache-Control')).toBe(
      'public, max-age=60'
    );
    await expect(Promise.all(background)).resolves.toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) {
      Object.defineProperty(globalThis, 'caches', originalCaches);
    } else {
      Reflect.deleteProperty(globalThis, 'caches');
    }
  }
});

test('the cache key carries normalized Accept', () => {
  const key = buildCacheKey(
    new URL('https://api.weather.gov/points/38.5,-97.5'),
    'application/geo+json, application/json'
  );
  const otherRepresentation = buildCacheKey(
    new URL('https://api.weather.gov/points/38.5,-97.5'),
    'application/json'
  );
  expect(key.method).toBe('GET');
  expect(key.headers.get('Accept')).toBe(
    'application/geo+json, application/json'
  );
  expect(new URL(key.url).searchParams.get('__ddm_accept')).toBe(
    'application/geo+json, application/json'
  );
  expect(key.url).not.toBe(otherRepresentation.url);
});

test('the edge cache is capped at 60 seconds without changing upstream response headers', async () => {
  const upstreamCacheControl = 'public, max-age=82673, s-maxage=120';
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  const response = new Response(bytes, {
    status: 200,
    headers: { 'Cache-Control': upstreamCacheControl }
  });

  expect(permitsEdgeCaching(response)).toBe(true);
  const cached = prepareResponseForEdgeCache(response);
  expect(cached.headers.get('Cache-Control')).toBe('public, max-age=60');

  const restored = restoreResponseFromEdgeCache(cached);
  expect(restored).not.toBeNull();
  expect(restored?.headers.get('Cache-Control')).toBe(upstreamCacheControl);
  expect(restored?.headers.get('X-DDM-Origin-Cache-Control')).toBeNull();
  expect(
    Array.from(new Uint8Array(await (restored as Response).arrayBuffer()))
  ).toEqual(Array.from(bytes));
});

test('the edge cache respects an upstream lifetime shorter than 60 seconds', () => {
  const response = new Response('short lived', {
    status: 200,
    headers: { 'Cache-Control': 'public, max-age=45, s-maxage=12' }
  });

  expect(permitsEdgeCaching(response)).toBe(true);
  expect(prepareResponseForEdgeCache(response).headers.get('Cache-Control')).toBe(
    'public, max-age=12'
  );
});

test('the edge cache refuses non-200, Vary star, and private responses', () => {
  const responses = [
    new Response(null, { status: 204 }),
    new Response('partial', { status: 206 }),
    new Response('varies', { status: 200, headers: { Vary: '*' } }),
    new Response('varies', {
      status: 200,
      headers: { Vary: 'Accept, *' }
    }),
    ...[
      'no-store',
      'private, max-age=600',
      'no-cache',
      'public, s-maxage=0'
    ].map(
      (cacheControl) =>
        new Response('not cacheable', {
          status: 200,
          headers: { 'Cache-Control': cacheControl }
        })
    )
  ];

  for (const response of responses) {
    expect(permitsEdgeCaching(response)).toBe(false);
  }
});

/**
 * Scope of this file, stated so a green run is not read as more than it is.
 *
 * COVERED. The Worker module is imported and its default `fetch` is called in
 * this Node process, so dispatch order, the route and method policy, preflight
 * validation, CORS and `Allow` headers, redirect re-validation, the upstream
 * deadline, header minimization, byte transparency, and the edge-cache
 * decisions are all exercised against the real implementation. Upstream fetches
 * and `caches.default` are replaced with local fakes, which is what makes the
 * byte-transparency assertions deterministic.
 *
 * NOT COVERED. Nothing here starts miniflare, `wrangler dev`, or the deployed
 * edge, so the platform layer is untested by this file: the `RATE_LIMITER`
 * binding and its fail-open path, the real `caches.default` storage and its
 * time-to-live, Cloudflare's own header handling, and whether the published
 * Worker is these bytes at all. That last question is a live probe, not a unit
 * test; the Worker's `WORKER_REVISION` is a claim by the source, not evidence
 * about what is running.
 */
