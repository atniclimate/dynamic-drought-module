import { test, expect } from './offline-test';

import { gotoApp } from './helpers';

/**
 * found-066: at the CONUS default the hillshade row is on and reads a plain
 * live state while only the bundled Pacific Northwest archive draws. The row
 * itself must carry the existing coverage wording (the tail of the hillshade
 * `source` line in src/config/layers.ts) without opening the Sources
 * disclosure. Every request is routed by `gotoApp`'s suite-wide stubs.
 */
const COVERAGE = 'Pacific Northwest bake only';

for (const query of ['?region=national', '?region=pnw']) {
  test(`hillshade row shows its coverage cue without a disclosure (${query})`, async ({ page }) => {
    await gotoApp(page, query);
    const row = page.locator('#layer-toggles label.layer-toggle', {
      has: page.locator('input[data-layer-key="hillshade"]')
    });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.layer-toggle-coverage')).toHaveText(COVERAGE);
    await expect(row.locator('.layer-toggle-coverage')).toBeVisible();
    // No disclosure was opened to see it.
    await expect(page.locator('#layer-toggles button[aria-expanded="true"]')).toHaveCount(0);
  });
}

/* With no query the national default lands in Brief view, where the layer
 * rows live in the Layers studio. Opening the studio is how a reader reaches
 * any layer row there; the Sources disclosure inside it stays closed. */
test('hillshade row shows its coverage cue without a disclosure (default, Layers studio)', async ({ page }) => {
  await gotoApp(page, '');
  await page.locator('#layers-studio-entry').click();
  const studio = page.locator('#layers-studio-root');
  await expect(studio).toBeVisible();
  const row = studio.locator('label.layer-toggle', {
    has: page.locator('input[data-layer-key="hillshade"]')
  });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.layer-toggle-coverage')).toHaveText(COVERAGE);
  await expect(row.locator('.layer-toggle-coverage')).toBeVisible();
  await expect(studio.locator('.layer-group-sources-toggle[aria-expanded="true"]')).toHaveCount(0);
});
