import { expect, test, type Page } from '@playwright/test';
import type maplibregl from 'maplibre-gl';
import type { MultiPolygon, Polygon } from 'geojson';

import {
  clearStudioBoundary,
  showStudioBoundary
} from '../src/state/studio-boundary';
import { gotoApp } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

const PLACE_ROOT = '#place-studio-root';
const EMPTY_COLLECTION = JSON.stringify({
  type: 'FeatureCollection',
  features: []
});

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

const YAKIMA = rectangle(-121, 46, -120, 47);
const PACIFIC_NORTHWEST: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    rectangle(-124, 44, -116, 50).coordinates,
    rectangle(-130, 50, -129, 51).coordinates
  ]
};

interface CapturedWbdRequest {
  readonly layer: string;
  readonly params: URLSearchParams;
}

async function stubBriefingAndOverlapSources(page: Page): Promise<void> {
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
  // Both sovereign-boundary services answer the honest live-zero collection
  // so the overlap under test is the watershed one; the claim is recorded so
  // gotoApp's suite-wide fixture stub defers (tests/tribal-fixtures.ts).
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await page.route(
    '**/USEPA_Ecoregions_Level_III_and_IV/MapServer/*/query?*',
    (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('https://api.weather.gov/alerts/active?*', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' })
  );
}

async function stubWatersheds(
  page: Page,
  captured: CapturedWbdRequest[],
  holdYakimaSelection = false
): Promise<void> {
  await page.route('**/wbd/MapServer/*/query?*', async (route) => {
    const url = new URL(route.request().url());
    const layer = url.pathname.split('/').at(-2) ?? '';
    const params = url.searchParams;
    captured.push({ layer, params });

    if (params.get('returnGeometry') === 'false') {
      const features =
        layer === '1'
          ? [{ attributes: { huc2: '17', name: 'Pacific Northwest' } }]
          : [{ attributes: { huc4: '1703', name: 'Yakima' } }];
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ features })
      });
      return;
    }

    const where = params.get('where');
    if (holdYakimaSelection && where === "huc4='1703'") {
      return;
    }

    const features =
      where === "huc2='17'"
        ? [
            {
              type: 'Feature',
              properties: { huc2: '17', name: 'Pacific Northwest' },
              geometry: PACIFIC_NORTHWEST
            }
          ]
        : where === "huc4='1703'"
          ? [
              {
                type: 'Feature',
                properties: { huc4: '1703', name: 'Yakima' },
                geometry: YAKIMA
              }
            ]
          : layer === '1'
            ? [
                {
                  type: 'Feature',
                  properties: { huc2: '17', name: 'Pacific Northwest' },
                  geometry: PACIFIC_NORTHWEST
                }
              ]
            : [
                {
                  type: 'Feature',
                  properties: { huc4: '1703', name: 'Yakima' },
                  geometry: YAKIMA
                }
              ];
    await route.fulfill({
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features })
    });
  });
}

async function openWatersheds(page: Page): Promise<void> {
  await gotoApp(page, '?view=brief&layers=places&studio=place');
  await page.locator('#place-type-watershed').click();
  await expect(page.locator('#place-list .place-studio-option')).toHaveCount(2);
}

