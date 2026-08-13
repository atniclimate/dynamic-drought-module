import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

test.describe('retired ENSO driver line', () => {
  test('does not duplicate the hazard controls in the briefing column', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#enso-driver')).toHaveCount(0);
  });
});
