import { expect, test, type Page, type Route } from '@playwright/test';

import {
  gotoApp,
  layerCheckbox,
  search,
  waitForLayerSettled
} from './helpers';
import {
  failRecentSatelliteTiles,
  stubRecentSatellite
} from './satellite-fixture';

const SWITCHER = '.basemap-switcher-btn';
const CHIP = '#basemap-vintage';
const WILDFIRE = '.shell-cluster-btn[data-cluster="wildfire"]';

const EMPTY_FEATURE_COLLECTION = {
  type: 'FeatureCollection',
  features: []
} as const;

async function stubWildfireLayers(page: Page): Promise<void> {
  const fulfill = (route: Route): Promise<void> =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(EMPTY_FEATURE_COLLECTION)
    });

  for (const pattern of [
    'USDM_current',
    'WFIGS_Interagency_Perimeters_Current',
    'NOAA_Satellite_Smoke_Detection',
    'SPC_firewx/MapServer/1/query'
  ]) {
    await page.route(
      (url) => url.href.includes(pattern),
      (route) => fulfill(route)
    );
  }
}

test.describe('explicit Wildfire and Fire recent scenes', () => {
  test.beforeEach(async ({ page }) => {
    await stubWildfireLayers(page);
    await stubRecentSatellite(page);
  });

  test('desktop Wildfire selection adds recent GeoColor and independently timed smoke', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator(WILDFIRE).click();

    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect.poll(async () => search(page)).toContain('cluster=wildfire');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();

    const chip = page.locator(CHIP);
    await expect(chip).not.toBeInViewport();
    await expect(chip).toHaveAttribute('role', 'status');
    await expect(chip).toHaveAttribute('aria-live', 'polite');
    await expect(chip).toHaveAttribute('aria-atomic', 'true');
    await expect(chip).toContainText('NOAA GOES GeoColor');
    await expect(page.locator(WILDFIRE)).toHaveAttribute(
      'title',
      /independently timed NOAA Hazard Mapping System \(HMS\) smoke plumes/
    );
  });

  test('a bare Wildfire deep link retains the satellite default', async ({
    page
  }) => {
    await gotoApp(page, '?cluster=wildfire');

    await expect(page.locator(WILDFIRE)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');
    await expect(page.locator(CHIP)).not.toBeInViewport();
  });

  test('manual Recent off survives Wildfire horizon and layer-status changes', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator(WILDFIRE).click();
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(CHIP)).not.toBeInViewport();

    await page.locator(SWITCHER).click();
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => search(page)).toContain('basemap=default');

    await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
    await waitForLayerSettled(page, 'spc-fire-weather');

    await expect(page.locator(WILDFIRE)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).toContain('basemap=default');
    await expect(page.locator(CHIP)).toBeHidden();
  });

  test('imagery failure restores default without dropping Wildfire intent', async ({
    page
  }) => {
    await failRecentSatelliteTiles(page);
    await gotoApp(page);
    await page.locator(WILDFIRE).click();

    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false', {
      timeout: 30_000
    });
    await expect.poll(async () => search(page)).toContain('basemap=default');
    await expect(page.locator(WILDFIRE)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).toContain('cluster=wildfire');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(page.locator(CHIP)).toBeHidden();
  });

  test('mobile Fire explicitly selects the same recent scene', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await page.locator('#hazard-rail button[data-preset="hazard-fire"]').click();

    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });

  test('Fire risk quick view explicitly selects the same recent scene', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    await page
      .locator('#preset-chips .preset-chip', { hasText: 'Fire risk' })
      .click();

    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });
});
