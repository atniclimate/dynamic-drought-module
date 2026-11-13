import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The NWRFC `FcstDate` column echoes the requested `WyrDate` (we send today),
 * so the briefing never states it as an issue date: no "issued" in the claim
 * text and no `dates.issued` on either claim, only the retrieval day.
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

const { fetchWaterSupplyClaims, clearWaterSupplyRowsCache, waterSupplyPointForBasin } = await import(
  '../src/impact/water-supply.ts'
);

const WA_SELECTION = {
  kind: 'ecoregion',
  title: 'Test selection',
  properties: null,
  lngLat: { lng: -120.5, lat: 47.2 },
  place: null,
  containing: { state: 'WA', basis: 'point-in-polygon' },
  regionKey: 'washington_state'
};

async function twoBriefings(body) {
  clearWaterSupplyRowsCache();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(body);
  };
  try {
    await fetchWaterSupplyClaims(WA_SELECTION, new AbortController().signal);
    const second = await fetchWaterSupplyClaims(WA_SELECTION, new AbortController().signal);
    return { requests, second };
  } finally {
    globalThis.fetch = originalFetch;
    clearWaterSupplyRowsCache();
  }
}

test('a header-only NWRFC report (no forecast yet this water year) is cached: the next briefing asks again for nothing', async () => {
  const { requests, second } = await twoBriefings('ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n');
  assert.equal(requests, 1);
  assert.match(second.note, /carried no APR-SEP forecast/);
});

test('a 200 answer with no report header is a failed read, never cached', async () => {
  const { requests, second } = await twoBriefings('<html><body>Service unavailable</body></html>');
  assert.equal(requests, 2);
  assert.match(second.note, /did not respond/);
});

test('the forecast claim states the number and its 50 percent exceedance only: no DDM band sentence (DR-046 a)', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const pct of [20, 74, 88, 100, 130]) {
      clearWaterSupplyRowsCache();
      globalThis.fetch = async () =>
        new Response(
          'ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n' +
            `BONO3,COLUMBIA - BONNEVILLE DAM,APR-SEP,${pct},95,2026-10-08`
        );
      const result = await fetchWaterSupplyClaims(WA_SELECTION, new AbortController().signal);
      const forecast = result.claims.at(-1);
      assert.match(forecast.text, new RegExp(`is ${pct} percent of the 1991-2020 normal \\(50 percent exceedance\\)\\.`));
      assert.ok(forecast.text.endsWith('not a site-specific value.'), `${pct} percent: ${forecast.text}`);
      assert.match(forecast.uncertainty.text, /50 percent exceedance/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearWaterSupplyRowsCache();
  }
});

