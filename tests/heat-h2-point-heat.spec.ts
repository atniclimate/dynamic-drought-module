import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { placeRefFromBoundary } from '../src/config/entities';
import {
  postalCodeFromProperties,
  resolveCanonicalGeography
} from '../src/config/geography';
import { URLS } from '../src/config/urls';
import { ExpiringLruCache } from '../src/util/bounded-cache';
import { createBriefingSkeleton } from '../src/impact/briefing';
import { synthesizeHeatSources } from '../src/impact/heat-synthesis';
import { hydrateBriefing } from '../src/impact/hydrate';
import {
  clearNwsResponseCache,
  createNwsRequestSession
} from '../src/impact/nws-point';
import { fetchPointHeat, parseNwsValidTime } from '../src/impact/point-heat';
import { isStateCode } from '../src/impact/resources';
import {
  formatDistanceKm,
  formatPointHeatInterval,
  formatPointHeatTimestamp,
  formatPointHeatValue
} from '../src/impact/point-heat-format';
import { briefingSourcePolicy } from '../src/impact/source-policy';
import { fetchNwsForecastClaims } from '../src/impact/sources';
import type {
  BoundarySelectionContext,
  PointHeatBriefing
} from '../src/impact/types';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  stubCpcSeasonalTempOutlook,
  stubHeatRiskCatalog as stubHeatRiskCatalogShared
} from './helpers';

/**
 * What the literal's own properties say about its containing state, derived
 * exactly the way `buildBoundaryContext`'s `containingFromProperties` derives
 * it in production (src/impact/context.ts): from the properties bag alone,
 * never from `regionKey`. A code that is not a recognized `StateCode` (for
 * example a territory postal code like `AS`) honestly resolves to `none`.
 */
function containingFromProperties(
  properties: BoundarySelectionContext['properties']
): BoundarySelectionContext['containing'] {
  const code = postalCodeFromProperties(properties);
  return code !== null && isStateCode(code)
    ? { state: code, basis: 'feature-property' }
    : { state: null, basis: 'none' };
}

function context(
  code: string | null,
  regionKey: BoundarySelectionContext['regionKey'] = 'national',
  kind: BoundarySelectionContext['kind'] = 'state'
): BoundarySelectionContext {
  const properties = code ? { STUSPS: code } : null;
  return {
    kind,
    title: code ?? 'Selected place',
    properties,
    lngLat: { lng: -97.5, lat: 38.5 },
    regionKey,
    containing: containingFromProperties(properties),
    place: placeRefFromBoundary(kind, properties)
  };
}

const POINT_URL = 'https://api.weather.gov/points/38.5,-97.5';
const GRID_URL = 'https://api.weather.gov/gridpoints/TOP/31,80';
const STATIONS_URL =
  'https://api.weather.gov/gridpoints/TOP/31,80/stations';
const FORECAST_URL =
  'https://api.weather.gov/gridpoints/TOP/31,80/forecast';
const NEAR_STATION_URL = 'https://api.weather.gov/stations/KNEAR';
const LATEST_URL = `${NEAR_STATION_URL}/observations/latest`;
const NWS_PROXY_ROUTE = new RegExp(
  `^${URLS.workerProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy\\?url=${encodeURIComponent(
    `${URLS.nwsApi}/`
  )}`
);

function nwsUpstreamUrl(requestUrl: string): string {
  const request = new URL(requestUrl);
  const worker = new URL(URLS.workerProxy);
  const upstream = request.searchParams.get('url');
  if (
    request.origin !== worker.origin ||
    request.pathname !== '/proxy' ||
    upstream === null ||
    !upstream.startsWith(`${URLS.nwsApi}/`)
  ) {
    throw new Error(`Expected a Worker-wrapped NWS URL, received ${requestUrl}`);
  }
  return upstream;
}

const POINT_PAYLOAD = {
  properties: {
    forecastGridData: GRID_URL,
    observationStations: STATIONS_URL,
    forecast: FORECAST_URL,
    cwa: 'TOP',
    gridId: 'TOP'
  }
};

const GRID_PAYLOAD = {
  properties: {
    updateTime: '2026-07-29T10:00:00+00:00',
    temperature: {
      uom: 'wmoUnit:degC',
      values: [
        {
          validTime: '2026-07-29T00:00:00+00:00/P2D',
          value: 31
        },
        {
          validTime: '2026-07-30T00:00:00+00:00/PT1H',
          value: null
        }
      ]
    },
    apparentTemperature: {
      uom: 'wmoUnit:degC',
      values: [
        {
          validTime: '2026-07-30T12:00:00+00:00/PT3H',
          value: 34
        }
      ]
    },
    heatIndex: {
      uom: 'wmoUnit:degC',
      values: [
        {
          validTime: '2026-07-30T12:00:00+00:00/PT3H',
          value: 36
        }
      ]
    },
    wetBulbGlobeTemperature: {
      uom: 'wmoUnit:degC',
      values: []
    }
  }
};

const STATIONS_PAYLOAD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-100, 40] },
      properties: {
        stationIdentifier: 'KFAR',
        name: 'Far Station',
        '@id': 'https://api.weather.gov/stations/KFAR'
      }
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-97.49, 38.51] },
      properties: {
        stationIdentifier: 'KNEAR',
        name: 'Near Station',
        '@id': NEAR_STATION_URL
      }
    }
  ]
};

