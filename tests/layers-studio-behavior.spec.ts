import { expect, test, type Page } from '@playwright/test';

import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';
import { gotoApp, search, urlLayers } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeBoundary,
  routeGeojson,
  syntheticAiannhBody
} from './tribal-fixtures';
import { stubRecentSatellite } from './satellite-fixture';

const STUDIO = '#layers-studio-root';
const STATES_BODY = {
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
};

async function stubPlaces(page: Page): Promise<void> {
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 44 }] })
    })
  );
}

async function stubSatellite(page: Page): Promise<void> {
  await stubRecentSatellite(page);
}

test.describe('LAYERS studio behavior', () => {
  test('the six-label mapping is explicit by status key', () => {
    expect(STATUS_PILL_TEXT.loading).toBe('loading...');
    expect(STATUS_PILL_TEXT.ready).toBe('live');
    expect(STATUS_PILL_TEXT.degraded).toBe('live (partial)');
    expect(STATUS_PILL_TEXT.error).toBe('unavailable');
    expect(STATUS_PILL_TEXT['no-data']).toBe('no data (see data/README.md)');
    expect(STATUS_PILL_TEXT['zoom-in']).toBe('zoom in to load');
  });

  test('layer-scoped search activates a result and the controller round-trips it', async ({
    page
  }) => {
    await stubPlaces(page);
    await gotoApp(page, '?layers=&view=brief&studio=layers');
    let studio = page.locator(STUDIO);
    const input = studio.getByRole('combobox', { name: 'Search layers' });
    await expect(input).toBeVisible();
    await input.fill('City & Town Labels');

    const result = studio.locator('[data-search-kind="layer"][data-search-id="places"]');
    await expect(result).toBeVisible();
    await result.click();
    await expect(studio.locator('input[data-layer-key="places"]')).toBeChecked();
    await expect(studio.locator('[data-layer-status="places"]')).toHaveText('live');
    await expect.poll(async () => [...(await urlLayers(page))].sort()).toEqual(['places']);

    await page.reload({ waitUntil: 'domcontentloaded' });
    studio = page.locator(STUDIO);
    await expect(studio).toBeVisible();
    const placesToggle = studio.locator('input[data-layer-key="places"]');
    await expect(placesToggle).toBeChecked();
    await placesToggle.uncheck();
    await expect.poll(async () => [...(await urlLayers(page))]).toEqual([]);
    expect(new URLSearchParams(await search(page)).has('layers')).toBe(true);
  });

  test('the Tribal Nations command selects two members and Sources reports expansion', async ({
    page
  }) => {
    // The boundary pair answers the honest live-zero collection here: this
    // case is about the umbrella command and the Sources line, not about
    // boundary geometry.
    await gotoApp(page, '?layers=&view=brief&studio=layers', { boundaries: 'empty' });
    const studio = page.locator(STUDIO);
    const placeGroup = studio.getByRole('group', { name: 'Place · boundaries & rivers' });

    await placeGroup.getByRole('button', { name: 'Show Tribal Nations layers' }).click();
    await expect(placeGroup.locator('.layer-umbrella-count')).toHaveText('2 of 2 selected');
    await expect(placeGroup.locator('.layer-group-count')).toHaveText('2 on');
    await placeGroup.getByRole('button', { name: 'Layer details' }).click();
    await expect(placeGroup.locator('input[data-layer-key="aiannh"]')).toBeChecked();
    await expect(placeGroup.locator('input[data-layer-key="bia-reservations"]')).toBeChecked();
    await expect.poll(async () => [...(await urlLayers(page))].sort()).toEqual([
      'aiannh',
      'bia-reservations'
    ]);

    const sources = placeGroup.getByRole('button', { name: 'Sources', exact: true });
    await expect(sources).toHaveAttribute('aria-expanded', 'false');
    await sources.click();
    const hideSources = placeGroup.getByRole('button', { name: 'Hide sources', exact: true });
    await expect(hideSources).toHaveAttribute('aria-expanded', 'true');
    await expect(placeGroup.locator('[data-provenance="tribal-nations"]')).toBeVisible();
    await hideSources.click();
    await expect(sources).toHaveAttribute('aria-expanded', 'false');
  });

  test('the rehosted basemap control reflects pressed state and URL state', async ({ page }) => {
    await stubSatellite(page);
    await gotoApp(page, '?layers=&view=brief&studio=layers');
    let studio = page.locator(STUDIO);
    let satellite = studio.getByRole('button', { name: 'Satellite imagery' });
    await expect(satellite).toHaveAttribute('aria-pressed', 'true');
    await satellite.click();
    await expect(satellite).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('basemap'))
      .toBe('default');

    await page.reload({ waitUntil: 'domcontentloaded' });
    studio = page.locator(STUDIO);
    satellite = studio.getByRole('button', { name: 'Satellite imagery' });
    await expect(satellite).toHaveAttribute('aria-pressed', 'false');
    await satellite.click();
    await expect(satellite).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => new URLSearchParams(await search(page)).has('basemap'))
      .toBe(false);
  });

  test('all six canonical statuses render in studio pills and loading settles', async ({ page }) => {
    let releasePlaces!: () => void;
    const placesRelease = new Promise<void>((resolve) => {
      releasePlaces = resolve;
    });
    await page.route('**/data/us-places.json', async (route) => {
      await placesRelease;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 44 }] })
      });
    });
    await page.route('**/data/us-states.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(STATES_BODY)
      })
    );
    await page.route('**/data/tribal-lands.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(emptyCollectionBody())
      })
    );
    const partialAiannh = {
      ...syntheticAiannhBody(),
      exceededTransferLimit: true
    };
    await routeGeojson(page, AIANNH_ROUTE, partialAiannh);
    await routeBoundary(page, BIA_ROUTE, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 503, message: 'Synthetic unavailable' } })
      })
    );

    await gotoApp(
      page,
      '?layers=places,states,aiannh,bia-reservations,tribal,telemetry&view=brief&studio=layers'
    );
    const studio = page.locator(STUDIO);
    await studio.getByRole('button', { name: 'Layer details' }).click();
    const pill = (key: string) => studio.locator(`[data-layer-status="${key}"]`);

    await expect(pill('places')).toHaveText('loading...');
    await expect(pill('states')).toHaveText('live');
    await expect(pill('aiannh')).toHaveText('live (partial)');
    await expect(pill('bia-reservations')).toHaveText('unavailable');
    await expect(pill('tribal')).toHaveText('no data (see data/README.md)');
    await expect(pill('telemetry')).toHaveText('zoom in to load');

    releasePlaces();
    await expect(pill('places')).toHaveText('live');
    await expect(studio.locator('.layer-toggle-status.loading')).toHaveCount(0);
  });
});
