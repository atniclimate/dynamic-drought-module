import { test, expect, type Page } from '@playwright/test';
import { gotoApp, urlLayers, waitForLayerSettled } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

/**
 * The mobile quick-view spine and the footer doors. Four icon-only hazard
 * controls occupy the lower-right thumb zone, with the one authoritative
 * Satellite control seated directly below them.
 *
 * Contract under test:
 * - The rail exists in the map-led closed and peek detents, yields to the
 *   half and full sheet detents, and stays absent on desktop and in embed
 *   byte for byte (hard rule 8).
 * - A hazard tap routes through the ONE layer controller (applyPreset):
 *   the preset's layer set replaces the active set in the URL, so the
 *   result is shareable state, never a parallel state machine.
 * - The pressed state REFLECTS the registry (the rail and the catalog
 *   share one state): a button reads pressed only while its surface
 *   layer is actually active.
 * - Buttons clear the 44px touch floor.
 * - The Alerts door opens the honest alert pane inside the one sheet.
 */

async function stubQuickViewSources(page: Page): Promise<void> {
  const empty = emptyCollectionBody();
  await routeGeojson(page, AIANNH_ROUTE, empty);
  await routeGeojson(page, BIA_ROUTE, empty);

  for (const pattern of [
    '**/SPC_firewx/MapServer/1/query?**',
    '**/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?**',
    '**/NOAA_Satellite_Smoke_Detection_*/FeatureServer/0/query?**'
  ]) {
    await routeGeojson(page, pattern, empty);
  }

  // The current SST surface installs before this optional date enumeration.
  // Bound the latter deterministically while preserving the real layer path.
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'text/plain',
      body: 'Synthetic offline response'
    })
  );
}

test.beforeEach(async ({ page }) => {
  await stubQuickViewSources(page);
});

