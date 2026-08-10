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

test('the Worker health response identifies the route-hardening revision', async () => {
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
    revision: '2026-08-09-route-hardening-v3'
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
  const post = await worker.fetch(
    proxyRequest(['https://api.weather.gov/points/38.5,-97.5'], {
      method: 'POST',
      body: 'unused'
    }),
    {},
    {} as Parameters<typeof worker.fetch>[2]
  );
  expect(post.status).toBe(405);
  await expect(post.json()).resolves.toMatchObject({
    error: 'method_not_allowed'
  });

  const options = await worker.fetch(
    new Request(`${WORKER_ORIGIN}/proxy`, { method: 'OPTIONS' }),
    {},
    {} as Parameters<typeof worker.fetch>[2]
  );
  expect(options.status).toBe(204);
  expect(options.headers.get('Access-Control-Allow-Methods')).toBe(
    'GET, HEAD, OPTIONS'
  );
  expect(options.headers.get('Access-Control-Allow-Headers')).toBe('Accept');
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
