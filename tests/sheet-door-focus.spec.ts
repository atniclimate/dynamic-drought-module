import { test, expect, type Page } from './offline-test';
import { gotoApp } from './helpers';

/**
 * WCAG 2.4.3 on the phone: a door press that opens or switches the sheet moves
 * focus into the view it shows, and closing returns focus to the door. Without
 * this a keyboard or switch user tabs past unrelated map controls to reach
 * the content (src/ui/mobile-sheet.ts, `focusShownView`).
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
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect.poll(() => insideSheet(page)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => onDoor(page, 'place')).toBe(true);
  });

  test('switching doors at the same stop moves focus into the new view', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const layers = page.locator('#mobile-footer-nav button[data-tab="layers"]');
    const alerts = page.locator('#mobile-footer-nav button[data-tab="alerts"]');

    await layers.tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect.poll(() => insideSheet(page)).toBe(true);

    // Layers and Alerts both open at half: same stop, new door.
    await alerts.tap();
    await expect(app).toHaveAttribute('data-sheet-tab', 'alerts');
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect.poll(() => insideSheet(page)).toBe(true);
    await expect(page.locator('#sheet-title')).toHaveText(/alerts/i);

    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => onDoor(page, 'alerts')).toBe(true);
  });

  test('pressing the lit door still closes and focus stays on that door', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const place = page.locator('#mobile-footer-nav button[data-tab="place"]');

    await place.tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect.poll(() => insideSheet(page)).toBe(true);
    await place.tap();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => onDoor(page, 'place')).toBe(true);
  });
});
