import { expect, test } from '@playwright/test';

import { gotoApp } from './helpers';

test('the retired historical-ground disclosure and tile source stay absent', async ({
  page
}) => {
  let historicalRequests = 0;
  await page.route('**/wmts/1.0.0/s2cloudless_3857/**', (route) => {
    historicalRequests += 1;
    return route.abort();
  });

  await gotoApp(page);
  await expect(page.locator('#ground-vintage')).toHaveCount(0);
  await expect(page.locator('.historical-ground-chip')).toHaveCount(0);
  expect(historicalRequests).toBe(0);
});

test('SAT is on by default and toggles to the standard map without provenance copy', async ({
  page
}) => {
  await gotoApp(page);
  const button = page.locator('.basemap-switcher-btn');
  await expect(button).toHaveText('SAT');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page).not.toHaveURL(/basemap=/);

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/basemap=default/);
  await expect(page.locator('#ground-vintage')).toHaveCount(0);
});
