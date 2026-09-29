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

  test('desktop PLACE and LAYERS dock beside the sidebar, which stays visible but inert (DR-169)', async ({
    page
  }) => {
    // Screen-filling studios start at the sidebar's inner edge and fill
    // the rest of the viewport instead of painting over the sidebar (the
    // owner's slide-out-beside-the-side-card direction, unchanged by
    // DR-169). What DR-169 changes (ratified 2026-09-29, RATIFICATION-8,
    // "Desktop sidebar inert"): the sidebar column stays on screen but is
    // no longer live while a studio is open; #app itself (sidebar
    // included) goes inert, reversing this test's pre-DR-169 title and
    // its "#app is no longer blanket-inerted" assertion below.
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoApp(page, '?view=brief&layers=places');
    const sidebarWidth = await page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().width);
    expect(sidebarWidth).toBeGreaterThan(0);

    await page.locator('#place-studio-entry').click();
    const placeBox = await page.locator(PLACE_ROOT).boundingBox();
    expect(placeBox?.x).toBe(sidebarWidth);
    expect(placeBox?.width).toBe(1280 - sidebarWidth);
    expect(placeBox?.height).toBe(900);

    // #app itself is inert (DR-169), which reaches every descendant:
    // #map-container (what the studio visually covers) and #sidebar
    // (what it does not) alike.
    await expect(page.locator('#app')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    // The sidebar stays visible on screen (still where it always sits,
    // sidebarWidth unchanged) but is reachable through neither a click
    // nor script focus while the veil is up.
    await expect(page.locator('#sidebar')).toBeVisible();
    await page.locator('#sidebar-collapse').focus();
    await expect(page.locator('#sidebar-collapse')).not.toBeFocused();

    await page.locator(`${PLACE_ROOT} #place-studio-back`).click();
    // Closed: the veil lifts and the sidebar is reachable again.
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    await page.locator('#sidebar-collapse').focus();
    await expect(page.locator('#sidebar-collapse')).toBeFocused();

    await page.locator('#layers-studio-entry').click();
    const layersBox = await page.locator(LAYERS_ROOT).boundingBox();
    expect(layersBox?.x).toBe(sidebarWidth);
    expect(layersBox?.width).toBe(1280 - sidebarWidth);
    expect(layersBox?.height).toBe(900);
    await expect(page.locator('#app')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
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

  test('Escape in either studio removes studio= and returns focus to its entry button', async ({
    page
  }) => {
    // found-004: no Escape handler existed anywhere in the open path, so
    // before the fix this presses Escape and nothing happens (studio=
    // stays, the root stays mounted, focus stays put).
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoApp(page, '?view=brief&layers=places');

    const placeOpener = page.locator('#place-studio-entry');
    await placeOpener.click();
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]studio=/);
    await expect(placeOpener).toBeFocused();

    const layersOpener = page.locator('#layers-studio-entry');
    await layersOpener.click();
    await expect(page.locator(LAYERS_ROOT)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(LAYERS_ROOT)).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]studio=/);
    await expect(layersOpener).toBeFocused();
  });

  test('Escape during a held Place studio chunk closes it and never lets a late chunk reopen it', async ({
    page
  }) => {
    // found-012 / found-004 together, the M15 repair round's diagnosis: the
    // studio root and its pending-entry feedback are created synchronously
    // on the press, but Escape used to be handled only inside the lazily
    // loaded chunk's own Preact effect. Before the fix: pressing Escape
    // while the chunk is held does nothing (the root stays mounted, the
    // opener's aria-busy state never clears), because no listener exists
    // yet to catch it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chunkPattern = /\/place-studio-[^/?]*\.js(\?|$)/;
    await page.route(chunkPattern, async (route) => {
      await gate;
      await route.continue();
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoApp(page, '?view=brief&layers=places');

    const opener = page.locator('#place-studio-entry');
    await opener.click();
    await expect(opener).toHaveAttribute('aria-busy', 'true', { timeout: 500 });
    await expect(opener).toHaveClass(/studio-entry-pending/);
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    // The chunk is still held: no #place-studio-back has ever mounted.
    await expect(page.locator(`${PLACE_ROOT} #place-studio-back`)).toHaveCount(0);

    await page.keyboard.press('Escape');

    await expect(page).not.toHaveURL(/[?&]studio=/);
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).not.toHaveAttribute('aria-busy', 'true');
    await expect(opener).not.toHaveClass(/studio-entry-pending/);

    // Release the held chunk and let it finish resolving; the late arrival
    // must never reopen anything the Escape already closed.
    const chunkResponse = page.waitForResponse(chunkPattern);
    release();
    await chunkResponse;
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]studio=/);
  });

  test('Shift+Tab from Back never leaves an open studio', async ({ page }) => {
    // found-004: nothing before this fix stopped Tab from walking out of
    // the studio root into the live app behind it, or into the map
    // chrome's #share-btn (rehosted into the shell), the exact
    // reachability the register recorded. The trap (src/ui/island/
    // studio-inert.ts, trapStudioTabFocus) still matters after DR-169
    // made #app inert too: inert removes #sidebar and #share-btn from
    // the tab order themselves, but this proves the studio's OWN focus
    // ring never depends on that veil to hold.
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('#layers-studio-entry').click();
    const root = page.locator(LAYERS_ROOT);
    await expect(root).toBeVisible();
    const back = root.locator('.layers-studio-back', { hasText: 'Back to map' });
    await expect(back).toBeFocused();

    await page.keyboard.press('Shift+Tab');

    const focusedInRoot = await root.evaluate((el) => el.contains(document.activeElement));
    expect(focusedInRoot).toBe(true);
    await expect(page.locator('#share-btn')).not.toBeFocused();
  });
});
