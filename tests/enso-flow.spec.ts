import { expect, test, type Page, type Route } from '@playwright/test';
import { gotoApp, search } from './helpers';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FLOW_ROUTE = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\/v1\//;

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
}

function payload(url: URL, missing = false): unknown[] {
  const latitudes = url.searchParams.get('latitude')!.split(',').map(Number);
  const longitudes = url.searchParams.get('longitude')!.split(',').map(Number);
  const [valueKey, directionKey] = url.searchParams.get('current')!.split(',') as [string, string];
  const time = Math.floor(Date.now() / 900_000) * 900;
  return latitudes.map((latitude, i) => ({ latitude, longitude: longitudes[i],
    current_units: { time: 'unixtime', [valueKey]: valueKey === 'wave_height' ? 'm' : 'm/s', [directionKey]: '°' },
    current: { time, interval: 900, [valueKey]: missing ? null : 2, [directionKey]: missing ? null : 90 }
  }));
}

async function respond(route: Route, missing = false): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload(new URL(route.request().url()), missing)) });
}

test('all three ENSO overlays remain bounded, independently timed, and preserve color through reload', async ({ page }) => {
  await stubSst(page);
  const calls: URL[] = [];
  await page.route(FLOW_ROUTE, async (route) => { calls.push(new URL(route.request().url())); await respond(route); });
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default');
  const panel = page.locator('.enso-flow');
  await expect(panel).toBeVisible();
  expect(calls).toHaveLength(0);
  for (const kind of ['currents', 'wind', 'waves']) {
    await panel.locator(`[data-flow-kind="${kind}"]`).click();
    await expect(panel).toHaveAttribute('data-status', 'live');
    await expect(panel.locator('.enso-flow-status')).toContainText('Model valid');
    expect(new URLSearchParams(await search(page)).get('flow')).toBe(kind);
  }
  expect(calls).toHaveLength(3);
  expect(calls.map((url) => url.searchParams.get('models'))).toEqual(['meteofrance_currents', 'gfs_global', 'ncep_gfswave025']);
  for (const url of calls) expect(url.searchParams.get('latitude')!.split(',').length).toBeLessThanOrEqual(40);
  await panel.getByLabel('Direction arrow color').selectOption('dark');
  expect(new URLSearchParams(await search(page)).get('flowink')).toBe('dark');
  await page.reload();
  await expect(panel.locator('[data-flow-kind="waves"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByLabel('Direction arrow color')).toHaveValue('dark');
  await expect(panel).toHaveAttribute('data-status', 'live');
  await page.locator('.view-switch [data-view="console"]').click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Direction arrow color')).toHaveValue('dark');
  await panel.locator('summary').click();
  await expect(panel).toContainText('independently timed from the observed SST map');
  await panel.locator('[data-flow-kind="off"]').click();
  await expect(panel).toHaveAttribute('data-status', 'off');
  expect(new URLSearchParams(await search(page)).has('flow')).toBe(false);
});

test('turning an ENSO overlay off aborts its held request and drops the late response', async ({ page }) => {
  await stubSst(page);
  let held: Route | null = null;
  await page.route(FLOW_ROUTE, (route) => { held = route; });
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default');
  const panel = page.locator('.enso-flow');
  await panel.locator('[data-flow-kind="wind"]').click();
  await expect.poll(() => held !== null).toBe(true);
  const failed = page.waitForEvent('requestfailed', (req) => FLOW_ROUTE.test(req.url()));
  await panel.locator('[data-flow-kind="off"]').click();
  await failed;
  await expect(panel).toHaveAttribute('data-status', 'off');
  await respond(held!).catch(() => undefined);
  await expect(panel.locator('.enso-flow-status')).toHaveText('Direction overlay off');
  expect(new URLSearchParams(await search(page)).has('flow')).toBe(false);
});

test('marine no-data and network failure remain separate from a successful direction field', async ({ page }) => {
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route, true));
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=currents');
  const panel = page.locator('.enso-flow');
  await expect(panel).toHaveAttribute('data-status', 'no data');
  await panel.locator('summary').click();
  await expect(panel).toContainText('0 of 40 sampled cells have data');
  await page.route(FLOW_ROUTE, (route) => route.abort('failed'));
  await panel.locator('[data-flow-kind="waves"]').click();
  await expect(panel).toHaveAttribute('data-status', 'unavailable');
  await expect(panel).toContainText('No direction or calm condition is inferred');
});

test('the same ENSO controls move into the mobile Layers glass panel and return to desktop', async ({ page }) => {
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route));
  await page.setViewportSize({ width: 721, height: 844 });
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=wind&flowink=dark');
  await expect(page.locator('.sidebar-scroll > #enso-flow-controls .enso-flow')).toBeVisible();
  await page.setViewportSize({ width: 720, height: 844 });
  await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
  const mobilePanel = page.locator('#sheet-enso-flow-host .enso-flow');
  await expect(mobilePanel).toBeVisible();
  await expect(mobilePanel.getByLabel('Direction arrow color')).toHaveValue('dark');
  await expect(page.locator('#enso-flow-controls')).toHaveCount(1);
  await page.setViewportSize({ width: 721, height: 844 });
  await expect(page.locator('.sidebar-scroll > #enso-flow-controls .enso-flow')).toBeVisible();
  await expect(page.locator('#sheet-enso-flow-host')).toBeEmpty();
  await expect(page.locator('.enso-flow [data-flow-kind="wind"]')).toHaveAttribute('aria-pressed', 'true');
});
