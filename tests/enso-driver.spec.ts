import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * ENSO driver line (0.4.0 B2 slice 1). The line reads the BUNDLED build-time
 * snapshot (public/data/enso-indices.json), so unlike the live-agency layers
 * this surface is deterministic: it must render on every boot. What is NOT
 * asserted is the phase or index value (those change with each snapshot
 * refresh); the assertions are structural, per the smoke-suite doctrine.
 */
test.describe('ENSO driver line', () => {
  test('renders inside the post-time display description and expands', async ({
    page
  }) => {
    await gotoApp(page);

    const driver = page.locator('#enso-driver');
    await expect(driver).toBeVisible();

    // The compact line: kicker, a non-empty operational RONI value, and tilt.
    await expect(driver.locator('.enso-driver-kicker')).toHaveText('ENSO driver');
    await expect(driver.locator('.enso-driver-value')).toContainText('RONI');
    await expect(driver.locator('.enso-driver-tilt')).not.toBeEmpty();

    // It is demoted into the display description, after the stable time rail.
    await expect(page.locator('#brief-display > #enso-driver')).toHaveCount(1);
    // S4 (2026-07-18 design record): #shell-panel now sits between the brief
    // head and the time rail, so assert presence and order of the four stable
    // panel nodes rather than strict adjacency.
    await expect(
      page.locator('#brief-head ~ #shell-panel ~ #time-bar ~ #brief-display')
    ).toHaveCount(1);

    // Expanding the disclosure shows the full odds-never-outcomes detail and
    // the source link; the detail must carry the honesty framing.
    await driver.locator('.enso-driver-line').click();
    await expect(driver.locator('.enso-driver-detail')).toContainText('odds');
    await expect(driver.locator('.enso-driver-detail')).toContainText(
      /snapshot retrieved \d{4}-\d{2}-\d{2}/
    );
    await expect(driver.locator('.enso-driver-source')).toHaveAttribute(
      'href',
      /cpc\.ncep\.noaa\.gov/
    );
  });
});
