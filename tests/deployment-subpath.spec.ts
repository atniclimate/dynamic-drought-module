import { expect, test } from '@playwright/test';

import { ROLE_GROUPS } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';

test('the production artifact boots from the GitHub Pages subpath', async ({
  page,
}) => {
  // Vite preview serves dist/ at the origin root, while GitHub Pages mounts
  // the same artifact beneath the repository name. Map that mount locally so
  // the browser exercises the production-relative asset URLs without adding a
  // second test server or changing the application build.
  await page.route('**/dynamic-drought-module/**', async (route) => {
    const requested = new URL(route.request().url());
    const mountedPath =
      requested.pathname.slice('/dynamic-drought-module'.length) || '/';
    const previewUrl = new URL(
      `${mountedPath}${requested.search}`,
      requested.origin,
    );
    const response = await route.fetch({ url: previewUrl.href });
    await route.fulfill({ response });
  });

  const sameOriginFailures: string[] = [];
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  // Console errors count as subpath evidence only when they concern this
  // origin. Live agency endpoints can blip (a CORS header drops, a service
  // times out) in any environment; the client already degrades those to
  // honest statuses, and this spec's claim is the deployment seat, not
  // upstream health. Script errors (pageerror above) always count.
  const externalOrigin = /https?:\/\/(?!127\.0\.0\.1:4173)[^\s'")]+/;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const locationUrl = message.location().url ?? '';
    if (externalOrigin.test(locationUrl) || externalOrigin.test(text)) return;
    runtimeErrors.push(text);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.origin === 'http://127.0.0.1:4173' &&
      response.status() >= 400
    ) {
      sameOriginFailures.push(`${response.status()} ${url.pathname}`);
    }
  });

  await stubRecentSatellite(page);
  await page.goto(
    '/dynamic-drought-module/?view=console&layers=states',
    { waitUntil: 'domcontentloaded' },
  );

  await page.waitForTimeout(1_000);
  expect(sameOriginFailures, 'subpath resource failures').toEqual([]);
  expect(runtimeErrors, 'subpath boot errors').toEqual([]);
  await expect(page.locator('#layer-toggles .layer-group')).toHaveCount(
    ROLE_GROUPS.length,
  );
  await expect
    .poll(() => page.locator('#map canvas').count(), {
      message: `map boot errors: ${runtimeErrors.join(' | ') || '(none)'}`,
    })
    .toBe(1);
  await expect(page.locator('#map canvas')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/dynamic-drought-module/');

  const entryAssets = await page
    .locator('script[src], link[rel="stylesheet"][href]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLScriptElement | HTMLLinkElement;
        return new URL(
          element instanceof HTMLScriptElement ? element.src : element.href,
        ).pathname;
      }),
    );
  expect(entryAssets.length).toBeGreaterThan(0);
  expect(entryAssets).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^\/dynamic-drought-module\/assets\//),
    ]),
  );
});