test.describe('the mobile hazard rail (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the map-first boot shows four accessible icon controls followed geometrically by Satellite', async ({
    page
  }) => {
    await gotoApp(page);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');

    const rail = page.locator('#hazard-rail');
    await expect(rail).toBeVisible();
    const buttons = rail.locator('.hazard-rail-btn');
    await expect(buttons).toHaveCount(4);
    expect(
      await buttons.evaluateAll((controls) =>
        controls.map((control) => control.getAttribute('data-preset'))
      )
    ).toEqual(['hazard-enso', 'hazard-fire', 'hazard-drought', 'hazard-heat']);
    await expect(buttons.nth(0)).toHaveAccessibleName(/El Nino.*ENSO/i);
    await expect(buttons.nth(1)).toHaveAccessibleName(/wildfire/i);
    await expect(buttons.nth(2)).toHaveAccessibleName(/drought/i);
    await expect(buttons.nth(3)).toHaveAccessibleName(/heat/i);

    const satellite = page.locator('.basemap-switcher-btn');
    await expect(satellite).toHaveCount(1);
    await expect(satellite).toBeVisible();
    await expect(satellite).toHaveAccessibleName(/satellite imagery/i);
    await expect(page.locator('#hazard-rail .basemap-switcher-btn')).toHaveCount(0);

    // Mobile labels remain in the accessibility tree but do not render as
    // visible map text.
    const labelStyles = await page
      .locator('#hazard-rail .map-control-label, .basemap-switcher-btn .basemap-switcher-label')
      .evaluateAll((labels) =>
        labels.map((label) => {
          const style = getComputedStyle(label);
          return {
            clip: style.clip,
            height: style.height,
            overflow: style.overflow,
            position: style.position,
            width: style.width
          };
        })
      );
    expect(labelStyles).toHaveLength(5);
    for (const style of labelStyles) {
      expect(style.position).toBe('absolute');
      expect(style.width).toBe('1px');
      expect(style.height).toBe('1px');
      expect(style.overflow).toBe('hidden');
      expect(style.clip).not.toBe('auto');
    }

    const lowerControls = [
      buttons.nth(0),
      buttons.nth(1),
      buttons.nth(2),
      buttons.nth(3),
      satellite
    ];
    const boxes = [];
    for (const control of lowerControls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      boxes.push(box!);
    }

    // Shared right edge and strictly increasing centers establish the visual
    // order ENSO, Fire, Drought, Heat, Satellite without hardcoded pixels.
    const rightEdges = boxes.map((box) => box.x + box.width);
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1);
    const centers = boxes.map((box) => box.y + box.height / 2);
    for (let i = 1; i < centers.length; i += 1) {
      expect(centers[i]).toBeGreaterThan(centers[i - 1]!);
    }

    // The default-on drought surface presses the Drought button (the rail
    // reflects the registry, it never claims a hazard the map is not
    // showing).
    await waitForLayerSettled(page, 'nadm-drought');
    await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(3)).toHaveAttribute('aria-pressed', 'false');
  });

  test('tapping ENSO applies the shipped SST anomaly preset through shareable URL state', async ({
    page
  }) => {
    await gotoApp(page);
    await waitForLayerSettled(page, 'nadm-drought');

    const ensoBtn = page.locator('#hazard-rail button[data-preset="hazard-enso"]');
    await ensoBtn.click();

    await expect
      .poll(async () => [...(await urlLayers(page))].sort())
      .toEqual(['aiannh', 'sst-anomaly']);
    await waitForLayerSettled(page, 'sst-anomaly');
    await expect(ensoBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.locator('#hazard-rail button[data-preset="hazard-drought"]')
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');
  });

  test('tapping Fire applies the wildfire preset through the URL, stays map-first, and presses the button', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');

    // Settle the default-on surface before the preset swap (the helpers'
    // documented precondition for deterministic URL assertions).
    await waitForLayerSettled(page, 'nadm-drought');

    const fireBtn = page.locator('#hazard-rail button[data-preset="hazard-fire"]');
    await fireBtn.click();

    // The map-first state holds: a quick select shows the map, it never
    // opens the sheet.
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect
      .poll(
        async () => [...(await urlLayers(page))].sort(),
        // Several lazy activations settle through the serialized controller.
        // The URL is written during the swap, but give the full replacement
        // room under a parallel suite.
        { timeout: 30_000 }
      )
      .toEqual(['aiannh', 'hms-smoke', 'nifc-fires', 'spc-fire-weather']);
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
    const satellite = page.locator('.basemap-switcher-btn');
    const share = page.locator('#share-btn');
    const reset = page.locator('#reset-btn');
    await expect(rail).toBeVisible();
    await expect(satellite).toBeVisible();
    await expect(share).toBeVisible();
    await expect(reset).toBeVisible();

    // The open sheet owns the rail's zone (the mockup's sheet covers its
    // rail): at half and full the rail is gone; closing brings it back.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(rail).toBeHidden();
    await expect(satellite).toBeHidden();
    await expect(share).toBeVisible();
    await expect(reset).toBeVisible();
    await satellite.evaluate((button) => (button as HTMLButtonElement).focus());
    await expect(satellite).not.toBeFocused();

    // A quick-view chip applies its preset AND closes the sheet (the
    // mockup's rule 5: the map answers).
    await page.locator('#preset-chips .preset-chip', { hasText: 'Fire risk' }).click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(rail).toBeVisible();
    await expect(satellite).toBeVisible();
    await expect(share).toBeVisible();
    await expect(reset).toBeVisible();
    await expect
      .poll(async () => (await urlLayers(page)).has('spc-fire-weather'))
      .toBe(true);

    // At full (Brief door) the map has receded and the rail stays gone.
    await page.locator('#mobile-footer-nav button[data-tab="brief"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(rail).toBeHidden();
    await expect(satellite).toBeHidden();
    await expect(share).toBeHidden();
    await expect(reset).toBeHidden();
    await share.evaluate((button) => (button as HTMLButtonElement).focus());
    await expect(share).not.toBeFocused();
    await page.locator('#mobile-footer-nav button[data-tab="brief"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(rail).toBeVisible();
    await expect(satellite).toBeVisible();
    await expect(share).toBeVisible();
    await expect(reset).toBeVisible();
  });

  test('reduced motion removes presentational transitions from the mobile chrome', async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoApp(page);
    for (const control of [
      page.locator('#share-btn'),
      page.locator('#reset-btn'),
      page.locator('#hazard-rail .hazard-rail-btn').first(),
      page.locator('.basemap-switcher-btn'),
      page.locator('#map-info-btn')
    ]) {
      await expect(control).toBeVisible();
      const durations = await control.evaluate((element) =>
        getComputedStyle(element).transitionDuration
          .split(',')
          .map((duration) => duration.trim())
      );
      expect(durations.every((duration) => duration === '0s')).toBe(true);
    }
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
