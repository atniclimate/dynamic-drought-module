import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import worker, {
  permitsEdgeCaching,
  prepareResponseForEdgeCache,
  restoreResponseFromEdgeCache
} from '../workers/proxy/src/index';

test('the Worker health response identifies the point-heat allowlist revision', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/healthz'),
    {},
    {} as Parameters<typeof worker.fetch>[2]
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await expect(response.json()).resolves.toMatchObject({
    status: 'ok',
    worker: 'ddm-proxy',
    revision: '2026-07-29-nws-point-heat-v2'
  });
});

test('the Worker allowlists only the exact NWS API host and supplies the identifying User-Agent', () => {
  const worker = readFileSync(
    new URL('../workers/proxy/src/index.ts', import.meta.url),
    'utf8'
  );
  expect(worker).toContain('/^api\\.weather\\.gov$/i');
  expect(worker).not.toContain(
    '/^([a-z0-9-]+\\.)*weather\\.gov$/i'
  );
  expect(worker).toContain(
    '"DDM-Proxy/0.1.0 (+https://github.com/atniclimate/dynamic-drought-module)"'
  );
  expect(worker).toContain('upstreamHeaders.set("User-Agent", USER_AGENT)');
});

test('NWS proxy support preserves the existing SSRF and body-transparency guards', () => {
  const worker = readFileSync(
    new URL('../workers/proxy/src/index.ts', import.meta.url),
    'utf8'
  );
  expect(worker).toContain('!isAllowedHost(next.hostname)');
  expect(worker).toContain('HEADERS_TO_STRIP_FROM_REQUEST');
  expect(worker).toContain('return new Response(upstream.body');
  expect(worker).not.toMatch(/JSON\.parse\(.*upstreamResponse/s);
});

test('the edge cache is capped at 60 seconds without changing upstream response headers', async () => {
  const upstreamCacheControl = 'public, max-age=82673, s-maxage=120';
  const response = new Response('unchanged bytes', {
    headers: { 'Cache-Control': upstreamCacheControl }
  });

  expect(permitsEdgeCaching(response)).toBe(true);
  const cached = prepareResponseForEdgeCache(response);
  expect(cached.headers.get('Cache-Control')).toBe('public, max-age=60');

  const restored = restoreResponseFromEdgeCache(cached);
  expect(restored).not.toBeNull();
  expect(restored?.headers.get('Cache-Control')).toBe(upstreamCacheControl);
  expect(restored?.headers.get('X-DDM-Origin-Cache-Control')).toBeNull();
  await expect(restored?.text()).resolves.toBe('unchanged bytes');
});

test('the edge cache respects upstream directives that forbid shared caching', () => {
  for (const cacheControl of [
    'no-store',
    'private, max-age=600',
    'no-cache',
    'public, s-maxage=0'
  ]) {
    expect(
      permitsEdgeCaching(
        new Response('not cacheable', {
          headers: { 'Cache-Control': cacheControl }
        })
      )
    ).toBe(false);
  }
});
