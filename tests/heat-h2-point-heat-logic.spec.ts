// These tests came from heat-h2-point-heat.spec.ts: none of them opens a page, so they run in the pure lane.
import { expect, test } from './offline-test';

import { placeRefFromBoundary } from '../src/config/entities';
import {
  postalCodeFromProperties,
  resolveCanonicalGeography
} from '../src/config/geography';
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
  FORECAST_URL,
  GRID_PAYLOAD,
  GRID_URL,
  LATEST_URL,
  OBSERVATION_PAYLOAD,
  FORECAST_PAYLOAD,
  POINT_PAYLOAD,
  POINT_URL,
  STATIONS_PAYLOAD,
  STATIONS_URL,
  nwsUpstreamUrl
} from './point-heat-fixtures';

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

// DR-256: every source reads where its issuer covers the place; the drought and
// fire sources no longer wait on the Northwest family (the water-supply adapter
// keeps its own NWRFC domain gate inside src/impact/water-supply.ts).
test('per-source policy reads national heat, drought and fire sources by their own coverage', () => {
  const kansas = briefingSourcePolicy(context('KS'));
  expect(kansas.sources.pointHeat.state).toBe('available');
  expect(kansas.sources.nwsForecast.state).toBe('available');
  expect(kansas.sources.nwsAlerts.state).toBe('available');
  expect(kansas.sources.usdm.state).toBe('available');
  expect(kansas.sources.nifc.state).toBe('available');
  expect(kansas.sources.cpcExtended.state).toBe('available');
  expect(kansas.sources.waterSupply.state).toBe('available');
  expect(kansas.droughtImpact.enabled).toBe(false);

  const americanSamoa = briefingSourcePolicy(context('AS'));
  expect(americanSamoa.sources.pointHeat.state).toBe('conditional');
  expect(americanSamoa.sources.nwsForecast.state).toBe('conditional');

  const canada = briefingSourcePolicy(
    context(null, 'british_columbia', 'watershed')
  );
  expect(canada.sources.pointHeat.state).toBe('unavailable');
  expect(canada.sources.nwsAlerts.state).toBe('unavailable');
  expect(canada.sources.usdm.state).toBe('unavailable');
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
      fetchNwsForecastClaims(
        context('KS'),
        master.signal,
        session,
        Date.parse('2026-07-29T12:30:00+00:00')
      )
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
          text: 'NWS reports no active heat alert at the selected point.'
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

test.describe('DDM-P7-T07: the season-ahead heat cell', () => {
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
