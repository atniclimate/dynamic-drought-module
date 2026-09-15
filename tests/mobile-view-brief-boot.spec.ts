import { test, expect } from '@playwright/test';
import { gotoApp, search } from './helpers';

/**
 * Owner direction: side panels start closed, including shared and reloaded
 * Brief URLs. The URL preserves view mode; panel visibility is ephemeral.
 */

test.describe('DEF-2 explicit view=brief on a mobile cold load (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a shared ?view=brief URL starts closed and the Place door toggles its panel', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief');

    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#sheet-grabber')).toBeHidden();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeVisible();
    const placeDoor = page.locator('#mobile-footer-nav button[data-tab="place"]');
    await placeDoor.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(placeDoor).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sheet-at-hand-title')).toBeVisible();
    await expect(page.locator('.sheet-at-hand-title')).toHaveText('Pick a place');
    await expect(page.locator('#sheet-report .impact-panel')).toHaveCount(0);
    await placeDoor.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(placeDoor).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sidebar')).toBeHidden();

    // Round-trip: the URL still claims the Brief door after the first
    // canonical write, and the ephemeral detent never enters it.
    const params = new URLSearchParams(await search(page));
    expect(params.get('view')).toBe('brief');
    expect(await search(page)).not.toMatch(/detent|sheet|tab/i);
  });

  test('a RELOAD of the app-stamped URL closes an open side panel', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief');
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#preset-chips .preset-chip')).not.toHaveCount(0);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');
  });

  test('GUARD: a bare boot stays map-first closed; the derived Brief mode earns no raise (D-0.7.0-041)', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    // Derived Brief (bare URL) is NOT an explicit ask: closed, edgeless.
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#sheet-grabber')).toBeHidden();
  });

  test('GUARD: an explicit view=console boot stays map-first closed', async ({ page }) => {
    await gotoApp(page, '?view=console');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-console\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
  });

  test('GUARD: view=brief inside an embed stays sheetless (the embed contract)', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&embed=true');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(page.locator('#sheet-grabber')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
  });

  test('GUARD: exiting embed returns to the map-first mobile shell', async ({
    page
  }) => {
    // Embed remains free of the mobile rail. Its explicit exit restores
    // the rail and map-first closed state; a panel opens only after the
    // user chooses one of the side controls.
    await gotoApp(page, '?view=brief&embed=true');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bembed\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#mobile-footer-nav')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeHidden();
  });
});

test.describe('DEF-2 one-shot consumption across a desktop-to-mobile crossing', () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test('desktop sidebar starts closed and can open, close, and reopen', async ({ page }) => {
    await gotoApp(page, '?view=brief');
    const sidebar = page.locator('#sidebar');
    const expand = page.locator('#sidebar-expand');
    await expect(sidebar).toBeHidden();
    await expand.click();
    await expect(sidebar).toBeVisible();
    await expect(page.locator('#place-studio-entry')).toBeVisible();
    await page.locator('#sidebar-collapse').click();
    await expect(sidebar).toBeHidden();
    await expect(expand).toBeFocused();
    await expand.click();
    await expect(sidebar).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(sidebar).toBeHidden();
  });

  test('a desktop ?view=brief boot spends the flag: a later crossing to mobile stays map-first closed', async ({
    page
  }) => {
    // The core one-shot mechanism (DG-080-REVIEW finding 4): the boot
    // evaluation clears the explicit-view flag even when the boot
    // viewport activated no sheet (a desktop boot does not), so the
    // shell activation on a later viewport crossing must NOT treat the
    // stale ask as current intent. The crossing boots the sheet at the
    // ratified map-first closed detent (D-0.7.0-041).
    await gotoApp(page, '?view=brief');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#sheet-grabber')).toBeHidden();
  });
});
