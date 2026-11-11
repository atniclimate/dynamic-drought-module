import { expect, test } from './offline-test';

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

test('the standard map is the only ground, with its OpenStreetMap credit', async ({
  page
}) => {
  await gotoApp(page);
  await expect(page.locator('#map-osm-credit')).toContainText('OpenStreetMap');
  await expect(page.locator('#ground-vintage')).toHaveCount(0);
});
