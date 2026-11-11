import { expect, test, type Page, type Route } from './offline-test';

import {
  gotoApp,
  layerCheckbox,
  search,
  waitForLayerSettled
} from './helpers';

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

test.describe('explicit Wildfire and Fire selections', () => {
  test.beforeEach(async ({ page }) => {
    await stubWildfireLayers(page);
  });

  test('desktop Wildfire selection opens with independently timed smoke', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator(WILDFIRE).click();

    await expect.poll(async () => search(page)).toContain('cluster=wildfire');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(page.locator(WILDFIRE)).toHaveAttribute(
      'title',
      /independently timed NOAA Hazard Mapping System \(HMS\) smoke plumes/
    );
  });

  test('a bare Wildfire deep link selects Wildfire', async ({
    page
  }) => {
    await gotoApp(page, '?cluster=wildfire');

    await expect(page.locator(WILDFIRE)).toHaveAttribute('aria-pressed', 'true');
  });

  test('a horizon change keeps the Wildfire selection', async ({
    page
  }) => {
    await gotoApp(page);
    await page.locator(WILDFIRE).click();

    await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
    await waitForLayerSettled(page, 'spc-fire-weather');

    await expect(page.locator(WILDFIRE)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).toContain('cluster=wildfire');
  });

  test('mobile Fire explicitly selects the same layers', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await page.locator('#hazard-rail button[data-preset="hazard-fire"]').click();

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });
});
