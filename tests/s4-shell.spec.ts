import { test, expect } from '@playwright/test';
import { gotoApp, layerCheckbox, search, urlLayers } from './helpers';

/**
 * S4a: the main-screen shell boot state (the 2026-07-18 design record
 * sections 2-3). Desktop first, then the 390x844 mobile shape (the
 * shell must degrade honestly and never fight the mobile sheet), then
 * the embed guarantee (hard rule 8: shipped embed surface unchanged).
 *
 * Deterministic backbone only: cluster button identity, committed
 * aria-pressed truth, URL-as-state round trips, and the honest
 * empty-recipe summary. No exact live-value assertions.
 */

const CLUSTER_TITLES = ['Drought', 'Wildfire', 'Extreme Heat', 'ENSO'];

test.describe('S4a desktop shell boot', () => {
  test('bare boot renders the four cluster buttons with Drought committed', async ({
    page
  }) => {
    await gotoApp(page);
    const buttons = page.locator('.shell-cluster-btn');
    await expect(buttons).toHaveCount(4);
    for (const [i, title] of CLUSTER_TITLES.entries()) {
      await expect(buttons.nth(i)).toHaveText(title);
    }
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');
    for (const key of ['wildfire', 'heat', 'enso']) {
      await expect(
        page.locator(`.shell-cluster-btn[data-cluster="${key}"]`)
      ).toHaveAttribute('aria-pressed', 'false');
    }
    // The committed horizon boots 'current'.
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="current"]')
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('the summary renders status-derived truth once the display settles', async ({
    page
  }) => {
    await gotoApp(page);
    // Terminal statuses on the committed recipe clear the pending mark.
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('data-pending', 'false', { timeout: 45_000 });
    // The status-derived sentence remains in the accessibility tree for
    // diagnostics, but the redundant visible inventory is retired.
    const primary = page.locator('#shell-summary-primary');
    await expect(primary).toHaveText(/^(Showing |No layers are displayed yet\.)/);
    await expect(primary).not.toBeInViewport();
  });

  test('choosing Wildfire commits the cluster and writes the one-word URL claim', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="wildfire"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'false');
    await page.waitForFunction(() =>
      window.location.search.includes('cluster=wildfire')
    );
    // A clean cluster replaces the granular list (D-0.7.0-044).
    expect(await search(page)).not.toContain('layers=');
  });

  test('the briefing region label follows the selected hazard without a visible heading', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#brief-head-title')).toHaveCount(0);
    await expect(page.locator('#brief-head')).toHaveAttribute('aria-label', 'Drought briefing');

    for (const [key, heading] of [
      ['wildfire', 'Wildfire briefing'],
      ['heat', 'Extreme Heat briefing'],
      ['enso', 'ENSO briefing']
      ] as const) {
      await page.locator(`.shell-cluster-btn[data-cluster="${key}"]`).click();
      await expect(page.locator('#brief-head')).toHaveAttribute('aria-label', heading);
    }
  });

  test('the empty heat/season-ahead recipe yields the honest no-surface primary', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator('.shell-cluster-btn[data-cluster="heat"]').click();
    await page.locator('.shell-horizon-btn[data-horizon="season-ahead"]').click();
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shell-summary-primary')).toHaveText(
      'No verified Extreme Heat surface is available at this horizon; showing reference layers only.'
    );
  });

  test('a cluster commit at a non-current horizon round-trips through the URL (invariant 2)', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator('.shell-cluster-btn[data-cluster="wildfire"]').click();
    await page.locator('.shell-horizon-btn[data-horizon="season-ahead"]').click();
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true');
    // The share carries BOTH halves of the claim: without `horizon=`,
    // the recipient would boot the current-horizon wildfire recipe
    // (perimeters and smoke) instead of the season-ahead display (WHP)
    // the sharer was looking at.
    await page.waitForFunction(
      () =>
        window.location.search.includes('cluster=wildfire') &&
        window.location.search.includes('horizon=season-ahead')
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.shell-cluster-btn')).toHaveCount(4);
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="wildfire"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('the pre-S4 surfaces stay staged: the console door lives, Quick views stays hidden in Brief', async ({
    page
  }) => {
    await gotoApp(page);
    // Reconciliation (2026-07-24): the header mode switch STAYS as the
    // last desktop door to console (the honest console escape,
    // D-0.7.0-055 via D-0.7.0-062) pending a conductor ruling on a
    // successor; the design record's "mode-switch cleanup" does not
    // sanction retiring desktop console itself.
    await expect(page.locator('.view-switch [data-view="console"]')).toBeVisible();
    // Quick views is hidden on the desktop Brief launch pad (as since
    // E1; the shell's cluster buttons carry the view question there)
    // but remains the shipped surface of console and the mobile sheet.
    await expect(page.locator('#panel-quick-views')).toBeHidden();
    await expect(page.locator('#panel-quick-views')).toBeAttached();
  });

  test('desktop Brief seats the same controls in the ruled shell order and restores them for console and collapse', async ({
    page
  }) => {
    await gotoApp(page);

    const shellOrder = await page.locator('#shell-panel .shell').evaluate((shell) => {
      const children = Array.from(shell.children);
      const indexOf = (selector: string): number =>
        children.findIndex((child) => child.matches(selector));
      return [
        '.shell-view',
        '#shell-conditions-summary',
        '.shell-minimap-map',
        '.shell-minimap-popover-wrap',
        '#shell-region-host',
        '#shell-refine-host',
        '.shell-when',
        '#shell-share-host'
      ].map(indexOf);
    });
    expect(shellOrder).toEqual([...shellOrder].sort((a, b) => a - b));
    expect(shellOrder.every((index) => index >= 0)).toBe(true);

    for (const id of ['conditions-strip', 'legend-panel', 'panel-region', 'share-btn', 'brief-head']) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    await expect(page.locator('#conditions-strip-dock > #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#sidebar-key-host > #legend-panel')).toHaveCount(1);
    await expect(page.locator('#shell-region-host > #panel-region')).toHaveCount(1);
    await expect(page.locator('#shell-share-host > #share-btn')).toHaveCount(1);
    await expect(page.locator('#shell-refine-host > #brief-head')).toHaveCount(1);
    await expect(page.locator('#shell-conditions-heading')).toHaveText('Conditions in view');
    await expect(page.locator('#conditions-strip-dock .conditions-title')).toBeHidden();

    // Existing behavior rides the moved nodes: region navigation still owns
    // URL state, and the one share listener still produces its toast.
    await page.locator('#region-select').selectOption('region:central_oregon');
    await expect.poll(() => new URL(page.url()).searchParams.get('region')).toBe('central_oregon');
    await page.locator('#share-btn').click();
    await expect(page.locator('#copy-toast')).toBeVisible();
    await expect(page.locator('#copy-toast')).toContainText(/Link copied|Copy blocked/);

    await page.locator('.view-switch [data-view="console"]').click();
    await expect(page.locator('#conditions-strip-home + #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#legend-panel-home + #legend-panel')).toHaveCount(1);
    await expect(page.locator('#panel-region-home + #panel-region')).toHaveCount(1);
    await expect(page.locator('#share-btn-home + #share-btn')).toHaveCount(1);
    await expect(page.locator('#brief-head-home + #brief-head')).toHaveCount(1);
    await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);

    await page.locator('.view-switch [data-view="brief"]').click();
    await page.locator('#sidebar-collapse').click();
    await expect(page.locator('#conditions-strip-home + #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#legend-panel-home + #legend-panel')).toHaveCount(1);
    await expect(page.locator('#panel-region-home + #panel-region')).toHaveCount(1);
    await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
    await expect(page.locator('#brief-head-home + #brief-head')).toHaveCount(1);
  });
});

