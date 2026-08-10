import { expect, test, type Page } from '@playwright/test';

import { stubRecentSatellite } from './satellite-fixture';

const EOX_ROUTE = '**/wmts/1.0.0/s2cloudless_3857/**';
const PROBE_SUFFIX = '/default/g/4/5/2.jpg';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function fulfillPng(route: Parameters<Parameters<Page['route']>[1]>[0]): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: PNG
  });
}

test('ground stays on disclosed OSM fallback until probe and viewport tiles succeed', async ({
  page
}) => {
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let probeCount = 0;
  let renderTileCount = 0;

  await page.route(EOX_ROUTE, async (route) => {
    if (route.request().url().endsWith(PROBE_SUFFIX) && probeCount === 0) {
      probeCount += 1;
      await probeGate;
      await fulfillPng(route);
      return;
    }
    renderTileCount += 1;
    await fulfillPng(route);
  });

  await page.goto('/');
  await expect(page.locator('#sidebar')).toBeVisible();
  const chip = page.locator('#ground-vintage');
  await expect(chip).toHaveAttribute('role', 'status');
  await expect(chip).toHaveAttribute('aria-live', 'polite');
  await expect(chip).toHaveAttribute('aria-atomic', 'true');
  await expect(chip).toHaveAttribute('data-status', 'loading');
  await expect(chip).toContainText('OpenStreetMap fallback');
  expect(renderTileCount).toBe(0);

  releaseProbe();
  await expect(chip).toHaveAttribute('data-status', 'live');
  await expect(chip).toContainText('EOxCloudless');
  await expect(chip).toContainText('Sentinel-2 2016');
  await expect(chip).toContainText('Historical context, not current conditions');
  expect(renderTileCount).toBeGreaterThan(0);
  await expect(chip).toHaveCSS('pointer-events', 'none');
  await expect(chip.getByRole('link').first()).toHaveCSS('pointer-events', 'auto');
});

test('a mislabeled probe never starts viewport tiles and discloses fallback', async ({
  page
}) => {
  let requestCount = 0;
  await page.route(EOX_ROUTE, async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: '<html>not an image</html>'
    });
  });

  await page.goto('/');
  const chip = page.locator('#ground-vintage');
  await expect(chip).toHaveAttribute('data-status', 'fallback');
  await expect(chip).toContainText('OpenStreetMap fallback is showing');
  expect(requestCount).toBe(1);
});

test('viewport tile failure retires EOX instead of making a false live claim', async ({
  page
}) => {
  let probeComplete = false;
  await page.route(EOX_ROUTE, async (route) => {
    if (!probeComplete && route.request().url().endsWith(PROBE_SUFFIX)) {
      probeComplete = true;
      await fulfillPng(route);
      return;
    }
    await route.fulfill({ status: 404, body: 'missing' });
  });

  await page.goto('/');
  const chip = page.locator('#ground-vintage');
  await expect(chip).toHaveAttribute('data-status', 'fallback', {
    timeout: 12_000
  });
  await expect(chip).toContainText('OpenStreetMap fallback is showing');
});

test('recent NOAA mode pauses EOX viewport work and default resumes without a second probe', async ({
  page
}) => {
  await stubRecentSatellite(page);
  let probeCount = 0;
  let renderTileCount = 0;
  await page.route(EOX_ROUTE, async (route) => {
    if (route.request().url().endsWith(PROBE_SUFFIX) && probeCount === 0) {
      probeCount += 1;
    } else {
      renderTileCount += 1;
    }
    await fulfillPng(route);
  });

  await page.goto('/?basemap=satellite');
  const chip = page.locator('#ground-vintage');
  await expect(chip).toBeHidden();
  await expect(page.locator('.basemap-switcher-btn')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(renderTileCount).toBe(0);

  await page.locator('.basemap-switcher-btn').click();
  await expect(chip).toHaveAttribute('data-status', 'live');
  expect(probeCount).toBe(1);
  expect(renderTileCount).toBeGreaterThan(0);
  await expect(page).not.toHaveURL(/basemap=satellite/);
});
