import { test, expect } from '@playwright/test';
import { gotoApp, layerCheckbox, waitForLayerSettled } from './helpers';

/**
 * UX-3 unified legend registry: one panel whose sections are contributed by
 * the active layers, retiring the four ad-hoc per-layer panels.
 *
 * These specs drive layers whose legend appears synchronously on activate
 * (the drought and gridded-index raster surfaces, and the bundled-PMTiles
 * ecoregion reference), so the assertions do not couple to a live agency
 * fetch. The event legend (nifc-fires) is verified in the manual lane, where
 * its appearance depends on the upstream returning perimeters.
 */

/** The data-legend keys of the rendered sections, in DOM (visual) order. */
async function sectionKeys(page: import('@playwright/test').Page): Promise<(string | null)[]> {
  return page.$$eval('#legend-sections .legend-section', (els) =>
    els.map((e) => e.getAttribute('data-legend'))
  );
}

test.describe('UX-3 unified legend registry', () => {
  test('unifies the active surface and the ecoregion reference into one ordered panel', async ({
    page
  }) => {
    // Console boot: this spec drives catalog checkboxes, and E1 deliverable 1
    // hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');
    // Settle the default surface first so its own activation cannot race the
    // swap below (an in-flight activation could re-add its section).
    await waitForLayerSettled(page, 'usdm');

    // Turn on a raster surface (synchronous legend) and the bundled ecoregion
    // reference (synchronous legend). The surface deactivates usdm.
    await layerCheckbox(page, 'drought').check();
    await layerCheckbox(page, 'ecoregions').check();

    const panel = page.locator('#legend-panel');
    await expect(panel).toBeVisible();

    // One panel, two sections, ordered surface then reference (usdm gone).
    await expect
      .poll(() => sectionKeys(page))
      .toEqual(['drought', 'ecoregions']);

    // The ecoregion section folds its Level III/IV selector in.
    const level = page.locator('#ecoregion-level');
    await expect(level).toBeVisible();
    await expect(level.locator('option')).toHaveCount(2);

    // The drought section rendered its swatch key.
    await expect(
      page.locator('.legend-section[data-legend="drought"] .legend li')
    ).toHaveCount(4);
  });

  test('switching the surface swaps only the surface section', async ({ page }) => {
    await gotoApp(page, '?view=console'); // catalog-driving spec (E1 deliverable 1)
    await waitForLayerSettled(page, 'usdm');
    await layerCheckbox(page, 'drought').check();
    await layerCheckbox(page, 'ecoregions').check();
    await expect.poll(() => sectionKeys(page)).toEqual(['drought', 'ecoregions']);

    // Swap to the gridded-index surface: it replaces drought, ecoregions stays.
    await layerCheckbox(page, 'gridded-index').check();
    await expect.poll(() => sectionKeys(page)).toEqual(['gridded-index', 'ecoregions']);

    // The gridded-index section carries its product selector, populated.
    await expect(page.locator('#gridded-index-product option')).toHaveCount(5);
  });

  test('the panel hides when the last legend layer is turned off', async ({ page }) => {
    await gotoApp(page, '?view=console'); // catalog-driving spec (E1 deliverable 1)
    await waitForLayerSettled(page, 'usdm');
    await layerCheckbox(page, 'drought').check();
    await expect(page.locator('#legend-panel')).toBeVisible();

    // Turning off the only legend-bearing layer leaves no section, so the panel
    // hides rather than showing an empty legend. (Telemetry and Tribal, still
    // on by default, carry no legend.)
    await layerCheckbox(page, 'drought').uncheck();
    await expect(page.locator('#legend-panel')).toBeHidden();
    await expect(page.locator('#legend-sections .legend-section')).toHaveCount(0);
  });
});