test.describe('S4 temporal register coherence (DG-080 review blocker 1)', () => {
  const CPC_FIXTURE = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          outlook: 'Persistence',
          fcst_date: '06/30/2026',
          target: 'Jul 2026'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-120, 42],
              [-110, 42],
              [-110, 47],
              [-120, 47],
              [-120, 42]
            ]
          ]
        }
      }
    ]
  };

  async function routeCpcOutlook(page: import('@playwright/test').Page): Promise<void> {
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(CPC_FIXTURE)
        })
    );
  }

  test('a legacy layers=+outlook= link restores the horizon the displayed outlook register means', async ({
    page
  }) => {
    await routeCpcOutlook(page);
    // The legacy split: `horizon=` absent, the outlook surface restored
    // at the monthly register. The one precedence rule: the DISPLAYED
    // drought register wins, so the shell must press Weeks ahead, never
    // claim Current over an outlook display.
    await gotoApp(
      page,
      '?view=brief&layers=hillshade,aiannh,bia-reservations,states,drought&outlook=monthly'
    );
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="current"]')
    ).toHaveAttribute('aria-pressed', 'false');
    // The canonical write then carries the coherent pair.
    await page.waitForFunction(() =>
      window.location.search.includes('horizon=weeks-ahead')
    );
    expect(await search(page)).toContain('outlook=monthly');
  });

  test('the current NADM view switches to the monthly outlook in one gesture', async ({
    page
  }) => {
    await routeCpcOutlook(page);
    await gotoApp(page);
    await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
    // The pressed chip claims the register the map is being switched to,
    // through the one temporal authority (requestHorizon), and the clean
    // Drought claim survives the instrument switch.
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await page.waitForFunction(
      () =>
        window.location.search.includes('horizon=weeks-ahead') &&
        window.location.search.includes('outlook=monthly')
    );
  });

  test('switching weeks-ahead to season-ahead reaches the already-mounted outlook surface', async ({
    page
  }) => {
    await routeCpcOutlook(page);
    await gotoApp(page);
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
    // The monthly register renders (the More time door's description
    // names the product register the surface installed).
    await expect(page.locator('#shell-time-more')).toHaveAttribute(
      'title',
      /Monthly Drought Outlook/,
      { timeout: 45_000 }
    );
    await page.locator('.shell-horizon-btn[data-horizon="season-ahead"]').click();
    // The exact toggle door no-ops on the already-on drought layer; the
    // mounted surface itself must apply the new register (the review's
    // second ordinary path). The URL drops outlook=monthly (seasonal is
    // the default) and the stamp swaps to the Seasonal product.
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shell-time-more')).toHaveAttribute(
      'title',
      /Seasonal Drought Outlook/,
      { timeout: 45_000 }
    );
    await page.waitForFunction(
      () =>
        window.location.search.includes('horizon=season-ahead') &&
        !window.location.search.includes('outlook=monthly')
    );
  });
});

