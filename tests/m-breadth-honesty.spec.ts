import { test, expect } from './offline-test';

import type { RegionKey } from '../src/config/regions';
import { placeRefFromBoundary } from '../src/config/entities';
import { postalCodeFromProperties } from '../src/config/geography';
import { URLS } from '../src/config/urls';
import {
  regionCapabilityLevel,
  regionCapabilityNote
} from '../src/config/region-capability';
import { createBriefingSkeleton } from '../src/impact/briefing';
import {
  buildResources,
  isStateCode,
  resolveStateCode
} from '../src/impact/resources';
import type { BoundarySelectionContext } from '../src/impact/types';
import { gotoApp } from './helpers';

/** Mirrors `containingFromProperties` (src/impact/context.ts): derived from
 * the literal's own properties only, never from `regionKey`. */
function containingFromProperties(
  properties: BoundarySelectionContext['properties']
): BoundarySelectionContext['containing'] {
  const code = postalCodeFromProperties(properties);
  return code !== null && isStateCode(code)
    ? { state: code, basis: 'feature-property' }
    : { state: null, basis: 'none' };
}

function selectionContext(
  regionKey: RegionKey | null,
  properties: Readonly<Record<string, unknown>> | null = null
): BoundarySelectionContext {
  return {
    kind: 'bia-reservation',
    title: 'Example place',
    properties,
    lngLat: { lng: -98, lat: 38 },
    regionKey,
    containing: containingFromProperties(properties),
    place: placeRefFromBoundary('bia-reservation', properties)
  };
}

function resourceUrls(context: BoundarySelectionContext): string[] {
  return buildResources(context)
    .map((resource) => resource.url)
    .filter((url): url is string => typeof url === 'string');
}

const NWS_PROXY_ROUTE = new RegExp(
  `^${URLS.workerProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy\\?url=${encodeURIComponent(
    `${URLS.nwsApi}/`
  )}`
);

function nwsUpstreamUrl(requestUrl: string): string {
  const upstream = new URL(requestUrl).searchParams.get('url');
  if (upstream === null || !upstream.startsWith(`${URLS.nwsApi}/`)) {
    throw new Error(`Expected a Worker-wrapped NWS URL, received ${requestUrl}`);
  }
  return upstream;
}

test.describe('M-BREADTH resource-routing honesty', () => {
  test('Canada and transboundary contexts do not fall through to Washington', () => {
    const canada = selectionContext('canada' as RegionKey);
    const transboundary = selectionContext('columbia_snake_basin');

    expect(resolveStateCode(canada)).toBeNull();
    expect(resolveStateCode(transboundary)).toBeNull();
    expect(resourceUrls(canada).join(' ')).not.toContain('/states/washington');
    expect(resourceUrls(transboundary).join(' ')).not.toContain('/states/washington');
  });

  test('the existing PNW route remains Washington-aware', () => {
    const washington = selectionContext('washington_state');
    expect(resolveStateCode(washington)).toBe('WA');
    expect(resourceUrls(washington)).toContain(
      'https://www.drought.gov/states/washington'
    );
  });

  test('an explicit state identity is not routed when the matrix lacks validation', () => {
    const kansasProperties = { STUSPS: 'KS', NAME: 'Kansas' };
    const kansas = {
      ...selectionContext('national'),
      kind: 'state' as const,
      properties: kansasProperties,
      containing: containingFromProperties(kansasProperties)
    };
    expect(resolveStateCode(kansas)).toBe('KS');
    expect(createBriefingSkeleton(kansas).resources).toEqual([]);
  });
});

for (const provenance of [
  { label: 'absent', regionKey: null },
  { label: 'unrecognized', regionKey: 'future-region' as RegionKey }
] as const) {
  test(`${provenance.label} provenance is unavailable through the runtime capability consumer`, () => {
    expect(
      regionCapabilityLevel(
        provenance.regionKey,
        'impactSynthesis'
      )
    ).toBe('none');
    expect(
      regionCapabilityNote(
        provenance.regionKey,
        'impactSynthesis'
      )
    ).toBe(
      'Drought impact analysis and resource routing are unavailable because this selection has no recognized coverage region.'
    );
    expect(
      createBriefingSkeleton(selectionContext(provenance.regionKey)).resources
    ).toEqual([]);
  });
}