const OBSERVATION_PAYLOAD = {
  properties: {
    timestamp: '2026-07-29T12:05:00+00:00',
    temperature: { unitCode: 'wmoUnit:degC', value: 32 },
    relativeHumidity: { unitCode: 'wmoUnit:percent', value: 48 },
    heatIndex: { unitCode: 'wmoUnit:degC', value: 35 }
  }
};

const FORECAST_PAYLOAD = {
  properties: {
    periods: [
      {
        name: 'This Afternoon',
        temperature: 91,
        temperatureUnit: 'F',
        shortForecast: 'Sunny'
      }
    ]
  }
};

function responseFor(url: string): unknown {
  if (url === POINT_URL) return POINT_PAYLOAD;
  if (url === GRID_URL) return GRID_PAYLOAD;
  if (url === STATIONS_URL) return STATIONS_PAYLOAD;
  if (url === LATEST_URL) return OBSERVATION_PAYLOAD;
  if (url === FORECAST_URL) return FORECAST_PAYLOAD;
  throw new Error(`Unexpected URL ${url}`);
}

test.beforeEach(() => {
  clearNwsResponseCache();
});

test('canonical geography gives explicit selected-place identity precedence over framing', () => {
  expect(resolveCanonicalGeography(context('KS')).key).toBe('conus');
  expect(resolveCanonicalGeography(context('AK')).key).toBe('alaska');
  expect(resolveCanonicalGeography(context('HI')).key).toBe('hawaii');
  expect(resolveCanonicalGeography(context('PR')).key).toBe('puerto-rico');
  expect(resolveCanonicalGeography(context('AS')).key).toBe(
    'american-samoa'
  );
  expect(
    resolveCanonicalGeography(context('PR', 'british_columbia')).key
  ).toBe('puerto-rico');
  expect(
    resolveCanonicalGeography(
      context(null, 'columbia_snake_basin', 'treaty')
    ).key
  ).toBe('transboundary');
  expect(
    resolveCanonicalGeography(
      context(null, 'columbia_snake_basin', 'bia-reservation')
    ).key
  ).toBe('conus');
  expect(
    resolveCanonicalGeography(
      context(null, 'british_columbia', 'watershed')
    ).key
  ).toBe('canada');
});

test('per-source policy enables national heat without enabling regional drought and fire sources', () => {
  const kansas = briefingSourcePolicy(context('KS'));
  expect(kansas.sources.pointHeat.state).toBe('available');
  expect(kansas.sources.nwsForecast.state).toBe('available');
  expect(kansas.sources.nwsAlerts.state).toBe('available');
  expect(kansas.sources.usdm.state).toBe('unavailable');
  expect(kansas.sources.nifc.state).toBe('unavailable');
  expect(kansas.sources.cpcExtended.state).toBe('unavailable');
  expect(kansas.sources.waterSupply.state).toBe('unavailable');

  const americanSamoa = briefingSourcePolicy(context('AS'));
  expect(americanSamoa.sources.pointHeat.state).toBe('conditional');
  expect(americanSamoa.sources.nwsForecast.state).toBe('conditional');

  const canada = briefingSourcePolicy(
    context(null, 'british_columbia', 'watershed')
  );
  expect(canada.sources.pointHeat.state).toBe('unavailable');
  expect(canada.sources.nwsAlerts.state).toBe('unavailable');
});

