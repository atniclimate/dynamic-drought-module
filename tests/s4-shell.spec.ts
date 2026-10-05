import { test, expect } from '@playwright/test';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';
import { TEMPORAL_HORIZON_KEYS } from '../src/config/clusters';
import { HORIZON_CHROME, SHELL_HORIZON_KEY } from '../src/impact/horizon-chrome';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  search,
  stubHeatRiskCatalog,
  urlLayers,
  waitForLayerSettled
} from './helpers';

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

for (const viewport of [{ width: 1440, height: 1000 }, { width: 958, height: 935 }, { width: 900, height: 675 }]) {
  test(`upper navigation stays in place across hazard work and selection at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const empty = JSON.stringify({ type: 'FeatureCollection', features: [] });
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
    for (const key of ['wildfire', 'heat', 'enso']) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      gates.set(key, { promise, release });
    }
    let sstModuleRequests = 0;
    await page.route(/\/assets\/sst-anomaly-[^/?]+\.js(?:\?|$)/, async (route) => {
      // SST reports its latest surface ready before its date axis resolves.
      // The layer controller's module load is the observable pending phase.
      sstModuleRequests += 1;
      await gates.get('enso')!.promise;
      await route.continue();
    });
    await page.route('https://tile.openstreetmap.org/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: pixel }));
    await page.route((url) => url.href.includes('NOAA_Satellite_Smoke_Detection') ||
      url.hostname === 'api.weather.gov' || url.pathname.endsWith('/WWA/watch_warn_adv/MapServer/1/query'),
    (route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: empty }));
    await page.route('**/WFIGS_Interagency_Perimeters_Current/**', async (route) => {
      await gates.get('wildfire')!.promise;
      await route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify({
        type: 'FeatureCollection', features: [{
          type: 'Feature',
          properties: { attr_UniqueFireIdentifier: 'navigation-fixture', attr_IncidentName: 'Navigation Fixture', attr_IncidentTypeCategory: 'WF' },
          geometry: { type: 'Polygon', coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]] }
        }]
      }) });
    });
    await stubHeatRiskCatalog(page);
    await page.route((url) => url.pathname.endsWith('/NWS_HeatRisk/ImageServer'), async (route) => {
      await gates.get('heat')!.promise;
      await route.fallback();
    });
    await page.route((url) => url.href.includes('DescribeDomains'), async (route) => {
      await gates.get('enso')!.promise;
      await route.fulfill({
        status: 200, contentType: 'text/xml',
        body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
          '<ows:Identifier>time</ows:Identifier><Domain>2026-07-01/2026-07-07/P1D</Domain>' +
          '<Size>1</Size></DimensionDomain></Domains>'
      });
    });
    await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
      async (route) => {
        // Serve both latest and dated frames from the deterministic fixture.
        await gates.get('enso')!.promise;
        await route.fulfill({ status: 200, contentType: 'image/png', body: pixel });
      });

    await gotoApp(page);
    const minimap = viewport.height < 700 ? '.shell-minimap-popover-wrap' : '.shell-minimap-map';
    const selectors = ['#shell-panel', '.shell-view', '.shell-when', minimap,
      '#shell-region-host', '#brief-search', '#layers-studio-entry-host'];
    const readings: Array<{ phase: string; bounds: Array<{ selector: string; x: number; y: number; width: number; height: number }> }> = [];
    const sample = async (phase: string): Promise<void> => {
      // Read consecutive painted frames, including the held loading state,
      // rather than treating a settled final rectangle as proof of stability.
      for (let frame = 0; frame < 3; frame += 1) {
        const bounds = await page.evaluate(async (items) => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return items.map((selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Missing navigation control: ${selector}`);
            const { x, y, width, height } = element.getBoundingClientRect();
            return { selector, x, y, width, height };
          });
        }, selectors);
        readings.push({ phase: `${phase}, frame ${frame + 1}`, bounds });
      }
    };
    try {
      await sample('Drought settled');
      for (const [key, source] of [['wildfire', 'nifc-fires'], ['heat', 'heatrisk'], ['enso', 'sst-anomaly']] as const) {
        const button = page.locator(`.shell-cluster-btn[data-cluster="${key}"]`);
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        if (key === 'enso') await expect.poll(() => sstModuleRequests).toBeGreaterThan(0);
        await expect(button).toHaveAttribute('data-pending', 'true');
        await sample(`${key} loading`);
        gates.get(key)!.release();
        await expect(button).toHaveAttribute('data-pending', 'false', { timeout: 25_000 });
        await expect(layerPill(page, source)).toHaveText(/^live(?: \(partial\))?$/);
        if (key === 'enso') {
          // Value-only migration (found-014): the heading now leads with the
          // pressed horizon chip's own HORIZON_CHROME title ('Current
          // Conditions', the boot default here), so the stamp's own words
          // follow it rather than standing alone.
          await expect(page.locator('.shell-time-headline')).toHaveText(
            'Current Conditions · Observed Jul 7, 2026'
          );
        }
        await sample(`${key} settled`);
      }
      await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
      await expect(page.locator('.shell-cluster-btn[data-cluster="drought"]')).toHaveAttribute('data-pending', 'false');
      await page.locator('#brief-search [data-ddm-search]').fill('oregon');
      await page.locator('#brief-search [data-search-kind="place"][data-search-id="OR"]').click();
      await expect(page.locator('#brief-place-name')).toHaveText('Oregon');
      await sample('Drought with Oregon selected');
    } finally {
      for (const gate of gates.values()) gate.release();
    }

    const baseline = readings[0]!.bounds;
    const shifts = readings.flatMap(({ phase, bounds }) => bounds.flatMap((box, index) => {
      const before = baseline[index]!;
      return (['x', 'y', 'width', 'height'] as const).flatMap((dimension) =>
        Math.abs(box[dimension] - before[dimension]) > 1
          ? [{ phase, selector: box.selector, dimension, before: before[dimension], after: box[dimension] }]
          : []);
    }));
    expect(shifts, 'Source work and selected-place context must not move upper navigation controls').toEqual([]);
  });
}

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

  test('the empty heat/season-ahead recipe is disabled with its reason and yields the honest no-surface primary', async ({
    page
  }) => {
    // DDM-P8-T03 (DR-017 a): the season-ahead chip is disabled for an
    // empty recipe, so a click on it never lands here.
    // FLIPPED 2026-09-27 (D1 M6, found-009): the deep link this case used,
    // `?cluster=heat&horizon=season-ahead`, now boots on Current Conditions
    // (src/state/url.ts's resolveHorizonForCluster; pinned by
    // tests/precedence.spec.ts row A6), so it no longer reaches this state.
    // The one route left is in session: Drought at Long Range, then
    // Extreme Heat, which keeps the committed horizon (the designed
    // empty-recipe caveat, tests/cluster-service.spec.ts's "the empty
    // recipe" case). Every assertion below is unchanged; only the route in
    // is new. The CPC Drought Outlook the Long Range step shows is answered
    // locally.
    await stubCpcDroughtOutlook(page);
    await gotoApp(page, '?view=console');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await season.click();
    await expect(season).toHaveAttribute('aria-pressed', 'true');
    await waitForLayerSettled(page, 'drought');
    await page.locator('.shell-cluster-btn[data-cluster="heat"]').click();
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="heat"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(season).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shell-summary-primary')).toHaveText(
      'No verified Extreme Heat surface is available at this horizon; showing reference layers only.'
    );
    await expect(season).toHaveAttribute('aria-disabled', 'true');
    // DDM-P8-T03 step 3 stop rule: the always-visible `.shell-horizon-note`
    // line was reverted (interface-responsive.spec.ts's 900x675 tablet
    // band went red on the collision it introduced); the reason still
    // reaches every consumer through `title`, the same pattern the
    // custom-composition case above already uses.
    await expect(season).toHaveAttribute(
      'title',
      'No verified season-ahead Extreme Heat map surface exists yet.'
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
        '.shell-when',
        '.shell-minimap-map',
        '.shell-minimap-popover-wrap',
        '#shell-region-host',
        '#shell-refine-host'
      ].map(indexOf);
    });
    expect(shellOrder).toEqual([...shellOrder].sort((a, b) => a - b));
    expect(shellOrder.every((index) => index >= 0)).toBe(true);
    await expect(page.locator('#brief-display + #shell-details-panel')).toHaveCount(1);
    await expect(page.locator('#shell-details-island > #shell-conditions-summary')).toHaveCount(1);
    await expect(page.locator('#shell-panel #shell-conditions-summary')).toHaveCount(0);

    for (const id of ['conditions-strip', 'legend-panel', 'panel-region', 'share-btn', 'brief-head']) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    await expect(page.locator('#conditions-strip-dock > #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#sidebar-key-host > #legend-panel')).toHaveCount(1);
    await expect(page.locator('#shell-region-host > #panel-region')).toHaveCount(1);
    await expect(page.locator('#sidebar > #shell-share-host > #share-btn')).toHaveCount(1);
    await expect(page.locator('#map-condition-indicator #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#brief-head-lede')).toHaveCount(0);
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

  test('a horizon switch to a longer outlook headline does not shift the shell layout (fix-lane Defect 1)', async ({
    page
  }) => {
    // NADM's 'Consensus month ...' stamp is short and single-line; the CPC
    // outlook's 'Issued ... . through ...' stamp is markedly longer and,
    // pre-fix, wrapped the headline to a second line with no reserved
    // height, pushing every control below it down. app.css's
    // .shell-time-headline now reserves a fixed two-line box, so this
    // switch must not move the regional navigation seated after it.
    await routeCpcOutlook(page);
    await gotoApp(page);

    const headline = page.locator('.shell-time-headline');
    await expect(headline).toBeVisible();
    await expect(headline).toContainText('Consensus month');

    const navigation = page.locator('#shell-minimap-heading');
    const before = await navigation.boundingBox();
    expect(before).not.toBeNull();

    await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
    await expect(headline).toContainText('Issued', { timeout: 45_000 });
    await expect(headline).toContainText('through Jul 2026');

    const after = await navigation.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  });

  // S30D D1 M13 (found-010, found-017; DDM-P8-T07): a STRENGTHENED
  // assertion over the case above, not an edit to make a test pass. The
  // case above reads only #shell-minimap-heading at the suite's default
  // viewport; this extension adds #shell-share-host (the Share control's
  // sidebar seat, S4's rehosted `#share-btn`) at the four desktop widths
  // the design record's acceptance names, where --sidebar-w is the
  // unclamped 340px constant (app.css:394-398's tablet clamp band ends at
  // 1024px, below every width here). Red only if either element moves;
  // green on base counts as the acceptance's own measurement, named so in
  // the report.
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 }
  ]) {
    test(`a horizon switch to a longer outlook headline moves neither #shell-minimap-heading nor #shell-share-host by more than 1 px at ${viewport.width}x${viewport.height} (found-010, found-017)`, async ({
      page
    }) => {
      await page.setViewportSize(viewport);
      await routeCpcOutlook(page);
      await gotoApp(page);

      const headline = page.locator('.shell-time-headline');
      await expect(headline).toBeVisible();
      await expect(headline).toContainText('Consensus month');

      const navigation = page.locator('#shell-minimap-heading');
      const shareHost = page.locator('#shell-share-host');
      const navBefore = await navigation.boundingBox();
      const shareBefore = await shareHost.boundingBox();
      expect(navBefore).not.toBeNull();
      expect(shareBefore).not.toBeNull();

      await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
      await expect(headline).toContainText('Issued', { timeout: 45_000 });
      await expect(headline).toContainText('through Jul 2026');

      const navAfter = await navigation.boundingBox();
      const shareAfter = await shareHost.boundingBox();
      expect(navAfter).not.toBeNull();
      expect(shareAfter).not.toBeNull();
      expect(Math.abs(navAfter!.y - navBefore!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(shareAfter!.y - shareBefore!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(shareAfter!.x - shareBefore!.x)).toBeLessThanOrEqual(1);
    });
  }

  test('the time card heading names the pressed horizon chip in HORIZON_CHROME\'s own words at every Drought horizon, and the door opens anchored to its trigger (found-014, found-015)', async ({
    page
  }) => {
    await routeCpcOutlook(page);
    await gotoApp(page);

    // found-014: the heading is not a literal per-surface guess; it is
    // read straight from HORIZON_CHROME for whichever chip is pressed, at
    // every enabled horizon this cluster offers (TEMPORAL_HORIZON_KEYS,
    // never a hard-coded list, DR-113).
    //
    // found-015 (M12 repair, the director's door rule): NADM (Drought,
    // Current) is one period (`periodCount`, time-popover.tsx: no rail,
    // no modes), so its door keeps its 64px seat but goes disabled AND
    // hidden rather than opening on nothing; the CPC outlook at Weeks
    // ahead and Season ahead has `modes` (Monthly / Seasonal,
    // `periodCount` = 2), so those two stay enabled and openable. Read
    // the door's own visibility live rather than assuming which horizon
    // is which, so a future recipe change cannot go stale here.
    for (const key of TEMPORAL_HORIZON_KEYS) {
      const chip = page.locator(`.shell-horizon-btn[data-horizon="${key}"]`);
      if ((await chip.getAttribute('aria-disabled')) === 'true') continue;
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
      const chrome = HORIZON_CHROME[SHELL_HORIZON_KEY[key]];
      await expect(page.locator('.shell-time-headline-horizon')).toHaveText(chrome.title, {
        timeout: 45_000
      });
      await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'true', {
        timeout: 45_000
      });

      const door = page.locator('#shell-time-more');
      if (await door.isVisible()) {
        // The popover's own heading agrees (DetailControls reads the same
        // pressed horizon, not the surface's own declared stamp.horizon).
        await door.click();
        await expect(page.locator('.shell-time-detail-horizon')).toHaveText(
          `${chrome.title} · ${chrome.subtitle}`
        );
        await door.click();
        await expect(page.locator('#shell-time-popover')).toBeHidden();
      } else {
        await expect(door, `${key}: a one-period door stays disabled, not just hidden`).toBeDisabled();
      }
    }

    // found-015: the door opens anchored to its trigger (a measured
    // rectangle), not centred in the viewport, about 300 px away (the
    // native [popover] UA default of inset: 0; margin: auto). Season
    // ahead (the CPC Seasonal Drought Outlook, `periodCount` = 2 via its
    // two modes) is the loop's last horizon and is still pressed here, so
    // its door is the enabled, multi-period one this check needs.
    const seasonChip = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(seasonChip).toHaveAttribute('aria-pressed', 'true');
    const door = page.locator('#shell-time-more');
    await expect(door).toBeEnabled();
    const doorBox = await door.boundingBox();
    expect(doorBox).not.toBeNull();
    await door.click();
    const popover = page.locator('#shell-time-popover');
    await expect(popover).toBeVisible();
    const popoverBox = await popover.boundingBox();
    expect(popoverBox).not.toBeNull();
    expect(
      Math.abs(popoverBox!.y - (doorBox!.y + doorBox!.height))
    ).toBeLessThan(60);
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
    // cleanup ran. FLIPPED 2026-09-27 (D1 M5, found-003; the director's
    // Tier 1 scope: a failed RECIPE layer of the COMMITTED cluster keeps
    // its checkbox, so the committed view never demotes to a custom set).
    // The Season chip committed Drought, and `drought` is its season-ahead
    // recipe, so the checkbox now STAYS checked, the layer stays in the
    // Drought `layers=` claim, and the Drought button stays pressed; the
    // registry cleanup (no registration, no time-bar spec, no summary
    // claim) still runs. The title's "checkbox ... and URL claim all
    // withdraw" predates M5; it is kept because the sleep inventory keys
    // this test's wait by its exact title. The checkbox stays...
    await expect(layerCheckbox(page, 'drought')).toBeChecked({ timeout: 30_000 });
    // ...the pill carries the honest terminal error, not a live claim...
    await expect
      .poll(async () => {
        const cls =
          (await page.locator('[data-layer-status="drought"]').getAttribute('class')) ?? '';
        return cls.split(/\s+/).includes('error');
      })
      .toBe(true);
    // ...the committed Drought claim keeps the failed surface in layers=
    // (FLIPPED, D1 M5: it read "withdrawn") and the outlook token carries
    // no residue...
    await page.waitForFunction(() => {
      const raw = new URLSearchParams(window.location.search).get('layers');
      return raw !== null && raw.split(',').includes('drought');
    });
    expect((await urlLayers(page)).has('drought')).toBe(true);
    expect(await search(page)).not.toContain('outlook=');
    // ...the committed hazard stays pressed (FLIPPED, D1 M5: it read
    // "no cluster button claims the failed display")...
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');
    // ...and no empty Drought surface remains registered: no time-bar
    // spec installed, no summary claim.
    await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'false');
    await expect(page.locator('#shell-summary-primary')).not.toContainText('Drought Outlook');

    // Release the held, aborted first request LAST: a late stale
    // response must not resurrect the failed surface (no time-bar spec),
    // and the committed claim stays as it was (FLIPPED, D1 M5: the
    // checkbox and the layers= entry stay).
    for (const release of heldMonthly.splice(0, heldMonthly.length)) release();
    await page.waitForTimeout(500);
    await expect(layerCheckbox(page, 'drought')).toBeChecked();
    expect((await urlLayers(page)).has('drought')).toBe(true);
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
    await expect.poll(() => new URL(page.url()).searchParams.get('studio')).toBe('layers');
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

// D1 M8 imports. Import declarations are hoisted, so appending them beside the
// describe that uses them keeps the cases above byte-identical (append only).
import type { Page } from '@playwright/test';
import { REGIONS, regionToMapLibreBounds } from '../src/config/regions';
import type { RegionKey } from '../src/config/regions';

test.describe('M8: the refit on a sidebar toggle (found-029, DDM-P10-T07)', () => {
  // Collapsing or expanding the desktop column changes only the canvas WIDTH
  // at this size, so a bare resize keeps the vertical span and the centre,
  // while a refit changes the zoom and with it the vertical span.
  test.use({ viewport: { width: 1280, height: 720 } });

  interface Bounds {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  }

  // The production build has no map handle: the camera is read from the
  // minimap's live viewport footprint, `data-bounds` = west,south,east,north
  // rounded to 4 decimals (src/ui/island/minimap.tsx). It keeps updating on
  // the map's moveend while the collapsed sidebar hides it.
  const FOOTPRINT = '#shell-minimap-viewport';
  // Equality with the fresh-boot oracle, per edge, in degrees: about 0.1 CSS
  // px at the Washington State fit, far under the roughly 0.2 degree the
  // Washington refit moves each latitude edge.
  const ORACLE_TOLERANCE_DEG = 0.001;
  // No-refit proofs: the Mercator vertical span of data-bounds is fixed by
  // the canvas height and the zoom alone (a pan moves it by nothing), so a
  // bare width resize holds it and a refit moves it. The smallest refit here
  // (Washington State, zoom 6.28 on the 940 px open canvas to 6.43 on the
  // 1280 px closed one) moves it by about 11 percent; the tolerance is 0.2
  // percent.
  const SPAN_TOLERANCE = 0.002;
  const CENTRE_TOLERANCE_DEG = 0.001;
  // The settle floor: the handler's 220 ms delay plus the longest refit
  // flight in these cases (under 200 ms by MapLibre's flyTo arithmetic),
  // with margin. It only decides WHEN reading may start; the proof is the
  // assertion on the settled value, which must also hold for two reads.
  const SETTLE_FLOOR_MS = 900;
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );

  test.beforeEach(async ({ page }) => {
    // The OSM tile stub from the top of this file: no live tile decides a case.
    await page.route('https://tile.openstreetmap.org/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
  });

  const parseBounds = (raw: string): Bounds => {
    const [west, south, east, north] = raw.split(',').map(Number);
    if (
      west === undefined || south === undefined || east === undefined || north === undefined ||
      ![west, south, east, north].every(Number.isFinite)
    ) {
      throw new Error(`data-bounds is not west,south,east,north: ${raw}`);
    }
    return { west, south, east, north };
  };

  const mercatorY = (lat: number): number =>
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const verticalSpan = (bounds: Bounds): number =>
    mercatorY(bounds.north) - mercatorY(bounds.south);
  const spanChange = (after: Bounds, before: Bounds): number =>
    Math.abs(verticalSpan(after) - verticalSpan(before)) / verticalSpan(before);
  const centre = (bounds: Bounds): { lng: number; lat: number } => ({
    lng: (bounds.west + bounds.east) / 2,
    lat: (bounds.south + bounds.north) / 2
  });

  const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());

  /** Poll until the footprint reads the same value twice in a row, no earlier
   * than SETTLE_FLOOR_MS after `since` (page clock). With `oracle`, the two
   * equal reads must also be the oracle's camera (ORACLE_TOLERANCE_DEG per
   * edge): the refit's flight is driven by the map's render loop, so on a
   * slow runner two reads 250 ms apart can match BEFORE a frame has moved the
   * camera (s4-shell M8, GitHub run 37235148587: west -126.6329 against
   * -126.0567, flaky once). Waiting for the fact the case asserts, not for
   * the camera to stop, is the same assertion retried; a camera that never
   * reaches the oracle still ends in `expectSameCamera` naming the edge, with
   * the last stable read. */
  async function settledBounds(page: Page, since: number, oracle?: Bounds): Promise<Bounds> {
    const reads: { previous: string | null; settled: string | null; lastStable: string | null } = {
      previous: null,
      settled: null,
      lastStable: null
    };
    const atOracle =(raw: string): boolean => {
      if (oracle === undefined) return true;
      const read = parseBounds(raw);
      return (['west', 'south', 'east', 'north'] as const).every(
        (edge) => Math.abs(read[edge] - oracle[edge]) <= ORACLE_TOLERANCE_DEG
      );
    };
    try {
      await expect
        .poll(
          async () => {
            const [now, raw] = await page.evaluate(
              (selector) =>
                [
                  performance.now(),
                  document.querySelector(selector)?.getAttribute('data-bounds') ?? null
                ] as const,
              FOOTPRINT
            );
            const stable = raw !== null && raw === reads.previous && now - since >= SETTLE_FLOOR_MS;
            reads.previous = raw;
            if (stable) reads.lastStable = raw;
            if (stable && atOracle(raw)) {
              reads.settled = raw;
              return true;
            }
            return false;
          },
          { intervals: [250], timeout: 15_000, message: 'the viewport footprint settles' }
        )
        .toBe(true);
    } catch (error) {
      // Never reached the oracle: hand the caller the last stable read so its
      // `expectSameCamera` fails naming the edge and both values.
      if (oracle === undefined || reads.lastStable === null) throw error;
      return parseBounds(reads.lastStable);
    }
    return parseBounds(reads.settled!);
  }

  async function boot(page: Page, query: string): Promise<Bounds> {
    await gotoApp(page, query);
    await expect(page.locator(FOOTPRINT)).toHaveAttribute('data-bounds', /\S/);
    return settledBounds(page, 0);
  }

  async function toggleSidebar(
    page: Page,
    to: 'closed' | 'open',
    oracle?: Bounds
  ): Promise<Bounds> {
    const since = await pageNow(page);
    await page.locator(to === 'closed' ? '#sidebar-collapse' : '#sidebar-expand').click();
    if (to === 'closed') {
      await expect(page.locator('#app')).toHaveClass(/\bsidebar-collapsed\b/);
    } else {
      await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    }
    return settledBounds(page, since, oracle);
  }

  function expectSameCamera(actual: Bounds, oracle: Bounds, label: string): void {
    for (const edge of ['west', 'south', 'east', 'north'] as const) {
      expect(
        Math.abs(actual[edge] - oracle[edge]),
        `${label}: ${edge} ${actual[edge]} against the fresh boot's ${oracle[edge]}`
      ).toBeLessThanOrEqual(ORACLE_TOLERANCE_DEG);
    }
  }

  function regionBox(key: RegionKey): Bounds {
    const region = REGIONS[key];
    const [west, south, east, north] = regionToMapLibreBounds(region);
    const pad = region.padding;
    return { west: west - pad, south: south - pad, east: east + pad, north: north + pad };
  }

  function expectInside(inner: Bounds, outer: Bounds, label: string): void {
    expect(inner.west, `${label}: west edge inside`).toBeGreaterThanOrEqual(outer.west);
    expect(inner.east, `${label}: east edge inside`).toBeLessThanOrEqual(outer.east);
    expect(inner.south, `${label}: south edge inside`).toBeGreaterThanOrEqual(outer.south);
    expect(inner.north, `${label}: north edge inside`).toBeLessThanOrEqual(outer.north);
  }

  async function mapPoint(page: Page): Promise<{ x: number; y: number }> {
    const box = await page.locator('#map canvas.maplibregl-canvas').boundingBox();
    if (!box) throw new Error('the map canvas has no box');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
    await page.mouse.up();
  }

  test('opening or closing the sidebar keeps the committed region inside the remaining map area', async ({
    page
  }) => {
    test.setTimeout(180_000);
    for (const key of ['washington_state', 'national'] as const) {
      const box = regionBox(key);
      const openOracle = await boot(page, `?region=${key}`);
      const closedOracle = await boot(page, `?region=${key}&sidebar=closed`);

      // From a closed boot: expanding narrows the canvas. Before M8 the
      // resize kept the closed zoom, so the region's west and east edges fell
      // outside the remaining map area.
      const expanded = await toggleSidebar(page, 'open', openOracle);
      expectSameCamera(expanded, openOracle, `${key}: expand from a closed boot`);
      expectInside(box, expanded, `${key}: expand from a closed boot`);
      const collapsedAgain = await toggleSidebar(page, 'closed', closedOracle);
      expectSameCamera(collapsedAgain, closedOracle, `${key}: collapse after the expand`);
      expectInside(box, collapsedAgain, `${key}: collapse after the expand`);

      // From an open boot: collapsing widens the canvas; the refit fills the
      // wider area exactly as a closed boot frames it.
      await boot(page, `?region=${key}`);
      const collapsed = await toggleSidebar(page, 'closed', closedOracle);
      expectSameCamera(collapsed, closedOracle, `${key}: collapse from an open boot`);
      expectInside(box, collapsed, `${key}: collapse from an open boot`);
      const reopened = await toggleSidebar(page, 'open', openOracle);
      expectSameCamera(reopened, openOracle, `${key}: expand after the collapse`);
      expectInside(box, reopened, `${key}: expand after the collapse`);
    }
  });

  test('toggle refits committed framing without URL or briefing side effects', async ({ page }) => {
    test.setTimeout(240_000);
    const withoutSidebar = async (): Promise<string[]> => {
      const params = new URLSearchParams(await search(page));
      params.delete('sidebar');
      return [...params.entries()].map(([name, value]) => `${name}=${value}`).sort();
    };
    const sidebarTokens = async (): Promise<string[]> =>
      new URLSearchParams(await search(page)).getAll('sidebar');
    const panelState = (): Promise<string> =>
      page.evaluate(() => {
        const panel = document.getElementById('impact-panel');
        if (!panel) return 'absent';
        return `${panel.hidden ? 'hidden' : 'shown'}/${panel.classList.contains('open') ? 'open' : 'closed'}`;
      });

    for (const query of ['?region=national', '?region=washington_state', '?framing=all', '?framing=arid-west']) {
      const closedOracle = await boot(page, `${query}&sidebar=closed`);
      const openOracle = await boot(page, query);
      const keysBefore = await withoutSidebar();
      const panelBefore = await panelState();
      expect(await sidebarTokens(), `${query}: an open boot carries no sidebar=`).toEqual([]);

      // The oracle makes the settle wait for the camera the case asserts, as
      // the :1278 case does (GitHub run 37282168792, S30D B3 CI3: on a slow
      // runner two equal reads came before the refit's flight landed, west
      // -124.6708 against -125.094; the same assertion below still decides).
      const collapsed = await toggleSidebar(page, 'closed', closedOracle);
      expect(await withoutSidebar(), `${query}: collapse writes nothing but sidebar=`).toEqual(keysBefore);
      expect(await sidebarTokens(), `${query}: collapse writes sidebar=closed`).toEqual(['closed']);
      expect(await panelState(), `${query}: collapse leaves the briefing alone`).toBe(panelBefore);
      expectSameCamera(collapsed, closedOracle, `${query}: collapse`);

      const expanded = await toggleSidebar(page, 'open', openOracle);
      expect(await withoutSidebar(), `${query}: expand writes nothing but sidebar=`).toEqual(keysBefore);
      expect(await sidebarTokens(), `${query}: expand drops sidebar=`).toEqual([]);
      expect(await panelState(), `${query}: expand leaves the briefing alone`).toBe(panelBefore);
      expectSameCamera(expanded, openOracle, `${query}: expand`);
    }
  });

  test('a panned camera keeps its visible centre across a sidebar toggle', async ({ page }) => {
    await boot(page, '?region=washington_state');
    const dragSince = await pageNow(page);
    await drag(page, await mapPoint(page), -180, -90);
    const panned = await settledBounds(page, dragSince);

    const collapsed = await toggleSidebar(page, 'closed');
    expect(
      Math.abs(centre(collapsed).lng - centre(panned).lng),
      'the panned centre longitude holds'
    ).toBeLessThanOrEqual(CENTRE_TOLERANCE_DEG);
    expect(
      Math.abs(centre(collapsed).lat - centre(panned).lat),
      'the panned centre latitude holds'
    ).toBeLessThanOrEqual(CENTRE_TOLERANCE_DEG);
    expect(spanChange(collapsed, panned), 'no refit: the vertical span holds').toBeLessThanOrEqual(
      SPAN_TOLERANCE
    );
  });

  test('a pan during the transition cancels refit', async ({ page }) => {
    const before = await boot(page, '?region=washington_state');
    const point = await mapPoint(page);
    // The page's own clock times the collapse click and the first dragging
    // move, so a slow run fails on the timing it could not meet rather than
    // passing or failing on the product.
    const timings = page.evaluate(
      () =>
        new Promise<{ click: number; move: number }>((resolve) => {
          let click = -1;
          document.getElementById('sidebar-collapse')?.addEventListener(
            'click',
            () => {
              click = performance.now();
            },
            { capture: true, once: true }
          );
          const onMove = (event: MouseEvent): void => {
            if (click < 0 || event.buttons === 0) return;
            window.removeEventListener('mousemove', onMove, true);
            resolve({ click, move: performance.now() });
          };
          window.addEventListener('mousemove', onMove, true);
        })
    );
    const since = await pageNow(page);
    await page.locator('#sidebar-collapse').click();
    await drag(page, point, -160, 80);
    const { click, move } = await timings;
    expect(move - click, 'the drag began inside the 220 ms transition').toBeLessThan(180);
    await expect(page.locator('#app')).toHaveClass(/\bsidebar-collapsed\b/);

    const after = await settledBounds(page, since);
    expect(spanChange(after, before), 'no refit: the vertical span keeps the pre-toggle zoom').toBeLessThanOrEqual(
      SPAN_TOLERANCE
    );
  });

  test('a pitched camera keeps its live camera across a sidebar toggle', async ({ page }) => {
    test.setTimeout(120_000);
    const flat = await boot(page, '?region=washington_state');
    const canvas = page.locator('#map canvas.maplibregl-canvas');
    await canvas.focus();
    const pitchSince = await pageNow(page);
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    const pitched = await settledBounds(page, pitchSince);
    // The pitch landed: a tilted view reaches further north on screen.
    expect(spanChange(pitched, flat), 'the keyboard pitch changed the view').toBeGreaterThan(SPAN_TOLERANCE);

    const collapsed = await toggleSidebar(page, 'closed');
    expect(spanChange(collapsed, pitched), 'no refit: the pitched vertical span holds').toBeLessThanOrEqual(
      SPAN_TOLERANCE
    );

    // Reduced motion changes only HOW a flat committed camera refits (a jump),
    // never WHETHER it does.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const closedOracle = await boot(page, '?region=washington_state&sidebar=closed');
    await boot(page, '?region=washington_state');
    const jumped = await toggleSidebar(page, 'closed');
    expectSameCamera(jumped, closedOracle, 'reduced motion: collapse');
  });
});