test.describe('S4 r2: custom-composition horizon honesty and the failed range switch (DG-080 r2 finding 1)', () => {
  function cpcFixture(target: string): unknown {
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            outlook: 'Persistence',
            fcst_date: '06/30/2026',
            target
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-120, 42],
                [-110, 42],
                [-110, 47],
                [-120, 47],
                [-120, 42]
              ]
            ]
          }
        }
      ]
    };
  }

  const MONTHLY_TARGET = 'Jul 2026';
  const SEASONAL_TARGET = 'September 30';

  /** Route the two CPC outlook registers separately: MapServer/1 is the
   * Monthly layer, MapServer/4 the Seasonal (RANGE_LAYER_INDEX in
   * src/layers/drought.ts). */
  async function routeCpcPerRange(
    page: import('@playwright/test').Page,
    seasonal: 'ok' | 'fail',
    onSeasonalAttempt?: () => void
  ): Promise<void> {
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/1/'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(cpcFixture(MONTHLY_TARGET))
        })
    );
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/4/'),
      (route) => {
        onSeasonalAttempt?.();
        if (seasonal === 'fail') {
          return route.fulfill({
            status: 500,
            contentType: 'text/plain',
            body: 'synthetic upstream outage'
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(cpcFixture(SEASONAL_TARGET))
        });
      }
    );
  }

  test('a custom composition disables the horizon chips it cannot honestly apply (aria-disabled + reason)', async ({
    page
  }) => {
    // The review counterexample: custom (an extra reference layer) with
    // the US Drought Monitor displayed. A horizon switch cannot
    // re-resolve a custom set, so Weeks/Season ahead must disable with
    // an honest reason instead of pressing a chip for a time the map
    // does not show.
    await gotoApp(
      page,
      '?view=brief&layers=hillshade,aiannh,bia-reservations,states,usdm,places'
    );
    await expect(page.locator('.shell-cluster-btn')).toHaveCount(4);
    // Custom: no cluster button claims pressed.
    for (const key of ['drought', 'wildfire', 'heat', 'enso']) {
      await expect(
        page.locator(`.shell-cluster-btn[data-cluster="${key}"]`)
      ).toHaveAttribute('aria-pressed', 'false');
    }
    const current = page.locator('.shell-horizon-btn[data-horizon="current"]');
    const weeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    await expect(weeks).toHaveAttribute('aria-disabled', 'true');
    await expect(weeks).toHaveAttribute('title', /custom layer set/);
    await expect(season).toHaveAttribute('aria-disabled', 'true');
    await expect(season).toHaveAttribute('title', /custom layer set/);

    // A press on a disabled chip claims nothing: no pressed flip, no
    // horizon= write, the custom layers= truth untouched. force: true
    // because Playwright's actionability check refuses aria-disabled
    // targets; the press reaching the handler and being refused is
    // exactly what this asserts.
    await weeks.click({ force: true });
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    await expect(weeks).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('horizon=');
    expect(await search(page)).toContain('usdm');
  });

  test('a custom composition WITH the outlook displayed keeps the honest outlook flip and disables Current', async ({
    page
  }) => {
    await routeCpcPerRange(page, 'ok');
    await gotoApp(
      page,
      '?view=brief&layers=hillshade,aiannh,bia-reservations,states,drought,places&outlook=monthly'
    );
    const current = page.locator('.shell-horizon-btn[data-horizon="current"]');
    const weeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    // The displayed monthly register commits Weeks ahead (blocker-1 rule).
    await expect(weeks).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
    // Current would need a surface switch the service cannot honestly
    // apply to a custom set: disabled with the reason.
    await expect(current).toHaveAttribute('aria-disabled', 'true');
    await expect(current).toHaveAttribute('title', /custom layer set/);
    // The mounted outlook surface follows its register itself, so the
    // OTHER outlook horizon stays honestly applicable.
    expect(await season.getAttribute('aria-disabled')).toBeNull();
    await season.click();
    await expect(season).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shell-time-more')).toHaveAttribute(
      'title',
      /Seasonal Drought Outlook/,
      { timeout: 45_000 }
    );
    await page.waitForFunction(() =>
      window.location.search.includes('horizon=season-ahead')
    );
    // Still custom: the extra layer survives and no cluster is claimed.
    expect(await search(page)).not.toContain('cluster=');
    expect(await search(page)).toContain('places');
  });

  test('a failed uncached range switch rolls chip, register, URL, stamp, status, and summary back together', async ({
    page
  }) => {
    let seasonalAttempts = 0;
    await routeCpcPerRange(page, 'fail', () => {
      seasonalAttempts += 1;
    });
    // The clean drought composition at the monthly outlook register.
    await gotoApp(
      page,
      '?view=brief&layers=hillshade,aiannh,bia-reservations,states,drought&outlook=monthly'
    );
    const weeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(weeks).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
    // The monthly product rendered: the stamp carries ITS dates (read
    // off the rendered FeatureCollection, the production build's honest
    // window into the source data).
    await expect(page.locator('.shell-time-headline')).toContainText(MONTHLY_TARGET, {
      timeout: 45_000
    });

    // The switch to Season ahead fails terminally (synthetic outage).
    await season.click();
    await expect.poll(() => seasonalAttempts, { timeout: 30_000 }).toBeGreaterThan(0);

    // Rollback: the chip returns to the RENDERED range's horizon...
    await expect(weeks).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await expect(season).toHaveAttribute('aria-pressed', 'false');
    // ...the URL claim returns with it (no season-ahead residue)...
    await page.waitForFunction(
      () =>
        window.location.search.includes('horizon=weeks-ahead') &&
        window.location.search.includes('outlook=monthly') &&
        !window.location.search.includes('horizon=season-ahead')
    );
    // ...the stamp still describes the monthly product on screen (source
    // truth: these dates come from the rendered features)...
    await expect(page.locator('.shell-time-headline')).toContainText(MONTHLY_TARGET);
    await expect(page.locator('.shell-time-headline')).not.toContainText(SEASONAL_TARGET);
    await expect(page.locator('#shell-time-more')).toHaveAttribute(
      'title',
      /Monthly Drought Outlook/
    );
    // ...the status is the displayed range's honest 'live', not a
    // dangling error over a healthy render...
    await expect
      .poll(async () => {
        const cls =
          (await page.locator('[data-layer-status="drought"]').getAttribute('class')) ?? '';
        return cls.split(/\s+/).includes('ready');
      })
      .toBe(true);
    // ...and the summary still claims exactly what is displayed.
    await expect(page.locator('#shell-summary-primary')).toContainText('Drought Outlook');
  });
});

