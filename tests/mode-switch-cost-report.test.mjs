/**
 * DDM-P14-T08 microtask 1: the pure core the mode-switch cost Playwright
 * spec (microtask 2, not written yet) imports to decide which network
 * requests count, merge runs, compare a baseline against a candidate, and
 * render the committed markdown table.
 *
 * Runs under `node --test`, same pattern as tests/fetch-budget.test.mjs and
 * tests/chunk-retry.test.mjs: import the module directly, no browser, no
 * network, no fs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODE_KEYS,
  SWITCHES,
  switchId,
  isCountedRequest,
  classifyRequest,
  strippedUrl,
  tallyUrls,
  emptyRecord,
  mergeRun,
  compareRuns,
  renderReport
} from '../scripts/mode-switch-cost-report.mjs';

const ORIGIN = 'https://ddm.example.org';

function makeSwitchEntry(pair, overrides = {}) {
  return {
    id: switchId(pair),
    from: pair.from,
    to: pair.to,
    requests: 3,
    dataRequests: 3,
    tileRequests: 0,
    quiescentMs: 400,
    // Non-empty by default so an unrelated test does not accidentally
    // trip the "lower bound" footnote; tests that need the footnote set
    // this to [] explicitly.
    pendingAtStart: ['stub-layer'],
    counted: [{ url: '/data/us-states.geojson', n: 1 }],
    tiles: [],
    ...overrides
  };
}

function makeRun(label, overrides = {}) {
  return {
    label,
    commit: 'abc1234',
    recordedAt: '2026-09-11T00:00:00.000Z',
    viewport: { width: 1280, height: 800 },
    switches: SWITCHES.map((pair) => makeSwitchEntry(pair)),
    ...overrides
  };
}

// --- isCountedRequest: reject / accept rules on same origin -----------

test('isCountedRequest rejects a same-origin asset under /assets/', () => {
  assert.equal(isCountedRequest(`${ORIGIN}/assets/index-Cv_ZPl0o.js`, ORIGIN), false);
});

test('isCountedRequest rejects the same-origin document root', () => {
  assert.equal(isCountedRequest(`${ORIGIN}/`, ORIGIN), false);
});

test('isCountedRequest rejects a same-origin path ending in a slash', () => {
  assert.equal(isCountedRequest(`${ORIGIN}/embed/`, ORIGIN), false);
});

test('isCountedRequest rejects same-origin code and document extensions, case-insensitively, ignoring query and hash', () => {
  assert.equal(isCountedRequest(`${ORIGIN}/main.CSS?v=2#x`, ORIGIN), false);
  assert.equal(isCountedRequest(`${ORIGIN}/favicon.ico`, ORIGIN), false);
  assert.equal(isCountedRequest(`${ORIGIN}/font.woff2`, ORIGIN), false);
  assert.equal(isCountedRequest(`${ORIGIN}/chunk.mjs`, ORIGIN), false);
});

test('isCountedRequest accepts a same-origin data read with no rejected extension', () => {
  assert.equal(isCountedRequest(`${ORIGIN}/data/us-states.geojson`, ORIGIN), true);
  assert.equal(isCountedRequest(`${ORIGIN}/data/enso-indices.json`, ORIGIN), true);
  assert.equal(isCountedRequest(`${ORIGIN}/tiles/conus/0/0/0.pmtiles`, ORIGIN), true);
  assert.equal(isCountedRequest(`${ORIGIN}/api/some-endpoint`, ORIGIN), true);
});

// --- isCountedRequest: cross-origin and scheme rules -------------------

test('isCountedRequest accepts every cross-origin http(s) URL regardless of extension', () => {
  assert.equal(isCountedRequest('https://tiles.example.com/style.css', ORIGIN), true);
  assert.equal(isCountedRequest('http://data.example.net/points.json', ORIGIN), true);
  assert.equal(isCountedRequest('https://cdn.example.com/assets/lib.js', ORIGIN), true);
});

test('isCountedRequest rejects data:, blob:, and about: URLs', () => {
  assert.equal(isCountedRequest('data:text/plain;base64,aGVsbG8=', ORIGIN), false);
  assert.equal(isCountedRequest('blob:https://ddm.example.org/1234', ORIGIN), false);
  assert.equal(isCountedRequest('about:blank', ORIGIN), false);
});

test('isCountedRequest returns false, never throws, for an unparseable string', () => {
  assert.doesNotThrow(() => isCountedRequest('not a url at all', ORIGIN));
  assert.equal(isCountedRequest('not a url at all', ORIGIN), false);
});

// --- classifyRequest: ignored -------------------------------------------

test('classifyRequest returns ignored for anything isCountedRequest rejects', () => {
  assert.equal(classifyRequest(`${ORIGIN}/assets/index.js`, ORIGIN), 'ignored');
  assert.equal(classifyRequest(`${ORIGIN}/`, ORIGIN), 'ignored');
  assert.equal(classifyRequest('data:text/plain;base64,aGVsbG8=', ORIGIN), 'ignored');
  assert.equal(classifyRequest('not a url at all', ORIGIN), 'ignored');
});

// --- classifyRequest: the DescribeDomains / GetCapabilities trap --------

test('classifyRequest returns data for a GIBS WMTS DescribeDomains request, not tile', () => {
  const url =
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0';
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('classifyRequest returns data for a GetCapabilities request, case-insensitively', () => {
  const url = 'https://example.com/wmts/service.cgi?service=wmts&request=getcapabilities';
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

// --- classifyRequest: tile rules -----------------------------------------

test('classifyRequest returns tile for a GIBS WMTS tile URL', () => {
  const url =
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-09-11/GoogleMapsCompatible_Level9/7/22/45.jpg';
  assert.equal(classifyRequest(url, ORIGIN), 'tile');
});

test('classifyRequest returns tile for an ArcGIS ImageServer exportImage URL with a bbox', () => {
  const url =
    'https://example.com/arcgis/rest/services/Fire/MapServer/exportImage?bbox=-120,40,-119,41&f=image';
  assert.equal(classifyRequest(url, ORIGIN), 'tile');
});

test('classifyRequest returns data for an ArcGIS MapServer /query URL', () => {
  const url = 'https://example.com/arcgis/rest/services/WFIGS/MapServer/0/query?where=1=1&f=json';
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('classifyRequest returns data for /data/enso-indices.json', () => {
  assert.equal(classifyRequest(`${ORIGIN}/data/enso-indices.json`, ORIGIN), 'data');
});

test('classifyRequest returns tile for /tiles/x.pmtiles', () => {
  assert.equal(classifyRequest(`${ORIGIN}/tiles/x.pmtiles`, ORIGIN), 'tile');
});

test('classifyRequest returns ignored for /assets/index.js', () => {
  assert.equal(classifyRequest(`${ORIGIN}/assets/index.js`, ORIGIN), 'ignored');
});

test('classifyRequest returns tile for a z/x/y path with an extension', () => {
  assert.equal(
    classifyRequest('https://tiles.example.com/layer/7/22/45.png', ORIGIN),
    'tile'
  );
});

test('classifyRequest returns tile for a z/x/y path with no extension', () => {
  assert.equal(
    classifyRequest('https://tiles.example.com/layer/7/22/45', ORIGIN),
    'tile'
  );
});

// --- renderReport --------------------------------------------------------

test('renderReport with one run renders a row per switch in SWITCHES order and no em dash', () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline'));
  const markdown = renderReport(record);

  const EM_DASH = String.fromCharCode(0x2014);
  assert.equal(markdown.includes(EM_DASH), false);
  assert.match(markdown, /Requests/);
  assert.match(markdown, /Time to quiescence \(ms\)/);
  assert.equal(markdown.includes('Candidate requests'), false);
  assert.equal(markdown.includes('Delta'), false);

  const rows = markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('From') && !line.includes('---'));
  assert.equal(rows.length, SWITCHES.length);
  SWITCHES.forEach((pair, i) => {
    assert.match(rows[i], new RegExp(`\\| ${pair.from} \\| ${pair.to} \\|`));
  });
});

test('renderReport with both runs adds candidate columns and a delta column computed on data reads, each pinned to its own row', () => {
  let record = mergeRun(emptyRecord(), makeRun('baseline'));
  record = mergeRun(
    record,
    makeRun('candidate', {
      switches: SWITCHES.map((pair, i) =>
        makeSwitchEntry(pair, {
          dataRequests: i === 0 ? 5 : 3,
          requests: i === 0 ? 5 : 3,
          quiescentMs: i === 0 ? 900 : 400
        })
      )
    })
  );
  const markdown = renderReport(record);

  assert.match(markdown, /Candidate data reads/);
  assert.match(markdown, /Candidate tiles/);
  assert.match(markdown, /Candidate requests/);
  assert.match(markdown, /Candidate ms/);
  assert.match(markdown, /Delta/);
  assert.match(markdown, /rose/);

  const rows = markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('From') && !line.includes('---'));
  assert.equal(rows.length, SWITCHES.length);
  SWITCHES.forEach((pair, i) => {
    const baselineData = 3;
    const candidateData = i === 0 ? 5 : 3;
    const candidateMs = i === 0 ? 900 : 400;
    const delta = i === 0 ? '\\+2' : '0';
    assert.match(
      rows[i],
      new RegExp(
        `\\| ${pair.from} \\| ${pair.to} \\| ${baselineData} \\| 0 \\| 3 \\| 400 \\| ${candidateData} \\| 0 \\| ${candidateData} \\| ${candidateMs} \\| ${delta} \\|`
      ),
      `row ${i} (${switchId(pair)}) did not carry its own baseline, candidate, and delta values`
    );
  });
});

// --- compareRuns: shape guards -------------------------------------------

test('compareRuns throws a TypeError when the first argument is a RECORD, not a RUN', () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline'));
  assert.throws(
    () => compareRuns(record, makeRun('candidate')),
    (err) => err instanceof TypeError && /baseline/.test(err.message) && /switches/.test(err.message) && /RUN/.test(err.message) && /RECORD/.test(err.message)
  );
});

test('compareRuns throws a TypeError when the second argument is a RECORD, not a RUN', () => {
  const record = mergeRun(emptyRecord(), makeRun('candidate'));
  assert.throws(
    () => compareRuns(makeRun('baseline'), record),
    (err) => err instanceof TypeError && /candidate/.test(err.message) && /switches/.test(err.message) && /RUN/.test(err.message) && /RECORD/.test(err.message)
  );
});

test('compareRuns throws a TypeError when either argument is undefined or null', () => {
  assert.throws(() => compareRuns(undefined, makeRun('candidate')), TypeError);
  assert.throws(() => compareRuns(makeRun('baseline'), undefined), TypeError);
  assert.throws(() => compareRuns(null, makeRun('candidate')), TypeError);
  assert.throws(() => compareRuns(makeRun('baseline'), null), TypeError);
});

test('compareRuns does not throw for a run whose switches array is empty', () => {
  const baseline = makeRun('baseline', { switches: [] });
  const candidate = makeRun('candidate', { switches: [] });
  assert.doesNotThrow(() => compareRuns(baseline, candidate));
  const { rises, falls, unchanged, missing } = compareRuns(baseline, candidate);
  assert.deepEqual(rises, []);
  assert.deepEqual(falls, []);
  assert.deepEqual(unchanged, []);
  assert.deepEqual(missing, []);
});

// --- compareRuns ---------------------------------------------------------

test('compareRuns reports a rise when the candidate exceeds the baseline', () => {
  const baseline = makeRun('baseline');
  const candidate = makeRun('candidate', {
    switches: SWITCHES.map((pair, i) => makeSwitchEntry(pair, { dataRequests: i === 0 ? 4 : 3 }))
  });
  const { rises } = compareRuns(baseline, candidate);
  assert.equal(rises.length, 1);
  assert.equal(rises[0].id, switchId(SWITCHES[0]));
  assert.equal(rises[0].baselineData, 3);
  assert.equal(rises[0].candidateData, 4);
});

test('compareRuns reports unchanged when equal and a fall when the candidate is lower', () => {
  const baseline = makeRun('baseline');
  const candidate = makeRun('candidate', {
    switches: SWITCHES.map((pair, i) => makeSwitchEntry(pair, { dataRequests: i === 1 ? 1 : 3 }))
  });
  const { falls, unchanged, rises } = compareRuns(baseline, candidate);
  assert.equal(rises.length, 0);
  assert.equal(falls.length, 1);
  assert.equal(falls[0].id, switchId(SWITCHES[1]));
  assert.equal(unchanged.length, SWITCHES.length - 1);
});

test('compareRuns reports a switch present in the baseline and absent from the candidate as missing, not a fall', () => {
  const baseline = makeRun('baseline');
  const candidate = makeRun('candidate', {
    switches: SWITCHES.filter((_, i) => i !== 2).map((pair) => makeSwitchEntry(pair))
  });
  const { missing, falls, rises } = compareRuns(baseline, candidate);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, switchId(SWITCHES[2]));
  assert.equal(missing[0].candidateData, null);
  assert.equal(missing[0].candidateTiles, null);
  assert.equal(falls.length, 0);
  assert.equal(rises.length, 0);
});

test('compareRuns compares dataRequests and ignores a tile-count-only change', () => {
  const baseline = makeRun('baseline', {
    switches: SWITCHES.map((pair) =>
      makeSwitchEntry(pair, { requests: 19, dataRequests: 3, tileRequests: 16 })
    )
  });
  const candidate = makeRun('candidate', {
    switches: SWITCHES.map((pair) =>
      makeSwitchEntry(pair, { requests: 40, dataRequests: 3, tileRequests: 37 })
    )
  });
  const { rises, falls, unchanged } = compareRuns(baseline, candidate);
  assert.equal(rises.length, 0, 'a tile-only rise must not be reported as a rise');
  assert.equal(falls.length, 0);
  assert.equal(unchanged.length, SWITCHES.length);
  assert.equal(unchanged[0].baselineData, 3);
  assert.equal(unchanged[0].candidateData, 3);
  assert.equal(unchanged[0].baselineTiles, 16);
  assert.equal(unchanged[0].candidateTiles, 37);
});

test('compareRuns refuses a run whose switches lack dataRequests', () => {
  const oldShapeSwitch = { id: switchId(SWITCHES[0]), from: SWITCHES[0].from, to: SWITCHES[0].to, requests: 19, quiescentMs: 400, pendingAtStart: [], counted: [] };
  const oldRun = makeRun('baseline', { switches: [oldShapeSwitch] });
  assert.throws(
    () => compareRuns(oldRun, makeRun('candidate')),
    (err) => err instanceof TypeError && /dataRequests/.test(err.message)
  );
  assert.throws(
    () => compareRuns(makeRun('baseline'), oldRun),
    (err) => err instanceof TypeError && /dataRequests/.test(err.message)
  );
});

// --- mergeRun --------------------------------------------------------------

test('mergeRun replaces a run with the same label and leaves the other run untouched', () => {
  const base = emptyRecord();
  const withBaseline = mergeRun(base, makeRun('baseline', { commit: 'aaa1111' }));
  const withBoth = mergeRun(withBaseline, makeRun('candidate', { commit: 'bbb2222' }));
  const replaced = mergeRun(withBoth, makeRun('candidate', { commit: 'ccc3333' }));

  assert.equal(replaced.runs.baseline.commit, 'aaa1111');
  assert.equal(replaced.runs.candidate.commit, 'ccc3333');
  // mergeRun never mutates its input
  assert.equal(withBoth.runs.candidate.commit, 'bbb2222');
  assert.equal(base.runs.baseline, undefined);
});

// --- SWITCHES ---------------------------------------------------------------

test('SWITCHES has exactly twelve entries: every ordered pair of the four mode keys with from !== to, no duplicates', () => {
  assert.equal(SWITCHES.length, 12);
  const seen = new Set();
  for (const { from, to } of SWITCHES) {
    assert.notEqual(from, to);
    assert.ok(MODE_KEYS.includes(from));
    assert.ok(MODE_KEYS.includes(to));
    const key = switchId({ from, to });
    assert.equal(seen.has(key), false, `duplicate switch ${key}`);
    seen.add(key);
  }
  for (const from of MODE_KEYS) {
    for (const to of MODE_KEYS) {
      if (from === to) continue;
      assert.ok(seen.has(switchId({ from, to })), `missing switch ${from}->${to}`);
    }
  }
});

// --- strippedUrl and tallyUrls (used by the spec to build `counted`) -------

test('strippedUrl keeps a same-origin URL as pathname plus search', () => {
  assert.equal(
    strippedUrl(`${ORIGIN}/data/us-states.geojson?v=3`, ORIGIN),
    '/data/us-states.geojson?v=3'
  );
});

test('strippedUrl keeps a cross-origin URL absolute', () => {
  assert.equal(
    strippedUrl('https://tiles.example.com/0/0/0.pbf', ORIGIN),
    'https://tiles.example.com/0/0/0.pbf'
  );
});

test('strippedUrl truncates a long URL to 160 characters with a trailing ellipsis', () => {
  const longPath = `/data/${'x'.repeat(300)}.json`;
  const result = strippedUrl(`${ORIGIN}${longPath}`, ORIGIN);
  assert.equal(result.length, 160);
  assert.ok(result.endsWith('...'));
});

test('tallyUrls counts occurrences and sorts by descending count then ascending url', () => {
  const tally = tallyUrls([
    '/data/b.json',
    '/data/a.json',
    '/data/a.json',
    '/data/c.json',
    '/data/a.json'
  ]);
  assert.deepEqual(tally, [
    { url: '/data/a.json', n: 3 },
    { url: '/data/b.json', n: 1 },
    { url: '/data/c.json', n: 1 }
  ]);
});
