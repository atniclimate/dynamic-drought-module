import { expect, test, type Page } from '@playwright/test';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

import { createBriefingSkeleton } from '../src/impact/briefing';
import { selectBriefNarrativeLine } from '../src/impact/brief-narrative-selector';
import { caveatFor } from '../src/impact/context';
import { makeClaim } from '../src/impact/evidence';
import type { BoundarySelectionContext } from '../src/impact/types';
import { gotoApp, search } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeBoundary,
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

function mixedValidityGeometry(valid: Polygon): MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: [
      valid.coordinates,
      [[
        [-120, 46],
        [-119, 46],
        [-118, 46],
        [-120, 46]
      ]]
    ]
  };
}

const STATE_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { STUSPS: 'WA', STATEFP: '53', NAME: 'Washington' },
      geometry: rectangle(-123, 45, -117, 49)
    },
    {
      type: 'Feature',
      properties: { STUSPS: 'OR', STATEFP: '41', NAME: 'Oregon' },
      geometry: rectangle(-122, 46, -121, 47)
    }
  ]
};

async function stubStateGeometry(
  page: Page,
  includeOverlap = true
): Promise<void> {
  const collection = includeOverlap
    ? STATE_COLLECTION
    : {
        type: 'FeatureCollection',
        features: [STATE_COLLECTION.features[0]]
      };
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(collection)
    })
  );
}

async function stubBriefingSources(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { DM: 2 },
            geometry: null
          }
        ]
      })
    })
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

/**
 * The land-area representation id and the formal name it crosswalks to are
 * BOTH synthetic. The candidate is a fabricated rectangle in the Pacific
 * Northwest, so putting a real Tribal Nation's name on it would render, in a
 * retained screenshot or trace, a real Nation over an invented boundary in a
 * place it has no relationship to. Stubbing the bundled roster and crosswalk
 * beside the land-area response keeps the representation-id to formal-name
 * path under test with nothing real anywhere in it.
 */
const FIXTURE_LAR_NAME = 'Synthetic Brief Fixture Reservation';
const FIXTURE_NATION_NAME = 'Synthetic Brief Fixture Nation';

async function stubTribalCandidates(page: Page, withCandidate: boolean): Promise<void> {
  await page.route('**/data/tribal-roster.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        areas: [
          {
            larName: FIXTURE_LAR_NAME,
            displayName: FIXTURE_NATION_NAME,
            provenance: 'bia-authoritative'
          }
        ]
      })
    })
  );
  await page.route('**/data/tribal-larname-crosswalk.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meta: {
          rosterSource: 'Synthetic fixture roster',
          landAreaSource: 'Synthetic fixture land areas'
        },
        matched: [{ tribe: FIXTURE_NATION_NAME, larName: FIXTURE_LAR_NAME }],
        rosterNoLar: []
      })
    })
  );
  await routeBoundary(page, BIA_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: withCandidate
        ? JSON.stringify({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  LARID: 1,
                  LARNAME: FIXTURE_LAR_NAME,
                  CLASSIFICATION: 'Reservation'
                },
                geometry: rectangle(-120, 45, -114, 49)
              }
            ]
          })
        : EMPTY_COLLECTION
    })
  );
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
}

async function stubEcoregionCandidates(page: Page, withCandidates: boolean): Promise<void> {
  await page.route(
    '**/USEPA_Ecoregions_Level_III_and_IV/MapServer/*/query?*',
    (route) => {
      const layer = new URL(route.request().url()).pathname.split('/').at(-2);
      const features = !withCandidates
        ? []
        : layer === '11'
          ? [
              {
                type: 'Feature',
                properties: { US_L3CODE: 'outer', US_L3NAME: 'Outer Ecoregion' },
                geometry: rectangle(-124, 44, -116, 50)
              }
            ]
          : [
              {
                type: 'Feature',
                properties: {
                  US_L4CODE: 'partial',
                  US_L4NAME: 'Partial Ecoregion',
                  US_L3CODE: 'outer',
                  US_L3NAME: 'Outer Ecoregion'
                },
                geometry: rectangle(-120, 45, -114, 49)
              },
              {
                type: 'Feature',
                properties: {
                  US_L4CODE: 'sliver',
                  US_L4NAME: 'Edge Ecoregion',
                  US_L3CODE: 'outer',
                  US_L3NAME: 'Outer Ecoregion'
                },
                geometry: rectangle(-117.06, 45, -111.06, 49)
              }
            ];
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features })
      });
    }
  );
}

async function stubWatershedCandidates(page: Page): Promise<void> {
  await page.route('**/wbd/MapServer/*/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: EMPTY_COLLECTION
    })
  );
}

