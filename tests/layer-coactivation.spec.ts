import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox, urlLayers } from './helpers';

/**
 * U3f1 / found-007: the wildfire event pair is INDEPENDENT (the owner's
 * ruling of 2026-09-28, reversing D-0.7.0-018's catalog coupling).
 *
 * Checking Current Mapped Fire Perimeters (nifc-fires) turns on exactly that
 * layer, and checking Smoke Plumes (hms-smoke) turns on exactly that layer;
 * unchecking either turns off only itself. Neither row carries a partner note.
 * The Wildfire MODE is a different path and is unchanged: its recipes and the
 * Fire preset name both layers explicitly, so pressing Wildfire still shows
 * both. An inbound URL is authoritative, so a deep link restores exactly the
 * layers it names.
 *
 * Every assertion is on checkbox intent and `layers=`, which the controller
 * writes through the island bridge, so the specs are independent of whether
 * the live NIFC / HMS fetches succeed in the test environment. The checkbox
 * assertions are the deterministic discriminator: the retired cascade set the
 * partner's checkbox synchronously inside the same change handler.
 */
test.describe('U3f1 the fire perimeters and smoke plumes checkboxes are independent (found-007)', () => {
  test('checking Current Mapped Fire Perimeters turns on only itself, not Smoke Plumes', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();

    await layerCheckbox(page, 'nifc-fires').check();

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
  });

  test('checking Smoke Plumes turns on only itself, not Current Mapped Fire Perimeters', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    await layerCheckbox(page, 'hms-smoke').check();

    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
  });

  test('each stays individually toggleable off after both are checked by hand', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await layerCheckbox(page, 'nifc-fires').check();
    // Independence: the first check brought in only itself.
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
    await layerCheckbox(page, 'hms-smoke').check();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();

    // Turn only Smoke Plumes back off; Current Mapped Fire Perimeters stays on.
    await layerCheckbox(page, 'hms-smoke').uncheck();

    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
  });

  test('a deep link naming only one of the pair restores only that one (URL authoritative)', async ({
    page
  }) => {
    await gotoApp(page, '?layers=nifc-fires');

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    // The URL restore path (applyLayerSet) names its layers exactly: the
    // sharer named exactly one layer, and that is what the recipient gets.
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
  });

  test('a deep link naming both of the pair restores both', async ({ page }) => {
    await gotoApp(page, '?layers=nifc-fires,hms-smoke');

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });

  /**
   * found-007 (repurposed from D1 M14's partner-note case): with the pair
   * independent there is no partner to name, so neither row carries a note
   * and each row's accessible name starts with its own layer name and never
   * mentions the other layer.
   */
  test('neither the fire perimeters nor the smoke plumes row carries a partner note; each accessible name is its own layer name', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    const fire = layerCheckbox(page, 'nifc-fires');
    await expect(fire).toHaveAccessibleName(/^Current Mapped Fire Perimeters \(NIFC\)/);
    await expect(fire).not.toHaveAccessibleName(/also turns on|Smoke Plumes/);

    const smoke = layerCheckbox(page, 'hms-smoke');
    await expect(smoke).toHaveAccessibleName(/^Smoke Plumes \(HMS\)/);
    await expect(smoke).not.toHaveAccessibleName(/also turns on|Current Mapped Fire Perimeters/);

    // Both rows are mounted (the accessible-name reads above waited on them),
    // so a zero count is a real absence, not an unrendered catalog.
    await expect(page.locator('[data-layer-coactivate-note]')).toHaveCount(0);
  });

  /**
   * found-007's register acceptance ("a test asserts layers= after each of
   * the four actions"), under the owner's ruling of 2026-09-28: the pair is
   * fully independent. After each action `layers=` holds exactly the member
   * the user just left on, and never the other. Each step first waits on the
   * URL, then reads the partner's checkbox, which the retired cascade set
   * synchronously, so a coupling cannot pass through a transient URL write.
   */
  test('layers= holds only the member the user toggled after each of the four actions (independent pair)', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // Action 1: check nifc-fires. Only nifc-fires enters layers=.
    await layerCheckbox(page, 'nifc-fires').check();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('nifc-fires') && !layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Action 2: uncheck nifc-fires. Neither is in layers=.
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return !layers.has('nifc-fires') && !layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Action 3: check hms-smoke. Only hms-smoke enters layers=.
    await layerCheckbox(page, 'hms-smoke').check();
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return !layers.has('nifc-fires') && layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Action 4: uncheck hms-smoke. Neither is in layers=.
    await layerCheckbox(page, 'hms-smoke').uncheck();
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return !layers.has('nifc-fires') && !layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);
  });
});
