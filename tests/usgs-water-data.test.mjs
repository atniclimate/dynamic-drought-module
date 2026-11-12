import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { after, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The stream gauges read the USGS Water Data APIs (OGC API Features) behind
 * the same functions the popup, the sidebar and the map's discovery called
 * before (src/util/usgs.ts, src/config/station-registry.ts). Every answer
 * here is a trimmed copy of a live answer recorded 2026-11-06 at 05:39 UTC
 * (tests/fixtures/usgs/); no test reaches a host.
 *
 * The tests share one module instance, so they run in order: the session
 * names its gauges first, and the later views prove the names are reused.
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

// The recording's own clock, so freshness reads as it did then (Date only).
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T05:39:26Z') });
const usgs = await import('../src/util/usgs.ts');
const { discoverStationsForViewport } = await import('../src/config/station-registry.ts');
const { hydrateTelemetryPopup } = await import('../src/ui/popups.ts');
const { TELEMETRY_STATIONS } = await import('../src/config/telemetry.ts');

const API = 'https://api.waterdata.usgs.gov/ogcapi/v1/';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/usgs/${name}`, import.meta.url), 'utf8'));
const SERIES = fixture('continuous-14103000.json');
const VIEW = fixture('latest-continuous-view.json');
const NAMES = fixture('monitoring-locations-names.json');

// What the legacy service answered for the same gauge at 05:02 UTC that day:
// the values, units, time and name a visitor saw before the move.
const LEGACY = {
  discharge: 4350,
  dischargeUnit: 'ft3/s',
  gageHeight: '2.87 ft',
  at: Date.parse('2026-11-05T20:45:00.000-08:00'),
  name: 'DESCHUTES RIVER AT MOODY, NEAR BIGGS, OR'
};

const MODO3 = TELEMETRY_STATIONS.find((station) => station.id === 'modo3');
const CONW1 = TELEMETRY_STATIONS.find((station) => station.id === 'conw1');
const DISCOVERY = 'USGS IV station discovery';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
console.warn = () => {};
after(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const collection = (features, links = []) => ({ type: 'FeatureCollection', features, numberReturned: features.length, links });
/** The collection a request asked: continuous, latest-continuous or monitoring-locations. */
const kind = (url) => url.pathname.slice(new URL(API).pathname.length).split('/')[1];

/** Every request is recorded; USGS ones get `answer(url)`, any other host is down. */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (!url.href.startsWith(API)) throw new TypeError('network down');
    return answer(url, init);
  };
  return { calls, usgs: () => calls.filter((call) => call.url.href.startsWith(API)) };
}

/** The recorded answers, by collection; names only for the ids asked. */
function recorded(extraRows = [], extraNames = []) {
  return (url) => {
    if (kind(url) === 'continuous') return json(SERIES);
    if (kind(url) === 'latest-continuous') return json(collection([...VIEW.features, ...extraRows]));
    if (kind(url) === 'monitoring-locations') {
      const ids = new Set(url.searchParams.get('id').split(','));
      return json(collection([...NAMES.features, ...extraNames].filter((feature) => ids.has(feature.id))));
    }
    return json({ code: 'NotFound', type: 'NotFound', description: 'Collection not found' }, 404);
  };
}

const view = (west, south, east, north) => ({
  bounds: { west, south, east, north },
  center: [(south + north) / 2, (west + east) / 2],
  signal: null
});
const usgsRecords = (result) => result.records.filter((record) => record.network === 'usgs-iv');
const head = (paint) => paint.model.value[0];

test('a typical session asks USGS six times: the layer, one view and its names, two gauges', async () => {
  const { calls, usgs: usgsCalls } = stubFetch(recorded());

  // Opening the layer: the sidebar reads each curated gauge (src/ui/sidebar.ts
  // fetchPrimaryStationValue), and the Washington framing is wider than the gate.
  const curated = TELEMETRY_STATIONS.filter((station) => station.usgsSite);
  assert.deepEqual(curated.map((station) => station.usgsSite), ['14103000', '12194000']);
  for (const station of curated) {
    const value = usgs.usgsLatestStationValue(station.id, await usgs.fetchUsgsIV(station.usgsSite, null));
    assert.equal(value?.value, LEGACY.discharge);
  }
  assert.equal((await discoverStationsForViewport(view(-124.8, 45.5, -116.9, 49))).status, 'zoom-in');
  assert.equal(usgsCalls().length, 2, 'the layer itself costs one read per curated gauge');

  // One view: its latest values, then the names of its gauges. A small pan
  // inside the queried box is answered from the session.
  const first = await discoverStationsForViewport(view(-122.6, 45.2, -119.6, 47.2));
  assert.deepEqual(usgsRecords(first).map((record) => record.station.name), [LEGACY.name]);
  await discoverStationsForViewport(view(-122.8, 45.2, -119.8, 47.2));
  assert.deepEqual(usgsCalls().slice(2).map((call) => kind(call.url)), ['latest-continuous', 'monitoring-locations']);

  // Two gauges opened: one 7-day read each.
  for (const station of [MODO3, CONW1]) {
    assert.equal(head(await hydrateTelemetryPopup(station, new AbortController().signal)).label, 'Discharge');
  }
  assert.equal(usgsCalls().length, 6);

  // Every id carries its USGS- prefix; no request carries a key or a header; none is legacy.
  const names = usgsCalls().find((call) => kind(call.url) === 'monitoring-locations').url.searchParams;
  assert.deepEqual(
    names.get('id').split(',').sort(),
    ['USGS-12175000', 'USGS-12179000', 'USGS-12194000', 'USGS-14046500', 'USGS-14103000'],
    'names only for the gauges that have a reading'
  );
  assert.equal(names.get('limit'), '6', 'one more than asked, so no empty next page is linked');
  for (const { url, init } of calls) {
    assert.notEqual(url.hostname, 'waterservices.usgs.gov');
    assert.equal(/api_?key/i.test(url.search), false, url.href);
    assert.equal(init?.headers, undefined);
    for (const id of url.searchParams.get('monitoring_location_id')?.split(',') ?? []) assert.match(id, /^USGS-\d+$/);
  }
});

test('a map view parses to the same station records, and names the session holds are not asked again', async () => {
  const { usgs: usgsCalls } = stubFetch(recorded());
  const result = await discoverStationsForViewport(view(-124.5, 44.5, -119.5, 49.5));
  assert.equal(result.status, 'ok');
  assert.deepEqual(usgsCalls().map((call) => kind(call.url)), ['latest-continuous'], 'every name was already held');
  const asked = usgsCalls()[0].url.searchParams;
  assert.equal(asked.get('bbox'), '-124.5,44.5,-119.5,49.5');
  assert.equal(asked.get('parameter_code'), '00060,00065');
  assert.equal(asked.get('time'), 'P183D', 'the legacy active-site span');

  const byId = new Map(usgsRecords(result).map((record) => [record.station.id, record]));
  // DISCONTINUED with no value, DAMFAILURE and DRY rows carry no reading DDM shows, so those gauges make no marker.
  assert.deepEqual([...byId.keys()].sort(), ['usgs-12175000', 'usgs-12179000', 'usgs-12194000', 'usgs-14046500', 'usgs-14103000']);
  // Field for field what the legacy parser built for the Deschutes at Moody.
  assert.deepEqual(byId.get('usgs-14103000'), {
    network: 'usgs-iv',
    station: {
      id: 'usgs-14103000',
      name: LEGACY.name,
      coords: [45.6220678034004, -120.905620323184],
      region: 'discovered',
      type: 'gage',
      agency: 'USGS',
      color: '#06b6d4',
      description: 'USGS Instantaneous Values station discovered in the current viewport.',
      usgsSite: '14103000',
      links: [{ label: 'USGS streamgage', url: 'https://waterdata.usgs.gov/monitoring-location/14103000' }]
    },
    value: {
      stationId: 'usgs-14103000',
      parameter: 'discharge_cfs',
      label: 'Discharge',
      value: LEGACY.discharge,
      unit: LEGACY.dischargeUnit,
      timestamp: '2026-11-06T04:45:00+00:00',
      freshness: 'fresh',
      source: 'usgs-iv'
    },
    primaryParameterCategory: 'streamflow',
    handles: { usgsSite: '14103000' }
  });
  assert.equal(Date.parse(byId.get('usgs-14103000').value.timestamp), LEGACY.at);
  // Two sensors on one gauge's gage height make one marker, a stage gauge.
  const twoSensors = byId.get('usgs-12175000');
  assert.deepEqual([twoSensors.value.parameter, twoSensors.value.value, twoSensors.value.unit], ['gage_height_ft', 1567.58, 'ft']);
  assert.equal(twoSensors.primaryParameterCategory, 'stage');
  // A gauge silent for 16 days still shows, marked stale, as under the legacy active-site rule.
  assert.deepEqual([byId.get('usgs-12179000').value.value, byId.get('usgs-12179000').value.freshness], [4650, 'stale']);
});

test('a new view asks names only for the gauges the session has not named', async () => {
  const newRow = structuredClone(VIEW.features.find((f) => f.properties.monitoring_location_id === 'USGS-14046500'));
  newRow.properties.monitoring_location_id = 'USGS-14046000';
  newRow.geometry.coordinates = [-119.5, 44];
  const newName = { type: 'Feature', properties: { monitoring_location_name: 'FIXTURE CREEK NEAR NOWHERE, OR' }, id: 'USGS-14046000', geometry: null };
  const { usgs: usgsCalls } = stubFetch(recorded([newRow], [newName]));
  const result = await discoverStationsForViewport(view(-121, 43, -117, 46));
  const names = usgsCalls().filter((call) => kind(call.url) === 'monitoring-locations');
  assert.equal(names.length, 1);
  assert.equal(names[0].url.searchParams.get('id'), 'USGS-14046000');
  assert.ok(usgsRecords(result).some((record) => record.station.name === 'FIXTURE CREEK NEAR NOWHERE, OR'));
});

test('one gauge week reads exactly as the legacy service gave it, whatever the row order', async () => {
  const reversed = collection([...SERIES.features].reverse());
  const { calls } = stubFetch(() => json(reversed));
  const payload = await usgs.fetchUsgsIV('14103000', null);
  assert.equal(calls.length, 1);
  const asked = calls[0].url.searchParams;
  assert.equal(kind(calls[0].url), 'continuous');
  assert.deepEqual(
    [asked.get('monitoring_location_id'), asked.get('parameter_code'), asked.get('time'), asked.get('limit')],
    ['USGS-14103000', '00060,00065', 'P7D', '5000']
  );

  const series = usgs.extractTimeSeries(payload);
  assert.deepEqual(series.map((s) => [s.code, s.unit, s.readings.length]), [['00060', 'ft3/s', 8], ['00065', 'ft', 8]]);
  for (const s of series) {
    const times = s.readings.map((reading) => Date.parse(reading.dateTime));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${s.code} oldest first`);
  }
  const latest = usgs.usgsLatestStationValue('modo3', payload);
  assert.deepEqual(latest, {
    stationId: 'modo3',
    parameter: 'discharge_cfs',
    label: 'Discharge',
    value: LEGACY.discharge,
    unit: LEGACY.dischargeUnit,
    timestamp: '2026-11-06T04:45:00+00:00',
    freshness: 'fresh',
    source: 'usgs-iv'
  });
  assert.equal(Date.parse(latest.timestamp), LEGACY.at);

  // A prefixed id is sent as it is, never as USGS-USGS-.
  await usgs.fetchUsgsIV('USGS-14103000', null);
  assert.equal(calls[1].url.searchParams.get('monitoring_location_id'), 'USGS-14103000');
});

