import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A station roster answered with an error object (or an unreadable AgriMet
 * script) is a failed source, not an empty one: it is recorded as failed and
 * never cached, so the next viewport reads the network again.
 */

// Extensionless relative `.ts` imports (see tests/hydrate-lane-reject.test.mjs).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

// Mock Date (only Date) before the import so the roster caches read a clock
// the partial-list test can advance; it stays at the real time otherwise.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
const { discoverStationsForViewport } = await import('../src/config/station-registry.ts');

const ROSTERS = [
  { label: 'NRCS AWDB station discovery', network: 'nrcs-awdb' },
  { label: 'NOAA CO-OPS station discovery', network: 'noaa-coops' },
  { label: 'USBR AgriMet station discovery', network: 'usbr-agrimet' },
  { label: 'CoCoRaHS station discovery', network: 'cocorahs' }
];

const GOOD = {
  awdb: [{ stationTriplet: '1:WA:SNTL', name: 'Test Pass', latitude: 46.5, longitude: -120.5 }],
  coops: { stations: [{ id: '9999', name: 'Test Harbor', lat: 46.5, lng: -120.5, state: 'WA' }] },
  agrimet: `agrimet_sites = '${JSON.stringify({
    features: [
      {
        geometry: { coordinates: [-120.5, 46.5] },
        properties: { StationID: 'TEST', StationName: 'Test Farm', StationState: 'WA' }
      }
    ]
  })}';`,
  cocorahs: {
    features: [
      {
        geometry: { coordinates: [-120.5, 46.5] },
        properties: { online: true, sid: 'WA-TEST-1', sname: 'Test Gauge', state: 'WA' }
      }
    ]
  }
};

function installFetch(answers) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    let body = null;
    if (url.includes('wcc.sc.egov.usda.gov')) body = answers.awdb;
    else if (url.includes('tidesandcurrents.noaa.gov')) body = answers.coops;
    else if (url.includes('AgrimetSites.js') || url.includes(encodeURIComponent('AgrimetSites.js'))) {
      return new Response(answers.agrimet, { status: 200 });
    } else if (url.includes('mesonet.agron.iastate.edu')) body = answers.cocorahs;
    if (body === null) throw new TypeError('network down');
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

const REQUEST = {
  bounds: { south: 46, west: -121, north: 47, east: -120 },
  center: [46.5, -120.5],
  signal: null
};

