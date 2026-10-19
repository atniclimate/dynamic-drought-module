/**
 * ENSO block B3, the active tropical cyclones layer, in the browser: the
 * empty-season key wording (the owner's words, enso-mode-expansion.yaml F2)
 * and one occupied slot drawn with its popup. The NOAA service is answered by
 * tests/tropical-fixtures.ts through gotoApp's `tropical` arm; no request
 * reaches NOAA. The six-state matrix, the slot sweep and cancellation are
 * proved browser-free in tests/tropical-read.test.mjs.
 */
import { test, expect } from './offline-test';

import { EP5_LAYERS, tropicalStubLog } from './tropical-fixtures';
import { bootStorm, clickStorm } from './frame-fixtures-tropical';
import { gotoApp, waitForLayerSettled } from './helpers';

test('an empty season: the ENSO key reads "No active tropical cyclones" and carries no basins note', async ({ page }) => {
  await gotoApp(page, '?cluster=enso&view=console');
  await waitForLayerSettled(page, 'tropical-cyclones');
  const row = page.locator('#map-key [data-tropical-key]');
  await expect(row).toHaveAttribute('data-tropical-state', 'no data');
  await expect(row.locator('[data-tropical-empty]')).toHaveText('No active tropical cyclones');
  // The basins sentence reads in the Impact Briefing's Technical information (tests/terrain-coverage.test.mjs).
  await expect(row).not.toContainText('Basins covered');
  await expect(row.locator('[data-tropical-issuer]')).toHaveText(
    'NOAA National Hurricane Center and Central Pacific Hurricane Center'
  );
  // The presence sweep: one Forecast Points read per slot, and nothing more in an empty season.
  const log = tropicalStubLog(page);
  expect(log.map((entry) => entry.layerId)).toEqual(Array.from({ length: 15 }, (_, n) => 4 + 26 * n + 2));
});

test('one occupied slot draws, its key names the advisory, and its popup opens', async ({ page }) => {
  await bootStorm(page);
  const row = page.locator('#map-key [data-tropical-key]');
  await expect(row).toHaveAttribute('data-tropical-state', 'live');
  await expect(row.locator('[data-tropical-storm="EP5"]')).toHaveText(
    'Hurricane Simon, Eastern North Pacific, advisory 24, issued 200 AM MST Tue Oct 13 2026'
  );
  expect(tropicalStubLog(page).map((entry) => entry.layerId)).toEqual(
    expect.arrayContaining([EP5_LAYERS.points, EP5_LAYERS.track, EP5_LAYERS.cone, EP5_LAYERS.ww])
  );
  await clickStorm(page);
  const popup = page.locator('.maplibregl-popup [data-popup-frame]');
  await expect(popup.locator('[data-popup-slot="title"]')).toHaveText(/Simon/);
  await expect(popup.locator('[data-popup-slot="issuer"]')).toContainText('NOAA National Hurricane Center');
  await expect(popup.locator('[data-popup-slot="value"]')).toContainText('24');
  await expect(popup).toContainText('200 AM MST Tue Oct 13 2026');
});

test("a storm's key line is a button: Enter opens that storm's popup and Escape returns focus to it", async ({ page }) => {
  await bootStorm(page);
  const toggle = page.locator('#map-key-details-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  const door = page.locator('#map-key [data-feature-door="storm:EP5"]');
  await expect(door).toBeVisible();
  await door.focus();
  await page.keyboard.press('Enter');
  const popup = page.locator('.maplibregl-popup [data-popup-frame]');
  await expect(popup.locator('[data-popup-slot="title"]')).toHaveText(/Simon/);
  // A key re-render (a storm refresh, an SST or flow snapshot) replaces the button while the popup holds focus.
  await page.evaluate(() => {
    const old = document.querySelector('#map-key [data-feature-door="storm:EP5"]')!;
    old.replaceWith(old.cloneNode(true));
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect(door).toBeFocused();
});

test("a storm refresh re-renders the key and the focused storm button keeps focus", async ({ page }) => {
  await bootStorm(page);
  const toggle = page.locator('#map-key-details-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  const door = page.locator('#map-key [data-feature-door="storm:EP5"]');
  await expect(door).toBeVisible();
  await door.focus();
  // The 30-minute refresh brings the next advisory: replay the layer's snapshot with advisory 25.
  await page.evaluate(() => {
    type Snapshot = { status: string; storms: { advisory: string }[] };
    let current: Snapshot | null = null;
    window.addEventListener('ddm:tropical-snapshot', (event) => {
      current = (event as CustomEvent<Snapshot>).detail;
    }, { once: true });
    window.dispatchEvent(new Event('ddm:tropical-snapshot-request'));
    const replayed = current as Snapshot | null;
    if (!replayed || replayed.storms.length === 0) throw new Error('the layer replayed no storm snapshot');
    const storms = replayed.storms.map((storm) => ({ ...storm, advisory: '25' }));
    window.dispatchEvent(new CustomEvent('ddm:tropical-snapshot', { detail: { ...replayed, storms } }));
  });
  await expect(door).toContainText('advisory 25');
  await expect(door).toBeFocused();
});
