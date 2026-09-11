import { test, expect, type Page } from '@playwright/test';

import {
  gotoApp,
  layerCheckbox,
  urlLayers,
  waitForLayerSettled,
  stubCpcSeasonalTempOutlook,
  stubSpcFireOutlook,
  coverFuturePages,
  assertBuildIdentity,
  PRESET_LABELS,
  ROLE_GROUPS
} from './helpers';
import { stubRecentSatellite } from './satellite-fixture';
import { installBoundaryStubs } from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';

/**
 * DDM-P1-T04 acceptance: "a search chunk failure degrades search only, and a
 * core control island can retry successfully after an initial chunk failure."
 *
 * This spec proves both clauses at the browser. It is written to FAIL against
 * today's source (no source file changes ride with it): `src/ui/sidebar.ts`
 * mounts the island with `Promise.all([import('./island'),
 * import('./search-controller')])`, one shared catch, so a search-only chunk
 * failure today takes the whole island down with it (tests 1 and 2), and the
 * cached `islandPromise` there is never reset, so a later mount attempt
 * cannot retry (test 3). `src/ui/view-shell.ts`'s `mountBriefSearch` imports
 * the same chunk with no `.catch` at all (test 4).
 *
 * Measured fact this spec designs around (director, 2026-09-11, Chromium
 * 149.0.7827.55 under Playwright 1.61.1): Chromium keeps a failed module
 * fetch in its module map, so a second `import()` of the identical URL
 * rejects without a new network request. A retry can only succeed under a
 * NEW url, which is why test 3 counts island chunk requests instead of
 * assuming a second identical request will appear, and why the abort routes
 * below tolerate a trailing query string.
 */

/** Every request for the island chunk, tolerating a retry's query string. */
const ISLAND_CHUNK = /\/island-[^/?]*\.js(\?|$)/;

/** Every request for the search-controller chunk, tolerating a query string. */
const SEARCH_CONTROLLER_CHUNK = /\/search-controller-[^/?]*\.js(\?|$)/;

/**
 * A raw boot for the one case `gotoApp` cannot serve: a `view=brief`
 * non-embed boot whose island chunk is deliberately broken. `gotoApp` waits
 * unconditionally on `#layer-toggles .layer-group` for any boot that is not
 * a brief EMBED (`src/ui/sidebar.ts`'s `isBriefEmbed` needs `embed=true`
 * too), so it cannot express a boot where the catalog is expected to be
 * absent while the mode is merely `brief`. This helper installs the same
 * suite-wide stubs `gotoApp` installs and waits on the same pre-catalog
 * signals (`gotoApp`'s own doc comment calls this the MAP READY point),
 * never a fixed sleep. Registered in
 * `tests/boundary-boot-inventory.test.mjs` under this file's name.
 */
async function bootBriefWithoutCatalog(page: Page, query: string): Promise<void> {
  await stubRecentSatellite(page);
  await installBoundaryStubs(page, 'fixture');
  await installMinimapAnalysisStubs(page);
  await stubCpcSeasonalTempOutlook(page);
  await stubSpcFireOutlook(page);
  coverFuturePages(page);
  await page.goto(query, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#preset-chips .preset-chip')).toHaveCount(PRESET_LABELS.length);
  await assertBuildIdentity(page);
  await expect(page.locator('#region-select option')).not.toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-ddm-controls', 'ready');
  await expect.poll(() => page.locator('html').getAttribute('data-ddm-boot')).toBe('idle');
}

test.describe('island and search chunk isolation (DDM-P1-T04)', () => {
  test('a failed search chunk degrades search only: the catalog, the shell and a layer toggle still work', async ({
    page
  }) => {
    await page.route(SEARCH_CONTROLLER_CHUNK, (route) => route.abort('failed'));

    await gotoApp(page, '?layers=');

    await expect(page.locator('input[data-layer-key]')).not.toHaveCount(0);
    await expect(page.locator('#app')).toHaveClass(/\bshell-ready\b/);

    await layerCheckbox(page, 'places').check();
    await waitForLayerSettled(page, 'places');
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);

    await expect(page.locator('#catalog-search [data-ddm-search]')).toHaveCount(0);
  });

  test('a failed search chunk leaves the Layers studio usable without its search box', async ({
    page
  }) => {
    await page.route(SEARCH_CONTROLLER_CHUNK, (route) => route.abort('failed'));

    await gotoApp(page, '?view=brief&layers=places');

    await page.locator('#layers-studio-entry').click();
    const studio = page.locator('#layers-studio-root');
    await expect(studio).toBeVisible();
    await expect(studio.locator('.layer-group')).toHaveCount(ROLE_GROUPS.length);
    await expect(page.locator('#layers-studio-failure-heading')).toHaveCount(0);
    await expect(studio.locator('[data-ddm-search]')).toHaveCount(0);
  });

  test('the core island retries after its chunk fails once, and the retried catalog toggles a layer', async ({
    page
  }) => {
    let islandRequestCount = 0;
    const islandRequestUrls: string[] = [];
    await page.route(ISLAND_CHUNK, (route) => {
      islandRequestCount += 1;
      islandRequestUrls.push(route.request().url());
      if (islandRequestCount === 1) {
        void route.abort('failed');
      } else {
        void route.continue();
      }
    });

    await bootBriefWithoutCatalog(page, '?view=brief&layers=');
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);

    // The real mode control (view-shell.ts's buildModeSwitch), not a direct
    // state mutation: the click is what re-arms `ensureIslandMounted` via
    // `onViewModeChange` in sidebar.ts.
    await page.locator('[data-view="console"]').click();

    await expect(page.locator('input[data-layer-key]')).not.toHaveCount(0);
    await expect(page.locator('#app')).toHaveClass(/\bshell-ready\b/);

    await layerCheckbox(page, 'places').check();
    await waitForLayerSettled(page, 'places');
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);

    expect(islandRequestCount).toBeGreaterThanOrEqual(2);
    // A count of two alone cannot rule out a preload link plus a single
    // `import()` on the first attempt; a `retry=` query on at least one
    // recorded URL proves the retry path in `createChunkLoader`
    // (src/util/chunk-retry.ts) actually ran.
    expect(islandRequestUrls.some((url) => new URL(url).searchParams.has('retry'))).toBe(true);
  });

  test('a failed search chunk raises no unhandled rejection from any search host', async ({
    page
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(SEARCH_CONTROLLER_CHUNK, (route) => route.abort('failed'));

    // gotoApp's own boot-idle poll (default `bootIdle: true`) is the wait:
    // no fixed sleep is added here or anywhere else in this spec.
    await gotoApp(page, '?layers=');

    const searchHostErrors = pageErrors.filter((error) =>
      error.message.includes('search-controller')
    );
    expect(searchHostErrors).toHaveLength(0);
  });
});