test('a roster answered with an error object is failed and not cached', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    installFetch({
      awdb: { error: 'service unavailable' },
      coops: { error: 'service unavailable' },
      agrimet: '<html>maintenance</html>',
      cocorahs: { error: 'service unavailable' }
    });
    const bad = await discoverStationsForViewport(REQUEST);
    assert.equal(bad.status, 'ok');
    for (const { label } of ROSTERS) {
      assert.ok(bad.failedSources.includes(label), `${label} is recorded as failed`);
    }

    installFetch(GOOD);
    const good = await discoverStationsForViewport(REQUEST);
    assert.equal(good.status, 'ok');
    for (const { label, network } of ROSTERS) {
      assert.ok(!good.failedSources.includes(label), `${label} recovers on the next read`);
      assert.ok(
        good.records.some((record) => record.network === network),
        `${network} records come back, so the bad answer was not cached`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

/**
 * When one AWDB network fails and the other answers, the stations that came
 * back still render, the source is recorded as failed (the pill reads
 * "live (partial)"), and the partial list is cached only briefly, so the
 * failed network is asked again about 30 seconds later.
 */
test('one failed AWDB network is reported as partial and retried soon', async () => {
  const LABEL = 'NRCS AWDB station discovery';
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  // Expire the complete roster the previous test cached for an hour.
  mock.timers.tick(61 * 60 * 1000);
  let sntlUp = false;
  let sntlCalls = 0;
  globalThis.fetch = async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes('wcc.sc.egov.usda.gov') && url.includes(':SNTL')) {
      sntlCalls += 1;
      if (!sntlUp) throw new TypeError('network down');
      const body = [{ stationTriplet: '1:WA:SNTL', name: 'Test Pass', latitude: 46.5, longitude: -120.5 }];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes('wcc.sc.egov.usda.gov') && url.includes(':SCAN')) {
      const body = [{ stationTriplet: '2:WA:SCAN', name: 'Test Field', latitude: 46.6, longitude: -120.6 }];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new TypeError('network down');
  };
  const awdbIds = (result) =>
    result.records.filter((r) => r.network === 'nrcs-awdb').map((r) => r.station.id);
  try {
    const partial = await discoverStationsForViewport(REQUEST);
    assert.equal(partial.status, 'ok');
    assert.ok(partial.failedSources.includes(LABEL), 'a partial roster is a failed source');
    assert.deepEqual(awdbIds(partial), ['scan-2:wa:scan'], 'the SCAN stations still render');

    sntlUp = true;
    const cached = await discoverStationsForViewport(REQUEST);
    assert.equal(sntlCalls, 1, 'the partial list is served from cache at first');
    assert.ok(cached.failedSources.includes(LABEL), 'and still reads as partial');

    mock.timers.tick(31 * 1000);
    const whole = await discoverStationsForViewport(REQUEST);
    assert.equal(sntlCalls, 2, 'the failed network is asked again after 30 s');
    assert.ok(!whole.failedSources.includes(LABEL), 'the complete roster reads as healthy');
    assert.equal(awdbIds(whole).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

/**
 * A fetch-helper timeout rejects with an AbortError too. While the caller's
 * own signal is live it is a provider failure, so the rest still renders.
 */
test('a provider timeout (AbortError, caller not aborted) gives a partial list', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  // Expire the rosters the previous tests cached.
  mock.timers.tick(61 * 60 * 1000);
  globalThis.fetch = async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes('wcc.sc.egov.usda.gov') && url.includes(':SCAN')) {
      const body = [{ stationTriplet: '2:WA:SCAN', name: 'Test Field', latitude: 46.6, longitude: -120.6 }];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new DOMException('timed out', 'AbortError');
  };
  try {
    const result = await discoverStationsForViewport(REQUEST);
    assert.equal(result.status, 'ok');
    for (const { label } of ROSTERS) {
      assert.ok(result.failedSources.includes(label), `${label} is recorded as failed`);
    }
    assert.ok(
      result.records.some((r) => r.network === 'nrcs-awdb'),
      'the SCAN stations still render'
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

/**
 * The latest-value readers skip a source's "no reading" marker and walk back
 * to the newest real value, so a gauge never reads as dead because its
 * newest row is a placeholder.
 */

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input));
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a USGS series whose newest value is -999999 falls back to the last real value', async () => {
  const { readLatestUsgsReading, usgsLatestStationValue } = await import('../src/util/usgs.ts');
  const series = {
    variable: { variableCode: [{ value: '00060' }], unit: { unitCode: 'ft3/s' } },
    values: [
      {
        value: [
          { value: '1234.00', dateTime: '2026-10-12T09:45:00.000-07:00' },
          { value: '1250.50', dateTime: '2026-10-12T10:00:00.000-07:00' },
          { value: '-999999', dateTime: '2026-10-12T10:15:00.000-07:00' }
        ]
      }
    ]
  };
  assert.deepEqual(readLatestUsgsReading(series), {
    value: '1250.50',
    dateTime: '2026-10-12T10:00:00.000-07:00'
  });
  const value = usgsLatestStationValue('usgs-1', { value: { timeSeries: [series] } });
  assert.equal(value?.value, 1250.5);
  assert.equal(value?.timestamp, '2026-10-12T10:00:00.000-07:00');
  assert.equal(value?.unit, 'ft3/s');

  const dead = { ...series, values: [{ value: [{ value: '-999999', dateTime: 'x' }, { value: ' ' }] }] };
  assert.equal(readLatestUsgsReading(dead), null);
});

test('a Hydromet NO RECORD on the newest day is skipped for the last posted day', async () => {
  const { fetchHydrometDaily, hydrometStationValue } = await import('../src/util/hydromet.ts');
  const body = [
    '<HTML><BODY><PRE>',
    'BEGIN DATA',
    'DATE       ,    WIC AF,    WIC ET',
    '06/28/2026 ,   1200.00,      0.20',
    '06/29/2026 ,   1234.00,      0.25',
    '06/30/2026 , NO RECORD, NO RECORD',
    'END DATA',
    '</PRE></BODY></HTML>'
  ].join('\n');
  const series = await withFetch(
    () => new Response(body, { status: 200 }),
    () => fetchHydrometDaily(['WIC AF', 'WIC ET'], 3, null)
  );
  const storage = series.find((s) => s.param === 'WIC AF');
  assert.deepEqual(storage?.readings, [
    { date: '2026-06-28', value: 1200 },
    { date: '2026-06-29', value: 1234 }
  ]);
  const value = hydrometStationValue('hm-1', storage);
  assert.equal(value?.value, 1234);
  assert.equal(value?.timestamp, '2026-06-29');

  // The shared fetch helper bounds the body: a runaway page is refused, and a
  // non-OK answer still throws the Hydromet error.
  await assert.rejects(
    withFetch(
      () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }),
      () => fetchHydrometDaily(['WIC AF'], 3, null)
    )
  );
  await assert.rejects(
    withFetch(
      () => new Response('down', { status: 503 }),
      () => fetchHydrometDaily(['WIC AF'], 3, null)
    ),
    /Hydromet HTTP 503/
  );
});

test('a CWMS series with a trailing null returns the newest real value', async () => {
  const { fetchCwmsLatest } = await import('../src/util/cwms.ts');
  const t1 = Date.UTC(2026, 9, 12, 16, 0, 0);
  const t2 = Date.UTC(2026, 9, 12, 17, 0, 0);
  const payload = {
    units: 'ft',
    values: [
      [t1, 1118.456, 0],
      [t2, null, 0]
    ]
  };
  const latest = await withFetch(
    () => new Response(JSON.stringify(payload), { status: 200 }),
    () => fetchCwmsLatest({ office: 'NWDP', tsId: 'X.Elev.Inst.1Hour.0.Best', catalogLike: 'X.Elev.*', label: 'Forebay' }, null)
  );
  assert.deepEqual(latest, { value: 1118.456, unit: 'ft', timestamp: new Date(t1).toISOString() });
});
