import { test, expect, type Page } from './offline-test';
import { gotoApp, showFullDetail } from './helpers';
import { readSnapshot, type SnapshotState } from './enso-snapshot-fixture';

/**
 * A snapshot whose operational RONI series is pinned to one of CPC's three
 * states, so the rendered wording is asserted against a fixture rather than
 * against whatever CPC published this month. Only `state` and `latest` are
 * overridden; the seasonal `values` (and therefore the chart) stay real.
 */
function snapshotInState(
  conditions: 'el-nino' | 'la-nina' | 'neutral',
  episode: 'el-nino' | 'la-nina' | 'neutral',
  direction: 'strengthening' | 'weakening' | 'steady',
  anom: number
): Record<string, unknown> {
  const base = readSnapshot();
  const state: SnapshotState = {
    conditions,
    episode,
    direction,
    emerging: conditions !== 'neutral' && episode === 'neutral',
    threshold: 0.5,
    conditionsRule:
      'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ensofaq.shtml',
    episodeRule: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/'
  };
  return {
    ...base,
    roni: {
      ...base.roni,
      phase: episode,
      state,
      latest: {
        ...base.roni.latest,
        anom,
        preliminary: true,
        exceedsThreshold: Math.abs(anom) >= 0.5,
        thresholdSide: anom >= 0.5 ? 'above' : anom <= -0.5 ? 'below' : 'within'
      }
    }
  };
}

/**
 * Serve the bundled snapshot with its monthly Nino 3.4 file published today,
 * so a case about how the monthly claim renders does not depend on CPC having
 * issued it within the 60-day cadence gate (audit round 5, R5-32).
 */
async function routeFreshMonthlySnapshot(page: Page): Promise<void> {
  const base = readSnapshot();
  const snapshot = { ...base, nino34: { ...base.nino34, published: new Date().toISOString().slice(0, 10) } };
  await page.route('**/data/enso-indices.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) })
  );
}

/**
 * Observed-state El Nino / Southern Oscillation (ENSO) repair
 * (0.8.0 U-ENSO-REPAIR). Assertions are structural: current phases and values
 * deliberately remain unpinned because the committed snapshot refreshes.
 */