test('the popup shows the same reading, units, time and sparkline as before', async () => {
  stubFetch(() => json(collection([...SERIES.features].reverse())));
  const paint = await hydrateTelemetryPopup(MODO3, new AbortController().signal);
  assert.deepEqual(head(paint), { label: 'Discharge', text: '4,350 ft3/s', issuer: 'USGS Water Data APIs' });
  assert.equal(paint.model.clocks[0].at.at, LEGACY.at);
  const reading = paint.model.details.find((detail) => detail.kind === 'reading');
  assert.deepEqual([reading.label, reading.text], ['Gage height', LEGACY.gageHeight]);
  const chart = paint.model.details.find((detail) => detail.kind === 'chart');
  assert.deepEqual(
    [chart.label, chart.unit, chart.attribution],
    ['Discharge over the past 7 days (USGS)', 'ft3/s', 'USGS Water Data APIs, past 7 days']
  );
  const discharge = SERIES.features.filter((f) => f.properties.parameter_code === '00060').map((f) => Number(f.properties.value));
  assert.deepEqual(chart.data, discharge, 'the sparkline runs oldest to newest');
  assert.equal(typeof paint.mount, 'function');
});

test('a null value or an unknown qualifier is unknown, never a number', async () => {
  const discharge = SERIES.features.filter((f) => f.properties.parameter_code === '00060');
  const row = (minutesAfterLatest, value, qualifier) => ({
    type: 'Feature',
    properties: {
      ...discharge[0].properties,
      time: new Date(Date.parse('2026-11-06T04:45:00Z') + minutesAfterLatest * 60_000).toISOString().replace('.000Z', '+00:00'),
      value,
      qualifier
    },
    id: `row-${minutesAfterLatest}`,
    geometry: null
  });
  const payload = { features: [row(15, null, null), row(30, '9999', ['EQUIP']), row(45, null, ['ICE']), ...discharge].reverse() };
  const [series] = usgs.extractTimeSeries(payload);
  assert.equal(usgs.readLatestUsgsReading(series).value, '4350', 'walks back past null, ICE and EQUIP');
  assert.equal(usgs.readValueArray(series).length, discharge.length);
  assert.equal(usgs.usgsLatestStationValue('modo3', { features: [row(15, '4400', ['ESTIMATED']), ...discharge] }).value, 4400);

  // A week of nothing readable: the popup says so, as it did for the legacy -999999, and never shows 0.
  stubFetch(() => json(collection([row(0, null, ['ICE']), row(15, null, null), row(30, '0', ['DRY'])])));
  const paint = await hydrateTelemetryPopup(MODO3, new AbortController().signal);
  assert.deepEqual(head(paint), { text: 'No active sensors at this site.', state: 'no data' });
});