test.describe('PS-WATER provider and studio wiring', () => {
  test.beforeEach(async ({ page }) => {
    await stubBriefingAndOverlapSources(page);
  });

  test('keeps catalogs attribute-only and generalizes selected and bbox candidate geometry', async ({
    page
  }) => {
    const captured: CapturedWbdRequest[] = [];
    await stubWatersheds(page, captured);
    await openWatersheds(page);

    const catalogRequests = captured.filter(
      (request) => request.params.get('returnGeometry') === 'false'
    );
    expect(catalogRequests).toHaveLength(2);
    for (const request of catalogRequests) {
      expect(request.params.has('maxAllowableOffset')).toBe(false);
    }

    await page.locator('#place-studio-search').fill('Yakima');
    await page.locator('#place-list-panel .place-studio-option').click();
    await expect(
      page.locator('#place-brief-narrative .place-studio-selection-kind')
    ).toHaveText('Watershed (USGS Watershed Boundary Dataset)');
    await expect(page.locator('#place-capability-briefable')).toContainText('available');
    await expect(page.locator('#place-capability-overlap-computable')).toContainText(
      'available'
    );

    const watershedWithin = page.locator(
      '.place-overlap-column[aria-labelledby="place-overlap-within"] [data-overlap-kind="watershed"][data-overlap-id="17"]'
    );
    await expect(watershedWithin).toContainText('Pacific Northwest (HUC 17)');

    const geometryRequests = captured.filter(
      (request) => request.params.get('returnGeometry') === 'true'
    );
    expect(geometryRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of geometryRequests) {
      const offset = Number(request.params.get('maxAllowableOffset'));
      expect(Number.isFinite(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0.0001);
      expect(offset).toBeLessThanOrEqual(0.05);
      expect(request.params.get('outSR')).toBe('4326');
      expect(request.params.get('geometryPrecision')).toBe('6');
    }

    const selectionRequest = geometryRequests.find(
      (request) => request.params.get('where') === "huc4='1703'"
    );
    expect(selectionRequest).toBeDefined();
    expect(selectionRequest?.params.get('resultRecordCount')).toBe('1');
    expect(selectionRequest?.params.has('geometry')).toBe(false);

    const candidateRequests = geometryRequests.filter((request) =>
      request.params.has('geometry')
    );
    expect(candidateRequests.map((request) => request.layer).sort()).toEqual([
      '1',
      '2'
    ]);
    for (const request of candidateRequests) {
      expect(request.params.get('geometryType')).toBe('esriGeometryEnvelope');
      expect(request.params.get('spatialRel')).toBe('esriSpatialRelIntersects');
    }

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Yakima (HUC 1703)');
    await expect(panel.locator('.impact-panel-kind')).toHaveText(
      'Watershed (USGS Watershed Boundary Dataset)'
    );
  });

  test('aborts a superseded Polygon request and accepts a MultiPolygon selection', async ({
    page
  }) => {
    const captured: CapturedWbdRequest[] = [];
    let yakimaAborted = false;
    await stubWatersheds(page, captured, true);
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.searchParams.get('where') === "huc4='1703'") yakimaAborted = true;
    });
    await openWatersheds(page);

    await page.locator('#place-studio-search').fill('Yakima');
    const pendingYakima = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.searchParams.get('where') === "huc4='1703'";
    });
    await page.locator('#place-list-panel .place-studio-option').click();
    await pendingYakima;

    await page.locator('#place-studio-search').fill('Pacific Northwest');
    await page
      .locator('[data-place-kind="watershed"][data-place-id="17"]')
      .click();

    await expect.poll(() => yakimaAborted).toBe(true);
    await expect(page.locator('#place-selection-title')).toHaveText(
      'Pacific Northwest (HUC 17)'
    );
    await expect(
      page.locator('#place-brief-narrative .place-studio-selection-kind')
    ).toHaveText('Watershed (USGS Watershed Boundary Dataset)');
  });
});

test('the ephemeral emphasis surface shows, updates, and clears areal geometry', () => {
  const sources = new Map<
    string,
    { setData: (data: GeoJSON.GeoJSON) => void }
  >();
  const layers = new Map<string, maplibregl.LayerSpecification>();
  let latestData: GeoJSON.GeoJSON | null = null;
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      sources.set(id, {
        setData: (data: GeoJSON.GeoJSON) => {
          latestData = data;
        }
      });
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: maplibregl.LayerSpecification) => {
      layers.set(layer.id, layer);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    }
  } as unknown as maplibregl.Map;

  showStudioBoundary(map, YAKIMA);
  expect(sources.has('place-studio-boundary')).toBe(true);
  expect(layers.get('place-studio-boundary-fill')).toMatchObject({
    type: 'fill',
    paint: { 'fill-opacity': 0.1 }
  });
  expect(layers.get('place-studio-boundary-line')).toMatchObject({
    type: 'line',
    paint: { 'line-width': 2 }
  });

  showStudioBoundary(map, PACIFIC_NORTHWEST);
  expect(latestData).toMatchObject({
    type: 'Feature',
    geometry: { type: 'MultiPolygon' }
  });

  clearStudioBoundary(map);
  expect(sources.has('place-studio-boundary')).toBe(false);
  expect(layers.has('place-studio-boundary-fill')).toBe(false);
  expect(layers.has('place-studio-boundary-line')).toBe(false);
});
