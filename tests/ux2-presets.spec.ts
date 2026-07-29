import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  urlLayers,
  waitForLayerSettled,
  PRESET_LABELS,
  SURFACE_KEYS
} from './helpers';

/**
 * UX-2 (CHANGES.md 2026-07-01): question-first view presets. Each chip
 * REPLACES the active layer set through the same activation and deactivation
 * paths a manual toggle takes, so the UX-1 surface exclusivity holds for free.
 *
 * The deactivation side of a preset (which layers turn off) is fully
 * synchronous and network-independent; those are the headline assertions
 * here. The activation side sets the checkbox synchronously too; a preset
 * names at most one surface by construction.
 */
test.describe('UX-2 view presets', () => {
  test('the five preset chips render in order', async ({ page }) => {
    await gotoApp(page);

    const chips = page.locator('#preset-chips .preset-chip');
    await expect(chips).toHaveCount(PRESET_LABELS.length);
    for (let i = 0; i < PRESET_LABELS.length; i++) {
      await expect(chips.nth(i)).toHaveText(PRESET_LABELS[i]!);
    }
  });

  test('the Fire risk preset swaps the surface off USDM to fire weather', async ({ page }) => {
    // Console boot: this spec clicks the Quick views chips, and E1
    // deliverable 1 hides them in Brief behind the console door.
    await gotoApp(page, '?view=console');
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    // Settle usdm's boot activation so the preset swap that turns it off is
    // not racing its own in-flight activation (which would re-add it to the URL).
    await waitForLayerSettled(page, 'usdm');

    await page.locator('#preset-chips .preset-chip', { hasText: 'Fire risk' }).click();

    // Fire risk = spc-fire-weather, nifc-fires, aiannh (the live Tribal
    // Lands layer carries the whose-land context in every preset since the
    // umbrella build). USDM and telemetry are not named, so the replace
    // semantics turn (or keep) them off.
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();
    await expect(layerCheckbox(page, 'spc-fire-weather')).toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();

    // Exactly one surface is checked, and it is the fire-weather outlook.
    for (const key of SURFACE_KEYS) {
      const cb = layerCheckbox(page, key);
      if (key === 'spc-fire-weather') await expect(cb).toBeChecked();
      else await expect(cb).not.toBeChecked();
    }

    // The URL settles to the preset's set: fire weather in, usdm out. The
    // fire-weather layer enters the URL only after its live activation
    // resolves, which can exceed the default 10-second expect ceiling on a
    // slow-upstream day; 25 seconds matches waitForLayerSettled. (This exact
    // poll flaked in CI on 2026-07-03 under the default ceiling.)
    await expect
      .poll(async () => (await urlLayers(page)).has('usdm'), { timeout: 25_000 })
      .toBe(false);
    await expect
      .poll(async () => (await urlLayers(page)).has('spc-fire-weather'), { timeout: 25_000 })
      .toBe(true);
  });

  test('the Whose land preset clears the surface and lights the place layers', async ({ page }) => {
    // Console boot: clicks a Quick views chip (hidden in Brief since E1
    // deliverable 1).
    await gotoApp(page, '?view=console');
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();

    await page.locator('#preset-chips .preset-chip', { hasText: 'Whose land' }).click();

    // Whose land names no surface, so every surface turns off.
    for (const key of SURFACE_KEYS) {
      await expect(layerCheckbox(page, key)).not.toBeChecked();
    }

    // The three place layers light up (aiannh and bia-reservations are live,
    // states bundled; every checkbox is set
    // synchronously by the preset). The deployer own-data slots are NOT in
    // the preset and stay off.
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(layerCheckbox(page, 'states')).toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).toBeChecked();
    // The deployer slots are ui-hidden while off (Unit I, D-0.7.0-038):
    // not being in the preset means no row renders at all.
    await expect(layerCheckbox(page, 'tribal')).toHaveCount(0);
    await expect(layerCheckbox(page, 'treaty')).toHaveCount(0);
  });
});