test.describe('ENSO observed-state repair', () => {
  test('the standalone ENSO driver line is removed from the interface', async ({
    page
  }) => {
    await gotoApp(page);
    await expect(page.locator('#enso-driver')).toHaveCount(0);
  });

  test('preliminary seasonal values say they may change in every rendered surface', async ({
    page
  }) => {
    const snapshot = readSnapshot();
    expect(snapshot.roni.latest.preliminary).toBe(true);
    expect(snapshot.oni.latest.preliminary).toBe(true);

    await routeFreshMonthlySnapshot(page);
    await gotoApp(page, '?select=state:WA');

    await expect(page.locator('#enso-driver')).toHaveCount(0);

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);
    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    const chart = derived.first().locator('.impact-claim-chart');
    await expect.soft(chart).toContainText(/RONI\* [+-]?\d+\.\d{2}/);
    await expect.soft(chart).toContainText(/ONI\* [+-]?\d+\.\d{2}/);
    await expect.soft(chart).toContainText(/Preliminary: plotted value may change/i);

    const analyzed = panel.locator('.impact-claim-analyzed', {
      hasText: 'analyzed monthly Nino 3.4'
    });
    await expect(analyzed.first()).toBeVisible({ timeout: 15_000 });
    await expect(analyzed.first()).not.toContainText(/preliminary/i);
  });

  test('missing optional Nino 3.4 and SOI blocks do not restore the retired driver', async ({
    page
  }) => {
    const snapshot: Record<string, unknown> = { ...readSnapshot() };
    delete snapshot.nino34;
    delete snapshot.soi;
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot)
      })
    );

    await gotoApp(page);
    await expect(page.locator('#enso-driver')).toHaveCount(0);
  });

  for (const block of ['nino34', 'soi'] as const) {
    test(`present malformed optional ${block} block does not restore the retired driver`, async ({
      page
    }) => {
      const snapshot: Record<string, unknown> = {
        ...readSnapshot(),
        [block]: { malformed: true }
      };
      await page.route('**/data/enso-indices.json', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot)
        })
      );

      await gotoApp(page);
      await expect(page.locator('#enso-driver')).toHaveCount(0);
    });
  }

  test('briefing labels Nino 3.4 analyzed, keeps SOI supporting, and renders no plume', async ({
    page
  }) => {
    await routeFreshMonthlySnapshot(page);
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    await expect(derived.first()).toContainText('historical-continuity Oceanic Nino Index');
    await expect(derived.first()).toContainText('ocean-atmosphere agreement flag only');

    const analyzed = panel.locator('.impact-claim-analyzed', {
      hasText: 'analyzed monthly Nino 3.4'
    });
    await expect(analyzed.first()).toBeVisible({ timeout: 15_000 });
    await expect(analyzed.first().locator('.impact-claim-badge')).toHaveText('Analyzed');

    await expect(
      panel.locator('.impact-claim', { hasText: 'probabilistic ENSO outlook' })
    ).toHaveCount(0);
    await expect(
      panel.locator('.impact-claim-chart', { hasText: 'odds of El Nino' })
    ).toHaveCount(0);
  });

  test('an emerging El Nino leads with conditions and states the episode rule second', async ({
    page
  }) => {
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotInState('el-nino', 'neutral', 'strengthening', 0.98))
      })
    );

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    // The headline is the present-tense onset answer.
    await expect(derived.first()).toContainText('El Nino conditions are present and strengthening');
    // The historical rule follows, named as historical.
    await expect(derived.first()).toContainText('five consecutive overlapping seasons');
    await expect(derived.first()).toContainText('historical episode classification still reads neutral');
    // The regression this replaced: the episode rule reported as the present.
    await expect(panel).not.toContainText('ENSO is currently neutral');
    await expect(panel).not.toContainText('offers little long-range signal');

    // CPC's own status is reachable, and the app says it does not restate it.
    const authority = panel.locator('.impact-claim', { hasText: 'ENSO Diagnostic Discussion' });
    await expect(authority.first()).toBeVisible();
    await expect(authority.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml'
    );

    // The Pacific Northwest tendency carries the issuer that states it, and
    // the flat below-normal-snowpack claim is gone (report 13, ENSOSCI-09).
    const tendency = panel.locator('.impact-claim', { hasText: 'past El Nino events' });
    await expect(tendency.first()).toBeVisible();
    await expect(tendency.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.climatehubs.usda.gov/hubs/northwest/topic/el-nino-northwest-what-can-we-expect'
    );
    await expect(tendency.first()).toContainText('near-normal Washington snowpack');
    await expect(panel).not.toContainText('below-normal snowpack');
  });

  test('a La Nina read cites its issuer and carries no uncited fine-fuels claim', async ({
    page
  }) => {
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // The stored direction is the raw sign: a rise toward zero, which is a weakening La Nina.
        body: JSON.stringify(snapshotInState('la-nina', 'la-nina', 'strengthening', -1.1))
      })
    );

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    await expect(derived.first()).toContainText('La Nina conditions are present and weakening');
    await expect(derived.first()).toContainText('episode criterion is met');

    const tendency = panel.locator('.impact-claim', { hasText: 'past La Nina events' });
    await expect(tendency.first()).toBeVisible();
    await expect(tendency.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.climatehubs.usda.gov/hubs/northwest/topic/la-nina-northwest-what-can-we-expect'
    );
    // The uncited fine-fuels teleconnection was deleted, not softened.
    await expect(panel).not.toContainText('fine fuels');
  });

  test('a neutral read says so without asserting an absence of signal', async ({ page }) => {
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotInState('neutral', 'neutral', 'steady', 0.12))
      })
    );

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    await expect(derived.first()).toContainText('ENSO conditions are neutral');
    await expect(derived.first()).toContainText('CPC thresholds');
    // The uncited forecast-skill assertion is gone; the redirection stays.
    await expect(panel).not.toContainText('offers little long-range signal');
    const tendency = panel.locator('.impact-claim', {
      hasText: 'neither El Nino nor La Nina conditions present'
    });
    await expect(tendency.first()).toBeVisible();
    await expect(tendency.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/ENSO/composites/'
    );
  });
});