test.describe('S4 r3: an initial-load horizon supersession stays owned (DG-080 r3 finding 1)', () => {
  test('a terminal replacement failure before first render runs the controller cleanup: checkbox, registry, and URL claim all withdraw', async ({
    page
  }) => {
    // Monthly (MapServer/1): HELD, never fulfilled until after the
    // failure settles, so the FIRST drought request is superseded before
    // anything renders. Seasonal (MapServer/4): terminal synthetic
    // outage, the replacement's first-render failure.
    const heldMonthly: Array<() => void> = [];
    let seasonalAttempts = 0;
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/1/'),
      (route) => {
        heldMonthly.push(() => {
          void route
            .fulfill({
              status: 200,
              contentType: 'application/geo+json',
              body: JSON.stringify({ type: 'FeatureCollection', features: [] })
            })
            .catch(() => {
              /* aborted by the page: the per-range cancellation won */
            });
        });
      }
    );
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/4/'),
      (route) => {
        seasonalAttempts += 1;
        return route.fulfill({
          status: 500,
          contentType: 'text/plain',
          body: 'synthetic upstream outage'
        });
      }
    );

    // The clean drought composition at the monthly outlook register. The
    // routes above hold the initial outlook request open on purpose, so the
    // boot cannot settle: opt out of the boot-idle wait.
    await gotoApp(
      page,
      '?view=brief&layers=hillshade,aiannh,bia-reservations,states,drought&outlook=monthly',
      { bootIdle: false }
    );
    const weeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    // The requested monthly register commits its horizon AT REQUEST TIME,
    // so the chip presses while the first fetch is still held: nothing
    // has rendered yet, and the drought checkbox carries the intent.
    await expect(weeks).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
    await expect(layerCheckbox(page, 'drought')).toBeChecked();
    await expect.poll(() => heldMonthly.length, { timeout: 30_000 }).toBeGreaterThan(0);

    // Supersede before first render: the other outlook horizon. The
    // held monthly request aborts; the replacement seasonal request
    // fails terminally with NO prior render to roll back to.
    await season.click();
    await expect(season).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => seasonalAttempts, { timeout: 30_000 }).toBeGreaterThan(0);

    // The activation promise followed the replacement (the latest-owner
    // settle), so the controller observed the terminal error and its
    // cleanup ran: the checkbox clears...
    await expect(layerCheckbox(page, 'drought')).not.toBeChecked({ timeout: 30_000 });
    // ...the pill carries the honest terminal error, not a live claim...
    await expect
      .poll(async () => {
        const cls =
          (await page.locator('[data-layer-status="drought"]').getAttribute('class')) ?? '';
        return cls.split(/\s+/).includes('error');
      })
      .toBe(true);
    // ...the URL claim is withdrawn: the failed surface leaves layers=
    // and the outlook token carries no residue...
    await page.waitForFunction(() => {
      const raw = new URLSearchParams(window.location.search).get('layers');
      return raw !== null && !raw.split(',').includes('drought');
    });
    expect((await urlLayers(page)).has('drought')).toBe(false);
    expect(await search(page)).not.toContain('outlook=');
    // ...no cluster button claims the failed display...
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'false');
    // ...and no empty Drought surface remains registered: no time-bar
    // spec installed, no summary claim.
    await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'false');
    await expect(page.locator('#shell-summary-primary')).not.toContainText('Drought Outlook');

    // Release the held, aborted first request LAST: a late stale
    // response must not resurrect the withdrawn surface.
    for (const release of heldMonthly.splice(0, heldMonthly.length)) release();
    await page.waitForTimeout(500);
    await expect(layerCheckbox(page, 'drought')).not.toBeChecked();
    expect((await urlLayers(page)).has('drought')).toBe(false);
    await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'false');
  });
});

