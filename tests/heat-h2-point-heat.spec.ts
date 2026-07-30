import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { resolveCanonicalGeography } from '../src/config/geography';
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
import { briefingSourcePolicy } from '../src/impact/source-policy';
import { fetchNwsForecastClaims } from '../src/impact/sources';
import type {
  BoundarySelectionContext,
  PointHeatBriefing
} from '../src/impact/types';
import { gotoApp } from './helpers';

function context(
  code: string | null,
  regionKey: BoundarySelectionContext['regionKey'] = 'national',
  kind: BoundarySelectionContext['kind'] = 'state'
): BoundarySelectionContext {
  return {
    kind,
    title: code ?? 'Selected place',
    properties: code ? { STUSPS: code } : null,
    lngLat: { lng: -97.5, lat: 38.5 },
    regionKey
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
      'Heat at the selected point: Near Station reports temperature 32 °C, heat index 35 °C'
    );
    await page.locator('#sheet-report-door').click();
    const pointHeat = page.locator(
      '#sheet-report .point-heat[aria-label="Heat at selected point"]'
    );
    await expect(pointHeat).toBeVisible();
    await expect(pointHeat.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    await expect(
      pointHeat.locator('.point-heat-series[open] code').first()
    ).toHaveText('2026-07-30T12:00:00+00:00/PT3H');
    await expect(
      page.locator('#sheet-report .impact-capability-unavailable')
    ).toHaveCount(0);
  });

  test('embed report exposes the same point heat model without adding URL state', async ({
    page
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
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
