import { test, expect } from '@playwright/test';
import { gotoApp, urlLayers, waitForLayerSettled } from './helpers';

/**
 * The mobile hazard rail and the footer doors (0.7.0 mobile shell,
 * 2026-07-14; from the ratified 2026-07-11 mockup): the quick hazard
 * selections (Drought / Heat / Fire) in the lower-right thumb zone, over
 * the map-first closed sheet and the four-door footer.
 *
 * Contract under test:
 * - The rail exists whenever the map is visible (closed, peek, half):
 *   present on the map-first boot, gone at the full detent, absent on
 *   desktop, and absent in embed byte for byte (hard rule 8).
 * - A hazard tap routes through the ONE layer controller (applyPreset):
 *   the preset's layer set replaces the active set in the URL, so the
 *   result is shareable state, never a parallel state machine.
 * - The pressed state REFLECTS the registry (the rail and the catalog
 *   share one state): a button reads pressed only while its surface
 *   layer is actually active.
 * - Buttons clear the 44px touch floor.
 * - The Alerts door opens the honest alert pane inside the one sheet.
 */

test.describe('the mobile hazard rail (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the map-first boot shows the rail with three 44px+ hazard buttons', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');

    const rail = page.locator('#hazard-rail');
    await expect(rail).toBeVisible();
    const buttons = rail.locator('.hazard-rail-btn');
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toContainText('Drought');
    await expect(buttons.nth(1)).toContainText('Heat');
    await expect(buttons.nth(2)).toContainText('Fire');

    for (let i = 0; i < 3; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // The default-on drought surface presses the Drought button (the rail
    // reflects the registry, it never claims a hazard the map is not
    // showing).
    await waitForLayerSettled(page, 'usdm');
    await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'false');
  });

  test('tapping Fire applies the wildfire preset through the URL, stays map-first, and presses the button', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');

    // Settle the default-on surface before the preset swap (the helpers'
    // documented precondition for deterministic URL assertions).
    await waitForLayerSettled(page, 'usdm');

    const fireBtn = page.locator('#hazard-rail button[data-preset="hazard-fire"]');
    await fireBtn.click();

    // The map-first state holds: a quick select shows the map, it never
    // opens the sheet.
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return (
            layers.has('spc-fire-weather') &&
            layers.has('nifc-fires') &&
            layers.has('hms-smoke') &&
            layers.has('aiannh') &&
            !layers.has('usdm')
          );
        },
        // The live SPC and NIFC activations run through real fetches;
        // under a parallel suite they can be slow. The URL is written on
        // activation, but give the whole swap room.
        { timeout: 30_000 }
      )
      .toBe(true);
    await waitForLayerSettled(page, 'spc-fire-weather');
    await expect(fireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.locator('#hazard-rail button[data-preset="hazard-drought"]')
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('the rail yields to the open sheet; a quick-view chip closes the sheet to the map', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const rail = page.locator('#hazard-rail');
    await expect(rail).toBeVisible();

    // The open sheet owns the rail's zone (the mockup's sheet covers its
    // rail): at half and full the rail is gone; closing brings it back.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(rail).toBeHidden();

    // A quick-view chip applies its preset AND closes the sheet (the
    // mockup's rule 5: the map answers).
    await page.locator('#preset-chips .preset-chip', { hasText: 'Fire risk' }).click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(rail).toBeVisible();
    await expect
      .poll(async () => (await urlLayers(page)).has('spc-fire-weather'))
      .toBe(true);

    // At full (Brief door) the map has receded and the rail stays gone.
    await page.locator('#mobile-footer-nav button[data-tab="brief"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(rail).toBeHidden();
    await page.locator('#mobile-footer-nav button[data-tab="brief"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(rail).toBeVisible();
  });

  test('the Alerts door opens the alert pane inside the one sheet', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');

    await page.locator('#mobile-footer-nav button[data-tab="alerts"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(app).toHaveAttribute('data-sheet-tab', 'alerts');
    await expect(page.locator('#sheet-alerts')).toBeVisible();
    // The pane is the sheet's only content (one sheet, one surface).
    await expect(page.locator('#sheet-at-hand')).toBeHidden();
    await expect(page.locator('#panel-region')).toBeHidden();
    // Honest content: either real alert rows or an honest status line;
    // never an empty pane.
    await expect
      .poll(async () => (await page.locator('#sheet-alerts-body').textContent())?.trim().length ?? 0)
      .toBeGreaterThan(0);

    // Re-tapping the active door closes back to the map.
    await page.locator('#mobile-footer-nav button[data-tab="alerts"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(app).not.toHaveAttribute('data-sheet-tab', /.+/);
  });
});

test.describe('the hazard rail and footer stay out of embed and desktop', () => {
  test('a 400x600 embed has no rail and no footer', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true');
    await expect(page.locator('#hazard-rail')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
  });

  test('a desktop viewport has no rail and no footer', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoApp(page);
    await expect(page.locator('#hazard-rail')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
  });
});