test('an ESTIMATED reading carries USGS\'s word Estimated beside its value; a null qualifier does not', async () => {
  const discharge = SERIES.features.filter((f) => f.properties.parameter_code === '00060');
  const estimated = {
    type: 'Feature',
    properties: { ...discharge[0].properties, time: '2026-11-06T05:00:00+00:00', value: '4400', qualifier: ['ESTIMATED'] },
    id: 'row-estimated',
    geometry: null
  };
  assert.equal(usgs.usgsLatestStationValue('modo3', { features: [estimated, ...discharge] }).estimated, true);
  assert.equal(usgs.usgsLatestStationValue('modo3', { features: discharge }).estimated, undefined);

  stubFetch(() => json(collection([estimated, ...SERIES.features])));
  assert.equal(head(await hydrateTelemetryPopup(MODO3, new AbortController().signal)).text, '4,400 ft3/s (Estimated)');
  stubFetch(() => json(SERIES));
  assert.equal(head(await hydrateTelemetryPopup(MODO3, new AbortController().signal)).text, '4,350 ft3/s');
});

test('a week with no rows reads as no recent values, in the legacy words; a failed read stays unavailable', async () => {
  // The id always carries its USGS- prefix, so an empty week is the gauge's own answer, not the bare-number trap.
  const empty = stubFetch(() => json(collection([])));
  assert.deepEqual(await usgs.fetchUsgsIV('14103000', null), { features: [] });
  assert.equal(empty.calls[0].url.searchParams.get('monitoring_location_id'), 'USGS-14103000');
  assert.equal(usgs.usgsLatestStationValue('modo3', { features: [] }), null);
  assert.deepEqual(head(await hydrateTelemetryPopup(MODO3, new AbortController().signal)), {
    text: 'No recent USGS values for this site.',
    state: 'no data'
  });
  stubFetch(() => json({ code: 'ServerError', description: 'Internal Server Error' }, 503));
  assert.equal(head(await hydrateTelemetryPopup(MODO3, new AbortController().signal)).state, 'unavailable');
});

