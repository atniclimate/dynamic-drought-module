import { test, expect } from './offline-test';
import { gotoApp, layerCheckbox, layerPill, PILL, search, waitForLayerSettled } from './helpers';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';

/**
 * The CPC seasonal outlooks' renderer labels, verbatim from both services'
 * Lead 1 uniqueValue renderer (cpc_sea_precip_outlk and cpc_sea_temp_outlk,
 * MapServer/0?f=json, read 2026-11-05), in the renderer's order.
 */
const CPC_SEASONAL_LABELS = [
  'Above, 90%', 'Above, 80%', 'Above, 70%', 'Above, 60%', 'Above, 50%', 'Above, 40%', 'Above, 33%',
  'Near Normal, 33%', 'Near Normal, 40%',
  'Below, 33%', 'Below, 40%', 'Below, 50%', 'Below, 60%', 'Below, 70%', 'Below, 80%', 'Below, 90%',
  'Equal Chances'
];

/**
 * The 6-10 and 8-14 day outlooks' renderer labels, verbatim from both services'
 * layer 0 and 1 uniqueValue renderers (cpc_6_10_day_outlk, cpc_8_14_day_outlk,
 * MapServer/N?f=json, read 2026-11-06), in the renderer's order.
 */
const CPC_EXTENDED_LABELS = [
  'Above, 90%', 'Above, 80%', 'Above, 70%', 'Above, 60%', 'Above, 50%', 'Above, 40%', 'Above, 33%',
  'Near Normal',
  'Below, 33%', 'Below, 40%', 'Below, 50%', 'Below, 60%', 'Below, 70%', 'Below, 80%', 'Below, 90%'
];

/** The CPC outlook keys among the rendered sections, in panel order. */
async function cpcKeys(page: import('./offline-test').Page): Promise<(string | null)[]> {
  return (await sectionKeys(page)).filter((key) => key?.startsWith('cpc-'));
}

/**
 * UX-3 unified legend registry: one panel whose sections are contributed by
 * the active layers, retiring the four ad-hoc per-layer panels.
 *
 * The CPC Drought Outlook is answered from a deterministic vector fixture.
 * Each case that enables it waits for a live layer before inspecting its legend.
 * Ecoregions is a bundled PMTiles reference; the gridded-index cases exercise
 * their own product controls.
 */

/** The data-legend keys of the rendered sections, in DOM (visual) order. */
async function sectionKeys(page: import('./offline-test').Page): Promise<(string | null)[]> {
  return page.$$eval('#legend-sections .legend-section', (els) =>
    els.map((e) => e.getAttribute('data-legend'))
  );
}