test.describe('S4a mobile shape (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the shell stands down; the sheet and footer nav carry mobile', async ({
    page
  }) => {
    await gotoApp(page);
    await expect(page.locator('#shell-panel')).toBeHidden();
    await expect(page.locator('#panel-response')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeVisible();
    // The mobile hazard rail remains the mobile quick-hazard surface.
    await expect(page.locator('#hazard-rail')).toBeAttached();
    // S4b staged retirement: #panel-region is PRESERVED for the mobile
    // sheet until S6 supplies labeled touch tiles.
    await expect(page.locator('#panel-region')).toBeAttached();
    await expect(page.locator('#conditions-strip-home + #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#panel-region-home + #panel-region')).toHaveCount(1);
    await expect(page.locator('#brief-head-home + #brief-head')).toHaveCount(1);
    await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
  });
});

test.describe('S4a embed guarantee', () => {
  test('an embed boot never shows the shell chrome', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    await expect(page.locator('#shell-panel')).toBeHidden();
    await expect(page.locator('#panel-response')).toBeHidden();
    await expect(page.locator('#conditions-strip-home + #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#panel-region-home + #panel-region')).toHaveCount(1);
    await expect(page.locator('#brief-head-home + #brief-head')).toHaveCount(1);
    await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
  });
});

test.describe('S4 r4: off intent during activation reaches the abort path (DG-080 r4 finding 2)', () => {
  test('toggling Drought off while its initial request is held tears down without waiting out the network budget', async ({
    page
  }) => {
    // Every CPC outlook range: HELD, never fulfilled, so activation is
    // still in flight when off intent arrives. Before the r4 fix the
    // module exported no cancelActivation, so the queued deactivate could
    // not run until this held request ran out its 20-second HEADER budget;
    // the controller's synchronous seam now aborts the master immediately.
    // The load-bearing observation: WHEN the held request is aborted. The
    // checkbox and the URL claim are NOT sufficient evidence here, because
    // the controller records off intent synchronously and both clear even
    // while the module teardown is still queued behind a hung activation
    // (verified: with the seam disabled they still pass). Only the abort
    // itself distinguishes a real cancellation from a pending one.
    const abortedAt: number[] = [];
    page.on('requestfailed', (req) => {
      if (req.url().includes('cpc_drought_outlk/MapServer/')) abortedAt.push(Date.now());
    });

    const held: Array<() => void> = [];
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/'),
      (route) => {
        held.push(() => {
          void route
            .fulfill({
              status: 200,
              contentType: 'application/geo+json',
              body: JSON.stringify({ type: 'FeatureCollection', features: [] })
            })
            .catch(() => {
              /* aborted by the page: cancellation won, which is the point */
            });
        });
      }
    );

    // The route above holds Drought's initial request open on purpose, so
    // the boot cannot settle: opt out of the boot-idle wait.
    await gotoApp(page, '?view=brief&layers=hillshade,states,drought', {
      bootIdle: false
    });
    const drought = layerCheckbox(page, 'drought');
    await expect(drought).toBeChecked();
    // The request is genuinely in flight and genuinely held.
    await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);

    // The toggle lives behind the Layer studio door in Brief view, so off
    // intent travels the real user path rather than a synthetic event. The
    // studio mounts its OWN checkbox for the same key, so from here on the
    // studio id is the unambiguous handle (the shared data-layer-key
    // locator matches both the panel and the studio input once open).
    await page.locator('#layers-studio-entry').click();
    const studioDrought = page.locator('#studio-layer-toggle-drought');
    await expect(studioDrought).toBeVisible();
    await expect(studioDrought).toBeChecked();

    // Off intent DURING activation. The bound below is the whole assertion:
    // 10 seconds is comfortably under the 20-second budget the pre-fix path
    // would have had to exhaust first, and comfortably over any honest
    // teardown cost.
    const offAt = Date.now();
    await studioDrought.uncheck();

    // THE assertion: the in-flight request is actually aborted, and well
    // inside the 20-second header budget the pre-seam path had to exhaust
    // before its queued teardown could even begin.
    await expect.poll(() => abortedAt.length, { timeout: 12_000 }).toBeGreaterThan(0);
    expect(Math.min(...abortedAt) - offAt).toBeLessThan(12_000);

    // The intent surfaces follow (necessary, not sufficient: see above).
    await expect(studioDrought).not.toBeChecked({ timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const raw = new URLSearchParams(window.location.search).get('layers');
        return raw === null || !raw.split(',').includes('drought');
      },
      undefined,
      { timeout: 10_000 }
    );

    // The surface is fully withdrawn, not merely unchecked.
    expect((await urlLayers(page)).has('drought')).toBe(false);
    expect(await search(page)).not.toContain('outlook=');
    await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'false');
    await expect(page.locator('#shell-summary-primary')).not.toContainText('Drought Outlook');

    // Release the held, aborted request LAST: a late stale response must
    // not resurrect the withdrawn surface.
    for (const release of held.splice(0, held.length)) release();
    await page.waitForTimeout(500);
    await expect(studioDrought).not.toBeChecked();
    expect((await urlLayers(page)).has('drought')).toBe(false);
    await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'false');
  });
});