test('water-supply claims never present the echoed FcstDate as an issue date', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    requested.push(decodeURIComponent(String(input)));
    return new Response(
      'ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n' +
        'BONO3,COLUMBIA - BONNEVILLE DAM,APR-SEP,88,95,2026-10-08'
    );
  };
  try {
    const selection = {
      kind: 'ecoregion',
      title: 'Test selection',
      properties: null,
      lngLat: { lng: -120.5, lat: 47.2 },
      place: null,
      containing: { state: 'WA', basis: 'point-in-polygon' },
      regionKey: 'washington_state'
    };
    const result = await fetchWaterSupplyClaims(selection, new AbortController().signal);
    assert.equal(result.claims.length, 2);
    for (const claim of result.claims) {
      assert.doesNotMatch(claim.text, /issued/i);
      assert.equal(claim.dates.issued, undefined);
      assert.match(claim.dates.retrieved, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.match(result.claims[1].text, /\(50 percent exceedance\)\./);
    // The forecast names its water year: from October it is the coming season.
    assert.match(result.claims[1].text, /April-September 20\d\d water-supply forecast/);
    // The request date and the claim's retrieval date are the same local day.
    assert.ok(requested[0].includes(`WyrDate=${result.claims[0].dates.retrieved}&`));

    // A second briefing reuses the day's report instead of downloading it again.
    const again = await fetchWaterSupplyClaims(selection, new AbortController().signal);
    assert.equal(again.claims.length, 2);
    assert.equal(requested.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * A Tribal place or a watershed reads the forecast point on its own river.
 * The reader's fault (2026-11-13): the Umatilla Reservation briefing quoted
 * the Deschutes at Moody, because the point was chosen by state alone. The
 * place's basin is its USGS Watershed Boundary Dataset code: a watershed
 * place carries its own, a Tribal place asks the WBD service for the HUC8
 * at its point.
 */

const BASIN_QUERY = '/wbd/MapServer/4/query';
const REPORT =
  'ID,Location,FcstPeriod,50PerAvg,CurPerAvg,FcstDate\n' +
  'BONO3,COLUMBIA - BONNEVILLE DAM,APR-SEP,79,NA,2026-11-12\n' +
  'MODO3,DESCHUTES - AT MOODY NR BIGGS,APR-SEP,93,NA,2026-11-12\n' +
  'PDTO3,UMATILLA - AT PENDLETON,APR-SEP,82,NA,2026-11-12\n' +
  'SLMO3,WILLAMETTE - AT SALEM,APR-SEP,89,NA,2026-11-12';

/** The WBD answer shape observed live 2026-11-12 (f=geojson, returnGeometry=false). */
const basinAnswer = (...codes) =>
  JSON.stringify({
    type: 'FeatureCollection',
    features: codes.map((huc8) => ({ type: 'Feature', geometry: null, properties: { huc8, name: 'Stand-in' } }))
  });

const tribalPlace = (title, lng, lat) => ({
  kind: 'aiannh',
  title,
  properties: null,
  lngLat: { lng, lat },
  pointInsidePlace: true,
  place: null,
  containing: { state: 'OR', basis: 'point-in-polygon' },
  // The camera sits elsewhere on purpose: the place decides, never the camera.
  regionKey: 'washington_state'
});
const UMATILLA = tribalPlace('Confederated Tribes of the Umatilla Indian Reservation', -118.68, 45.67);
const WARM_SPRINGS = tribalPlace('Confederated Tribes of the Warm Springs Reservation of Oregon', -121.27, 44.76);
const SILETZ = tribalPlace('Confederated Tribes of Siletz Indians of Oregon', -123.92, 44.72);

/** One briefing read; `basin` is the WBD body, or a function returning its Response. */
async function basinBriefing(selection, basin, signal = new AbortController().signal) {
  clearWaterSupplyRowsCache();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = decodeURIComponent(String(input));
    requested.push(url);
    if (!url.includes(BASIN_QUERY)) return new Response(REPORT);
    return typeof basin === 'function' ? basin() : new Response(basin);
  };
  try {
    return { result: await fetchWaterSupplyClaims(selection, signal), requested };
  } finally {
    globalThis.fetch = originalFetch;
    clearWaterSupplyRowsCache();
  }
}

test('the Umatilla Reservation reads the Umatilla forecast point, never the Deschutes', async () => {
  const { result, requested } = await basinBriefing(UMATILLA, basinAnswer('17070103'));
  assert.equal(result.ok, true);
  const forecast = result.claims.at(-1);
  assert.match(forecast.text, /forecast at Umatilla - At Pendleton is 82 percent/);
  assert.match(forecast.support.reporting, /\(PDTO3\)/);
  assert.ok(forecast.sourceUrl.endsWith('id=PDTO3'));
  assert.doesNotMatch(JSON.stringify(result.claims), /Deschutes|MODO3|Bonneville/);
  // The basin is asked for at the place's own point, then the report once.
  assert.equal(requested.length, 2);
  assert.ok(requested[0].includes(BASIN_QUERY) && requested[0].includes('geometry=-118.68,45.67'), requested[0]);
  // Two named fields: the upstream-drift field probe refuses a one-field list.
  assert.ok(requested[0].includes('outFields=huc8,name&'), requested[0]);
});

test('a place in the Deschutes basin keeps the Deschutes forecast point', async () => {
  const { result } = await basinBriefing(WARM_SPRINGS, basinAnswer('17070306'));
  const forecast = result.claims.at(-1);
  assert.match(forecast.text, /forecast at Deschutes - At Moody Nr Biggs is 93 percent/);
  assert.match(forecast.support.reporting, /\(MODO3\)/);
});

test('a place whose basin has no forecast point reads none, and the report is not downloaded', async () => {
  const { result, requested } = await basinBriefing(SILETZ, basinAnswer('17100204'));
  assert.deepEqual(result, { claims: [], ok: true });
  assert.equal(requested.length, 1);
});

test('a basin code resolves to the point on its own river, else its containing mainstem, else nothing', () => {
  assert.equal(waterSupplyPointForBasin('17070103'), 'PDTO3');
  assert.equal(waterSupplyPointForBasin('17070306'), 'MODO3');
  // No river-level point: the Columbia above Bonneville Dam contains the Sanpoil.
  assert.equal(waterSupplyPointForBasin('17020004'), 'BONO3');
  // A HUC4 watershed place: the Yakima has its own point, the Middle Columbia only the mainstem.
  assert.equal(waterSupplyPointForBasin('1703'), 'KIOW1');
  assert.equal(waterSupplyPointForBasin('1707'), 'BONO3');
  // Puget Sound and the coast do not drain to Bonneville; Washington's own
  // Deschutes (17110016) is another river than Oregon's.
  for (const code of ['17110019', '17110016', '17100204', '17080006', '17', '18010206', '']) {
    assert.equal(waterSupplyPointForBasin(code), undefined, code);
  }
});

test('a watershed place uses its own code and asks the boundary service for nothing', async () => {
  const watershed = (properties) => ({ ...UMATILLA, kind: 'watershed', title: 'Stand-in watershed', properties });
  const willamette = await basinBriefing(watershed({ huc4: '1709' }), basinAnswer('17070103'));
  assert.match(willamette.result.claims.at(-1).text, /forecast at Willamette - At Salem is 89 percent/);
  assert.equal(willamette.requested.length, 1);
  assert.ok(!willamette.requested[0].includes(BASIN_QUERY));
  // The whole Pacific Northwest region (HUC2 17) is no single river's basin.
  const region = await basinBriefing(watershed({ huc2: 17 }), basinAnswer('17070103'));
  assert.deepEqual(region.result, { claims: [], ok: true });
  assert.equal(region.requested.length, 0);
});

test('a failed basin read is unavailable, never a forecast and never a no-data claim', async () => {
  const failures = {
    'blank 200 body': '',
    'corrupt body': '{"type":"FeatureCollection","features":[',
    'not JSON at all': REPORT,
    'ArcGIS error envelope under HTTP 200': '{"error":{"code":400,"message":"Unable to complete operation."}}',
    'partial page': JSON.stringify({ ...JSON.parse(basinAnswer('17070103')), exceededTransferLimit: true }),
    'a feature with no usable code': JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: null, properties: { huc8: '1707', name: 'Stand-in' } }]
    }),
    'HTTP 503': () => new Response('Synthetic offline response', { status: 503 })
  };
  for (const [label, basin] of Object.entries(failures)) {
    const { result, requested } = await basinBriefing(UMATILLA, basin);
    assert.deepEqual(result, { claims: [], ok: false }, label);
    assert.equal(requested.length, 1, `${label}: the report must not be downloaded`);
  }
});

test('a point outside every hydrologic unit is a verified absence: no forecast, nothing failed', async () => {
  const { result, requested } = await basinBriefing(UMATILLA, basinAnswer());
  assert.deepEqual(result, { claims: [], ok: true });
  assert.equal(requested.length, 1);
});

test('a briefing abandoned during the basin body read stops there with nothing pending', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const hangingBody = () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"type":"FeatureCollection",'));
          setTimeout(() => controller.abort(), 0);
        },
        cancel() {
          cancelled = true;
        }
      })
    );
  const { result, requested } = await basinBriefing(UMATILLA, hangingBody, controller.signal);
  assert.deepEqual(result, { claims: [], ok: false });
  assert.equal(requested.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true, 'the body stream must be cancelled, leaving no pending read');
});

test('a basin answer that lands after the briefing was superseded starts no report download', async () => {
  const controller = new AbortController();
  const lateAnswer = () => {
    controller.abort();
    return new Response(basinAnswer('17070103'));
  };
  const { result, requested } = await basinBriefing(UMATILLA, lateAnswer, controller.signal);
  assert.deepEqual(result, { claims: [], ok: false });
  assert.equal(requested.length, 1);
});
