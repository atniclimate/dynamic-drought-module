import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import type { Polygon } from 'geojson';

import { resolveLandscapeContext } from '../src/impact/landscape-consumer';
import { loadLandscapeSignature } from '../src/impact/landscape';
import {
  resolveLandscapeSelection,
  selectedLandscapeEcoregion,
  UNSUPPORTED_LANDSCAPE_SELECTION_NOTE
} from '../src/impact/landscape-resolution';
import type { BoundarySelectionContext } from '../src/impact/types';
import { gotoApp } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

const ARTIFACT = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../public/data/landscape-signature-pnw.json',
        import.meta.url
      )
    ),
    'utf8'
  )
) as unknown;

function context(
  kind: BoundarySelectionContext['kind'],
  properties: BoundarySelectionContext['properties']
): BoundarySelectionContext {
  return {
    kind,
    title: 'Selected place',
    properties,
    lngLat: { lng: -122, lat: 46 },
    regionKey: 'washington_state'
  };
}

function loadFixture(
  opts?: Parameters<typeof loadLandscapeSignature>[0]
) {
  return loadLandscapeSignature({
    ...opts,
    url: 'https://example.invalid/landscape.json',
    fetchJsonImpl: async () => ARTIFACT
  });
}

test.describe('T3-2 exact selected-place resolution', () => {
  test('resolves exact Level IV and Level III issuer codes only', () => {
    expect(
      selectedLandscapeEcoregion(
        context('ecoregion', {
          US_L3CODE: '4',
          US_L4CODE: '4a'
        })
      )
    ).toEqual({ level: 4, code: '4a' });
    expect(
      selectedLandscapeEcoregion(
        context('ecoregion', { US_L3CODE: '4' })
      )
    ).toEqual({ level: 3, code: '4' });
    expect(
      selectedLandscapeEcoregion(context('state', { STUSPS: 'WA' }))
    ).toBeNull();
    expect(
      selectedLandscapeEcoregion(context('bia-reservation', { LARID: '1' }))
    ).toBeNull();
    expect(
      selectedLandscapeEcoregion(context('watershed', { huc4: '1703' }))
    ).toBeNull();
    expect(resolveLandscapeSelection(context('state', { STUSPS: 'WA' }))).toEqual({
      ok: false,
      note: UNSUPPORTED_LANDSCAPE_SELECTION_NOTE
    });
  });

  test('pins the shipped Western Cascades Level IV fields and provenance', async () => {
    const result = await resolveLandscapeContext(
      { level: 4, code: '4a' },
      { load: loadFixture }
    );

    expect(result.status).toBe('ready');
    expect(result.ecoregion).toEqual({
      level: 4,
      code: '4a',
      name: 'Western Cascades Lowlands and Valleys'
    });
    expect(result.artifactDate).toBe('2026-07-24');
    expect(result.support).toContain(
      'summarizes the full EPA Omernik Level IV ecoregion'
    );
    expect(result.support).toContain('not current conditions or a point reading');
    expect(result.facts).toEqual([
      {
        key: 'terrain',
        label: 'Terrain',
        text:
          'Mean elevation is 641 m (3 to 1,551 m). Mean slope is 17.0 degrees. Terrain coverage is 100.0%.'
      },
      {
        key: 'soil',
        label: 'Soil water storage',
        text:
          'Root-zone available water storage is 200 mm; the within-ecoregion 10th to 90th percentile is 113 to 285 mm. Estimated root-zone depth is 132 cm. Dominant surface texture is Loam. Soil coverage is 97.9%.'
      },
      {
        key: 'landcover',
        label: 'Land cover',
        text:
          'Forest 67.0%; cropland 1.5%; wetland 0.3%; open water 1.0%. Land-cover coverage is 100.0%.'
      },
      {
        key: 'fuels',
        label: 'Surface fuels and long-term hazard potential',
        text:
          'The largest modeled surface-fuel share is timber litter model 5 (TL5; issuer code 185), at 48.1%. Wildfire Hazard Potential shares are Very Low 3.9%, Low 11.7%, Moderate 72.6%, High 7.6%, Very High 1.6%, non-burnable 1.4%, and water 1.2%. WHP coverage is 100.0%.',
        note:
          'Wildfire Hazard Potential is 270 m static landscape context, not a current condition or risk reading.'
      }
    ]);
    expect(result.sources.map((source) => source.key)).toEqual([
      'terrain',
      'soilMukey',
      'soilSda',
      'landcoverNlcd',
      'fuelsFbfm40',
      'hazardWhp'
    ]);
    expect(result.sources.every((source) => source.vintage.length > 0)).toBe(
      true
    );
  });

  test('reports honest absence for an unbundled ecoregion', async () => {
    const unbundled = await resolveLandscapeContext(
      { level: 4, code: 'not-shipped' },
      { load: loadFixture }
    );
    expect(unbundled.status).toBe('unavailable');
    expect(unbundled.note).toContain(
      'No valid Level IV landscape-signature bundle is available'
    );
  });
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

const EMPTY_COLLECTION = JSON.stringify({
  type: 'FeatureCollection',
  features: []
});

async function stubBriefingSources(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
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
  await expect(landscape.locator('.impact-landscape-source a')).toHaveCount(6);
});
