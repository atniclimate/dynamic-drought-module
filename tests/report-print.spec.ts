import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * The report in print (U1, D-0.7.0-017): with a briefing open, printing
 * prints THE REPORT (the panel as a static document) and none of the
 * interactive chrome; with no briefing open, printing is untouched
 * browser default. Asserted by emulating print media, not by generating
 * a PDF: the display rules ARE the contract, and they are what a
 * council-packet print-to-PDF consumes.
 */
test.describe('U1 the report in print', () => {
  test('with a briefing open, print media shows the report and hides the chrome', async ({
    page
  }) => {
    // The briefing is opened by the select= deep link: since S2
    // (D-0.7.0-041) a bare boot never opens one unsolicited, and the
    // deep link is the boot-time explicit opener.
    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    await page.emulateMedia({ media: 'print' });

    // The app shell never prints while a report is open; the report does.
    await expect(page.locator('#app')).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-close')).toBeHidden();

    // Back on screen media the app returns; nothing was destroyed.
    await page.emulateMedia({ media: 'screen' });
    await expect(page.locator('#app')).toBeVisible();
    await expect(panel).toBeVisible();
  });

  test('with no briefing open, print media leaves the app alone', async ({ page }) => {
    // No boot auto-opens a briefing since S2 (D-0.7.0-041); a console
    // boot is the sharpest case (it never did).
    await gotoApp(page, '?region=washington_state&layers=usdm');
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#app')).toBeVisible();
  });
});
