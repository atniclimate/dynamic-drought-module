// Live fuel moisture in the browser: the layer is offered and loaded only in
// Wildfire (the owner's ruling DR-276), it draws from the publisher's maps by
// byte range, and the Impact Briefing reads a place from them (DR-275, method
// M-115). Every request is answered by the stand-in in tests/lfmc-fixtures.ts;
// nothing reaches the publisher.

import { expect, test, type Page } from './offline-test';

import { gotoApp, showFullDetail, urlLayers, waitForLayerSettled } from './helpers';
import { lfmcStub } from './lfmc-fixtures';

const KEY = 'live-fuel-moisture';
const STUDIO = '#layers-studio-root';
const row = (page: Page) => page.locator(STUDIO).locator(`input[data-layer-key="${KEY}"]`);

// The stand-in's two maps moved over central Washington: 120.5 W to 119.86 W, 47.12 N to 47.6 N.
const OVER_WASHINGTON = { arm: 'inland', west: -120.5, north: 47.6 } as const;

test('an address that names the layer under another mode is read without it and asks the publisher nothing', async ({ page }) => {
  await gotoApp(page, `?layers=${KEY}`);
  await expect.poll(async () => (await urlLayers(page)).has(KEY)).toBe(false);
  expect(lfmcStub(page).log).toEqual([]);
});

test('the Layers studio offers the row in Wildfire and not in Drought; turning it on reads the maps and keeps Wildfire pressed', async ({ page }) => {
  await gotoApp(page, '?view=brief');
  await page.locator('#layers-studio-entry').click();
  await expect(page.locator(STUDIO)).toBeVisible();
  // Drought: the studio lists every other condition layer, and not this one.
  await expect(page.locator(STUDIO).locator('input[data-layer-key="usfs-whp"]')).toHaveCount(1);
  await expect(row(page)).toHaveCount(0);

  lfmcStub(page).arm = OVER_WASHINGTON;
  await gotoApp(page, '?cluster=wildfire&region=washington_state&view=brief');
  await page.locator('#layers-studio-entry').click();
  await expect(page.locator(STUDIO)).toBeVisible();
  await row(page).check();
  await expect.poll(async () => (await urlLayers(page)).has(KEY)).toBe(true);
  await waitForLayerSettled(page, KEY);
  // The list, then the raster by byte range: never a whole-file read.
  const log = lfmcStub(page).log;
  expect(log.some((entry) => entry.path === 'manifest.json')).toBe(true);
  const rasterReads = log.filter((entry) => entry.path.endsWith('.tif'));
  expect(rasterReads.length).toBeGreaterThan(0);
  expect(rasterReads.every((entry) => /^bytes=\d+-\d+$/.test(entry.range ?? ''))).toBe(true);
  // Wildfire plus its optional layer is still Wildfire.
  expect(new URL(page.url()).searchParams.get('cluster')).toBe('wildfire');
});

test('the briefing states live fuel moisture for a place the maps reach, as modelled analysis with its dates', async ({ page }) => {
  await gotoApp(page, '?view=brief');
  lfmcStub(page).arm = OVER_WASHINGTON;
  await gotoApp(page, '?cluster=wildfire&select=state:WA&region=washington_state');
  const panel = page.locator('#impact-panel');
  await expect(panel.locator('#impact-panel-title')).toHaveText('Washington', { timeout: 15_000 });
  await showFullDetail(page);
  const claim = panel.locator('.impact-claim-modeled-analysis', { hasText: 'Live fuel moisture across Washington' });
  await expect(claim).toHaveCount(1, { timeout: 20_000 });
  await expect(claim).toContainText(/about \d+ percent of dry weight/);
  await expect(claim).toContainText('in the satellite-based estimate for Oct 24 to 31, 2026.');
  await expect(claim).toContainText('Lower values mean drier living plants.');
  await expect(claim).toContainText('Modeled analysis');
  await expect(claim).toContainText('EOSIAL Laboratory, Sapienza University of Rome');
});

test('with the default stand-in the maps reach no selected place, so a briefing reads as it did before the lane existed', async ({ page }) => {
  await gotoApp(page, '?select=state:WA&region=washington_state');
  const panel = page.locator('#impact-panel');
  await expect(panel.locator('#impact-panel-title')).toHaveText('Washington', { timeout: 15_000 });
  await showFullDetail(page);
  // The lane ran (the list was read) and stated nothing.
  await expect.poll(() => lfmcStub(page).log.some((entry) => entry.path === 'manifest.json'), { timeout: 20_000 }).toBe(true);
  await expect(panel.getByText(/live fuel moisture/i)).toHaveCount(0);
});
