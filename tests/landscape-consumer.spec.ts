import { expect, test, type Page } from './offline-test';
import type { Polygon } from 'geojson';

import { gotoApp } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

function rectangle(
  west: number,
  south: number,
  east: number,
  north: number
): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south]
    ]]
  };
}

const EMPTY_COLLECTION = JSON.stringify({
  type: 'FeatureCollection',
  features: []
});

async function stubBriefingSources(page: Page): Promise<void> {
  // The weekly map's briefing reads get gotoApp's default empty collection (tests/usdm-fixtures.ts).
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
  await page.route('https://mapservices.weather.noaa.gov/**', (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' })
  );
  // The two sovereign-boundary services answer the honest live-zero
  // collection, so the briefing under test names no Tribal land area. These
  // go through routeGeojson so the claim is recorded and gotoApp's
  // suite-wide fixture stub defers to them (tests/tribal-fixtures.ts).
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await page.route('**/wbd/MapServer/*/query?*', (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
}

test('the full briefing renders dated ecoregion context and source vintages', async ({
  page
}) => {
  await stubBriefingSources(page);
  await page.route(
    '**/USEPA_Ecoregions_Level_III_and_IV/MapServer/*/query?*',
    (route) => {
      const url = new URL(route.request().url());
      const layer = url.pathname.split('/').at(-2);
      const exactLevel4 =
        layer === '7' &&
        (url.searchParams.get('where') ?? '').includes("US_L4CODE='4a'");
      return route.fulfill({
        contentType: 'application/geo+json',
        body: exactLevel4
          ? JSON.stringify({
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: {
                    US_L3CODE: '4',
                    US_L3NAME: 'Cascades',
                    US_L4CODE: '4a',
                    US_L4NAME: 'Western Cascades Lowlands and Valleys'
                  },
                  geometry: rectangle(-123, 44, -121, 46)
                }
              ]
            })
          : EMPTY_COLLECTION
      });
    }
  );

  await gotoApp(page, '?view=brief&layers=places&studio=place');
  await page.locator('#place-type-ecoregion').click();
  await page.locator('#place-studio-search').fill(
    'Western Cascades Lowlands and Valleys'
  );
  await page
    .locator('[data-place-kind="ecoregion"][data-place-id="4a"]')
    .click();
  await expect(page.locator('#place-selection-title')).toHaveText(
    'Western Cascades Lowlands and Valleys'
  );
  await page.locator('#place-studio-back').click();

  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible();
  const landscape = panel.locator('.impact-landscape');
  await expect(landscape).toContainText(
    'EPA Omernik Level IV Western Cascades Lowlands and Valleys (4a)'
  );
  await expect(landscape).toContainText(
    'Root-zone available water storage is 200 mm'
  );
  await expect(landscape).toContainText(
    'timber litter model 5 (TL5; issuer code 185)'
  );
  await expect(landscape).toContainText('Artifact dated 2026-07-24');
  await expect(landscape).toContainText('Vintage: FY2025');
  // Terrain, FBFM40 and the WHP DOI; the machine endpoints show as labels
  // (tests/landscape-source-links.test.mjs).
  await expect(landscape.locator('.impact-landscape-source a')).toHaveCount(3);
});
