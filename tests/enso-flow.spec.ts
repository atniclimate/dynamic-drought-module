import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { gotoApp, layerCheckbox, search } from './helpers';

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

/*
 * found-115 (DR-188, P3-ENSOKEY): the arrows draw wherever `flow=` and the
 * SST layer are on, but their panel lives in the sidebar, which a desktop
 * embed and a closed sidebar hide, and which a phone shows only in the
 * Layers sheet. The Key drawer carries their own status, model valid time
 * and qualifications as one more row of the SST key. Every case below
 * first reads `[data-enso-flow="status"]`, so on code without the row it
 * fails on that missing node, never on a stub or a selector of its own.
 */
const FLOW_ROW = '#map-key [data-enso-flow]';

function flowStatus(page: Page): Locator {
  return page.locator('#map-key [data-enso-flow="status"]');
}

function flowNotes(page: Page): Locator {
  return page.locator('#map-key [data-enso-flow="notes"]');
}

/** The key's own toggle is the chip for the SST key on every surface. */
async function openKeyDrawer(page: Page): Promise<void> {
  const toggle = page.locator('#map-key-details-toggle');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.locator('#map-key-content')).toBeVisible();
  await expect(page.locator('#map-key [data-sst-anomaly-key]')).toBeVisible();
}

/** The served instant in the page's own Intl, the panel's own format. */
async function modelValid(page: Page, seconds: number): Promise<string> {
  return page.evaluate((ms) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(ms), seconds * 1000);
}

const DRAWER_SURFACES = [
  { name: 'a desktop embed', width: 1280, height: 800, query: '&embed=true' },
  { name: 'the desktop shell with the sidebar closed', width: 1280, height: 800, query: '&sidebar=closed' },
  { name: 'a 390x844 phone with the Layers sheet not showing', width: 390, height: 844, query: '' }
] as const;

for (const surface of DRAWER_SURFACES) {
  test(`found-115 ${surface.name}: the Key drawer reads the arrows' own status and model valid time, apart from the SST date`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await stubSst(page);
    let served: number | null = null;
    await page.route(FLOW_ROUTE, async (route) => {
      const body = payload(new URL(route.request().url()));
      served = (body[0] as { current: { time: number } }).current.time;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await gotoApp(page, `?cluster=enso&ocean=pacific&flow=wind${surface.query}`);
    // The defect's premise: the arrows load while their own panel is off screen.
    const panel = page.locator('.enso-flow');
    await expect(panel).toHaveAttribute('data-status', 'live');
    await expect(panel).toBeHidden();
    await openKeyDrawer(page);
    const valid = await modelValid(page, served!);
    await expect(flowStatus(page)).toBeVisible();
    await expect(flowStatus(page)).toHaveText(`Atmospheric currents · live · Model valid ${valid}`);
    await expect(flowNotes(page)).toBeVisible();
    await expect(flowNotes(page)).toContainText(/^\d+ of \d+ sampled cells have data\. /);
    await expect(flowNotes(page)).toContainText('Arrows show travel direction only, with equal lengths; still water or calm wind has no arrow.');
    await expect(flowNotes(page)).toContainText('Missing cells have no arrow and do not imply calm conditions.');
    await expect(flowNotes(page)).toContainText('This is model context, independently timed from the observed SST map.');
    // The resample control is hidden on exactly these surfaces.
    await expect(flowNotes(page)).not.toContainText('Update area');
    // Two products, two clocks: the SST date keeps its own node and words.
    const observed = page.locator('#map-key [data-sst-observed]');
    await expect(observed).toContainText('Observed');
    await expect(observed).not.toContainText('Model valid');
    await expect(flowStatus(page)).not.toContainText('Observed');
    await expect(flowNotes(page)).not.toContainText('Observed');
  });
}

test('found-115 a Key that starts after the arrows have loaded still reads their state (a boot with flow= in the URL)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route));
  // The key is a lazy chunk; hold it until the arrows are live, so no
  // status change of theirs can reach it as it happens.
  let release!: () => void;
  const arrowsLive = new Promise<void>((resolve) => { release = resolve; });
  let keyRequested = false;
  await page.route(/\/assets\/map-key-[^/?]+\.js(?:\?|$)/, async (route) => {
    keyRequested = true;
    await arrowsLive;
    await route.continue();
  });
  await gotoApp(page, '?cluster=enso&ocean=pacific&flow=waves&embed=true');
  await expect(page.locator('.enso-flow')).toHaveAttribute('data-status', 'live');
  await expect.poll(() => keyRequested).toBe(true);
  await expect(page.locator('#map-key-details-toggle')).toHaveCount(0);
  release();
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toContainText('Ocean waves · live · Model valid ');
  await expect(flowNotes(page)).toContainText('Missing cells have no arrow and do not imply calm conditions.');
});

test("found-115 the Key drawer reads the arrows' loading, failed and no-data words while the panel is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubSst(page);
  let held: Route | null = null;
  await page.route(FLOW_ROUTE, (route) => { held = route; });
  await gotoApp(page, '?cluster=enso&ocean=pacific&flow=wind&embed=true');
  await expect.poll(() => held !== null).toBe(true);
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toHaveText('Atmospheric currents · loading · Model direction samples');
  await expect(flowNotes(page)).toHaveText('Loading up to 40 source grid cells for this area.');
  await held!.abort('failed');
  await expect(flowStatus(page)).toHaveText('Atmospheric currents · unavailable · Direction samples did not load');
  await expect(flowNotes(page)).toHaveText('No direction or calm condition is inferred from a failed request.');
  // The newest handler runs first, so this one answers every later read.
  await page.route(FLOW_ROUTE, (route) => respond(route, true));
  await page.reload();
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toContainText('Atmospheric currents · no data · Model valid ');
  await expect(flowNotes(page)).toContainText(/^0 of \d+ sampled cells have data\. /);
  await expect(flowNotes(page)).toContainText('Missing cells have no arrow and do not imply calm conditions.');
});

test("found-115 the arrows' Key drawer row follows the open panel: none while off, the panel's words while on, kept through a pan, gone with the SST layer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route));
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=console&basemap=default');
  const panel = page.locator('.enso-flow');
  const panelStatus = panel.locator('.enso-flow-status');
  await expect(panel).toBeVisible();
  await openKeyDrawer(page);
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
  await panel.locator('[data-flow-kind="waves"]').click();
  await expect(panel).toHaveAttribute('data-status', 'live');
  const line = (await panelStatus.textContent())!;
  await expect(flowStatus(page)).toHaveText(`Ocean waves · ${line}`);
  const panelText = (await panel.textContent())!;
  const notes = (await flowNotes(page).textContent())!;
  for (const sentence of notes.split(/(?<=\.)\s+/)) expect(panelText, 'the key re-types no sentence').toContain(sentence);
  const box = (await page.locator('#map').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 30, { steps: 5 });
  await page.mouse.up();
  await expect(panelStatus).toContainText('Update area to resample');
  await expect(flowStatus(page)).toHaveText(`Ocean waves · ${line}`);
  await panel.locator('[data-flow-kind="off"]').click();
  await expect(panel).toHaveAttribute('data-status', 'off');
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
  await panel.locator('[data-flow-kind="wind"]').click();
  await expect(flowStatus(page)).toContainText('Atmospheric currents · live · Model valid ');
  await layerCheckbox(page, 'sst-anomaly').uncheck();
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
});
