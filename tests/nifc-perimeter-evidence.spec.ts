import { expect, test, type Page, type Route } from '@playwright/test';
import type { FeatureCollection } from 'geojson';

import { gotoApp } from './helpers';

/**
 * Selected-place NIFC mapped-perimeter evidence (browser contract).
 *
 * Pins the geometry-exact query and its honesty states end to end: the
 * request is a POST carrying `esriGeometryPolygon` rings (never the GET
 * envelope the Current-horizon claim uses), the rendered section reports
 * N greater than zero with its breakdown, a verified zero that is not an
 * all-clear, failure as unknown-never-zero, truncation as an at-least
 * lower bound in the live (partial) state, coexistence with the existing
 * envelope-based claim, and cancellation on reopen (a superseded query
 * never renders). Stubbing follows tests/place-studio-brief.spec.ts.
 */

const EMPTY_COLLECTION = JSON.stringify({
  type: 'FeatureCollection',
  features: []
});

function rectangle(
  west: number,
  south: number,
  east: number,
  north: number
): FeatureCollection['features'][number]['geometry'] {
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

function perimeterFeatures(types: readonly string[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: types.map((incidentType) => ({
      type: 'Feature',
      properties: { attr_IncidentTypeCategory: incidentType },
      geometry: null
    }))
  });
}

async function stubStates(page: Page): Promise<void> {
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(STATE_COLLECTION)
    })
  );
}

async function stubQuietBriefingSources(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { DM: 2 }, geometry: null }]
      })
    })
  );
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('https://mapservices.weather.noaa.gov/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' })
  );
}

/** True when this WFIGS request is the minimap's returnCountOnly POST. */
function isMinimapCountRequest(route: Route): boolean {
  return (route.request().postData() ?? '').includes('returnCountOnly=true');
}

/**
 * Split the one WFIGS endpoint by request shape: the minimap's count POST,
 * the Current-horizon GET envelope query, and the perimeter-evidence
 * polygon POST (handled by `onPolygonPost`).
 */
async function stubWfigs(
  page: Page,
  onPolygonPost: (route: Route) => Promise<void> | void
): Promise<void> {
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({
        contentType: 'application/geo+json',
        body: EMPTY_COLLECTION
      });
      return;
    }
    if (isMinimapCountRequest(route)) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ count: 0 })
      });
      return;
    }
    await onPolygonPost(route);
  });
}

const SECTION = '#impact-panel .perimeter-evidence';

test.describe('perimeter evidence rendering states', () => {
  test.beforeEach(async ({ page }) => {
    await stubStates(page);
    await stubQuietBriefingSources(page);
  });

  test('POSTs the boundary polygon and renders the breakdown beside the envelope claim', async ({
    page
  }) => {
    const polygonBodies: string[] = [];
    await stubWfigs(page, async (route) => {
      polygonBodies.push(route.request().postData() ?? '');
      await route.fulfill({
        contentType: 'application/geo+json',
        body: perimeterFeatures(['WF', 'CX', 'RX'])
      });
    });
    await gotoApp(page, '?select=state:WA');

    const section = page.locator(SECTION);
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.locator('.impact-claim-text')).toHaveText(
      '3 current mapped NIFC fire perimeters intersect Washington right now: 2 wildfire and 1 Prescribed fire perimeter.',
      { timeout: 15_000 }
    );
    await expect(section.locator('.perimeter-evidence-pill')).toHaveText('live');
    await expect(section.locator('.impact-claim-badge')).toHaveText('Observed');
    await expect(section.locator('.impact-claim-date')).toContainText('Retrieved');

    // The standing scope paragraph frames the section in every state.
    await expect(section.locator('.perimeter-evidence-scope')).toContainText(
      "Washington's own boundary shape"
    );
    await expect(section.locator('.perimeter-evidence-scope')).toContainText(
      'not a bounding rectangle'
    );
    await expect(section.locator('.perimeter-evidence-meta')).toContainText(
      'Queried '
    );
    await expect(section.locator('.perimeter-evidence-meta')).toContainText(
      'every 5 minutes'
    );

    // The request was a polygon POST, never the GET envelope shape.
    expect(polygonBodies.length).toBeGreaterThan(0);
    const params = new URLSearchParams(polygonBodies[0]!);
    expect(params.get('geometryType')).toBe('esriGeometryPolygon');
    expect(params.get('geometryType')).not.toBe('esriGeometryEnvelope');
    expect(params.get('spatialRel')).toBe('esriSpatialRelIntersects');
    expect(params.get('returnGeometry')).toBe('false');
    expect(params.get('resultRecordCount')).toBe('2000');
    expect(params.get('outFields')).toBe('attr_IncidentTypeCategory');
    expect(params.get('f')).toBe('geojson');
    const geometry = JSON.parse(params.get('geometry') ?? '{}') as {
      rings?: number[][][];
      spatialReference?: { wkid?: number };
    };
    expect(Array.isArray(geometry.rings)).toBe(true);
    expect(geometry.rings!.length).toBeGreaterThan(0);
    expect(geometry.spatialReference?.wkid).toBe(4326);

    // Coexistence: the envelope-based Current-horizon claim (stubbed empty
    // via GET) renders its own zero sentence while the geometry-exact
    // section reports three, and neither assertion collides.
    const horizonClaim = page.locator(
      '#impact-panel .impact-horizon .impact-claim',
      { hasText: 'No current mapped NIFC fire perimeters intersect this area.' }
    );
    await expect(horizonClaim.first()).toBeVisible({ timeout: 15_000 });
    await expect(section).not.toContainText(
      'No current mapped NIFC fire perimeters intersect this area.'
    );
  });

  test('renders a verified zero that is never an all-clear', async ({ page }) => {
    await stubWfigs(page, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: EMPTY_COLLECTION
      })
    );
    await gotoApp(page, '?select=state:WA');

    const section = page.locator(SECTION);
    await expect(section.locator('.impact-claim-text')).toHaveText(
      'No current mapped NIFC fire perimeters intersect Washington right now. This is a verified zero for mapped perimeters, not an all-clear: an active incident without a mapped perimeter yet would not appear in this count.',
      { timeout: 15_000 }
    );
    await expect(section.locator('.perimeter-evidence-pill')).toHaveText('live');
  });

  test('renders unknown, never zero, when the query fails', async ({ page }) => {
    await stubWfigs(page, (route) =>
      route.fulfill({ status: 500, body: 'upstream failure' })
    );
    await gotoApp(page, '?select=state:WA');

    const section = page.locator(SECTION);
    await expect(section).toContainText(
      "The NIFC current-perimeters service did not respond to the query against Washington's boundary.",
      { timeout: 15_000 }
    );
    await expect(section).toContainText(
      'Whether a mapped perimeter intersects this place is unknown right now.'
    );
    await expect(section.locator('.perimeter-evidence-pill')).toHaveText(
      'unavailable'
    );
    await expect(section).not.toContainText('verified zero');
    await expect(section.locator('.impact-claim')).toHaveCount(0);
    // The scope paragraph still stands in the failure state.
    await expect(section.locator('.perimeter-evidence-scope')).toContainText(
      'mapped fire perimeters only'
    );
  });

  test('reports a truncated result as an at-least lower bound in live (partial)', async ({
    page
  }) => {
    await stubWfigs(page, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          exceededTransferLimit: true,
          features: ['WF', 'WF', 'WF', 'RX', 'WF'].map((incidentType) => ({
            type: 'Feature',
            properties: { attr_IncidentTypeCategory: incidentType },
            geometry: null
          }))
        })
      })
    );
    await gotoApp(page, '?select=state:WA');

    const section = page.locator(SECTION);
    await expect(section.locator('.impact-claim-text')).toHaveText(
      "At least 5 current mapped NIFC fire perimeters intersect Washington right now (the query reached the service's 2,000-record result limit, so the true count may be higher).",
      { timeout: 15_000 }
    );
    await expect(section.locator('.perimeter-evidence-pill')).toHaveText(
      'live (partial)'
    );
  });
});

