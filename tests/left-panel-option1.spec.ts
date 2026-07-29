import { test, expect } from '@playwright/test';

import { gotoApp } from './helpers';

test.describe('D-0.7.0-067 contextual time rail', () => {
  test('desktop reads place, time, display, then selection response', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=usdm');

    const order = await page.locator('.sidebar-scroll').evaluate((scroll) => {
      const children = Array.from(scroll.children);
      return ['brief-head', 'time-bar', 'brief-display'].map((id) =>
        children.indexOf(document.getElementById(id)!)
      );
    });
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);

    await expect(page.locator('#time-bar')).toBeVisible();
    await expect(page.locator('#brief-display')).toBeVisible();
    await expect(page.locator('#brief-display #studio-entry-pair')).toBeVisible();
    await expect(page.locator('#brief-display #enso-driver')).toBeVisible();
    await expect(page.locator('#brief-selection-summary')).toBeHidden();
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    const search = page.locator('#brief-search [data-ddm-search]');
    await search.fill('oregon');
    await page.locator('#brief-search [data-search-kind="place"][data-search-id="OR"]').click();
    await expect(page.locator('#brief-place-name')).toHaveText('Oregon');
    await expect(page.locator('#brief-selection-summary')).toContainText('focused on Oregon');
    await expect(page.locator('#brief-full-report-link')).toHaveCount(1);

    // Summary-first (D-0.7.0-070): the desktop search select behaves like
    // a map click; NO briefing opens until the one link is used, and the
    // link then opens it for the selected place.
    await expect(page.locator('#impact-panel.open')).toHaveCount(0);
    await page.locator('#brief-full-report-link').click();
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
  });

  test('mobile Brief moves the same focused control between stable hosts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?view=brief&layers=usdm');

    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');

    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible();
    await expect(page.locator('#sheet-time-host > #time-bar')).toHaveCount(1);
    // The sheet's PLACE-studio entry stays VISIBLE: the footer place tab
    // opens the at-hand search, not the studio, so this button is the only
    // mobile door to the full PLACE studio (D-0.7.0-054; integration
    // reconciliation of the lane's hide).
    await expect(page.locator('#sheet-place-studio-entry')).toBeVisible();
    expect(
      await page
        .locator('#mobile-footer-nav button[data-tab="place"]')
        .evaluate((button) => button.nextElementSibling?.getAttribute('data-tab'))
    ).toBe('layers');

    const targets = bar.locator(
      '.time-bar-step, .time-bar-play, .time-bar-jump, .time-bar-modes button'
    );
    for (let i = 0; i < (await targets.count()); i += 1) {
      const box = await targets.nth(i).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    const previous = bar.locator('[data-step="-1"]');
    await previous.focus();
    await expect(previous).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(previous).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('#brief-head + #time-bar')).toHaveCount(1);
    await expect(previous).toBeFocused();
  });

  test('embed keeps only the mirrored date until its explicit exit', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=brief&layers=usdm');

    await expect(page.locator('#time-bar')).toBeHidden();
    await expect(page.locator('#embed-date-stamp')).toBeVisible();
    await page.locator('#sidebar-expand').click();
    await expect(page.locator('#app')).not.toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'peek');
    await expect(page.locator('#embed-date-stamp')).toBeHidden();
    await expect(page.locator('#time-bar')).toBeHidden();

    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#sheet-time-host > #time-bar')).toBeVisible();
  });
});