test('point heat selects the geometrically nearest station and preserves sparse issuer intervals', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = nwsUpstreamUrl(String(input));
    calls.push(url);
    return Response.json(responseFor(url));
  };
  try {
    const master = new AbortController();
    const result = await fetchPointHeat(
      context('KS'),
      createNwsRequestSession(master.signal),
      Date.parse('2026-07-29T12:30:00+00:00')
    );

    expect(result.status).toBe('ready');
    expect(result.observation.stationId).toBe('KNEAR');
    expect(result.observation.distanceKm).toBeLessThan(2);
    expect(result.observation.metrics.map((metric) => metric.key)).toEqual([
      'temperature',
      'relativeHumidity',
      'heatIndex'
    ]);
    expect(result.grid.metrics.map((metric) => metric.key)).toEqual([
      'temperature',
      'apparentTemperature',
      'heatIndex'
    ]);
    expect(result.grid.metrics).not.toContainEqual(
      expect.objectContaining({ key: 'wetBulbGlobeTemperature' })
    );
    expect(
      result.grid.metrics.find((metric) => metric.key === 'heatIndex')
        ?.values[0]
    ).toMatchObject({
      value: 36,
      unitCode: 'wmoUnit:degC',
      validTime: '2026-07-30T12:00:00+00:00/PT3H',
      endTime: '2026-07-30T15:00:00.000Z'
    });
    expect(calls).toEqual([
      POINT_URL,
      STATIONS_URL,
      GRID_URL,
      LATEST_URL
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('point heat and point forecast share discovery and stay within the six-request ceiling', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = nwsUpstreamUrl(String(input));
    calls.push(url);
    return Response.json(responseFor(url));
  };
  try {
    const master = new AbortController();
    const session = createNwsRequestSession(master.signal);
    const [heat, forecast] = await Promise.all([
      fetchPointHeat(
        context('KS'),
        session,
        Date.parse('2026-07-29T12:30:00+00:00')
      ),
      fetchNwsForecastClaims(context('KS'), master.signal, session)
    ]);
    expect(heat.status).toBe('ready');
    expect(forecast.ok).toBe(true);
    expect(calls.filter((url) => url === POINT_URL)).toHaveLength(1);
    expect(calls).toHaveLength(5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing American Samoa discovery links become no data after one request', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(nwsUpstreamUrl(String(input)));
    return Response.json({
      properties: {
        forecastGridData: null,
        observationStations: null,
        forecast: null
      }
    });
  };
  try {
    const master = new AbortController();
    const result = await fetchPointHeat(
      {
        ...context('AS'),
        lngLat: { lng: -170.7, lat: -14.3 }
      },
      createNwsRequestSession(master.signal)
    );
    expect(result.status).toBe('no-data');
    expect(result.observation.status).toBe('no-data');
    expect(result.grid.status).toBe('no-data');
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('null optional observation and grid values remain absent rather than becoming zero', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = nwsUpstreamUrl(String(input));
    if (url === POINT_URL) return Response.json(POINT_PAYLOAD);
    if (url === GRID_URL) {
      return Response.json({
        properties: {
          temperature: {
            uom: 'wmoUnit:degC',
            values: [
              {
                validTime: '2026-07-29T00:00:00+00:00/P2D',
                value: null
              }
            ]
          },
          heatIndex: {
            uom: 'wmoUnit:degC',
            values: [
              {
                validTime: '2026-07-29T00:00:00+00:00/P2D',
                value: null
              }
            ]
          }
        }
      });
    }
    if (url === STATIONS_URL) return Response.json(STATIONS_PAYLOAD);
    if (url === LATEST_URL) {
      return Response.json({
        properties: {
          timestamp: '2026-07-29T12:05:00+00:00',
          temperature: { unitCode: 'wmoUnit:degC', value: null },
          relativeHumidity: {
            unitCode: 'wmoUnit:percent',
            value: null
          },
          heatIndex: { unitCode: 'wmoUnit:degC', value: null }
        }
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const master = new AbortController();
    const result = await fetchPointHeat(
      context('KS'),
      createNwsRequestSession(master.signal),
      Date.parse('2026-07-29T12:30:00+00:00')
    );
    expect(result.status).toBe('no-data');
    expect(result.observation.metrics).toEqual([]);
    expect(result.grid.metrics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('"value":0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Canada remains unavailable without starting any heat or regional source request', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error('Canada fixture must not start a network request.');
  };
  try {
    const briefing = createBriefingSkeleton(
      context(null, 'british_columbia', 'watershed')
    );
    const master = new AbortController();
    await hydrateBriefing(briefing, master.signal, () => undefined);
    expect(requestCount).toBe(0);
    expect(briefing.sourcePolicy.geography.key).toBe('canada');
    expect(briefing.pointHeat.status).toBe('error');
    expect(briefing.pointHeat.note).toContain(
      'NWS point API is not used for Canada'
    );
    expect(briefing.horizons.current.status).toBe('unavailable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cross-source synthesis compares issuer reads without creating a DDM heat class', () => {
  const pointHeat: PointHeatBriefing = {
    status: 'ready',
    point: { lng: -97.5, lat: 38.5 },
    observation: {
      status: 'ready',
      stationId: 'KNEAR',
      stationName: 'Near Station',
      distanceKm: 1.4,
      timestamp: '2026-07-29T12:05:00+00:00',
      metrics: [
        {
          key: 'temperature',
          label: 'Temperature',
          unitCode: 'wmoUnit:degC',
          availableValueCount: 1,
          values: [
            {
              value: 32,
              unitCode: 'wmoUnit:degC',
              validTime: '2026-07-29T12:05:00+00:00',
              startTime: '2026-07-29T12:05:00+00:00'
            }
          ]
        }
      ]
    },
    grid: {
      status: 'ready',
      metrics: [
        {
          key: 'heatIndex',
          label: 'Heat index',
          unitCode: 'wmoUnit:degC',
          availableValueCount: 1,
          values: [
            {
              value: 36,
              unitCode: 'wmoUnit:degC',
              validTime: '2026-07-29T12:00:00+00:00/PT3H',
              startTime: '2026-07-29T12:00:00+00:00',
              endTime: '2026-07-29T15:00:00.000Z'
            }
          ]
        }
      ]
    }
  };
  const synthesis = synthesizeHeatSources(
    pointHeat,
    [
      {
        ok: true,
        claims: [],
        heatRead: {
          key: 'nwsAlerts',
          label: 'NWS active heat alerts',
          text: 'NWS reports no active extreme-heat alert at the selected point.'
        }
      }
    ],
    true
  );
  expect(synthesis.status).toBe('ready');
  expect(synthesis.reads).toHaveLength(2);
  expect(synthesis.note).toContain(
    'does not combine them into a new heat class'
  );
});

test('valid-time parsing and the bounded cache retain exact intervals and evict least-recently-used entries', () => {
  expect(parseNwsValidTime('2026-07-29T14:00:00+00:00/P7DT23H')).toEqual({
    startTime: '2026-07-29T14:00:00+00:00',
    endTime: '2026-08-06T13:00:00.000Z'
  });

  let now = 100;
  const cache = new ExpiringLruCache<string, number>(2, () => now);
  cache.set('a', 1, 10);
  cache.set('b', 2, 10);
  expect(cache.get('a')).toBe(1);
  cache.set('c', 3, 10);
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe(1);
  now = 111;
  expect(cache.get('a')).toBeUndefined();
  expect(cache.get('c')).toBeUndefined();
});

async function stubBrowserNwsHeat(page: Page): Promise<void> {
  await page.route(NWS_PROXY_ROUTE, (route) => {
    const url = new URL(nwsUpstreamUrl(route.request().url()));
    let body: unknown;
    if (url.pathname.startsWith('/points/')) {
      body = POINT_PAYLOAD;
    } else if (url.pathname === '/gridpoints/TOP/31,80/stations') {
      body = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [-120.5, 47.5]
            },
            properties: {
              stationIdentifier: 'KNEAR',
              name: 'Near Station',
              '@id': NEAR_STATION_URL
            }
          }
        ]
      };
    } else if (url.pathname === '/stations/KNEAR/observations/latest') {
      body = OBSERVATION_PAYLOAD;
    } else if (url.pathname === '/gridpoints/TOP/31,80/forecast') {
      body = FORECAST_PAYLOAD;
    } else if (url.pathname === '/gridpoints/TOP/31,80') {
      body = GRID_PAYLOAD;
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
}

test.describe('H2 critical-first surfaces', () => {
  test('mobile at-hand and full report lead with point heat', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?select=state:WA');

    await expect(page.locator('.sheet-at-hand-headline')).toContainText(
      'Heat at the selected point: Near Station reports temperature 90 °F (32 °C), heat index 95 °F (35 °C)'
    );
    await page.locator('#sheet-report-door').click();
    const pointHeat = page.locator(
      '#sheet-report .point-heat[aria-label="Heat at selected point"]'
    );
    await expect(pointHeat).toBeVisible();
    await expect(pointHeat.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    const openInterval = pointHeat
      .locator('.point-heat-series[open] time')
      .first();
    await expect(openInterval).toHaveAttribute(
      'title',
      '2026-07-30T12:00:00+00:00/PT3H'
    );
    await expect(openInterval).toContainText('Jul 30');
    await expect(pointHeat).not.toContainText('wmoUnit');
    await expect(
      page.locator('#sheet-report .impact-capability-unavailable')
    ).toHaveCount(0);
  });

  test('embed report exposes the same point heat model without adding URL state', async ({
    page
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?embed=true&select=state:WA');

    const pointHeat = page.locator(
      '#impact-panel .point-heat[aria-label="Heat at selected point"]'
    );
    await expect(pointHeat).toBeVisible();
    await expect(
      pointHeat.locator(
        ':scope > .impact-horizon-head .point-heat-pill-ready'
      )
    ).toHaveText('live');
    const search = new URL(page.url()).searchParams;
    expect(search.get('embed')).toBe('true');
    expect([...search.keys()]).not.toContain('heatpoint');
  });

  test('a place change aborts the old point read and keeps the newer briefing current', async ({
    page
  }) => {
    let pointsRequestCount = 0;
    let releaseOldPoint: (() => void) | null = null;
    const oldPointReleased = new Promise<void>((resolve) => {
      releaseOldPoint = resolve;
    });
    await page.route(NWS_PROXY_ROUTE, async (route) => {
      const url = new URL(nwsUpstreamUrl(route.request().url()));
      let body: unknown;
      if (url.pathname.startsWith('/points/')) {
        pointsRequestCount += 1;
        const generation = pointsRequestCount === 1 ? 'OLD' : 'NEW';
        if (generation === 'OLD') await oldPointReleased;
        body = {
          properties: {
            forecastGridData:
              `https://api.weather.gov/gridpoints/${generation}/1,1`,
            observationStations:
              `https://api.weather.gov/gridpoints/${generation}/1,1/stations`,
            forecast:
              `https://api.weather.gov/gridpoints/${generation}/1,1/forecast`,
            cwa: generation,
            gridId: generation
          }
        };
      } else if (/\/gridpoints\/(OLD|NEW)\/1,1\/stations$/.test(url.pathname)) {
        const generation = url.pathname.includes('/OLD/') ? 'OLD' : 'NEW';
        body = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-120.5, 47.5] },
              properties: {
                stationIdentifier: `K${generation}`,
                name: `${generation === 'OLD' ? 'Old' : 'New'} Station`,
                '@id': `https://api.weather.gov/stations/K${generation}`
              }
            }
          ]
        };
      } else if (/\/stations\/K(OLD|NEW)\/observations\/latest$/.test(url.pathname)) {
        const generation = url.pathname.includes('KOLD') ? 'OLD' : 'NEW';
        body = {
          properties: {
            timestamp: '2026-07-29T12:05:00+00:00',
            temperature: {
              unitCode: 'wmoUnit:degC',
              value: generation === 'OLD' ? 10 : 32
            },
            relativeHumidity: {
              unitCode: 'wmoUnit:percent',
              value: 48
            },
            heatIndex: {
              unitCode: 'wmoUnit:degC',
              value: generation === 'OLD' ? 10 : 35
            }
          }
        };
      } else if (/\/gridpoints\/(OLD|NEW)\/1,1\/forecast$/.test(url.pathname)) {
        body = FORECAST_PAYLOAD;
      } else if (/\/gridpoints\/(OLD|NEW)\/1,1$/.test(url.pathname)) {
        body = GRID_PAYLOAD;
      } else if (url.pathname === '/alerts/active') {
        body = { type: 'FeatureCollection', features: [] };
      } else {
        return route.abort();
      }
      try {
        return await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        });
      } catch {
        return undefined;
      }
    });

    try {
      await gotoApp(page, '?view=brief&select=state:WA');
      await expect(page.locator('#impact-panel')).toBeVisible();
      await page.locator('#impact-panel .impact-panel-close').click();

      const search = page.locator('#brief-search [data-ddm-search]');
      await search.fill('oregon');
      await page
        .locator(
          '#brief-search [data-search-kind="place"][data-search-id="OR"]'
        )
        .click();
      await page.locator('#brief-full-report-link').click();
      await expect(page.locator('.point-heat-station')).toContainText(
        'New Station'
      );

      releaseOldPoint?.();
      await page.waitForTimeout(100);
      await expect(page.locator('.point-heat-station')).not.toContainText(
        'Old Station'
      );
      await expect(page.locator('#impact-panel-title')).toHaveText('Oregon');
    } finally {
      releaseOldPoint?.();
    }
  });

  test('reopening the same briefing reuses completed NWS responses', async ({
    page
  }) => {
    let requestCount = 0;
    page.on('request', (request) => {
      if (NWS_PROXY_ROUTE.test(request.url())) {
        requestCount += 1;
      }
    });
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?view=console');

    const trigger = page.locator('#region-briefing-btn');
    await trigger.click();
    await expect(page.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    expect(requestCount).toBe(6);
    await page.locator('#impact-panel .impact-panel-close').click();

    await trigger.click();
    await expect(page.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    await page.waitForTimeout(100);
    expect(requestCount).toBe(6);
  });
});

test.describe('H2 near-term HeatRisk claim independent of the map layer (DR-014 a)', () => {
  const HEATRISK_PATH = '/experimental/rest/services/NWS_HeatRisk/ImageServer';
  const HEATRISK_ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  // idp_validtime is in ascending order, so index 0 is the catalog's earliest
  // advertised granule ("day 1 of 7 of the catalog") whether or not the map
  // layer ever asks for it. Its value is deliberately null so the same
  // rendered branch (sources.ts fetchHeatRiskClaims, the `identified.value
  // === null` arm) exercises the "for day 1 of 7 of the catalog" / "for the
  // selected frame" wording.
  //
  // These times are FIXED 2026 literals, not built relative to the test
  // clock, and this suite runs with the real system clock (no
  // `page.clock.setFixedTime` in this describe block): every period below
  // has therefore ENDED by the time this runs (DR-070 amended 2026-09-08,
  // DR-071's phase rule, mirrored by heatRiskClaimRegister in
  // src/ui/heatrisk-sequence.ts), so the register assertions below read
  // `observed`, not `outlook`. That is deliberate: it is this fixture's one
  // proof of the ended-period branch. The paired in-force case lives in its
  // own test below, built relative to Date.now() instead of moving this
  // fixture (moving it would also force every `Valid ...` UTC-moment
  // assertion in this describe block onto computed, rather than literal,
  // strings, for no honesty gain over the dedicated case).
  const CATALOG_TIMES = [
    1785240000000,
    1785326400000,
    1785412800000,
    1785499200000,
    1785585600000,
    1785672000000,
    1785758400000
  ] as const;
  const CATALOG_VALUES = [null, 1, 0, 3, 4, 2, 2] as const;

  interface HeatRiskCatalogReceipt {
    /** Every `/identify` request's `time` param, in call order. */
    readonly identifyCalls: number[];
  }

  interface StubHeatRiskCatalogOptions {
    readonly catalogTimes?: readonly number[];
    readonly catalogValues?: readonly (number | null)[];
  }

  async function stubHeatRiskCatalog(
    page: Page,
    options: StubHeatRiskCatalogOptions = {}
  ): Promise<HeatRiskCatalogReceipt> {
    const times = options.catalogTimes ?? CATALOG_TIMES;
    const values = options.catalogValues ?? CATALOG_VALUES;
    const identifyCalls: number[] = [];
    await page.route(
      (url) => url.pathname.startsWith(HEATRISK_PATH),
      async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.pathname.endsWith('/query')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              features: times.map((validTime, index) => ({
                attributes: {
                  name: `HeatRisk_${index + 1}_Mercator`,
                  idp_validtime: validTime
                }
              }))
            })
          });
          return;
        }
        if (requestUrl.pathname.endsWith('/identify')) {
          const time = Number(requestUrl.searchParams.get('time'));
          identifyCalls.push(time);
          const index = times.indexOf(time);
          const value = index < 0 ? undefined : values[index];
          if (value === undefined) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: 'unknown time' } })
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              value: value === null ? 'NoData' : String(value),
              catalogItems: {
                features:
                  value === null
                    ? []
                    : [{ attributes: { idp_validtime: time } }]
              }
            })
          });
          return;
        }
        if (requestUrl.pathname.endsWith('/exportImage')) {
          await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: HEATRISK_ONE_PIXEL_PNG
          });
          return;
        }
        // Service metadata: reached by the map layer's own activation AND by
        // the briefing's independent-catalog fallback
        // (src/ui/heatrisk-sequence.ts identifyHeatRiskForBriefing), which
        // reads it whether or not the map layer ever activates (DDM-P7-T05
        // F8 correction: this comment previously said the opposite).
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            timeInfo: { timeExtent: [times[0], times.at(-1)] }
          })
        });
      }
    );
    return { identifyCalls };
  }

  /** Copies heat-h1-heatrisk.spec.ts's own counting-fixture toggle helper. */
  async function setLayerChecked(
    page: Page,
    key: string,
    checked: boolean
  ): Promise<void> {
    await layerCheckbox(page, key).evaluate((element, next) => {
      element.checked = next;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, checked);
  }

  test('layer off: the claim is present with its source and validity, naming day 1 of 7 of the catalog', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    await expect(page.locator('#heatrisk-sequence')).toBeHidden();
    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for day 1 of 7 of the catalog'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 28, 2026, 12:00 UTC to Jul 29, 2026, 12:00 UTC'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    // DR-070 amended 2026-09-08, DR-071: HeatRisk stays Classified evidence,
    // but its register follows the SAME phase the time bar draws
    // (heatRiskClaimRegister in src/ui/heatrisk-sequence.ts): this
    // fixture's day 1 period (Jul 28 to Jul 29, 2026) has long since ended
    // by the real clock this suite runs under, so it reads observed, not
    // outlook (an ended period is "the spent claim the doctrine forbids"
    // as an outlook). The in-force case is proven separately below.
    await expect(heatClaim.locator('.impact-claim-register')).toHaveText(
      'observed'
    );
  });

  test('layer on selecting the same frame: the claim carries the same source and validity, naming the selected frame', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=1&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for the selected frame'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 28, 2026, 12:00 UTC to Jul 29, 2026, 12:00 UTC'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    // DR-070 amended 2026-09-08, DR-071: same ended-period reasoning as the
    // layer-off case above; the selected frame is the same day 1 period.
    await expect(heatClaim.locator('.impact-claim-register')).toHaveText(
      'observed'
    );
  });

  test('a frame whose 24-hour period has not ended reads the outlook register', async ({
    page
  }) => {
    // Built relative to THIS test's own clock (real time, no
    // page.clock.setFixedTime in this describe block), three hours into day
    // 1, so day 1 is in force at the moment the briefing boots below. This
    // is the paired proof for the two ended-period cases immediately above:
    // heatRiskClaimRegister reads BOTH directions of the same boundary.
    const day1Start = Date.now() - 3 * 60 * 60 * 1000;
    const inForceTimes = Array.from(
      { length: 7 },
      (_, index) => day1Start + index * 24 * 60 * 60 * 1000
    );
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page, {
      catalogTimes: inForceTimes,
      catalogValues: [2, 1, 0, 3, 4, null, 2]
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'value 2, Moderate, at the selected point for Washington'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    await expect(heatClaim.locator('.impact-claim-register')).toHaveText(
      'outlook'
    );
  });

  test('toggling the layer off then on with the briefing open costs no extra identify request', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    const receipt = await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=1&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(CATALOG_TIMES.length);

    // A toggle off then quickly on must cost only the layer's own two
    // seven-frame reads (activation, then reactivation); the briefing's
    // independent-catalog fallback (src/ui/heatrisk-sequence.ts
    // identifyHeatRiskForBriefing) must settle through the toggle without
    // firing a request of its own (the RACE correction, DDM-P7-T05 brief 2).
    await setLayerChecked(page, 'heatrisk', false);
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
    await setLayerChecked(page, 'heatrisk', true);
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(CATALOG_TIMES.length * 2);

    // Give the fallback's settle window (about 500 ms) time to fully elapse;
    // it must still make no request once it does.
    await page.waitForTimeout(700);
    expect(receipt.identifyCalls.length).toBe(CATALOG_TIMES.length * 2);
  });

  test('toggling the layer off and LEAVING it off: the fallback answers once, past the settle window', async ({
    page
  }) => {
    // DDM-P7-T05 F5: the case DR-014 a is actually about. Unlike the test
    // above (toggled back on quickly, the fallback never runs), this leaves
    // the layer off, so the fallback's own settle-then-fetch sequence
    // (src/ui/heatrisk-sequence.ts identifyHeatRiskForBriefing) runs to
    // completion: the layer's own seven /identify calls (activation) plus
    // the fallback's own one.
    await stubBrowserNwsHeat(page);
    const receipt = await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=1&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(CATALOG_TIMES.length);

    await setLayerChecked(page, 'heatrisk', false);
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();

    // Past the ~500 ms deactivation settle window: the fallback's own
    // catalog read and single /identify have had time to complete.
    await page.waitForTimeout(800);

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for day 1 of 7 of the catalog'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 28, 2026, 12:00 UTC to Jul 29, 2026, 12:00 UTC'
    );
    expect(receipt.identifyCalls.length).toBe(CATALOG_TIMES.length + 1);
  });

});

