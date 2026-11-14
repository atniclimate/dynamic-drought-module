import { test, expect, type Page } from './offline-test';
import { gotoApp } from './helpers';

/**
 * WCAG 2.4.3 on the phone: a door press that opens the window moves focus
 * into the view it shows, and closing returns focus to the door. Without
 * this a keyboard or switch user tabs past unrelated map controls to reach
 * the content (src/ui/mobile-sheet.ts, `focusShownView`). Every window is
 * full screen with "Back to map" (owner, 2026-11-13), and what it covers,
 * the doors included, is inert while it is open.
 */

const insideSheet = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.getElementById('sidebar')?.contains(document.activeElement) ?? false);

const onDoor = (page: Page, tab: string): Promise<boolean> =>
  page.evaluate(
    (name) => document.activeElement === document.querySelector(`#mobile-footer-nav button[data-tab="${name}"]`),
    tab
  );

test.describe('sheet doors move focus into the view they open', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('an opening press focuses the view, Escape returns to the door', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const place = page.locator('#mobile-footer-nav button[data-tab="place"]');

    await place.tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect.poll(() => insideSheet(page)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => onDoor(page, 'place')).toBe(true);
  });

  test('a door opened after Back to map moves focus into its own view', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const layers = page.locator('#mobile-footer-nav button[data-tab="layers"]');
    const alerts = page.locator('#mobile-footer-nav button[data-tab="alerts"]');

    await layers.tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect.poll(() => insideSheet(page)).toBe(true);

    // The window covers the doors; the way to another door is back through the map.
    await page.locator('#sheet-close').tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await alerts.tap();
    await expect(app).toHaveAttribute('data-sheet-tab', 'alerts');
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect.poll(() => insideSheet(page)).toBe(true);
    await expect(page.locator('#sheet-title')).toHaveText(/alerts/i);

    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => onDoor(page, 'alerts')).toBe(true);
  });

  test('focus moved before the window settles stays where it was moved', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    // mobile-sheet.ts stamps each settle, so the case waits for the real one instead of sleeping.
    const settles = (): Promise<number> =>
      page.evaluate(() => Number(document.documentElement.dataset['ddmSheetSettles'] ?? 0));
    const before = await settles();

    // Press Place, then move focus to the window's Back in the same task: before any settle can run.
    // (The other doors are inert under the open window, so Back is where a reader can move it.)
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#mobile-footer-nav button[data-tab="place"]')?.click();
      document.getElementById('sheet-close')?.focus();
    });
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect.poll(settles).toBeGreaterThan(before);
    await expect(page.locator('#sheet-close')).toBeFocused();
  });

  test('the ENSO Guide door focuses the opened guide, Escape returns to the door', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const settles = (): Promise<number> =>
      page.evaluate(() => Number(document.documentElement.dataset['ddmSheetSettles'] ?? 0));

    await page.locator('.hazard-rail-btn[data-preset="hazard-enso"]').tap();
    const door = page.locator('#enso-guide-door');
    await expect(door).toBeVisible();

    const before = await settles();
    await door.tap();
    await expect(door).toHaveAttribute('aria-expanded', 'true');
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect.poll(settles).toBeGreaterThan(before);
    await expect.poll(() => insideSheet(page)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(door).toHaveAttribute('aria-expanded', 'false');
    await expect(door).toBeFocused();
  });

  test('Back to map closes the window and focus returns to the lit door', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const place = page.locator('#mobile-footer-nav button[data-tab="place"]');

    await place.tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect.poll(() => insideSheet(page)).toBe(true);
    await page.locator('#sheet-close').tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => onDoor(page, 'place')).toBe(true);
  });
});
