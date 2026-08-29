import { test, expect } from '@playwright/test';
import { gotoApp, search, urlLayers } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';
import { routeAllTribalFixtures } from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';

/**
 * U1 the two doors (D-ARCH-002), REWRITTEN for S2 (D-0.7.0-041): the
 * U1 answer-first boot (a Brief boot auto-opened the region briefing)
 * is DELIBERATELY SUPERSEDED. The boot never opens the impact briefing
 * without an explicit selection; a briefing opens ONLY from an explicit
 * place selection or a `select=` deep link. The two doors themselves
 * stand: BRIEF leads with the briefing search and keeps the catalog as
 * the drill-down; CONSOLE is the full map-and-layers instrument. The
 * mode round-trips through `view=` (URL as state), and URLs without it
 * follow the legacy-URL rule (D-0.7.0-017): layers= or region (without
 * select=) means the sharer meant the map (console); bare URLs and
 * select= deep links open Brief; embeds default to Brief.
 */
test.describe('U1 the two doors (view mode)', () => {
  test('a bare URL opens Brief with NO unsolicited briefing (D-0.7.0-041)', async ({ page }) => {
    await gotoApp(page);

    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);
    await expect(page.locator('#brief-head')).toBeVisible();

    // The URL records the door explicitly from the first sync.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('view'))
      .toBe('brief');

    // No briefing opens unsolicited: the panel is created lazily on
    // first open, so with no explicit selection and no select= deep
    // link it must not exist at all. The old U1 assertion (the region
    // answer auto-opening here) is deliberately superseded by
    // D-0.7.0-041 part 1.
    await page.waitForTimeout(2_000);
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    // Layers-SECOND still holds: the drill-down catalog is there.
    await expect(page.locator('#layer-toggles .layer-group')).toHaveCount(4);
  });

  test('a URL naming layers= opens the console (the sharer meant the map)', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&layers=usdm');

    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    await expect(page.locator('#brief-head')).toBeHidden();
    // No briefing panel was auto-opened (it is created lazily on first open).
    await expect(page.locator('#impact-panel')).toHaveCount(0);
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('view'))
      .toBe('console');
  });

  test('an explicit view= wins over the legacy rule', async ({ page }) => {
    await gotoApp(page, '?layers=usdm&view=brief');
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);

    await gotoApp(page, '?view=console');
    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    await expect(page.locator('#impact-panel')).toHaveCount(0);
  });

  test('the doors switch both ways, round-trip the URL, and never open unsolicited (D-0.7.0-041)', async ({
    page
  }) => {
    await gotoApp(page);
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);

    // The header switch to console: console is the map. (The interim
    // Brief-head console door retired with the LAYERS studio,
    // D-0.7.0-055 via D-0.7.0-062; the mode switch is the door now.)
    await page.locator('.view-switch [data-view="console"]').click();
    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('view'))
      .toBe('console');

    // The header switch goes back; with no explicit selection made, the
    // Brief door does NOT solicit a briefing (the U1 reopen-the-answer
    // behavior is deliberately superseded by D-0.7.0-041 part 1).
    await page.locator('.view-switch [data-view="brief"]').click();
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);
    await expect(page.locator('#impact-panel')).toHaveCount(0);
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('view'))
      .toBe('brief');
  });

  test('the newest briefing intent wins a fetch race (the picker vs the select= deep link)', async ({
    page
  }) => {
    // Regression for the U1 adversarial-review major, re-anchored on the
    // select= deep link (the boot answer it originally raced is retired,
    // D-0.7.0-041): two async briefing opens whose boundary fetches
    // resolve out of order must resolve to the LAST-DECLARED intent,
    // never to whichever fetch lands first. Setup: the FIRST us-states
    // fetch (the deep link's Washington) is held for 1.5 seconds; the
    // user picks Oregon in that window; the held deep-link fetch then
    // resolves and must YIELD.
    let first = true;
    await page.route('**/data/us-states.geojson', async (route) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });

    await gotoApp(page, '?select=state:WA');
    // Pick Oregon in the Brief head search (U3) while the deep link's
    // boundary fetch is still held.
    await page.locator('#brief-search [data-ddm-search]').fill('oregon');
    await page.locator('#brief-search [data-search-kind="place"][data-search-id="OR"]').click();

    // Summary-first (D-0.7.0-070): the pick sets the SELECTION (the
    // briefing opens only through the panel link), so the newest-intent
    // contract now reads: the summary shows the user's pick and the held
    // deep-link open YIELDS entirely (no Washington panel ever).
    await expect(page.locator('#brief-place-name')).toHaveText('Oregon', {
      timeout: 15_000
    });
    await expect(page.locator('#impact-panel.open')).toHaveCount(0);

    // Give the held deep-link fetch time to resolve, then confirm it
    // yielded: still the user's pick, still no panel.
    await page.waitForTimeout(2_000);
    await expect(page.locator('#impact-panel.open')).toHaveCount(0);
    await expect(page.locator('#brief-place-name')).toHaveText('Oregon');
  });

  test('a brief embed never downloads the catalog chunk and never solicits a briefing (C1, D-0.7.0-041)', async ({
    page
  }) => {
    const islandRequests: string[] = [];
    page.on('request', (req) => {
      if (/island-[^/]*\.js/.test(req.url())) islandRequests.push(req.url());
    });

    await stubRecentSatellite(page);
    await page.route('**/NADM-current.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { DROUGHTCAT: 'd0', YEAR_MONTH: '202607' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-125, 45], [-115, 45], [-115, 50], [-125, 50], [-125, 45]]]
            }
          }]
        })
      })
    );
    // Raw goto: gotoApp's catalog-independent signal would also work, but
    // the point here is exactly that no catalog exists to wait for. The
    // suite-wide boundary stub is installed by hand for the same reason.
    await routeAllTribalFixtures(page);
    await installMinimapAnalysisStubs(page);
    await page.goto('?embed=true', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);

    // The default layer set still activates with no catalog DOM at all
    // (the shared toggle command and the bridge are the doors since U1b).
    await expect
      .poll(async () => (await urlLayers(page)).has('nadm-drought'), { timeout: 25_000 })
      .toBe(true);

    // No briefing opens unsolicited (D-0.7.0-041; the old zero-click
    // embed answer is superseded): an embedding site that wants the
    // zero-click briefing carries select= in its iframe src, which is
    // the flagship deep-link case pinned elsewhere.
    await expect(page.locator('#impact-panel')).toHaveCount(0);
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
    expect(islandRequests).toEqual([]);
  });

  test('a legacy embed naming layers= keeps the console map (embed contract)', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&region=washington_state&layers=usdm');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    await expect(page.locator('#impact-panel')).toHaveCount(0);
  });
});
