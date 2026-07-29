import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox } from './helpers';

/**
 * U3f1: the wildfire event pair co-activates (D-0.7.0-018).
 *
 * Turning Active Wildfires (nifc-fires) on through a user toggle also turns on
 * Smoke Plumes (hms-smoke), and the reverse; each stays individually toggleable
 * off. Co-activation is a USER-TOGGLE affordance only: an inbound URL is
 * authoritative, so a deep link naming just one of the pair does NOT co-activate
 * the other (the sharer may have turned it off deliberately).
 *
 * Every assertion is on checkbox intent, which the controller writes
 * synchronously through the island bridge, so the specs are independent of
 * whether the live NIFC / HMS fetches succeed in the test environment.
 */
test.describe('U3f1 the wildfire event pair co-activates', () => {
  test('toggling Active Wildfires on co-activates Smoke Plumes', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();

    await layerCheckbox(page, 'nifc-fires').check();

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });

  test('toggling Smoke Plumes on co-activates Active Wildfires (symmetric)', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await layerCheckbox(page, 'hms-smoke').check();

    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
  });

  test('each stays individually toggleable off after the pair activates', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await layerCheckbox(page, 'nifc-fires').check();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();

    // Turn only Smoke Plumes back off; Active Wildfires stays on.
    await layerCheckbox(page, 'hms-smoke').uncheck();

    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
  });

  test('a deep link naming only one of the pair does NOT co-activate the other (URL authoritative)', async ({
    page
  }) => {
    await gotoApp(page, '?layers=nifc-fires');

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    // The URL restore path (applyLayerSet) never co-activates: the sharer named
    // exactly one layer, and that is what the recipient gets.
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
  });

  test('a deep link naming both of the pair restores both', async ({ page }) => {
    await gotoApp(page, '?layers=nifc-fires,hms-smoke');

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });
});
