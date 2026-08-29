import { expect, test, type Page } from '@playwright/test';

import { gotoApp, search, waitForLayerSettled } from './helpers';

const PLACE_ROOT = '#place-studio-root';
const EMPTY_COLLECTION = JSON.stringify({ type: 'FeatureCollection', features: [] });

async function stubLocalMapLayers(page: Page): Promise<void> {
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { STUSPS: 'OR', STATEFP: '41', NAME: 'Oregon' },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-124, 42],
                [-117, 42],
                [-117, 46],
                [-124, 46],
                [-124, 42]
              ]]
            }
          }
        ]
      })
    })
  );
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 47 }] })
    })
  );
  await page.route('**/US_Drought_Monitor/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
}

async function stubWildfireRecipe(page: Page): Promise<void> {
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('**/NOAA_Satellite_Smoke_Detection*/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
}

test.describe('PS-MAP clean-selection display', () => {
  test.beforeEach(async ({ page }) => {
    await stubLocalMapLayers(page);
    await stubWildfireRecipe(page);
  });

  test('sets aside conditions and events, switches reference types, and restores intent', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places,usdm,nifc-fires,states');

    await expect(page.locator('#layer-toggle-usdm')).toBeChecked();
    await expect(page.locator('#layer-toggle-nifc-fires')).toBeChecked();
    await expect(page.locator('#layer-toggle-hms-smoke')).not.toBeChecked();
    await page.locator('#place-studio-entry').click();
    await expect(page.locator(PLACE_ROOT)).toBeVisible();

    await expect(page.locator('#layer-toggle-usdm')).not.toBeChecked();
    await expect(page.locator('#layer-toggle-nifc-fires')).not.toBeChecked();
    await expect(page.locator('#layer-toggle-places')).toBeChecked();
    await expect(page.locator('#layer-toggle-states')).toBeChecked();
    await expect(page.locator('#layer-toggle-aiannh')).toBeChecked();
    await expect(page.locator('#layer-toggle-bia-reservations')).toBeChecked();

    await page.locator('#place-type-ecoregion').click();
    await expect(page.locator('#layer-toggle-ecoregions')).toBeChecked();
    await expect(page.locator('#layer-toggle-aiannh')).not.toBeChecked();
    await expect(page.locator('#layer-toggle-bia-reservations')).not.toBeChecked();

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page.locator('#layer-toggle-usdm')).toBeChecked();
    await expect(page.locator('#layer-toggle-nifc-fires')).toBeChecked();
    await expect(page.locator('#layer-toggle-places')).toBeChecked();
    await expect(page.locator('#layer-toggle-states')).toBeChecked();
    await expect(page.locator('#layer-toggle-ecoregions')).not.toBeChecked();
    await expect(page.locator('#layer-toggle-aiannh')).not.toBeChecked();
    await expect(page.locator('#layer-toggle-bia-reservations')).not.toBeChecked();
  });

  test('a direct studio URL keeps only its own session snapshot', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=usdm,places&studio=place');
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await expect(page.locator('#layer-toggle-usdm')).not.toBeChecked();

    const params = new URLSearchParams(await search(page));
    expect(params.get('studio')).toBe('place');
    expect(params.get('layers') ?? '').not.toContain('usdm');
    expect(params.has('place')).toBe(false);
    expect(params.has('typed-place')).toBe(false);
  });

  test('Back restores a clean cluster claim after temporary controller changes', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&cluster=wildfire');
    await waitForLayerSettled(page, 'nifc-fires');
    await waitForLayerSettled(page, 'hms-smoke');
    const priorUrl = await page.evaluate(
      () => `${window.location.pathname}${window.location.search}${window.location.hash}`
    );
    await page.locator('#place-studio-entry').click();
    await expect(page.locator(PLACE_ROOT)).toBeVisible();

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await waitForLayerSettled(page, 'nifc-fires');
    await waitForLayerSettled(page, 'hms-smoke');
    expect(
      await page.evaluate(
        () => `${window.location.pathname}${window.location.search}${window.location.hash}`
      )
    ).toBe(priorUrl);
    const params = new URLSearchParams(await search(page));
    expect(params.get('cluster')).toBe('wildfire');
    expect(params.has('layers')).toBe(false);
  });

  test('selecting a Level IV ecoregion keeps typed selection out of the URL', async ({
    page
  }) => {
    // The ecoregion list is the BUNDLED bake-derived manifest (swarm fix
    // F2, findings R2 H5 / R4 M7); the live EPA stub this spec used to
    // carry is gone because no runtime query determines membership. 4a is
    // a real Level IV member of the shipped Region 10 bake.
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-ecoregion').click();
    await page.locator('#place-studio-search').fill('Western Cascades Lowlands');
    await page
      .locator('[data-place-kind="ecoregion"][data-place-id="4a"]')
      .click();

    await expect(page.locator('#place-selection-title')).toHaveText(
      'Western Cascades Lowlands and Valleys'
    );
    const params = new URLSearchParams(await search(page));
    expect(params.get('studio')).toBe('place');
    expect(params.has('place')).toBe(false);
    expect(params.has('typed-place')).toBe(false);
  });
});
