import { test, expect } from '@playwright/test';

import type { RegionKey } from '../src/config/regions';
import { URLS } from '../src/config/urls';
import {
  regionCapabilityLevel,
  regionCapabilityNote
} from '../src/config/region-capability';
import { createBriefingSkeleton } from '../src/impact/briefing';
import {
  buildResources,
  resolveStateCode
} from '../src/impact/resources';
import type { BoundarySelectionContext } from '../src/impact/types';
import { gotoApp } from './helpers';

function selectionContext(
  regionKey: RegionKey | null,
  properties: Readonly<Record<string, unknown>> | null = null
): BoundarySelectionContext {
  return {
    kind: 'bia-reservation',
    title: 'Example place',
    properties,
    lngLat: { lng: -98, lat: 38 },
    regionKey
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
    const kansas = {
      ...selectionContext('national'),
      kind: 'state' as const,
      properties: { STUSPS: 'KS', NAME: 'Kansas' }
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

test('impactSynthesis none keeps unrelated sources off while independent point heat runs', async ({
  page
}) => {
  await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
  await gotoApp(page, '?region=national&layers=states&view=brief');
  expect(new URL(page.url()).searchParams.get('region')).toBe('national');

  await page.locator('#brief-search [data-ddm-search]').fill('kansas');
  await page
    .locator(
      '#brief-search [data-search-kind="place"][data-search-id="KS"]'
    )
    .click();
  await expect(page.locator('#brief-place-name')).toHaveText('Kansas');

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

  const unrelatedSourceRequests: string[] = [];
  const nwsRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (NWS_PROXY_ROUTE.test(url)) {
      nwsRequests.push(nwsUpstreamUrl(url));
      return;
    }
    if (
      url.includes('/data/enso-indices.json') ||
      url.includes('/USDM_current/FeatureServer/0/query') ||
      url.includes('/StateStatistics/GetDSCI') ||
      url.includes('/WFIGS_Interagency_Perimeters_Current/') ||
      url.includes('/cpc_610_outlk/') ||
      url.includes('/cpc_814_outlk/') ||
      url.includes('nwrfc.noaa.gov/water_supply/')
    ) {
      unrelatedSourceRequests.push(url);
    }
  });

  await page.locator('#brief-full-report-link').click();
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.impact-capability-unavailable')).toContainText(
    'The briefing synthesis and resource routing are not validated outside the PNW.'
  );
  await expect(
    panel.locator('.point-heat > .impact-horizon-head .point-heat-pill-ready')
  ).toHaveText('live');
  await expect(panel.locator('.point-heat-station')).toContainText(
    'Test Station'
  );
  expect(unrelatedSourceRequests).toEqual([]);
  expect(nwsRequests).toHaveLength(6);
  expect(nwsRequests.filter((url) => url.includes('/points/'))).toHaveLength(1);
  await expect(panel.locator('.impact-resource-link')).toHaveCount(0);
});