test.describe('perimeter evidence cancellation', () => {
  test('a superseded selection query never renders into the reopened panel', async ({
    page
  }) => {
    await stubStates(page);
    await stubQuietBriefingSources(page);
    // Stub the studio's candidate services quiet (the place-studio-brief
    // idiom) so overlap listing never blocks selection.
    await page.route('**/BIA_AIAN_National_LAR/FeatureServer/0/query?*', (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
    );
    await page.route('**/AIANNHA/MapServer/47/query?*', (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
    );
    await page.route(
      '**/USEPA_Ecoregions_Level_III_and_IV/MapServer/*/query?*',
      (route) =>
        route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
    );
    await page.route('**/wbd/MapServer/*/query?*', (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
    );

    // Washington's polygon POST (its rectangle carries longitude -123) is
    // delayed past the reopen; Oregon's answers immediately with zero.
    await stubWfigs(page, async (route) => {
      const body = route.request().postData() ?? '';
      if (decodeURIComponent(body).includes('-123')) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route
          .fulfill({
            contentType: 'application/geo+json',
            body: perimeterFeatures(['WF', 'WF', 'WF', 'WF', 'WF', 'WF', 'WF'])
          })
          .catch(() => undefined);
        return;
      }
      await route.fulfill({
        contentType: 'application/geo+json',
        body: EMPTY_COLLECTION
      });
    });

    await gotoApp(page, '?view=brief&layers=places&studio=place');

    // First selection: Washington. Back opens its briefing; the perimeter
    // query is now in flight and will stay pending past the reopen.
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Washington');
    await page.locator('#place-list-panel .place-studio-option').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Washington');
    await page.locator('#place-studio-back').click();
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Washington');

    // Reopen for Oregon before Washington's delayed response lands.
    await page.locator('#place-studio-entry').click();
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Oregon');
    await page.locator('#place-list-panel .place-studio-option').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Oregon');
    await page.locator('#place-studio-back').click();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');

    const section = page.locator(SECTION);
    await expect(section.locator('.impact-claim-text')).toHaveText(
      'No current mapped NIFC fire perimeters intersect Oregon right now. This is a verified zero for mapped perimeters, not an all-clear: an active incident without a mapped perimeter yet would not appear in this count.',
      { timeout: 15_000 }
    );

    // Let Washington's delayed response land; the superseded query must
    // never render (the cancellation invariant).
    await page.waitForTimeout(2200);
    await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
    await expect(section.locator('.impact-claim-text')).toHaveText(
      'No current mapped NIFC fire perimeters intersect Oregon right now. This is a verified zero for mapped perimeters, not an all-clear: an active incident without a mapped perimeter yet would not appear in this count.'
    );
    await expect(section).not.toContainText('7 current mapped');
    await expect(page.locator(SECTION)).toHaveCount(1);
  });
});
