import { test, expect } from '@playwright/test';
import type { Page, Response } from '@playwright/test';

import { placeRefFromBoundary } from '../src/config/entities';
import { gotoApp, layerCheckbox } from './helpers';

/**
 * Capture the WA feature's own properties from the bundled
 * `us-states.geojson` response the search door's own `openStateBriefing`
 * fetch retrieves (never a separate fetch of this test's own making), so
 * the computed reference reflects exactly what that door read.
 */
async function captureWaProperties(
  page: Page,
  action: () => Promise<void>
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  const listener = async (response: Response): Promise<void> => {
    if (!response.url().includes('/data/us-states.geojson')) return;
    try {
      const body = (await response.json()) as {
        features?: Array<{ properties?: Record<string, unknown> }>;
      };
      const match = body.features?.find((f) => f.properties?.['STUSPS'] === 'WA');
      if (match?.properties) captured = match.properties;
    } catch {
      // A held or aborted response has no body; not this capture's concern.
    }
  };
  page.on('response', listener);
  try {
    await action();
  } finally {
    page.off('response', listener);
  }
  return captured;
}

/**
 * U3c/U3d: the one search experience.
 *
 * One input in the console catalog searches across Places, Tribal land areas,
 * and Layers, grouped. These assertions cover the network-independent paths:
 * the grouping, a layer result turning its layer on, and the Tribal group
 * loading from the bundled NAMES-ONLY roster (public/data/tribal-roster.json).
 * The live LARNAME locate (an external AIAN-LAR query) and the place briefing
 * open are exercised by the Codex browser pass, not here.
 */
test.describe('U3 the one search', () => {
  // The search now mounts in more than one host (the console catalog and the
  // Brief head), so scope to the console catalog's instance.
  const searchInput = '#catalog-search [data-ddm-search]';

  test('the console catalog carries the search input', async ({ page }) => {
    await gotoApp(page, '?view=console');
    await expect(page.locator(searchInput)).toBeVisible();
  });

  test('a query groups results and a layer result carries its kind and id', async ({ page }) => {
    await gotoApp(page, '?view=console');
    await page.locator(searchInput).fill('wildfire');

    // The Layers group shows Current Mapped Fire Perimeters, tagged with its
    // kind and key so the wiring can route it.
    const layerResult = page.locator('[data-search-group="layer"] [data-search-kind="layer"][data-search-id="nifc-fires"]');
    await expect(layerResult).toBeVisible();
  });

  test('choosing a layer result turns that layer on through the shared toggle command', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();

    await page.locator(searchInput).fill('current mapped fire perimeters');
    await page.locator('[data-search-kind="layer"][data-search-id="nifc-fires"]').click();

    // The catalog checkbox reflects the search selection (and the query clears).
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(page.locator(searchInput)).toHaveValue('');
  });

  test('the Tribal land areas group loads from the bundled roster and matches a formal name', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    await page.locator(searchInput).fill('yakama');

    // The roster is a local static file, so the Tribal group is deterministic
    // here. A short LARNAME query surfaces the full formal Federal Register
    // name (never abbreviated).
    const tribalGroup = page.locator('[data-search-group="tribal"]');
    await expect(tribalGroup).toBeVisible();
    await expect(tribalGroup).toContainText('Yakama Nation');
  });

  test('a place result carries its kind and state code', async ({ page }) => {
    await gotoApp(page, '?view=console');
    await page.locator(searchInput).fill('oregon');

    const placeResult = page.locator('[data-search-group="place"] [data-search-kind="place"]');
    await expect(placeResult.first()).toBeVisible();
    await expect(placeResult.first()).toContainText('Oregon');
  });

  test('a query with no matches shows a plain, non-blaming empty line', async ({ page }) => {
    await gotoApp(page, '?view=console');
    await page.locator(searchInput).fill('zzzznotathing');

    // Wait for the Tribal load to settle so the empty line is the final state.
    await expect(page.locator('#catalog-search .ddm-search-empty')).toContainText('No matches for');
  });
});

test.describe('DDM-P2-T09: search resolves the same canonical place reference', () => {
  // Scoped to the console catalog's instance, matching the describe above.
  const searchInput = '#catalog-search [data-ddm-search]';

  test('choosing the Washington place result resolves state:WA, matching the select= and click doors', async ({
    page
  }) => {
    const briefingBtn = page.locator('#region-briefing-btn');
    // The boot sits inside the capture on purpose (DDM-P14-T06): the states
    // layer is default-on and reads us-states.geojson once at boot through the
    // shared budgeted fetch, and the search door's selection then reads that
    // same parsed object, so there is no selection-time response to capture.
    // The same idiom as tests/place-studio.spec.ts's click-door case.
    const waProperties = await captureWaProperties(page, async () => {
      await gotoApp(page, '?view=console');
      await page.locator(searchInput).fill('washington');
      await page.locator('[data-search-kind="place"][data-search-id="WA"]').click();
      // Summary-first (D-0.7.0-070): the pick sets the place selection; the
      // region-briefing trigger becomes this place's "See what this means"
      // door (src/ui/sidebar.ts updateRegionBriefingTrigger).
      await expect(briefingBtn).toHaveText('See what this means');
      await briefingBtn.click();
      await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    });

    expect(waProperties).not.toBeNull();
    expect(placeRefFromBoundary('state', waProperties)).toEqual({ scheme: 'state', code: 'WA' });
  });
});
