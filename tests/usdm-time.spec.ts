import { test, expect, type Page } from './offline-test';
import { gotoApp, layerCheckbox, layerPill, PILL, search, urlLayers } from './helpers';

const LATEST_MS = Date.UTC(2026, 5, 30);
const PRIOR_WEEK = '20260623';
const PRIOR_WHERE = "MapDate=timestamp '2026-06-23 00:00:00'";
const EMPTY_STATUS = 'no coverage returned by the active drought source';
const EMPTY_FRAME = { type: 'FeatureCollection', features: [] };
const CURRENT_FRAME = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { DM: 2, MapDate: LATEST_MS },
    geometry: {
      type: 'Polygon',
      coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]]
    }
  }]
};

/** A populated current release anchors the rail; the prior archive is a successful empty read. */
async function stubUsdmWeeks(page: Page): Promise<{ current: number; archive: string[] }> {
  const requests = { current: 0, archive: [] as string[] };
  await page.route('**/USDM_current/**', (route) => {
    requests.current++;
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(CURRENT_FRAME)
    });
  });
  await page.route('**/USDM_archive/**', (route) => {
    requests.archive.push(new URL(route.request().url()).searchParams.get('where') ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(EMPTY_FRAME)
    });
  });
  return requests;
}

async function expectEmptyHistoricalWeek(page: Page): Promise<void> {
  // These are the current-week empty words pinned in conditions-strip.spec.ts.
  await expect(layerPill(page, 'usdm')).toHaveText(EMPTY_STATUS);
  await expect(layerPill(page, 'usdm')).toHaveClass(/\bno-data\b/);
  await expect(layerCheckbox(page, 'usdm')).toBeChecked();
  expect((await urlLayers(page)).has('usdm')).toBe(true);
  await expect.poll(async () => new URLSearchParams(await search(page)).get('week')).toBe(PRIOR_WEEK);

  const bar = page.locator('#time-bar');
  await expect(bar).toHaveAttribute('data-register', 'observed');
  await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Valid Jun 23, 2026');
  await expect(bar.locator('.time-bar-rail')).toHaveValue('50');
  await expect(bar.locator('[data-mode="absolute"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.locator('[data-mode="chg1"]')).toBeDisabled();
  await expect(bar.locator('[data-mode="chg4"]')).toBeDisabled();

  // The metric queries both rendered USDM fill slots, so this also rejects stale current polygons.
  const drought = page.locator('.conditions-metric[data-metric="drought"]');
  await expect(drought.locator('.conditions-value')).toHaveText('No polygon');
  await expect(drought.locator('.conditions-sublabel')).toContainText('no D0-D4 polygon rendered');
  await expect(drought).not.toContainText('no drought in view');
}

async function expectCurrentWeek(page: Page): Promise<void> {
  await expect(layerPill(page, 'usdm')).toHaveText(PILL.live);
  await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Valid Jun 30, 2026');
  await expect(page.locator('#time-bar .time-bar-rail')).toHaveValue('51');
  await expect.poll(async () => new URLSearchParams(await search(page)).has('week')).toBe(false);
  await expect(page.locator('.conditions-metric[data-metric="drought"] .conditions-value')).toHaveText('D2');
}

test.describe('USDM historical empty weeks', () => {
  test('an empty historical USDM week reads as the current week empty state, never live', async ({ page }) => {
    await stubUsdmWeeks(page);
    await gotoApp(page, '?region=washington_state&view=console&layers=usdm');
    await expectCurrentWeek(page);

    await page.locator('#time-bar [data-step="-1"]').click();
    await expectEmptyHistoricalWeek(page);
  });

  test('an empty historical deep link keeps its selected week and replaces current polygons', async ({ page }) => {
    const requests = await stubUsdmWeeks(page);
    await gotoApp(page, `?region=washington_state&view=console&layers=usdm&week=${PRIOR_WEEK}`);

    await expectEmptyHistoricalWeek(page);
    expect(requests.current).toBe(1);
    expect(requests.archive.filter((where) => where === PRIOR_WHERE)).toHaveLength(1);
    expect(new URLSearchParams(await search(page)).get('region')).toBe('washington_state');
  });

  test('cached empty and populated weeks restore their own status, date, and polygons when stepping back and forth', async ({ page }) => {
    const requests = await stubUsdmWeeks(page);
    await gotoApp(page, '?region=washington_state&view=console&layers=usdm');
    await expectCurrentWeek(page);

    for (let cycle = 0; cycle < 2; cycle++) {
      await page.locator('#time-bar [data-step="-1"]').click();
      await expectEmptyHistoricalWeek(page);
      await page.locator('#time-bar [data-step="1"]').click();
      await expectCurrentWeek(page);
    }

    // Neighbor prefetches may read other dates; the selected empty frame is fetched exactly once.
    expect(requests.current).toBe(1);
    expect(requests.archive.filter((where) => where === PRIOR_WHERE)).toHaveLength(1);
  });
});