test.describe('DDM-P7-T07: the season-ahead heat cell', () => {
  const CELL = '.impact-hazard[data-horizon="longRange"][data-hazard="heat"]';

  test('(a) a stubbed outlook renders an outlook-register claim naming the CPC seasonal temperature outlook, the stubbed season, the fcst_date day and the point geography', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'Above',
      prob: 60,
      validSeas: 'DJF 2027',
      fcstDate: Date.UTC(2026, 10, 15)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-hazard-pill')).toHaveText('live');
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim.locator('.impact-claim-register')).toHaveText(
      'outlook'
    );
    await expect(claim).toContainText(
      'NOAA Climate Prediction Center seasonal temperature outlook'
    );
    await expect(claim).toContainText(
      'for Dec-Jan-Feb 2027: 60% chance of above-normal temperature, at the selected point.'
    );
    await expect(claim.locator('.impact-claim-date')).toContainText(
      '2026-11-15'
    );

    // DR-019: never presented as an ENSO forecast.
    await expect(claim).not.toContainText('ENSO');
    // The long-range drought cell keeps its own cited CPC Seasonal Drought
    // Outlook prose (hydrate.ts CPC_SEASONAL_OUTLOOK); it must not appear
    // under heat, which would misattribute a drought-tendency claim to heat.
    await expect(cell).not.toContainText('CPC Seasonal Drought Outlook');
  });

  test('(b1) a 500 response renders the named unavailable state, no claim', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, { httpStatus: 500 });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-claim')).toHaveCount(0);
    await expect(cell.locator('.impact-horizon-note')).toContainText(
      'NOAA CPC seasonal temperature outlook'
    );
  });

  test('(b2) an empty-features response renders the named unavailable state, no claim', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, { empty: true });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-claim')).toHaveCount(0);
    await expect(cell.locator('.impact-horizon-note')).toContainText(
      'NOAA CPC seasonal temperature outlook'
    );
  });

  test('(c) a superseded selection renders only the newer selection\'s claim', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    let releaseOld: (() => void) | null = null;
    const holdFirst = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await stubCpcSeasonalTempOutlook(page, {
      holdFirst,
      sequence: [
        { validSeas: 'DJF 2027 (superseded)' },
        { validSeas: 'MAM 2027' }
      ]
    });

    try {
      await gotoApp(page, '?view=brief&select=state:WA');
      await expect(page.locator('#impact-panel')).toBeVisible();
      await page.locator('#impact-panel .impact-panel-close').click();

      const search = page.locator('#brief-search [data-ddm-search]');
      await search.fill('oregon');
      await page
        .locator(
          '#brief-search [data-search-kind="place"][data-search-id="OR"]'
        )
        .click();
      await page.locator('#brief-full-report-link').click();

      const cell = page.locator(CELL);
      await expect(cell.locator('.impact-claim')).toContainText(
        'Mar-Apr-May 2027'
      );

      releaseOld?.();
      await page.waitForTimeout(200);
      await expect(cell.locator('.impact-claim')).toHaveCount(1);
      await expect(cell.locator('.impact-claim')).not.toContainText(
        'DJF 2027 (superseded)'
      );
      await expect(cell.locator('.impact-horizon-note')).toHaveCount(0);
    } finally {
      releaseOld?.();
    }
  });

  test('(d) the Heat season-ahead chip stays disabled with its reason, and #map-key and #time-bar carry no seasonal product', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?view=console&cluster=heat&horizon=season-ahead');

    // The map recipe for heat/season-ahead stays empty (clusters.ts is
    // untouched by this task): no dated product is displayed, and the chip
    // is disabled with its reason (DDM-P8-T03, DR-017 a: an empty map
    // recipe disables the chip even when it is the committed horizon); the
    // briefing's seasonal claim (this task) does not enable it.
    await expect(page.locator('#shell-time .shell-time-empty')).toHaveText(
      'No dated product is displayed.'
    );
    await expect(page.locator('#time-bar')).toBeHidden();
    const chip = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    await expect(chip).toHaveAttribute(
      'title',
      'No verified season-ahead Extreme Heat map surface exists yet.'
    );
    await expect(page.locator('#map-key')).not.toContainText(
      'seasonal temperature outlook'
    );
  });

  test('(e) a United States selection outside the Pacific Northwest (Texas) reads the honest conus matrix note under any camera (DR-090 owner ruling; DR-075 a survives at the source gate)', async ({
    page
  }) => {
    // History, so the change of assertion is not mistaken for a weakening.
    // Until DDM-P2-T08 microtask 5 (DR-090), briefingSourcePolicy gated the
    // whole horizon matrix on the CAMERA region, so a Texas selection under
    // the default washington_state framing rendered the matrix, and this
    // case proved the season-ahead heat cell inside it went live (DR-075 a,
    // director ruling: the cell's coverage gate follows the issuer's service
    // extent). The same Texas selection under the national camera never
    // rendered the matrix at all (tests/m-breadth-honesty.spec.ts, the
    // Kansas case). DR-090 reads the PLACE, so Texas now gets the conus
    // family's honest note under every camera, and the matrix collapse in
    // src/impact/hydrate.ts (matrixEnabled) takes the heat cell with it.
    // DR-075 a itself is untouched: the Texas cpcSeasonalTemp source cell is
    // still 'available' (proven browser-free in
    // tests/camera-region-fallbacks.spec.ts); whether the matrix should
    // render nationally available lanes under impactSynthesis 'none' is the
    // owner's call (S30 owner card), not this spec's.
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'Below',
      prob: 40,
      validSeas: 'JJA 2027',
      fcstDate: Date.UTC(2027, 5, 1)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:TX');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    const unavailable = panel.locator('.impact-capability-unavailable');
    await expect(unavailable).toBeVisible();
    await expect(unavailable.locator('.impact-horizon-note')).toHaveText(
      'The briefing synthesis and resource routing are not validated outside the PNW.'
    );
    await expect(panel.locator('.impact-hazard')).toHaveCount(0);
    await expect(page.locator(CELL)).toHaveCount(0);
  });

  test('(g) an Equal Chances reading renders "Equal Chances (no favored tercile)" with no percent (the issuer\'s own EC semantics, not a forecast confidence)', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'EC',
      prob: 33,
      validSeas: 'JJA 2027',
      fcstDate: Date.UTC(2027, 5, 1)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim).toContainText(
      'for Jun-Jul-Aug 2027: Equal Chances (no favored tercile), at the selected point.'
    );
    await expect(claim).not.toContainText('33%');
  });

  test('(h) a Normal reading renders the issuer legend label "near-normal"', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'Normal',
      prob: 40,
      validSeas: 'SON 2026',
      fcstDate: Date.UTC(2026, 8, 1)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim).toContainText(
      'for Sep-Oct-Nov 2026: 40% chance of near-normal temperature, at the selected point.'
    );
  });

  test('(f) a selection outside the United States renders a named unavailable note, never a claim, and issues no CPC seasonal temperature outlook request', async () => {
    // Mirrors the existing "Canada remains unavailable..." unit test above
    // (context(null, 'british_columbia', 'watershed') -> canonical geography
    // 'canada'): a pure hydrateBriefing() run, no page, so a stray fetch is
    // an immediate thrown error rather than a silent live request.
    const originalFetch = globalThis.fetch;
    let cpcRequestCount = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('cpc_sea_temp_outlk')) cpcRequestCount += 1;
      throw new Error(`Unexpected fetch in the Canada fixture: ${url}`);
    };
    try {
      const briefing = createBriefingSkeleton(
        context(null, 'british_columbia', 'watershed')
      );
      const master = new AbortController();
      await hydrateBriefing(briefing, master.signal, () => undefined);

      expect(cpcRequestCount).toBe(0);
      expect(briefing.sourcePolicy.geography.key).toBe('canada');
      expect(briefing.sourcePolicy.sources.cpcSeasonalTemp.state).toBe(
        'unavailable'
      );
      const heatLongRange = briefing.horizons.longRange.cells.heat;
      expect(heatLongRange.claims).toHaveLength(0);
      expect(heatLongRange.status).toBe('unavailable');
      expect(heatLongRange.note ?? '').not.toBe('');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test.describe('point-heat human formatting (pure)', () => {
  const LA = { timeZone: 'America/Los_Angeles' };

  test('temperatures lead Fahrenheit with whole-degree Celsius secondary', () => {
    expect(formatPointHeatValue(22.77777777777778, 'wmoUnit:degC')).toBe(
      '73 °F (23 °C)'
    );
    expect(formatPointHeatValue(35, 'wmoUnit:degC')).toBe('95 °F (35 °C)');
    expect(formatPointHeatValue(89.6, 'wmoUnit:degF')).toBe('90 °F (32 °C)');
  });

  test('percents round to whole numbers and unknown units keep one decimal', () => {
    expect(formatPointHeatValue(25.965300790594, 'wmoUnit:percent')).toBe('26%');
    expect(formatPointHeatValue(12.3456, 'wmoUnit:km_h-1')).toBe(
      '12.3 km_h-1'
    );
  });

  test('distance reads miles first with the issuer kilometres retained', () => {
    expect(formatDistanceKm(4.9)).toBe('3.0 mi (4.9 km)');
  });

  test('timestamps render as local calendar time with a zone name', () => {
    expect(
      formatPointHeatTimestamp('2026-08-31T20:57:00+00:00', LA)
    ).toBe('Aug 31, 1:57 PM PDT');
    expect(formatPointHeatTimestamp('not-a-date')).toBe('not-a-date');
  });

  test('intervals compress to one dated range with a single zone name', () => {
    expect(
      formatPointHeatInterval(
        '2026-08-31T21:00:00+00:00',
        '2026-08-31T23:00:00.000Z',
        LA
      )
    ).toBe('Aug 31, 2:00 PM to 4:00 PM PDT');
    expect(
      formatPointHeatInterval(
        '2026-08-31T23:00:00+00:00',
        '2026-09-01T09:00:00.000Z',
        LA
      )
    ).toBe('Aug 31, 4:00 PM to Sep 1, 2:00 AM PDT');
    expect(
      formatPointHeatInterval('2026-08-31T21:00:00+00:00', undefined, LA)
    ).toBe('from Aug 31, 2:00 PM PDT');
    expect(formatPointHeatInterval('garbage', undefined)).toBe('garbage');
  });
});