async function selectWashington(page: Page): Promise<void> {
  await page.locator('#place-type-state').click();
  await page.locator('#place-studio-search').fill('Washington');
  const stateList = page.locator('#place-list-panel');
  await stateList.locator('.place-studio-option').click();
  await expect(page.locator('#place-selection-title')).toHaveText('Washington');
}

test.describe('PS-BRIEF pure narrative selector', () => {
  test('selects only the first current briefing claim', () => {
    const context: BoundarySelectionContext = {
      kind: 'state',
      title: 'Washington',
      properties: { STUSPS: 'WA' },
      lngLat: { lng: -120.5, lat: 47.5 },
      regionKey: null
    };
    const briefing = createBriefingSkeleton(context);
    expect(selectBriefNarrativeLine(briefing)).toBeNull();

    briefing.horizons.current.claims = [
      makeClaim({
        text: 'Existing selected-place line.',
        source: 'Existing source',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' }
      }),
      makeClaim({
        text: 'Later current claim.',
        source: 'Existing source',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' }
      })
    ];
    expect(selectBriefNarrativeLine(briefing)).toBe(
      'Existing selected-place line.'
    );
  });
});

test.describe('PS-BRIEF PLACE studio rendering', () => {
  test.beforeEach(async ({ page }) => {
    await stubStateGeometry(page);
    await stubBriefingSources(page);
    await stubWatershedCandidates(page);
  });

  test('renders the selected narrative, overlap columns, suppression, unavailable pair, and Tribal caveat', async ({
    page
  }) => {
    await stubTribalCandidates(page, true);
    await stubEcoregionCandidates(page, true);
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await selectWashington(page);

    const narrative = page.locator('#place-brief-narrative');
    await expect(narrative.locator('.place-studio-selection-kind')).toHaveText(
      'State (Census cartographic boundary)'
    );
    await expect(narrative.locator('#place-selection-title')).toHaveText(
      'Washington'
    );
    await expect(narrative.locator('#place-brief-line')).toHaveText(
      "This location is in D2 Severe Drought as of this week's U.S. Drought Monitor. Crop or pasture losses are likely; water shortages are common and restrictions are imposed."
    );

    const columns = page.locator('#place-overlap-columns');
    await expect(columns.locator('.place-overlap-column > h6')).toHaveText([
      'Within',
      'Contains',
      'Overlaps'
    ]);
    await expect(
      columns.locator(
        '.place-overlap-column[aria-labelledby="place-overlap-within"]'
      )
    ).toContainText('Outer Ecoregion');
    await expect(
      columns.locator(
        '.place-overlap-column[aria-labelledby="place-overlap-contains"]'
      )
    ).toContainText('Oregon');

    const overlapColumn = columns.locator(
      '.place-overlap-column[aria-labelledby="place-overlap-overlaps"]'
    );
    await expect(overlapColumn).toContainText('Partial Ecoregion');
    const tribalRow = overlapColumn.locator('[data-overlap-kind="tribe"]');
    await expect(tribalRow).toHaveCount(1);
    await expect(tribalRow).toContainText(FIXTURE_NATION_NAME);
    await expect(tribalRow.locator('.place-overlap-tribal-caveat')).toHaveText(
      caveatFor('bia-reservation')
    );

    await expect(columns.locator('#place-overlap-suppression')).toHaveText(
      'Edge overlaps omitted.'
    );
    await expect(
      columns.locator('[data-overlap-unavailable-kind="watershed"]')
    ).toHaveCount(0);
  });

  test('renders the exact empty result when supported pairs have no rows', async ({
    page
  }) => {
    await page.unroute('**/data/us-states.geojson');
    await stubStateGeometry(page, false);
    await stubTribalCandidates(page, false);
    await stubEcoregionCandidates(page, false);
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await selectWashington(page);

    const columns = page.locator('#place-overlap-columns');
    await expect(columns.locator('#place-overlap-empty')).toHaveText(
      'No overlapping places listed.'
    );
  });

  test('keeps declared watershed capabilities available when a geometry request fails', async ({
    page
  }) => {
    await stubTribalCandidates(page, false);
    await stubEcoregionCandidates(page, false);
    await page.route('**/wbd/MapServer/*/query?*', (route) => {
      const layer = new URL(route.request().url()).pathname.split('/').at(-2);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          features: [
            {
              attributes:
                layer === '1'
                  ? { huc2: '17', name: 'Pacific Northwest' }
                  : { huc4: '1703', name: 'Yakima' }
            }
          ]
        })
      });
    });
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-watershed').click();
    await page.locator('#place-studio-search').fill('Yakima');
    await page.locator('#place-list-panel .place-studio-option').click();

    await expect(page.locator('#place-capability-briefable')).toContainText('available');
    await expect(page.locator('#place-capability-overlap-computable')).toContainText(
      'available'
    );

    const unavailablePairs = page.locator(
      '#place-overlap-columns [data-overlap-unavailable-kind]'
    );
    await expect(unavailablePairs).toHaveCount(4);
    await expect(unavailablePairs.locator('p')).toHaveText([
      'Overlap listing is not available for this pair yet.',
      'Overlap listing is not available for this pair yet.',
      'Overlap listing is not available for this pair yet.',
      'Overlap listing is not available for this pair yet.'
    ]);
  });

  test('renders a rejected candidate as unavailable without a repaired row', async ({
    page
  }) => {
    await page.unroute('**/data/us-states.geojson');
    const collection: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        STATE_COLLECTION.features[0]!,
        {
          ...STATE_COLLECTION.features[1]!,
          geometry: mixedValidityGeometry(rectangle(-122, 46, -121, 47))
        }
      ]
    };
    await page.route('**/data/us-states.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(collection)
      })
    );
    await stubTribalCandidates(page, false);
    await stubEcoregionCandidates(page, false);
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await selectWashington(page);

    const columns = page.locator('#place-overlap-columns');
    const rejected = columns.locator(
      '[data-overlap-rejected-candidate][data-overlap-id="OR"]'
    );
    await expect(rejected).toContainText('Oregon');
    await expect(rejected.locator('p')).toHaveText(
      'Overlap listing is not available for this pair yet.'
    );
    await expect(
      columns.locator('[data-overlap-id="OR"]:not([data-overlap-rejected-candidate])')
    ).toHaveCount(0);
  });

  test('renders a rejected selection as a wholly unavailable overlap section', async ({
    page
  }) => {
    await page.unroute('**/data/us-states.geojson');
    const collection: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          ...STATE_COLLECTION.features[0]!,
          geometry: mixedValidityGeometry(rectangle(-123, 45, -117, 49))
        },
        STATE_COLLECTION.features[1]!
      ]
    };
    await page.route('**/data/us-states.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(collection)
      })
    );
    await stubTribalCandidates(page, false);
    await stubEcoregionCandidates(page, false);
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await selectWashington(page);

    const columns = page.locator('#place-overlap-columns');
    await expect(columns.locator('#place-overlap-status')).toHaveText(
      'Overlap listing is not available for this pair yet.'
    );
    await expect(columns.locator('.place-overlap-grid')).toHaveCount(0);
    await expect(columns.locator('[data-overlap-rejected-candidate]')).toHaveCount(0);
  });
});