test.describe('UX-3 unified legend registry', () => {
  test('unifies the active surface and the ecoregion reference into one ordered panel', async ({
    page
  }) => {
    await stubCpcDroughtOutlook(page);
    // Console boot: this spec drives catalog checkboxes, and E1 deliverable 1
    // hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');
    // Settle the default surface first so its own activation cannot race the
    // swap below (an in-flight activation could re-add its section).
    await waitForLayerSettled(page, 'nadm-drought');

    // Turn on the fixture-backed outlook and the bundled ecoregion reference.
    // The outlook surface deactivates NADM.
    await layerCheckbox(page, 'drought').check();
    await expect(layerPill(page, 'drought')).toHaveText(PILL.live);
    await expect(layerCheckbox(page, 'drought')).toBeChecked();
    await layerCheckbox(page, 'ecoregions').check();

    const panel = page.locator('#legend-panel');
    await expect(panel).toBeVisible();

    // One panel, two sections, ordered surface then reference (NADM gone).
    await expect
      .poll(() => sectionKeys(page))
      .toEqual(['drought', 'ecoregions']);

    // The ecoregion section folds its Level III/IV selector in.
    const level = page.locator('#ecoregion-level');
    await expect(level).toBeVisible();
    await expect(level.locator('option')).toHaveCount(2);

    // The drought section rendered its swatch key.
    await expect(
      page.locator('.legend-section[data-legend="drought"] .legend li')
    ).toHaveCount(4);
  });

  test('switching the surface swaps only the surface section', async ({ page }) => {
    await stubCpcDroughtOutlook(page);
    await gotoApp(page, '?view=console'); // catalog-driving spec (E1 deliverable 1)
    await waitForLayerSettled(page, 'nadm-drought');
    await layerCheckbox(page, 'drought').check();
    await expect(layerPill(page, 'drought')).toHaveText(PILL.live);
    await expect(layerCheckbox(page, 'drought')).toBeChecked();
    await layerCheckbox(page, 'ecoregions').check();
    await expect.poll(() => sectionKeys(page)).toEqual(['drought', 'ecoregions']);

    // Swap to the gridded-index surface: it replaces drought, ecoregions stays.
    await layerCheckbox(page, 'gridded-index').check();
    await expect.poll(() => sectionKeys(page)).toEqual(['gridded-index', 'ecoregions']);

    // The gridded-index section carries its product selector, populated.
    await expect(page.locator('#gridded-index-product option')).toHaveCount(5);
  });

  /**
   * DDM-P13-T03: the gridded index must resolve to the prefix its issuer
   * publishes it under, show its own product date, and state that the raster
   * stack covers the contiguous United States only.
   *
   * The `info.json` sidecar is stubbed so the date assertions are about what
   * the layer DOES with a published date rather than about the bucket being
   * reachable, keeping this file's no-live-agency-fetch property. Two windows
   * are given different dates on purpose: they are not equally fresh upstream
   * (spi-365d carried 2026-07-01 while spi-90d carried 2026-08-31 on
   * 2026-09-03), and the legend must show the SELECTED product's own date.
   */
  test('the gridded index resolves through its issuer prefix, dates each product, and states its coverage', async ({
    page
  }) => {
    await gotoApp(page, '?view=console'); // catalog-driving spec (E1 deliverable 1)
    await waitForLayerSettled(page, 'nadm-drought');

    const dateByWindow: Record<string, string> = {
      'spi-90d': '2026-08-31',
      'spi-365d': '2026-07-01'
    };
    await page.route('**/current-conditions/tile/v1/*/info.json', async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      const slug = parts[parts.length - 2] ?? '';
      const window = slug.replace('ce-ACIS_NRCC_NN-', '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ date: dateByWindow[window] ?? '2026-01-02', tilezmax: '6' })
      });
    });

    await layerCheckbox(page, 'gridded-index').check();

    // Every offered product resolves through `ce-ACIS_NRCC_NN-`, the prefix
    // drought.gov publishes the ACIS "Grid 1" dataset's products under, and
    // the selector is still the five SPI windows: DR-049 kept expansion open
    // as a later product item, so growth here would be a decision, not a fix.
    // The selector fills after the layer's catalog read, so wait for the five
    // options before reading them once (a one-shot $$eval on an empty
    // selector would report [] and fail for the wrong reason).
    await expect(page.locator('#gridded-index-product option')).toHaveCount(5);
    const values = await page.$$eval('#gridded-index-product option', (els) =>
      els.map((e) => (e as HTMLOptionElement).value)
    );
    expect(values).toEqual([
      'ce-ACIS_NRCC_NN-spi-30d',
      'ce-ACIS_NRCC_NN-spi-60d',
      'ce-ACIS_NRCC_NN-spi-90d',
      'ce-ACIS_NRCC_NN-spi-180d',
      'ce-ACIS_NRCC_NN-spi-365d'
    ]);

    // The date is the product's own, read from the issuer, and it follows the
    // selection rather than staying on the window that happened to load first.
    await expect(page.locator('#gridded-index-valid')).toHaveText('Valid Aug 31, 2026');
    // S12: actual legend and product controls, with independent decoded issuer pins.
    // The white slot has no issuer label; no numeric threshold is inferred.
    const spiColors = [
      'rgb(115, 0, 0)', 'rgb(230, 0, 0)', 'rgb(255, 170, 0)',
      'rgb(252, 211, 127)', 'rgb(255, 255, 0)', 'rgb(255, 255, 255)',
      'rgb(170, 255, 85)', 'rgb(1, 255, 255)', 'rgb(0, 170, 255)',
      'rgb(0, 0, 255)', 'rgb(0, 0, 170)'
    ];
    for (const days of [30, 60, 90, 180, 365]) {
      await page.selectOption('#gridded-index-product', `ce-ACIS_NRCC_NN-spi-${days}d`);
      await expect(page.locator('#gridded-index-product-label')).toHaveText(`SPI, ${days} day`);
      await expect(page.locator('.gridded-index-ramp-bar > span')).toHaveCount(11);
      expect(await page.locator('.gridded-index-ramp-bar > span').evaluateAll(
        elements => elements.map(element => getComputedStyle(element).backgroundColor)
      )).toEqual(spiColors);
      await expect(page.locator('.gridded-index-ramp-bar')).toHaveCSS('background-image', 'none');
      await expect(page.locator('.gridded-index-ramp-labels')).toHaveText('DrierWetter');
    }
    await page.selectOption('#gridded-index-product', 'ce-ACIS_NRCC_NN-spi-90d');
    await expect(page.locator('#gridded-index-valid')).toHaveText('Valid Aug 31, 2026');
    await page.selectOption('#gridded-index-product', 'ce-ACIS_NRCC_NN-spi-365d');
    await expect(page.locator('#gridded-index-valid')).toHaveText('Valid Jul 1, 2026');

    // The coverage limit is stated, in the issuer's own geography. "Contiguous
    // United States" is not "the United States": the published bbox excludes
    // Alaska, Hawaii, Puerto Rico and the Pacific territories.
    const coverage = page.locator('#gridded-index-coverage');
    await expect(coverage).toContainText('the contiguous United States only');
    await expect(coverage).toContainText('Contiguous U.S.');
  });

  test('the panel hides when the last legend layer is turned off', async ({ page }) => {
    await stubCpcDroughtOutlook(page);
    await gotoApp(page, '?view=console'); // catalog-driving spec (E1 deliverable 1)
    await waitForLayerSettled(page, 'nadm-drought');
    await layerCheckbox(page, 'drought').check();
    await expect(layerPill(page, 'drought')).toHaveText(PILL.live);
    await expect(layerCheckbox(page, 'drought')).toBeChecked();
    await expect(page.locator('#legend-panel')).toBeVisible();

    // Prove the settled outlook owns the only section before removing it.
    await expect.poll(() => sectionKeys(page)).toEqual(['drought']);
    // Turning off the only legend-bearing layer leaves no section, so the panel
    // hides rather than showing an empty legend.
    await layerCheckbox(page, 'drought').uncheck();
    await expect(page.locator('#legend-panel')).toBeHidden();
    await expect(page.locator('#legend-sections .legend-section')).toHaveCount(0);
  });

  /**
   * The CPC seasonal outlook maps (their acceptance sentence, amended
   * 2026-09-26): an in-session entry into ENSO commits Season ahead, whose
   * outlook carries its own key, the renderer's 17 labels alone with Equal
   * Chances as a transparent fill inside the issuer's rgb(110,110,110)
   * outline; the temperature outlook is the mode's too, and on together
   * each keeps its own key. Both outlooks answer from `gotoApp`'s fixture.
   */
  test('entering ENSO opens on the Season ahead outlook with its own issuer key; the temperature outlook adds a second', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    await waitForLayerSettled(page, 'nadm-drought');
    const enso = page.locator('.shell-cluster-btn[data-cluster="enso"]');
    await enso.click();
    await expect(enso).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('horizon')).toBe('season-ahead');
    await expect(layerPill(page, 'cpc-seasonal-precip')).toHaveText(PILL.live);
    await expect(layerCheckbox(page, 'cpc-seasonal-temp')).not.toBeChecked();

    const precip = page.locator('.legend-section[data-legend="cpc-seasonal-precip"]');
    await expect(precip.locator('.legend-section-title')).toHaveText('Seasonal Precipitation Outlook');
    await expect(precip.locator('[data-cpc-clock]')).toHaveText(['Valid Season SON 2026 · Forecast Date Sep 1, 2026']);
    await expect(precip.locator('.legend li')).toHaveText(CPC_SEASONAL_LABELS);
    const precipEc = precip.locator('.legend li[data-cpc-class="EC,33"] .swatch');
    await expect(precipEc).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(precipEc).toHaveCSS('border-top-color', 'rgb(110, 110, 110)');

    await layerCheckbox(page, 'cpc-seasonal-temp').check();
    await expect(layerPill(page, 'cpc-seasonal-temp')).toHaveText(PILL.live);
    // The mode's own optional layer: ENSO stays pressed and the link carries it.
    await expect(enso).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('layers') ?? '').toContain('cpc-seasonal-temp');
    // Two keys, never one merged: each lists its own 17 classes.
    await expect.poll(() => cpcKeys(page)).toEqual(['cpc-seasonal-precip', 'cpc-seasonal-temp']);
    const temp = page.locator('.legend-section[data-legend="cpc-seasonal-temp"]');
    await expect(temp.locator('.legend-section-title')).toHaveText('Seasonal Temperature Outlook');
    await expect(temp.locator('.legend li')).toHaveText(CPC_SEASONAL_LABELS);
    await expect(temp.locator('.legend li[data-cpc-class="EC,33"] .swatch')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0)');
    await expect(page.locator('.legend-section[data-legend^="cpc-seasonal-"] .legend li')).toHaveCount(34);

    await layerCheckbox(page, 'cpc-seasonal-temp').uncheck();
    await expect.poll(() => cpcKeys(page)).toEqual(['cpc-seasonal-precip']);
  });

  /**
   * The CPC 6-10 and 8-14 day outlook maps, built to the seasonal sentence's
   * terms: Weeks ahead is its own map now (the 8-14 day precipitation outlook
   * beside the SST), with the day-range renderer's 15 labels alone and the
   * issuer's Start Date, End Date and Forecast Date; another day-range
   * outlook is the mode's own and keeps its own key beside it.
   */
  test('ENSO Weeks ahead draws the 8-14 day precipitation outlook with its own issuer key; another day-range outlook adds a second', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    await waitForLayerSettled(page, 'nadm-drought');
    const enso = page.locator('.shell-cluster-btn[data-cluster="enso"]');
    await enso.click();
    await expect(enso).toHaveAttribute('aria-pressed', 'true');
    const weeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    await expect(weeks).not.toHaveAttribute('aria-disabled', 'true');
    await weeks.click();
    await expect(weeks).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('horizon')).toBe('weeks-ahead');
    await expect(layerPill(page, 'cpc-814-precip')).toHaveText(PILL.live);
    await expect(layerCheckbox(page, 'cpc-seasonal-precip')).not.toBeChecked();
    await expect.poll(() => cpcKeys(page)).toEqual(['cpc-814-precip']);

    const days = page.locator('.legend-section[data-legend="cpc-814-precip"]');
    await expect(days.locator('.legend-section-title')).toHaveText('8-14 Day Precipitation Outlook');
    await expect(days.locator('[data-cpc-clock]')).toHaveText([
      'Start Date Nov 11, 2026 · End Date Nov 15, 2026 · Forecast Date Nov 5, 2026'
    ]);
    await expect(days.locator('.legend li')).toHaveText(CPC_EXTENDED_LABELS);
    await expect(days.locator('.legend li[data-cpc-class="Normal,36"] .swatch')).toHaveCSS('border-top-color', 'rgb(110, 110, 110)');

    await layerCheckbox(page, 'cpc-610-temp').check();
    await expect(layerPill(page, 'cpc-610-temp')).toHaveText(PILL.live);
    await expect(enso).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('layers') ?? '').toContain('cpc-610-temp');
    await expect.poll(() => cpcKeys(page)).toEqual(['cpc-610-temp', 'cpc-814-precip']);
    const other = page.locator('.legend-section[data-legend="cpc-610-temp"]');
    await expect(other.locator('.legend-section-title')).toHaveText('6-10 Day Temperature Outlook');
    await expect(other.locator('.legend li')).toHaveText(CPC_EXTENDED_LABELS);
    await expect(page.locator('.legend-section[data-legend^="cpc-"] .legend li')).toHaveCount(30);
  });

  test('an ENSO link without horizon= still opens on Current, the sea-surface-temperature anomaly, with no outlook', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&cluster=enso');
    await expect(page.locator('.shell-horizon-btn[data-horizon="current"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(layerCheckbox(page, 'sst-anomaly')).toBeChecked();
    await expect(layerCheckbox(page, 'cpc-seasonal-precip')).not.toBeChecked();
    await expect(page.locator('.legend-section[data-legend^="cpc-seasonal-"]')).toHaveCount(0);
    expect(new URLSearchParams(await search(page)).get('horizon')).toBeNull();
  });
});
