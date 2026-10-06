import { expect, test, type Page } from './offline-test';
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
      regionKey: null,
      // Washington's own STUSPS: the honest containing answer for a state
      // boundary's own postal code (see `containingFromProperties`,
      // src/impact/context.ts).
      containing: { state: 'WA', basis: 'feature-property' },
      place: { scheme: 'state', code: 'WA' }
    };
    const briefing = createBriefingSkeleton(context);
    expect(selectBriefNarrativeLine(briefing)).toBeNull();

    briefing.horizons.current.claims = [
      makeClaim({
        text: 'Existing selected-place line.',
        source: 'Existing source',
        // Generic stand-in for an already-settled current-horizon claim, not
        // one real product; `usdm` is the current-horizon lane's own product
        // (DDM-P14-T05 microtask 2).
        product: 'usdm',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' }
      }),
      makeClaim({
        text: 'Later current claim.',
        source: 'Existing source',
        product: 'usdm',
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

/**
 * Before DR-169, a sidebar hazard click reached the studio's deferred
 * hand-off (src/ui/island/shell.tsx runDisplayCommand,
 * setPlaceStudioReturnDisplayCommand) while the Place studio stayed open,
 * and this describe pinned that the display command composed with the
 * return hand-off's briefing rather than replacing it (/code-review,
 * 2026-09-10: the exposed-sidebar fix, Codex finding 6,
 * tests/studio-restore.spec.ts, first wrote the click into the single slot
 * the studio uses for the selected place's briefing, so selecting
 * Washington and then clicking Wildfire landed on Wildfire with no
 * briefing; the two now live in separate slots composed at exit, display
 * command first, then briefing).
 *
 * DR-169 (ratified 2026-09-29, RATIFICATION-8) makes the whole #app,
 * sidebar included, inert while ANY studio is open
 * (src/ui/island/studio-inert.ts, applyStudioInertScope), so that click can
 * no longer arrive while the studio is open at all: the button stays
 * visible (the sidebar column is never covered) but is unreachable by any
 * real input until the studio closes. These two cases now pin that
 * unreachability (a forced click on the visible, inert button changes
 * nothing and the studio stays open) and then prove the return hand-off
 * still composes exactly as before once the studio is closed by hand: Back
 * opens the briefing the selection promised (unchanged, see "PS-BRIEF
 * return hand-off" above), and a plain click on Wildfire after that lands
 * on Wildfire without touching that briefing (no code path closes the
 * impact panel on a hazard-cluster change: src/state/cluster-service.ts's
 * requestCluster/applyCluster write only the hazard-cluster store;
 * src/ui/view-shell.ts's closeImpactPanel fires only on a switch to console
 * mode). With no selection, Back opens nothing (D-0.7.0-041) and the later
 * Wildfire click still briefs nothing.
 *
 * These cases boot on `layers=states`, NOT the file's usual `layers=places`.
 * City & Town Labels is a reference-role layer outside every cluster's
 * composition, so a hazard chosen over it commits DEMOTED by design
 * (src/state/cluster-service.ts applyCluster, handoff step 5): the recipe
 * applies, the extra survives, and the URL keeps the granular `layers=`
 * truth with no button pressed (D-0.7.0-044). That is what the same click
 * does outside any studio from the same boot (verified 2026-09-11), so it is
 * not the hand-off's doing and must not be what these cases assert against.
 * State Boundaries is default-on and inside the composition, so the commit
 * stays clean and `cluster=wildfire` is the honest claim.
 */
const COMPOSABLE_BOOT_LAYERS = 'states';

test.describe('PS-BRIEF return hand-off composes with a sidebar hazard closed by hand (DR-169)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await stubStateGeometry(page);
    await stubBriefingSources(page);
    await stubTribalCandidates(page, false);
    await stubEcoregionCandidates(page, false);
    await stubWatershedCandidates(page);
    // The Wildfire cluster's smoke layer must not reach the network.
    await page.route('**/NOAA_Satellite_Smoke_Detection*/**', (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
    );
  });

  test('a sidebar hazard chosen after a selection is inert while the studio is open, then lands on Wildfire with the briefing still open once the studio closes', async ({
    page
  }) => {
    await gotoApp(page, `?view=brief&layers=${COMPOSABLE_BOOT_LAYERS}&studio=place`);
    await selectWashington(page);

    const wildfire = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
    await expect(wildfire).toBeVisible();
    await expect(wildfire).toHaveAttribute('aria-pressed', 'false');

    // DR-169: the button stays on screen (the sidebar column is never
    // covered at this width) but the whole #app is now inert, so a real
    // click at its coordinates lands on nothing that can act on it; only a
    // forced click proves it changes nothing. Web-first: the studio applies
    // `inert` in an effect after its first render (see studio-restore.spec.ts).
    await expect(page.locator('#app')).toHaveJSProperty('inert', true);
    await wildfire.click({ force: true });
    await expect(wildfire).toHaveAttribute('aria-pressed', 'false');
    await expect(page).not.toHaveURL(/cluster=wildfire/);
    await expect(page.locator(PLACE_ROOT)).toBeVisible();

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    await expect(page).not.toHaveURL(/studio=place/);

    // The return hand-off, unchanged: Back opens the briefing the selection
    // promised.
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Washington');

    // With the sidebar live again, a plain click lands on Wildfire exactly
    // as it always has, and leaves the briefing exactly as it was: no code
    // path closes the impact panel on a hazard-cluster change.
    await wildfire.click();
    await expect(wildfire).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(page).toHaveURL(/cluster=wildfire/);
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Washington');
  });

  test('a sidebar hazard chosen with no selection is inert while the studio is open, then lands on Wildfire and briefs nothing once the studio closes', async ({
    page
  }) => {
    // The control: composing must not invent a briefing (D-0.7.0-041, never
    // an unsolicited briefing).
    await gotoApp(page, `?view=brief&layers=${COMPOSABLE_BOOT_LAYERS}&studio=place`);
    await expect(page.locator(PLACE_ROOT)).toBeVisible();

    const wildfire = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
    await expect(wildfire).toBeVisible();
    // Web-first: the studio applies `inert` in an effect after its first render.
    await expect(page.locator('#app')).toHaveJSProperty('inert', true);
    await wildfire.click({ force: true });
    await expect(wildfire).toHaveAttribute('aria-pressed', 'false');
    await expect(page).not.toHaveURL(/cluster=wildfire/);
    await expect(page.locator(PLACE_ROOT)).toBeVisible();

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    await wildfire.click();
    await expect(wildfire).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(page).toHaveURL(/cluster=wildfire/);
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