test('a second page is read from the answer\'s own next link, and pages are bounded', async () => {
  const older = SERIES.features.slice(0, 8);
  const newer = SERIES.features.slice(8);
  const next = `${API}collections/continuous/items?cursor=c2Vjb25k&f=json`;
  const paged = stubFetch((url) =>
    url.searchParams.get('cursor') === 'c2Vjb25k' ? json(collection(newer)) : json(collection(older, [{ rel: 'next', href: next }]))
  );
  const payload = await usgs.fetchUsgsIV('14103000', null);
  assert.deepEqual(paged.calls.map((call) => call.url.href).slice(1), [next], 'the link as given, never rebuilt');
  assert.equal(payload.features.length, older.length + newer.length);

  let page = 0;
  const endless = stubFetch(() => json(collection(older, [{ rel: 'next', href: `${API}collections/continuous/items?cursor=${++page}` }])));
  await assert.rejects(usgs.fetchUsgsIV('14103000', null), /ran past 3 pages/);
  assert.equal(endless.calls.length, 3);

  const offApi = stubFetch(() => json(collection(older, [{ rel: 'next', href: 'https://example.org/items?cursor=1' }])));
  await assert.rejects(usgs.fetchUsgsIV('14103000', null), /left the API/);
  assert.equal(offApi.calls.length, 1);
});

