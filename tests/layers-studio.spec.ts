import { test, expect, type Page } from './offline-test';

import { TRIBAL_NATIONS_PROVENANCE_NOTE } from '../src/config/provenance';
import { parseStudioParam } from '../src/state/url';
import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';
import { gotoApp, layerPill, PILL, ROLE_GROUPS, search, urlLayers } from './helpers';

const STUDIO = '#layers-studio-root';

async function stubPlaces(page: Page): Promise<void> {
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 47 }] })
    })
  );
}

test.describe('minimal LAYERS studio', () => {
  test.beforeEach(async ({ page }) => {
    await stubPlaces(page);
  });

  test('the route token and six status labels stay canonical', () => {
    expect(parseStudioParam('layers')).toBe('layers');
    expect(parseStudioParam('place')).toBe('place');
    expect(parseStudioParam(null)).toBeNull();
    expect(STATUS_PILL_TEXT.loading).toBe('loading...');
    expect(STATUS_PILL_TEXT.ready).toBe('live');
    expect(STATUS_PILL_TEXT.degraded).toBe('live (partial)');
    expect(STATUS_PILL_TEXT.error).toBe('unavailable');
    expect(STATUS_PILL_TEXT['no-data']).toBe('no data (see data/README.md)');
    expect(STATUS_PILL_TEXT['zoom-in']).toBe('zoom in to load');
  });

  test('entry pushes once and Back to map keeps the changed display snapshot', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=places');
    const beforeLength = await page.evaluate(() => window.history.length);

    const entry = page.locator('#layers-studio-entry');
    await expect(entry).toHaveText('LAYERS');
    await expect(entry).toHaveAttribute(
      'aria-label',
      'Open the LAYERS studio: layer search, toggles, and sources'
    );
    await entry.click();

    await expect(page.locator(STUDIO)).toBeVisible();
    await expect(page.locator('#layers-studio-heading')).toHaveText('Layer studio');
    expect(await page.evaluate(() => window.history.length)).toBe(beforeLength + 1);
    expect(new URLSearchParams(await search(page)).get('studio')).toBe('layers');

    const studioPlaces = page.locator(
      `${STUDIO} input[data-layer-key="places"]`
    );
    await expect(studioPlaces).toBeChecked();
    await studioPlaces.uncheck();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(false);

    await page.locator(STUDIO).getByRole('button', { name: 'Back to map' }).click();
    await expect(page.locator(STUDIO)).toHaveCount(0);
    expect(new URLSearchParams(await search(page)).has('studio')).toBe(false);
    expect((await urlLayers(page)).has('places')).toBe(false);
  });

  test('browser Back performs the same single-step return', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('#layers-studio-entry').click();
    await expect(page.locator(STUDIO)).toBeVisible();

    await page.goBack();

    await expect(page.locator(STUDIO)).toHaveCount(0);
    expect(new URLSearchParams(await search(page)).has('studio')).toBe(false);
    expect((await urlLayers(page)).has('places')).toBe(true);
  });

  test('a studio deep link rehosts the existing controls and provenance', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=places&studio=layers');
    const studio = page.locator(STUDIO);
    await expect(studio).toBeVisible();
    await expect(studio.locator('[data-ddm-search]')).toBeVisible();
    await expect(studio.locator('.layer-group')).toHaveCount(ROLE_GROUPS.length);
    await expect(studio.locator('#panel-telemetry')).toBeVisible();
    await expect(studio.locator('.basemap-switcher-btn')).toHaveText('SAT');

    const placeGroup = studio
      .locator('.layer-group')
      // The has-locator resolves RELATIVE to each candidate; anchoring it to
      // the studio root makes it unmatchable (conductor truing, F7 gate).
      .filter({ has: page.locator('input[data-layer-key="aiannh"]') });
    await placeGroup.locator('.layer-group-sources-toggle').click();
    await expect(studio.locator('[data-provenance="tribal-nations"]')).toHaveText(
      TRIBAL_NATIONS_PROVENANCE_NOTE
    );
  });

  test('studio search is scoped to the existing Layers vocabulary', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=places&studio=layers');
    const studio = page.locator(STUDIO);
    const input = studio.locator('[data-ddm-search]');
    await expect(input).toHaveAttribute('placeholder', 'Search layers');
    await expect(input).toHaveAttribute('aria-label', 'Search layers');

    await input.fill('Oregon');
    await expect(studio.locator('[data-search-kind="place"]')).toHaveCount(0);
    await expect(studio.locator('[data-search-kind="tribal"]')).toHaveCount(0);
    await expect(studio.locator('[data-search-group="tribal"]')).toHaveCount(0);

    await input.fill('Drought');
    await expect(studio.locator('[data-search-group="layer"]')).toBeVisible();
    await expect(studio.locator('[data-search-group="layer"] .ddm-search-group-title')).toHaveText(
      'Layers'
    );
    await expect(studio.locator('[data-search-kind="layer"]')).not.toHaveCount(0);
  });

  test('embed mode links to the full-site studio and never mounts it in-frame', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&view=brief&layers=places&studio=layers');
    await expect(page.locator(STUDIO)).toHaveCount(0);

    const link = page.getByRole('link', {
      name: 'Open layer controls on the full site'
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    const href = new URL((await link.getAttribute('href')) ?? '');
    expect(href.searchParams.get('studio')).toBe('layers');
    expect(href.searchParams.has('embed')).toBe(false);
    expect(href.searchParams.get('view')).toBe('brief');
    expect(href.searchParams.get('layers')).toBe('places');
  });

  test('the retired Brief door is gone and console links remain reachable', async ({ page }) => {
    await gotoApp(page, '?view=console&layers=places');
    await expect(page.locator('#brief-console-door')).toHaveCount(0);
    await expect(page.locator('#panel-layers')).toBeVisible();
    expect(new URLSearchParams(await search(page)).get('view')).toBe('console');
  });

  // found-013 (register key: found-013; D1 M18): a Water & Snow station
  // press used to fly the camera and open the station's popup UNDERNEATH
  // the full-screen studio overlay, so nothing visible happened. The
  // curated Ice Harbor Dam station renders without any live network (the
  // national default's viewport exceeds the discovery area cap, so
  // src/config/station-registry.ts's discoverStationsForViewport returns
  // "zoom-in" before issuing any fetch; the curated seed still renders).
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`a Water & Snow station press closes the studio and frames the station with its popup open (${reducedMotion})`, async ({
      page
    }) => {
      // deriveViewMode (src/state/view-mode.ts) sends a bare `layers=` URL to
      // CONSOLE, whose surface has no on-screen studio door (#layers-studio-entry
      // lives only in #brief-display, the Brief surface); an explicit
      // view=brief keeps the door visible, matching every other case in this
      // file that opens the studio by pressing it.
      await page.emulateMedia({ reducedMotion });
      await gotoApp(page, '?view=brief&layers=telemetry');
      await expect(layerPill(page, 'telemetry')).toHaveText(PILL.zoomIn);
      const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
      const initialMarker = await marker.elementHandle();
      expect(initialMarker).not.toBeNull();

      await page.locator('#layers-studio-entry').click();
      await expect(page.locator(STUDIO)).toBeVisible();

      await page.locator('#telemetry-reveal').click();
      await page
        .locator('.telemetry-item', { hasText: 'Ice Harbor Dam' })
        .click();

      // The visible response: the studio is gone (never merely covered by
      // it), the station's own marker exists, and its popup is open and
      // named for the pressed station, not silent.
      await expect(page.locator(STUDIO)).toHaveCount(0);
      // The national boot skipped discovery. The destination now discovers
      // against the offline backstop, then reports live (partial). Check after
      // that refresh so a transient popup before marker replacement cannot pass.
      await expect(layerPill(page, 'telemetry')).toHaveText(PILL.degraded);
      await expect(marker).toHaveCount(1);
      expect(await initialMarker!.evaluate((element) => element.isConnected)).toBe(true);
      const popup = page.locator('.maplibregl-popup');
      await expect(popup).toBeVisible();
      await expect(popup.locator('.popup-title')).toHaveText('Ice Harbor Dam');
      await popup.getByRole('button', { name: 'Close popup' }).focus();
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await expect(page.locator('#map canvas.maplibregl-canvas')).toBeFocused();
    });
  }
});
