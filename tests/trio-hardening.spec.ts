import { test, expect, type Page } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  openTribalNationsDetails,
  waitForLayerSettled
} from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  routeAllTribalFixtures,
  syntheticAiannhBody,
  syntheticBiaBody,
  routeGeojson
} from './tribal-fixtures';

/**
 * Sovereign-geography hardening (the 2026-07-15 planning true-up, D-0.7.0-037).
 *
 * R1: every fetch that can carry sovereign-boundary geometry runs with
 * `cache: 'no-store'`, so the browser HTTP cache never persists a response
 * beyond the session. The upstreams themselves permit storage (max-age=0
 * with an ETag; two of the three explicitly `public`), which makes the
 * request-level directive the ONLY enforcement of hard rule 1's
 * session-only scope. Covered: the two live Tribal-geography layers at
 * boot, and the LARNAME locate behind the one search.
 *
 * The mechanism: an init script wraps `window.fetch` and records each
 * request's `RequestInit.cache` by URL BEFORE the app boots. Route
 * interception still serves the synthetic fixtures, so no live agency is
 * touched and no real polygon enters a test artifact.
 */

const USDM_ROUTE = '**/USDM_current/FeatureServer/0/query*';

/** Hosts whose responses can carry sovereign-boundary geometry. */
const SOVEREIGN_HOSTS = [
  'tigerweb.geo.census.gov',
  'biamaps.geoplatform.gov'
] as const;

/** Install the fetch-mode recorder before any app code runs. */
async function captureFetchCacheModes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const modes: Record<string, string> = {};
    (window as unknown as { __ddmFetchCacheModes: Record<string, string> }).__ddmFetchCacheModes =
      modes;
    const orig = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      modes[url] = init?.cache ?? '(unset)';
      return orig(input, init);
    }) as typeof window.fetch;
  });
}

/** Read back the recorded modes for one host's requests. */
async function modesForHost(page: Page, host: string): Promise<string[]> {
  return page.evaluate((h) => {
    const modes =
      (window as unknown as { __ddmFetchCacheModes?: Record<string, string> })
        .__ddmFetchCacheModes ?? {};
    return Object.entries(modes)
      .filter(([url]) => url.includes(h))
      .map(([, mode]) => mode);
  }, host);
}

test.describe('R1: sovereign-geography fetches are no-store', () => {
  test('the two live Tribal-geography layers fetch with cache: no-store at boot', async ({
    page
  }) => {
    await captureFetchCacheModes(page);
    await routeAllTribalFixtures(page);
    await page.route(USDM_ROUTE, (route) => route.abort('failed'));
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations');

    for (const key of ['aiannh', 'bia-reservations'] as const) {
      await waitForLayerSettled(page, key);
      await expect(layerPill(page, key)).toHaveText('live');
    }

    for (const host of SOVEREIGN_HOSTS) {
      const modes = await modesForHost(page, host);
      expect(modes.length, `no request was captured for ${host}`).toBeGreaterThan(0);
      for (const mode of modes) {
        expect(mode, `a ${host} request ran without cache: 'no-store'`).toBe('no-store');
      }
    }
  });

  test('the LARNAME locate fetch is no-store', async ({ page }) => {
    await captureFetchCacheModes(page);
    await routeAllTribalFixtures(page);
    await page.route(USDM_ROUTE, (route) => route.abort('failed'));
    // The locate issues a fresh LARNAME query; serve it the synthetic body.
    await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
    await gotoApp(page, '?view=console');

    await page.locator('#catalog-search [data-ddm-search]').fill('yakama');
    const tribalResult = page.locator('[data-search-kind="tribal"]').first();
    await expect(tribalResult).toBeVisible();

    const before = (await modesForHost(page, 'biamaps.geoplatform.gov')).length;
    await tribalResult.click();
    await expect
      .poll(async () => (await modesForHost(page, 'biamaps.geoplatform.gov')).length, {
        message: 'the LARNAME locate never issued its BIA query',
        timeout: 15_000
      })
      .toBeGreaterThan(before);

    const modes = await modesForHost(page, 'biamaps.geoplatform.gov');
    for (const mode of modes) {
      expect(mode, "a BIA request ran without cache: 'no-store'").toBe('no-store');
    }
  });
});

/** The same fixture body, flagged as truncated by the service. */
function truncatedBody(body: unknown): unknown {
  return { ...(body as Record<string, unknown>), exceededTransferLimit: true };
}

/**
 * R2: a response the service flags as truncated (exceededTransferLimit)
 * renders (partial data beats none) but reports `degraded` ("live (partial)"),
 * never an unqualified `ready`, and is NEVER admitted to the coverage-envelope
 * session cache: a cached envelope asserts the service answered the whole
 * envelope, which a truncated response cannot claim. Admission is proven
 * behaviorally: the session cache survives a toggle, so if the truncated
 * response had been cached, the re-toggle would render from cache with NO
 * second network request.
 */
const TRUNCATION_CASES = [
  { key: 'aiannh', route: AIANNH_ROUTE, body: () => syntheticAiannhBody() },
  { key: 'bia-reservations', route: BIA_ROUTE, body: () => syntheticBiaBody() }
] as const;

test.describe('R2: truncated responses are degraded and never cached as complete', () => {
  for (const { key, route, body } of TRUNCATION_CASES) {
    test(`${key}: exceededTransferLimit reports live (partial) and re-fetches on re-toggle`, async ({
      page
    }) => {
      await routeAllTribalFixtures(page);
      await page.route(USDM_ROUTE, (r) => r.abort('failed'));

      let requestCount = 0;
      await page.route(route, (r) => {
        requestCount += 1;
        return r.fulfill({
          contentType: 'application/geo+json',
          body: JSON.stringify(truncatedBody(body()))
        });
      });

      await gotoApp(page, `?view=console&layers=${key}`);
      await waitForLayerSettled(page, key);
      await expect(layerPill(page, key)).toHaveText('live (partial)');
      const firstCount = requestCount;
      expect(firstCount).toBeGreaterThan(0);

      // Toggle off, then on (the member rows live behind the Tribal Nations
      // disclosure). The truncated response must NOT have been admitted to
      // the session cache, so the reactivation issues a fresh request
      // instead of rendering the partial from cache as `live`.
      await openTribalNationsDetails(page);
      await layerCheckbox(page, key).click();
      await expect(layerCheckbox(page, key)).not.toBeChecked();
      await layerCheckbox(page, key).click();
      await waitForLayerSettled(page, key);

      expect(
        requestCount,
        'the re-toggle rendered from cache; the truncated response was admitted as complete'
      ).toBeGreaterThan(firstCount);
      await expect(layerPill(page, key)).toHaveText('live (partial)');
    });
  }
});