test('5xx, a timeout, corrupt JSON or a page past the body cap reads as unavailable, and as a failed source on the map', async () => {
  const answers = [
    () => json({ code: 'ServerError', description: 'Internal Server Error' }, 503),
    () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    () => new Response('{"type":"FeatureCollection","features":[', { status: 200 }),
    () => new Response('x'.repeat(2.5 * 1024 * 1024 + 1), { status: 200 })
  ];
  for (const answer of answers) {
    stubFetch(answer);
    await assert.rejects(usgs.fetchUsgsIV('14103000', null));
    assert.equal(head(await hydrateTelemetryPopup(MODO3, new AbortController().signal)).state, 'unavailable');
    mock.timers.tick(61 * 60 * 1000);
    const result = await discoverStationsForViewport(view(-124.5, 44.5, -119.5, 49.5));
    assert.equal(result.status, 'ok');
    assert.ok(result.failedSources.includes(DISCOVERY), 'the pill reads live (partial), not no data');
    assert.equal(usgsRecords(result).length, 0);
  }
});

test('a refusal for rate pauses every USGS read for ten minutes instead of retrying', async () => {
  const refused = stubFetch(() => json({ error: { code: 'OVER_RATE_LIMIT', message: 'API rate limit exceeded' } }, 429));
  await assert.rejects(usgs.fetchUsgsIV('14103000', null), /USGS HTTP 429/);
  // Nine minutes on: a new view and an opened gauge send nothing and read as failed and unavailable.
  mock.timers.tick(9 * 60 * 1000);
  const result = await discoverStationsForViewport(view(-110, 40, -106, 44));
  assert.ok(result.failedSources.includes(DISCOVERY));
  assert.equal(head(await hydrateTelemetryPopup(MODO3, new AbortController().signal)).state, 'unavailable');
  assert.equal(refused.usgs().length, 1, 'nothing more reached USGS');

  mock.timers.tick(60 * 1000);
  const resumed = stubFetch(recorded());
  assert.ok(usgs.usgsLatestStationValue('modo3', await usgs.fetchUsgsIV('14103000', null)));
  assert.equal(resumed.usgs().length, 1);
});