test.describe('PS-BRIEF return hand-off', () => {
  test.beforeEach(async ({ page }) => {
    await stubStateGeometry(page);
    await stubBriefingSources(page);
    await stubTribalCandidates(page, false);
    await stubEcoregionCandidates(page, false);
    await stubWatershedCandidates(page);
  });

  test('Back restores the map and opens the existing briefing after selection', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await selectWashington(page);
    await page.locator('#place-studio-back').click();

    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Washington');
    await expect(panel.locator('.impact-panel-kind')).toHaveText(
      'State (Census cartographic boundary)'
    );
    expect(new URLSearchParams(await search(page)).has('studio')).toBe(false);
  });

  test('Back runs a select command only after an unselected PLACE route closes', async ({
    page
  }) => {
    await gotoApp(
      page,
      '?view=brief&layers=places&studio=place&select=state:OR'
    );
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    await page.locator('#place-studio-back').click();

    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
  });

  test('the PLACE return hand-off drops a held select in favor of its selection', async ({
    page
  }) => {
    await gotoApp(
      page,
      '?view=brief&layers=places&studio=place&select=state:OR'
    );
    await expect(page.locator('#impact-panel')).toHaveCount(0);
    await selectWashington(page);
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    await page.locator('#place-studio-back').click();

    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Washington');
  });

  test('Back briefs nothing when no place was explicitly selected', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-studio-back').click();

    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page.locator('#impact-panel')).toHaveCount(0);
  });
});

test('embed mode keeps the PLACE studio out of frame', async ({ page }) => {
  await gotoApp(page, '?embed=true&view=brief&layers=places&studio=place');
  await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
  const link = page.locator('#studio-linkout-pair #place-studio-entry');
  await expect(link).toHaveText('Open place selection on the full site');
  await expect(link).toHaveAttribute('target', '_blank');
});
