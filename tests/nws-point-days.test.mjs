import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The NWS point reads keep the issuer's own day and age: a forecast period
 * written in the point's offset keeps that calendar day (never the UTC day),
 * and a station observation past the hourly freshness window is not read as
 * current heat.
 */

// Same extensionless-specifier hook as tests/briefing-truth.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { fetchNwsForecastClaims } = await import('../src/impact/sources.ts');
const { fetchPointHeat } = await import('../src/impact/point-heat.ts');
const { clearNwsResponseCache, createNwsRequestSession } = await import('../src/impact/nws-point.ts');

const SEATTLE = {
  kind: 'state',
  title: 'Washington',
  properties: { STUSPS: 'WA' },
  lngLat: { lng: -122.33, lat: 47.61 },
  place: null,
  containing: { state: { code: 'WA', name: 'Washington', basis: 'feature-property' } },
  regionKey: 'washington_state'
};

/** Answer each NWS upstream path (the Worker wraps it in `?url=`). */
function nwsAnswer(timestamp) {
  return async (input) => {
    const url = decodeURIComponent(String(input));
    const answer = (body) => Response.json(body);
    if (url.includes('/points/')) {
      return answer({
        properties: {
          forecast: 'https://api.weather.gov/gridpoints/SEW/1,1/forecast',
          observationStations: 'https://api.weather.gov/gridpoints/SEW/1,1/stations',
          forecastGridData: null
        }
      });
    }
    if (url.endsWith('/forecast')) {
      return answer({
        properties: {
          updateTime: '2026-11-07T01:30:00+00:00',
          periods: [
            {
              name: 'Tonight',
              startTime: '2026-11-06T18:00:00-08:00',
              temperature: 41,
              temperatureUnit: 'F',
              shortForecast: 'Rain'
            }
          ]
        }
      });
    }
    if (url.endsWith('/stations')) {
      return answer({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-122.31, 47.45] },
            properties: { stationIdentifier: 'KSEA', name: 'Seattle-Tacoma', '@id': 'https://api.weather.gov/stations/KSEA' }
          }
        ]
      });
    }
    if (url.endsWith('/observations/latest')) {
      return answer({
        properties: { timestamp, temperature: { unitCode: 'wmoUnit:degC', value: 16 } }
      });
    }
    return new Response('unexpected', { status: 599 });
  };
}

async function withFetch(fetchImpl, run) {
  clearNwsResponseCache();
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    clearNwsResponseCache();
  }
}

test('a forecast period written in the point offset keeps its own calendar day, never the UTC next day', async () => {
  const result = await withFetch(nwsAnswer('2026-11-06T18:00:00-08:00'), () =>
    fetchNwsForecastClaims(SEATTLE, new AbortController().signal)
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims[0].dates.valid, '2026-11-06');
});

// Audit round 5 (R5-24), DR-047 option a: the DDM-authored heat-to-dryness
// sentence is not part of the NWS outlook; it is its own derived claim with a lineage.
test('the NWS outlook claim carries only the forecast, and the heat-to-dryness sentence is derived', async () => {
  const result = await withFetch(nwsAnswer('2026-11-06T18:00:00-08:00'), () =>
    fetchNwsForecastClaims(SEATTLE, new AbortController().signal)
  );
  const [outlook, derived] = result.claims;
  assert.equal(outlook.evidence, 'outlook');
  assert.equal(outlook.text, 'Tonight: Rain, near 41 degrees F.');
  assert.equal(derived.evidence, 'derived');
  assert.equal(derived.product, 'nwsForecast');
  assert.equal(derived.text, 'Watch this against the heat outlook; hot, dry spells deepen near-term dryness and fire danger.');
  assert.ok(derived.lineage.length > 0, 'a derived claim names what it stands on');
});

/** A forecast answer carrying exactly `periods` (every other path as above). */
function forecastWith(periods) {
  const base = nwsAnswer('2026-11-06T18:00:00-08:00');
  return async (input) =>
    decodeURIComponent(String(input)).endsWith('/forecast')
      ? Response.json({ properties: { updateTime: '2026-11-04T01:30:00+00:00', periods } })
      : base(input);
}

// Audit round 6 (R6-12): an old forecast whose first periods have ended.
const TUESDAY = {
  name: 'Tuesday',
  startTime: '2026-11-03T06:00:00-08:00',
  endTime: '2026-11-03T18:00:00-08:00',
  temperature: 95,
  temperatureUnit: 'F',
  shortForecast: 'Sunny'
};
const THURSDAY = {
  name: 'Thursday',
  startTime: '2026-11-05T06:00:00-08:00',
  endTime: '2026-11-05T18:00:00-08:00',
  temperature: 52,
  temperatureUnit: 'F',
  shortForecast: 'Cloudy'
};
const ON_THURSDAY = Date.parse('2026-11-05T12:00:00-08:00');

test('a forecast period that has ended is never stated: the claim reads the first period still running', async () => {
  const result = await withFetch(forecastWith([TUESDAY, THURSDAY]), () =>
    fetchNwsForecastClaims(SEATTLE, new AbortController().signal, undefined, ON_THURSDAY)
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims[0].text, 'Thursday: Cloudy, near 52 degrees F.');
  assert.equal(result.claims[0].dates.valid, '2026-11-05');
});

test('a forecast whose every period has ended reads unavailable, never an ended period', async () => {
  const result = await withFetch(forecastWith([TUESDAY]), () =>
    fetchNwsForecastClaims(SEATTLE, new AbortController().signal, undefined, ON_THURSDAY)
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.claims, []);
});

const NOW = Date.parse('2026-11-06T22:30:00+00:00');

async function observationAt(timestamp) {
  return withFetch(nwsAnswer(timestamp), () =>
    fetchPointHeat(SEATTLE, createNwsRequestSession(new AbortController().signal), NOW)
  );
}

test('a station observation within the hourly window reads as current heat', async () => {
  const heat = await observationAt('2026-11-06T21:53:00+00:00');
  assert.equal(heat.observation.status, 'ready');
  assert.equal(heat.observation.metrics[0].key, 'temperature');
});

test('a station that last reported days ago is not current heat: no metrics, and the note says when it last reported', async () => {
  const heat = await observationAt('2026-10-30T21:00:00+00:00');
  assert.equal(heat.observation.status, 'no-data');
  assert.deepEqual(heat.observation.metrics, []);
  assert.equal(heat.observation.timestamp, '2026-10-30T21:00:00+00:00');
  assert.match(heat.note, /The nearest NWS station has not reported since Oct 30, /);
});

test('a station silent since an earlier year is dated with that year, not read as a coming day', async () => {
  const heat = await observationAt('2025-11-10T23:00:00+00:00');
  assert.equal(heat.observation.status, 'no-data');
  assert.match(heat.note, /has not reported since Nov 10, 2025, /);
});