// DR-256 (widening DR-096; this was the Kansas collapse case): a place outside
// the Northwest reads every source whose issuer covers it, cell by cell, with
// the Priority / Full detail switch; only the Northwest-curated resources and
// the NWRFC water-supply domain keep their data limits.
test('a place outside the Northwest reads every source that covers it, with no regional gate', async ({
  page
}) => {
  await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
  await gotoApp(page, '?region=national&layers=states&view=brief');
  expect(new URL(page.url()).searchParams.get('region')).toBe('national');

  await page.route(NWS_PROXY_ROUTE, (route) => {
    const url = new URL(nwsUpstreamUrl(route.request().url()));
    let body: unknown;
    if (url.pathname.startsWith('/points/')) {
      body = {
        properties: {
          forecastGridData:
            'https://api.weather.gov/gridpoints/TOP/31,80',
          observationStations:
            'https://api.weather.gov/gridpoints/TOP/31,80/stations',
          forecast:
            'https://api.weather.gov/gridpoints/TOP/31,80/forecast',
          cwa: 'TOP',
          gridId: 'TOP'
        }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80/stations') {
      body = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-98, 38] },
            properties: {
              stationIdentifier: 'KTEST',
              name: 'Test Station',
              '@id': 'https://api.weather.gov/stations/KTEST'
            }
          }
        ]
      };
    } else if (url.pathname === '/stations/KTEST/observations/latest') {
      body = {
        properties: {
          timestamp: '2026-07-29T12:00:00+00:00',
          temperature: { unitCode: 'wmoUnit:degC', value: 30 },
          relativeHumidity: { unitCode: 'wmoUnit:percent', value: 42 },
          heatIndex: { unitCode: 'wmoUnit:degC', value: 31 }
        }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80/forecast') {
      body = {
        properties: {
          periods: [
            {
              name: 'Today',
              temperature: 90,
              temperatureUnit: 'F',
              shortForecast: 'Sunny'
            }
          ]
        }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80') {
      body = {
        properties: {
          heatIndex: {
            uom: 'wmoUnit:degC',
            values: [
              {
                validTime: '2026-07-29T00:00:00+00:00/P2D',
                value: 32
              }
            ]
          }
        }
      };
    } else if (url.pathname === '/alerts/active') {
      body = { type: 'FeatureCollection', features: [] };
    } else {
      return route.abort();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    });
  });

  // The national sources reach the offline backstop (503), so their cells
  // settle on their own failure states; this case reads only who was asked.
  const nationalSourceRequests: string[] = [];
  const waterSupplyRequests: string[] = [];
  const nwsRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (NWS_PROXY_ROUTE.test(url)) {
      nwsRequests.push(nwsUpstreamUrl(url));
      return;
    }
    if (url.includes('nwrfc.noaa.gov/water_supply/') || url.includes(encodeURIComponent('nwrfc.noaa.gov/water_supply/'))) {
      waterSupplyRequests.push(url);
      return;
    }
    if (
      url.includes('/USDM_current/FeatureServer/0/query') ||
      url.includes('/StateStatistics/GetDSCI') ||
      url.includes(encodeURIComponent('/StateStatistics/GetDSCI')) ||
      url.includes('/WFIGS_Interagency_Perimeters_Current/')
    ) {
      nationalSourceRequests.push(url);
    }
  });

  // The pick opens the chosen place's briefing (owner 2026-11-13), so the
  // routes and the request log above are in place before it.
  await page.locator('#brief-search [data-ddm-search]').fill('kansas');
  await page
    .locator(
      '#brief-search [data-search-kind="place"][data-search-id="KS"]'
    )
    .click();
  await expect(page.locator('#brief-place-name')).toHaveText('Kansas');
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.impact-capability-unavailable')).toHaveCount(0);
  await expect(panel).not.toContainText('not validated outside the Pacific Northwest');
  await expect(panel.locator('.briefing-view-switch')).toBeVisible();
  // D4 (the look of 2026-11-05): the Northwest-curated resources keep their
  // data limit, so a Kansas place lists none of their rows. Since 2026-11-13
  // (DR-258 amendment) Resources holds the Grants.gov subsection for every
  // place inside the United States, so the section stands over it alone.
  const resources = panel.locator('.impact-resources');
  await expect(resources).toHaveCount(1);
  await expect(resources.locator('.impact-grants')).toHaveCount(1);
  await expect(resources.locator('.impact-resource-group > .impact-resource')).toHaveCount(0);
  await expect(
    panel.locator('.point-heat > .impact-horizon-head .point-heat-pill-ready')
  ).toHaveText('live');
  await expect(panel.locator('.point-heat-station')).toContainText(
    'Test Station'
  );
  await expect
    .poll(() => nationalSourceRequests.some((url) => url.includes('/USDM_current/FeatureServer/0/query')))
    .toBe(true);
  expect(waterSupplyRequests).toEqual([]);
  expect(nwsRequests).toHaveLength(6);
  expect(nwsRequests.filter((url) => url.includes('/points/'))).toHaveLength(1);
  await expect(panel.locator('.impact-resource-link')).toHaveCount(0);
});
