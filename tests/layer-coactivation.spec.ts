import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox, urlLayers } from './helpers';

/**
 * U3f1: the wildfire event pair co-activates (D-0.7.0-018).
 *
 * Turning Current Mapped Fire Perimeters (nifc-fires) on through a user toggle
 * also turns on Smoke Plumes (hms-smoke), and the reverse; each stays
 * individually toggleable off. Co-activation is a USER-TOGGLE affordance only:
 * an inbound URL is authoritative, so a deep link naming just one of the pair
 * does NOT co-activate the other (the sharer may have turned it off deliberately).
 *
 * Every assertion is on checkbox intent, which the controller writes
 * synchronously through the island bridge, so the specs are independent of
 * whether the live NIFC / HMS fetches succeed in the test environment.
 */
test.describe('U3f1 the wildfire event pair co-activates', () => {
  test('toggling Current Mapped Fire Perimeters on co-activates Smoke Plumes', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();

    await layerCheckbox(page, 'nifc-fires').check();

    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
  });

  test('toggling Smoke Plumes on co-activates Current Mapped Fire Perimeters (symmetric)', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    await layerCheckbox(page, 'hms-smoke').check();

    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
  });

  test('each stays individually toggleable off after the pair activates', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await layerCheckbox(page, 'nifc-fires').check();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();

    // Turn only Smoke Plumes back off; Current Mapped Fire Perimeters stays on.
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

  /**
   * found-007 (D1 M14): each row's visible note and accessible name make
   * the co-activation coupling explicit, in D1.md's own wording.
   */
  test('each of the fire perimeters and smoke plumes rows names the partner it switches on', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    const fireNote = page.locator('[data-layer-coactivate-note="nifc-fires"]');
    await expect(fireNote).toHaveText('also turns on Smoke Plumes (HMS)');
    await expect(layerCheckbox(page, 'nifc-fires')).toHaveAccessibleName(
      /also turns on Smoke Plumes \(HMS\)/
    );

    const smokeNote = page.locator('[data-layer-coactivate-note="hms-smoke"]');
    await expect(smokeNote).toHaveText('also turns on Current Mapped Fire Perimeters (NIFC)');
    await expect(layerCheckbox(page, 'hms-smoke')).toHaveAccessibleName(
      /also turns on Current Mapped Fire Perimeters \(NIFC\)/
    );
  });

  /**
   * found-007's register acceptance ("a test asserts layers= after each of
   * the four actions"): the Tier 1 choice is asymmetric-with-a-note, not
   * the register draft's symmetric-off or fully-independent alternatives
   * (D1.md Notes). This pins today's asymmetric behavior at the URL layer
   * specifically: checking either member brings both into layers=;
   * unchecking either drops only itself.
   *
   * FIXME REGISTER found-092: action 3 (check hms-smoke after both were
   * unchecked by hand) never brings nifc-fires back into layers=, on base
   * code too (DR-155 A/B gates/ab-lc105.log: 19 of 20 red, tree and base
   * alike), against the co-activation contract in layer-controller.ts
   * (D-0.7.0-018). Un-fixme with the found-092 fix; do not weaken it.
   */
  test.fixme('layers= reflects the pair asymmetrically after each of the four coupling actions', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // Action 1: check nifc-fires. Both enter layers= (symmetric ON).
    await layerCheckbox(page, 'nifc-fires').check();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('nifc-fires') && layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Action 2: uncheck nifc-fires. Only itself drops (asymmetric OFF); the
    // co-activated partner stays in layers=.
    await layerCheckbox(page, 'nifc-fires').uncheck();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return !layers.has('nifc-fires') && layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Reset both off before the mirror pair of actions.
    await layerCheckbox(page, 'hms-smoke').uncheck();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return !layers.has('nifc-fires') && !layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Action 3: check hms-smoke. Both enter layers= (symmetric ON, mirrored).
    await layerCheckbox(page, 'hms-smoke').check();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('nifc-fires') && layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Action 4: uncheck hms-smoke. Only itself drops (asymmetric OFF, mirrored).
    await layerCheckbox(page, 'hms-smoke').uncheck();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('nifc-fires') && !layers.has('hms-smoke');
        },
        { timeout: 25_000 }
      )
      .toBe(true);
  });
});
