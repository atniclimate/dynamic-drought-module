import { expect, test } from '@playwright/test';

import { gotoApp } from './helpers';

const PLACE_ROOT = '#place-studio-root';
const LAYERS_ROOT = '#layers-studio-root';

test.describe('studio focus and geometry', () => {
  test('desktop openers regain focus after both studios unmount', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoApp(page, '?view=brief&layers=places');

    const host = page.locator('#brief-display #layers-studio-entry-host');
    const pair = host.locator('#studio-entry-pair');
    const placeOpener = pair.locator('#place-studio-entry');
    const layersOpener = pair.locator('#layers-studio-entry');
    await expect(pair).toBeVisible();
    await expect(placeOpener).toBeVisible();
    await expect(layersOpener).toBeVisible();
    expect(await pair.locator('button').evaluateAll((buttons) => buttons.map((button) => button.id)))
      .toEqual(['place-studio-entry', 'layers-studio-entry']);

    await placeOpener.focus();
    await expect(placeOpener).toBeFocused();
    await placeOpener.press('Enter');
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await page.locator(`${PLACE_ROOT} #place-studio-back`).click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(placeOpener).toBeFocused();

    await layersOpener.focus();
    await expect(layersOpener).toBeFocused();
    await layersOpener.press('Space');
    await expect(page.locator(LAYERS_ROOT)).toBeVisible();
    await page.locator(`${LAYERS_ROOT} .layers-studio-back`).click();
    await expect(page.locator(LAYERS_ROOT)).toHaveCount(0);
    await expect(layersOpener).toBeFocused();
  });

  for (const studio of ['place', 'layers'] as const) {
    test(`direct-boot ${studio} exit focuses the map container`, async ({ page }) => {
      await gotoApp(page, `?view=brief&layers=places&studio=${studio}`);
      const root = studio === 'place' ? PLACE_ROOT : LAYERS_ROOT;
      await expect(page.locator(root)).toBeVisible();
      await page.locator(`${root} .layers-studio-back`).click();
      await expect(page.locator(root)).toHaveCount(0);
      await expect(page.locator('#map-container')).toBeFocused();
    });
  }

  test('desktop PLACE and LAYERS dock beside the sidebar, which stays live', async ({
    page
  }) => {
    // Screen-filling studios now start at the sidebar's inner edge and
    // fill the rest of the viewport instead of painting over the
    // sidebar, so #map-container (which they cover completely) goes
    // inert while #sidebar stays a live, focusable, screen-reader-visible
    // column (the owner's slide-out-beside-the-side-card direction).
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoApp(page, '?view=brief&layers=places');
    const sidebarWidth = await page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().width);
    expect(sidebarWidth).toBeGreaterThan(0);

    await page.locator('#place-studio-entry').click();
    const placeBox = await page.locator(PLACE_ROOT).boundingBox();
    expect(placeBox?.x).toBe(sidebarWidth);
    expect(placeBox?.width).toBe(1280 - sidebarWidth);
    expect(placeBox?.height).toBe(900);

    // #map-container is what the studio actually covers: inert and
    // hidden from assistive tech.
    await expect(page.locator('#map-container')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#map-container').evaluate((el) => (el as HTMLElement).inert)).toBe(
      true
    );
    // #app itself is no longer blanket-inerted; only what the studio
    // actually covers is.
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    // The sidebar is NOT covered, so it must stay reachable and visible
    // to assistive tech: no aria-hidden, not inert, and a real control
    // inside it can still take focus.
    await expect(page.locator('#sidebar')).not.toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#sidebar').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    await page.locator('#sidebar-collapse').focus();
    await expect(page.locator('#sidebar-collapse')).toBeFocused();

    await page.locator(`${PLACE_ROOT} #place-studio-back`).click();
    await page.locator('#layers-studio-entry').click();
    const layersBox = await page.locator(LAYERS_ROOT).boundingBox();
    expect(layersBox?.x).toBe(sidebarWidth);
    expect(layersBox?.width).toBe(1280 - sidebarWidth);
    expect(layersBox?.height).toBe(900);
    await expect(page.locator('#map-container')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#sidebar')).not.toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#sidebar').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  });

  test('mobile PLACE remains full-screen and restores its sheet opener', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?view=brief&layers=places');
    // Deterministic activation: await the mobile shell's ready stamp, then
    // the half-detent and search-mount signals, before touching the entry.
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', /./);
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-search [data-ddm-search]')).toBeVisible();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);

    const opener = page.locator('#sheet-place-studio-entry');
    await opener.scrollIntoViewIfNeeded();
    await expect(opener).toBeVisible();
    await opener.focus();
    await expect(opener).toBeFocused();
    await opener.press('Enter');
    const placeBox = await page.locator(PLACE_ROOT).boundingBox();
    expect(placeBox?.x).toBe(0);
    expect(placeBox?.width).toBe(390);
    expect(placeBox?.height).toBe(844);

    await page.locator(`${PLACE_ROOT} #place-studio-back`).click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).toBeVisible();

    await page.locator('#mobile-footer-nav button[data-tab="brief"]').click();
    // The desktop studio door pair lives in #brief-display, which the mobile
    // sheet matrix never admits: there is no mobile LAYERS-studio door (the
    // footer Layers tab opens the console sheet instead). Pin that honestly
    // rather than driving a desktop-only control (conductor truing at the
    // F7 gate; the lane's original phase scrolled a control that cannot
    // render at this breakpoint and hung).
    await expect(page.locator('#studio-entry-pair')).toBeHidden();
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator(LAYERS_ROOT)).toHaveCount(0);
  });
});
