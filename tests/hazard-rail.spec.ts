import { test, expect, type Page } from './offline-test';
import { gotoApp, search, urlLayers, waitForLayerSettled } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

/**
 * The mobile quick-view spine and the footer doors. Four labelled hazard
 * cells occupy the lower-right thumb zone, and the one authoritative
 * Satellite control leads the view tools in the same right-edge column.
 *
 * Contract under test:
 * - The rail answers on the map, sits inert under an open window (owner,
 *   2026-11-13: every window is full screen) and stays absent on desktop
 *   and in embed
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

  test('the map-first boot shows four labelled hazard cells in a column and Satellite in the view tools', async ({
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

    // Each cell in the phone's right-edge column shows one short word, and that word
    // leads its accessible name (WCAG 2.5.3).
    const hazardLabels = rail.locator('.hazard-rail-btn > .map-control-label');
    await expect(hazardLabels).toHaveText(['ENSO', 'Fire', 'Drought', 'Heat']);
    for (let i = 0; i < 4; i += 1) {
      const label = hazardLabels.nth(i);
      await expect(label).toBeVisible();
      expect(await label.evaluate((n) => getComputedStyle(n).position)).toBe('static');
      const lb = (await label.boundingBox())!;
      const cb = (await buttons.nth(i).boundingBox())!;
      expect(lb.width).toBeGreaterThan(1);
      expect(lb.height).toBeGreaterThan(1);
      expect(lb.x).toBeGreaterThanOrEqual(cb.x);
      expect(lb.x + lb.width).toBeLessThanOrEqual(cb.x + cb.width);
    }

    // The one Satellite control leads the view tools (order 10) in the same
    // column, outside the hazard rail. Its long word stays for assistive
    // technology; the cell draws the short word SAT, which leads its name.
    const satellite = page.locator('.basemap-switcher-btn');
    await expect(satellite).toHaveCount(1);
    await expect(satellite).toBeVisible();
    await expect(satellite).toHaveAccessibleName(/^SAT\b.*satellite imagery/i);
    await expect(page.locator('#hazard-rail .basemap-switcher-btn')).toHaveCount(0);
    await expect(page.locator('#edge-body-view > .basemap-switcher-control')).toHaveCount(1);
    await expect(page.locator('#edge-body-view > .basemap-switcher-control')).toHaveAttribute(
      'data-edge-order',
      '10'
    );
    await expect(satellite).toHaveAttribute('data-edge-word', 'SAT');
    await expect(buttons.nth(0)).toHaveAccessibleName(/^ENSO\b/);
    await expect(buttons.nth(1)).toHaveAccessibleName(/^Fire\b/);
    await expect(buttons.nth(2)).toHaveAccessibleName(/^Drought\b/);
    await expect(buttons.nth(3)).toHaveAccessibleName(/^Heat\b/);

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

  test('accessible names stand alone: no title duplicates them verbatim (W2-D7)', async ({
    page
  }) => {
    await gotoApp(page);

    // The four hazard-rail buttons carry aria-labels only; a title that
    // restates the accessible name verbatim is a redundant tooltip plus
    // double speech, not information.
    const buttons = page.locator('#hazard-rail .hazard-rail-btn');
    await expect(buttons).toHaveCount(4);
    for (const button of await buttons.all()) {
      expect(await button.getAttribute('title')).toBeNull();
      expect(((await button.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(0);
    }

    // The sidebar collapse/expand pair and the ATNI seal trigger follow
    // the same rule.
    for (const selector of ['#sidebar-collapse', '#sidebar-expand', '.brand-seal']) {
      const element = page.locator(selector);
      expect(await element.getAttribute('title'), selector).toBeNull();
      expect(
        ((await element.getAttribute('aria-label')) ?? '').length,
        selector
      ).toBeGreaterThan(0);
    }

    // Controls whose title ADDS information keep it (the spot-check's
    // counterexamples): Share and Reset describe their action targets.
    await expect(page.locator('#share-btn')).toHaveAttribute(
      'title',
      'The link restores region or framing, layers, mode and horizon, not the map position or an open briefing'
    );
    await expect(page.locator('#reset-btn')).toHaveAttribute(
      'title',
      'Return to the default view'
    );
  });

  test('tapping ENSO applies the shipped SST anomaly preset through shareable URL state', async ({
    page
  }) => {
    await gotoApp(page);
    await waitForLayerSettled(page, 'nadm-drought');

    const ensoBtn = page.locator('#hazard-rail button[data-preset="hazard-enso"]');
    await ensoBtn.click();

    // An entry into ENSO opens on its Season ahead outlook beside the SST.
    await expect
      .poll(async () => [...(await urlLayers(page))].sort())
      .toEqual(['aiannh', 'cpc-seasonal-precip', 'sst-anomaly']);
    await expect.poll(async () => new URLSearchParams(await search(page)).get('horizon')).toBe('season-ahead');
    await waitForLayerSettled(page, 'sst-anomaly');
    await waitForLayerSettled(page, 'cpc-seasonal-precip');
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

  test('an open window covers the rail and the map controls; Back to map returns them', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const rail = page.locator('#hazard-rail');
    const satellite = page.locator('.basemap-switcher-btn');
    const share = page.locator('#share-btn');
    const reset = page.locator('#reset-btn');
    const back = page.locator('#sheet-close');
    // Whether a control can take focus: false while it sits inert under an open window.
    const focusable = (locator: typeof share): Promise<boolean> =>
      locator.evaluate((button) => {
        (button as HTMLButtonElement).focus();
        return document.activeElement === button;
      });
    await expect(rail).toBeVisible();
    await expect(satellite).toBeVisible();
    await expect(share).toBeVisible();
    await expect(reset).toBeVisible();

    // Every window is full screen (owner, 2026-11-13): what it covers is
    // inert until the reader goes back to the map.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(back).toBeVisible();
    expect(await focusable(satellite)).toBe(false);
    expect(await focusable(share)).toBe(false);
    expect(await focusable(rail.locator('.hazard-rail-btn').first())).toBe(false);

    await back.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(rail).toBeVisible();
    await expect(satellite).toBeVisible();
    await expect(share).toBeVisible();
    await expect(reset).toBeVisible();
    expect(await focusable(satellite)).toBe(true);

    // Back on the map, a rail button applies its preset and the map answers.
    await page.locator('#hazard-rail button[data-preset="hazard-fire"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect
      .poll(async () => (await urlLayers(page)).has('spc-fire-weather'))
      .toBe(true);

    // The Brief door with no place chosen opens its window too, and the same
    // Back to map returns the controls.
    const briefDoor = page.locator('#mobile-footer-nav button[data-tab="brief"]');
    await briefDoor.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(app).toHaveAttribute('data-sheet-tab', 'brief');
    await expect(briefDoor).toHaveAttribute('aria-expanded', 'true');
    expect(await focusable(share)).toBe(false);
    await back.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(briefDoor).toHaveAttribute('aria-expanded', 'false');
    expect(await focusable(share)).toBe(true);
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
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
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

    // Back to map closes the window (it covers the doors).
    await page.locator('#sheet-close').click();
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
