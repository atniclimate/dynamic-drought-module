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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MODE_KEYS,
  SWITCHES,
  switchId,
  isCountedRequest,
  classifyRequest,
  PROXY_ORIGIN,
  strippedUrl,
  tallyUrls,
  emptyRecord,
  mergeRun,
  compareRuns,
  renderReport,
  writePolicy,
  normalizeProfile,
  runKey,
  shouldCompareToBaseline,
  PROFILES,
  measurementProfiles,
  bootQuery,
  fingerprintFrom,
  planMeasurementWrite
} from '../scripts/mode-switch-cost-report.mjs';

const ORIGIN = 'https://ddm.example.org';
const HERE = dirname(fileURLToPath(import.meta.url));

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

// --- classifyRequest: the Worker proxy nests an upstream URL (DDM-P14-T08, C4 part) ---

test('classifyRequest returns tile for a WHP exportImage tile fetched through the Worker proxy', () => {
  const upstream =
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage?bbox=-13692297.4,5311971.8,-13682513.5,5321755.8&bboxSR=3857&imageSR=3857&size=256,256&format=png&transparent=true&f=image';
  const url = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(upstream)}`;
  assert.equal(classifyRequest(url, ORIGIN), 'tile');
});

test('classifyRequest keeps today\'s classification for a url= parameter on a non-proxy host', () => {
  const upstream =
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage?bbox=1,2,3,4&f=image';
  const url = `https://example.com/proxy?url=${encodeURIComponent(upstream)}`;
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('classifyRequest returns data for a non-tile read fetched through the Worker proxy', () => {
  const upstream = 'https://api.weather.gov/points/45.52,-122.68';
  const url = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(upstream)}`;
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('classifyRequest returns data for proxied ImageServer metadata, not tile', () => {
  const upstream =
    'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer?f=json';
  const url = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(upstream)}`;
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('classifyRequest returns data for a proxied DescribeDomains request, not tile', () => {
  const upstream =
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0';
  const url = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(upstream)}`;
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('classifyRequest falls back to the outer proxy URL, and never throws, when the nested url= is malformed', () => {
  const url = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent('not a valid url')}`;
  assert.doesNotThrow(() => classifyRequest(url, ORIGIN));
  assert.equal(classifyRequest(url, ORIGIN), 'data');
});

test('the script\'s Worker proxy origin literal matches src/config/urls.ts workerProxy', () => {
  const urlsSource = readFileSync(join(HERE, '..', 'src', 'config', 'urls.ts'), 'utf8');
  assert.ok(urlsSource.includes(PROXY_ORIGIN), `${PROXY_ORIGIN} is not in src/config/urls.ts`);
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

// --- renderReport: one table per measurement profile (C4R U10 follow-up, Codex J6) ---

/**
 * The lines of the `## ` section whose heading matches `headingPattern`, up
 * to the next `## ` heading (or the end). Throws when no heading matches, so
 * a missing section fails loudly instead of matching nothing.
 */
function sectionOf(markdown, headingPattern) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## ') && headingPattern.test(line));
  assert.notEqual(start, -1, `no "## " heading matches ${headingPattern}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

function tableRows(lines) {
  return lines.filter((line) => line.startsWith('|') && !line.includes('From') && !line.includes('---'));
}

function makeConusSwitches(dataFor, quiescentMs) {
  return SWITCHES.map((pair, i) =>
    makeSwitchEntry(pair, { dataRequests: dataFor(i), requests: dataFor(i), tileRequests: 0, quiescentMs })
  );
}

test('renderReport renders a separate CONUS table from runs.conusBaseline/runs.conusCandidate and never compares conus data to the wa baseline', () => {
  // Washington: data 3 on every switch in both runs, so its deltas are all 0.
  let record = mergeRun(emptyRecord(), makeRun('baseline', { commit: 'wa00000' }));
  record = mergeRun(record, makeRun('candidate', { profile: 'wa', commit: 'wa11111' }));
  // CONUS: data 20 + i in the baseline; the candidate adds 4 on switch 1 only.
  // A delta against the Washington baseline (3) would read +17 or more on
  // every row, so the exact per-row values below pin the comparator.
  record = mergeRun(
    record,
    makeRun('baseline', { profile: 'conus', commit: 'cn00000', switches: makeConusSwitches((i) => 20 + i, 700) })
  );
  record = mergeRun(
    record,
    makeRun('candidate', {
      profile: 'conus',
      commit: 'cn11111',
      switches: makeConusSwitches((i) => 20 + i + (i === 1 ? 4 : 0), 800)
    })
  );
  const markdown = renderReport(record);

  const EM_DASH = String.fromCharCode(0x2014);
  assert.equal(markdown.includes(EM_DASH), false);

  const wa = sectionOf(markdown, /Washington/);
  const conus = sectionOf(markdown, /CONUS/);

  // Every one of the ordered switches appears once in each table, in SWITCHES order.
  const waRows = tableRows(wa);
  const conusRows = tableRows(conus);
  assert.equal(waRows.length, SWITCHES.length);
  assert.equal(conusRows.length, SWITCHES.length);
  assert.equal(tableRows(markdown.split('\n')).length, 2 * SWITCHES.length);

  SWITCHES.forEach((pair, i) => {
    assert.match(
      waRows[i],
      new RegExp(`^\\| ${pair.from} \\| ${pair.to} \\| 3 \\| 0 \\| 3 \\| 400 \\| 3 \\| 0 \\| 3 \\| 400 \\| 0 \\|$`),
      `Washington row ${i} (${switchId(pair)}) is not baseline 3 against candidate 3`
    );
    const b = 20 + i;
    const c = 20 + i + (i === 1 ? 4 : 0);
    const delta = i === 1 ? '\\+4' : '0';
    assert.match(
      conusRows[i],
      new RegExp(`^\\| ${pair.from} \\| ${pair.to} \\| ${b} \\| 0 \\| ${b} \\| 700 \\| ${c} \\| 0 \\| ${c} \\| 800 \\| ${delta} \\|$`),
      `CONUS row ${i} (${switchId(pair)}) is not conusCandidate against conusBaseline`
    );
  });

  // Each table cites only its own profile's runs.
  const waText = wa.join('\n');
  const conusText = conus.join('\n');
  assert.match(waText, /wa00000/);
  assert.match(waText, /wa11111/);
  assert.equal(/cn00000|cn11111/.test(waText), false, 'a CONUS run leaked into the Washington section');
  assert.match(conusText, /cn00000/);
  assert.match(conusText, /cn11111/);
  assert.equal(/wa00000|wa11111/.test(conusText), false, 'a Washington run leaked into the CONUS section');
  assert.match(conusText, /conusBaseline/);
  assert.match(conusText, /conusCandidate/);

  // The rise summary is per profile: only the CONUS switch rose, against the CONUS baseline.
  const risen = `\`${switchId(SWITCHES[1])}\` (conusBaseline ${21} to conusCandidate ${25})`;
  assert.ok(conusText.includes(risen), `the CONUS section does not report ${risen}`);
  assert.equal(waText.includes(switchId(SWITCHES[1]) + '` ('), false);
  assert.match(waText, /no switch's data-read count rose/i);
});

test('renderReport renders a CONUS-only record without a Washington table and without any cross-profile comparison', () => {
  const record = mergeRun(
    emptyRecord(),
    makeRun('baseline', { profile: 'conus', commit: 'cn00000', switches: makeConusSwitches((i) => 20 + i, 700) })
  );
  const markdown = renderReport(record);
  assert.equal(tableRows(sectionOf(markdown, /Washington/)).length, 0);
  assert.match(sectionOf(markdown, /Washington/).join('\n'), /No Washington-profile run is recorded yet/);
  const conusRows = tableRows(sectionOf(markdown, /CONUS/));
  assert.equal(conusRows.length, SWITCHES.length);
  assert.equal(markdown.includes('Delta'), false, 'a lone baseline has nothing to be compared against');
});

test('renderReport keeps the frozen historical Washington-only record to one table and says no CONUS run is recorded', () => {
  const record = historicalRecord();
  const markdown = renderReport(record);
  assert.equal(tableRows(sectionOf(markdown, /Washington/)).length, SWITCHES.length);
  assert.equal(tableRows(sectionOf(markdown, /CONUS/)).length, 0);
  assert.match(sectionOf(markdown, /CONUS/).join('\n'), /No CONUS-profile run is recorded yet/);
});

test('renderReport refuses a record whose slot holds the other profile\'s run, so no table can compare across profiles', () => {
  const conusUnderWaKey = { ...emptyRecord(), runs: { baseline: makeRun('baseline'), candidate: makeRun('candidate', { profile: 'conus' }) } };
  assert.throws(() => renderReport(conusUnderWaKey), (err) => err instanceof TypeError && /candidate/.test(err.message));
  const waUnderConusKey = { ...emptyRecord(), runs: { conusBaseline: makeRun('baseline') } };
  assert.throws(() => renderReport(waUnderConusKey), (err) => err instanceof TypeError && /conusBaseline/.test(err.message));
});

// --- F6c: the lower-bound footnote names its one evidenced cause only for
// the run it explains (keyed by commit), never as a claim about code that no
// longer matches it (Codex C4R F6c) ----------------------------------------

test('the lower-bound footnote states an empty pendingAtStart without a cause, and the SST cause stays with the 0c27ab1 run', () => {
  const record = mergeRun(
    emptyRecord(),
    makeRun('baseline', {
      profile: 'conus',
      commit: 'cn00000',
      switches: SWITCHES.map((pair) =>
        makeSwitchEntry(pair, switchId(pair) === 'heat->drought' ? { pendingAtStart: [] } : {})
      )
    })
  );
  const conusText = sectionOf(renderReport(record), /CONUS/).join('\n');
  assert.match(conusText, /heat->drought/);
  assert.equal(/sst-anomaly\.ts:575/.test(conusText), false, 'a run at commit cn00000 must not be blamed on the SST layer');
  assert.equal(/SST anomaly layer/.test(conusText), false, 'a run at commit cn00000 must not name the SST cause at all');

  const waText = sectionOf(renderReport(historicalRecord()), /Washington/).join('\n');
  assert.match(waText, /Run `baseline` \(commit `0c27ab1`\)/, 'the historical baseline run keeps its evidenced SST cause line');
  assert.match(waText, /SST anomaly layer/);
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

// --- normalizeProfile / runKey / shouldCompareToBaseline (DDM-P14-T08 review finding C4) ---

test('normalizeProfile treats the literal string "conus" as conus and everything else as wa', () => {
  assert.equal(normalizeProfile('conus'), 'conus');
  assert.equal(normalizeProfile('wa'), 'wa');
  assert.equal(normalizeProfile(undefined), 'wa');
  assert.equal(normalizeProfile(null), 'wa');
  assert.equal(normalizeProfile('CONUS'), 'wa');
  assert.equal(normalizeProfile('national'), 'wa');
});

test('runKey keeps today\'s keys for the wa profile', () => {
  assert.equal(runKey('wa', 'baseline'), 'baseline');
  assert.equal(runKey('wa', 'candidate'), 'candidate');
  assert.equal(runKey(undefined, 'baseline'), 'baseline');
  assert.equal(runKey(undefined, 'candidate'), 'candidate');
});

test('runKey uses its own non-overlapping keys for the conus profile', () => {
  assert.equal(runKey('conus', 'baseline'), 'conusBaseline');
  assert.equal(runKey('conus', 'candidate'), 'conusCandidate');
});

test('mergeRun: a conus run is stored under its own key and never overwrites the wa baseline or candidate', () => {
  let record = mergeRun(emptyRecord(), makeRun('baseline', { profile: 'wa' }));
  record = mergeRun(record, makeRun('candidate', { profile: 'wa' }));
  const waBaselineCommit = record.runs.baseline.commit;
  const waCandidateCommit = record.runs.candidate.commit;

  record = mergeRun(record, makeRun('baseline', { profile: 'conus', commit: 'conus000' }));
  record = mergeRun(record, makeRun('candidate', { profile: 'conus', commit: 'conus111' }));

  assert.equal(record.runs.baseline.commit, waBaselineCommit);
  assert.equal(record.runs.candidate.commit, waCandidateCommit);
  assert.equal(record.runs.conusBaseline.commit, 'conus000');
  assert.equal(record.runs.conusCandidate.commit, 'conus111');
});

test('mergeRun: a run with no profile field merges as wa (backward compatible)', () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline'));
  assert.equal('profile' in record.runs.baseline ? record.runs.baseline.profile : undefined, undefined);
  assert.ok(record.runs.baseline);
  assert.equal(record.runs.conusBaseline, undefined);
});

test('shouldCompareToBaseline is true for a wa candidate run and false for a wa baseline run', () => {
  assert.equal(shouldCompareToBaseline({ profile: 'wa', label: 'candidate' }), true);
  assert.equal(shouldCompareToBaseline({ profile: undefined, label: 'candidate' }), true);
  assert.equal(shouldCompareToBaseline({ profile: 'wa', label: 'baseline' }), false);
});

test('shouldCompareToBaseline is always false for a conus run, baseline or candidate, and never runs the wa no-rise comparison', () => {
  assert.equal(shouldCompareToBaseline({ profile: 'conus', label: 'candidate' }), false);
  assert.equal(shouldCompareToBaseline({ profile: 'conus', label: 'baseline' }), false);
});

// --- the one-fingerprint two-profile write protocol (C4R U10 follow-up, Codex M1) ---

const CLEAN = Object.freeze({ commit: 'fff0000', dirty: 0 });

function measuredProfiles(profiles) {
  return profiles.map((profile) => ({ profile, switches: SWITCHES.map((pair) => makeSwitchEntry(pair)) }));
}

// The historical Washington-only record, frozen as committed before D1 M3
// (docs/mode-switch-cost.json at 0634a0d, blob cd915393): the shape every
// test below that plans or renders against the historical baseline was
// written for. The live artifact changes at M3; only the shape-agnostic
// test further below reads it directly.
function historicalRecord() {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', 'mode-switch-cost-wa-only.json'), 'utf8'));
}

test('measurementProfiles: "both" measures every profile in PROFILES order; anything else measures one, defaulting to wa', () => {
  assert.deepEqual(measurementProfiles('both'), [...PROFILES]);
  assert.deepEqual(PROFILES, ['wa', 'conus']);
  assert.deepEqual(measurementProfiles('conus'), ['conus']);
  assert.deepEqual(measurementProfiles('wa'), ['wa']);
  assert.deepEqual(measurementProfiles(undefined), ['wa']);
  assert.deepEqual(measurementProfiles('BOTH'), ['wa']);
});

test('bootQuery pins each profile\'s region and keeps a null-token (default) mode in the brief view in both profiles', () => {
  // src/state/view-mode.ts deriveViewMode: a bare URL boots `brief`, but
  // `region=` or `cluster=` alone flips it to `console`; the default mode's
  // bare boot was `brief`, so both profiles carry `view=brief` for it.
  assert.equal(bootQuery({ urlToken: null, profile: 'wa' }), '?region=washington_state&view=brief');
  assert.equal(bootQuery({ urlToken: null, profile: 'conus' }), '?region=national&view=brief');
  assert.equal(bootQuery({ urlToken: 'heat', profile: 'wa' }), '?cluster=heat&region=washington_state');
  assert.equal(bootQuery({ urlToken: 'heat', profile: 'conus' }), '?cluster=heat&region=national');
  assert.equal(bootQuery({ urlToken: 'heat', profile: undefined }), '?cluster=heat&region=washington_state');
});

test('fingerprintFrom counts every porcelain line, including the two artifacts the measurement writes', () => {
  assert.deepEqual(fingerprintFrom({ head: 'fff0000\n', porcelain: '' }), { commit: 'fff0000', dirty: 0 });
  assert.deepEqual(fingerprintFrom({ head: 'fff0000', porcelain: ' M src/main.ts\n' }), { commit: 'fff0000', dirty: 1 });
  assert.deepEqual(
    fingerprintFrom({ head: 'fff0000', porcelain: ' M docs/mode-switch-cost.json\n M docs/MODE_SWITCH_COST.md\n' }),
    { commit: 'fff0000', dirty: 2 }
  );
});

test('planMeasurementWrite records both profiles on one clean fingerprint in a single record, and the historical wa baseline is untouched', () => {
  const record = historicalRecord();
  const historical = structuredClone(record.runs.baseline);
  const plan = planMeasurementWrite({
    record,
    measured: measuredProfiles(['wa', 'conus']),
    rawLabel: 'baseline',
    before: CLEAN,
    after: CLEAN,
    recordedAt: '2026-09-26T12:00:00.000Z',
    viewport: { width: 1280, height: 800 }
  });

  assert.equal(plan.policy, 'write');
  // The historical baseline is the same object, byte-for-byte unchanged.
  assert.equal(plan.record.runs.baseline, record.runs.baseline);
  assert.deepEqual(plan.record.runs.baseline, historical);
  // wa already has a baseline, so its `baseline`-labelled run records as the candidate.
  assert.equal(plan.record.runs.candidate.profile, 'wa');
  assert.equal(plan.record.runs.candidate.label, 'candidate');
  // conus has none yet, so its run establishes the conus baseline.
  assert.equal(plan.record.runs.conusBaseline.profile, 'conus');
  assert.equal(plan.record.runs.conusBaseline.label, 'baseline');
  assert.equal(plan.record.runs.conusCandidate, undefined);
  // One fingerprint: both runs cite the same clean commit and one timestamp.
  for (const key of ['candidate', 'conusBaseline']) {
    assert.equal(plan.record.runs[key].commit, 'fff0000');
    assert.equal(plan.record.runs[key].dirty, 0);
    assert.equal(plan.record.runs[key].recordedAt, '2026-09-26T12:00:00.000Z');
  }
  // The input record is never mutated.
  assert.deepEqual(Object.keys(record.runs), ['baseline']);
  // The single record renders both tables.
  const markdown = renderReport(plan.record);
  assert.equal(tableRows(sectionOf(markdown, /Washington/)).length, SWITCHES.length);
  assert.equal(tableRows(sectionOf(markdown, /CONUS/)).length, SWITCHES.length);
});

test('planMeasurementWrite: a later candidate run of both profiles fills the two candidate slots and leaves both baselines untouched', () => {
  let record = mergeRun(emptyRecord(), makeRun('baseline', { commit: 'wa00000' }));
  record = mergeRun(record, makeRun('baseline', { profile: 'conus', commit: 'cn00000' }));
  for (const rawLabel of ['candidate', 'baseline']) {
    const plan = planMeasurementWrite({
      record,
      measured: measuredProfiles(['wa', 'conus']),
      rawLabel,
      before: CLEAN,
      after: CLEAN,
      recordedAt: 'T',
      viewport: { width: 1280, height: 800 }
    });
    assert.equal(plan.policy, 'write', rawLabel);
    assert.equal(plan.record.runs.baseline, record.runs.baseline, rawLabel);
    assert.equal(plan.record.runs.conusBaseline, record.runs.conusBaseline, rawLabel);
    assert.equal(plan.record.runs.candidate.commit, 'fff0000', rawLabel);
    assert.equal(plan.record.runs.conusCandidate.commit, 'fff0000', rawLabel);
  }
});

test('planMeasurementWrite: a single wa baseline run on the committed record never overwrites the historical baseline', () => {
  const record = historicalRecord();
  const plan = planMeasurementWrite({
    record,
    measured: measuredProfiles(['wa']),
    rawLabel: 'baseline',
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'write');
  assert.equal(plan.record.runs.baseline, record.runs.baseline);
  assert.equal(plan.runs[0].label, 'candidate');
  assert.equal(plan.record.runs.candidate.commit, 'fff0000');
});

test('planMeasurementWrite: an empty slot takes a baseline-labelled run as its first baseline', () => {
  const plan = planMeasurementWrite({
    record: null,
    measured: measuredProfiles(['wa']),
    rawLabel: 'baseline',
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'write');
  assert.equal(plan.record.runs.baseline.commit, 'fff0000');
  assert.equal(plan.record.runs.candidate, undefined);
});

// --- F2: a candidate-labelled run of a profile with no baseline is that
// profile's first baseline, never a lone candidate (Codex C4R F2) ---------

test("planMeasurementWrite: a candidate-labelled run of a profile with no baseline records as that profile's first baseline, never a lone candidate", () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline', { commit: 'wa00000' }));
  const plan = planMeasurementWrite({
    record,
    measured: measuredProfiles(['wa', 'conus']),
    rawLabel: 'candidate',
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'write');
  // wa already has a baseline, so its candidate-labelled run is its candidate.
  // conus has none yet, so its candidate-labelled run becomes its first baseline.
  assert.deepEqual(plan.runs.map((r) => [r.profile, r.label]), [
    ['wa', 'candidate'],
    ['conus', 'baseline']
  ]);
  assert.equal(plan.record.runs.conusBaseline.commit, 'fff0000');
  assert.equal(plan.record.runs.conusCandidate, undefined);
  assert.equal(plan.record.runs.baseline, record.runs.baseline);

  // The single-profile path (conus measured alone) takes the same branch.
  const single = planMeasurementWrite({
    record,
    measured: measuredProfiles(['conus']),
    rawLabel: 'candidate',
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(single.policy, 'write');
  assert.deepEqual(single.runs.map((r) => [r.profile, r.label]), [['conus', 'baseline']]);
  assert.equal(single.record.runs.conusBaseline.commit, 'fff0000');
  assert.equal(single.record.runs.conusCandidate, undefined);
});

test('renderReport shows the measured values of the first CONUS run however it was labelled', () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline', { commit: 'wa00000' }));
  const plan = planMeasurementWrite({
    record,
    measured: [{ profile: 'conus', switches: makeConusSwitches((i) => 900 + i, 12345) }],
    rawLabel: 'candidate',
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'write');
  const markdown = renderReport(plan.record);
  const conusRows = tableRows(sectionOf(markdown, /CONUS/));
  assert.equal(conusRows.length, SWITCHES.length);
  for (const row of conusRows) {
    const cells = row.split('|').map((cell) => cell.trim());
    assert.notDeepEqual(
      cells.slice(3, 7),
      ['n/a', 'n/a', 'n/a', 'n/a'],
      `row rendered n/a for the only recorded run: ${row}`
    );
  }
  assert.match(markdown, /12345/);
});

// The bare-run case pins that an unlabelled run never fills an empty
// baseline slot (it stays a candidate that writes nothing at all); this is
// the F2 fix's other edge and must never regress.
test('planMeasurementWrite: a bare run never fills an empty baseline slot (it stays a candidate that writes nothing)', () => {
  const plan = planMeasurementWrite({
    record: null,
    measured: measuredProfiles(['conus']),
    rawLabel: undefined,
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'skip');
  assert.deepEqual(plan.runs.map((r) => [r.profile, r.label]), [['conus', 'candidate']]);
});

test('planMeasurementWrite refuses a genuinely dirty tree: an uncommitted source edit writes nothing', () => {
  const plan = planMeasurementWrite({
    record: historicalRecord(),
    measured: measuredProfiles(['wa', 'conus']),
    rawLabel: 'candidate',
    before: fingerprintFrom({ head: 'fff0000', porcelain: ' M src/main.ts\n' }),
    after: fingerprintFrom({ head: 'fff0000', porcelain: ' M src/main.ts\n' }),
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'refuse');
  assert.equal(plan.record, null);
  assert.match(plan.reason, /dirty/);
});

test('planMeasurementWrite refuses a tree dirtied only by its own artifacts: the guard ignores nothing, so both profiles must share one invocation', () => {
  const afterOneProfileWrite = fingerprintFrom({
    head: 'fff0000',
    porcelain: ' M docs/mode-switch-cost.json\n M docs/MODE_SWITCH_COST.md\n'
  });
  const plan = planMeasurementWrite({
    record: historicalRecord(),
    measured: measuredProfiles(['conus']),
    rawLabel: 'baseline',
    before: afterOneProfileWrite,
    after: afterOneProfileWrite,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'refuse');
  assert.equal(plan.record, null);
});

test('planMeasurementWrite refuses when the fingerprint moved during measurement: dirty at the start, or HEAD changed', () => {
  const base = {
    record: historicalRecord(),
    measured: measuredProfiles(['wa', 'conus']),
    rawLabel: 'candidate',
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  };
  const dirtyAtStart = planMeasurementWrite({ ...base, before: { commit: 'fff0000', dirty: 1 }, after: CLEAN });
  assert.equal(dirtyAtStart.policy, 'refuse');
  assert.equal(dirtyAtStart.record, null);
  const headMoved = planMeasurementWrite({ ...base, before: { commit: 'eee0000', dirty: 0 }, after: CLEAN });
  assert.equal(headMoved.policy, 'refuse');
  assert.equal(headMoved.record, null);
  assert.match(headMoved.reason, /eee0000/);
  assert.match(headMoved.reason, /fff0000/);
});

test('planMeasurementWrite skips a bare run on any tree but still returns its runs for the no-rise check', () => {
  const plan = planMeasurementWrite({
    record: historicalRecord(),
    measured: measuredProfiles(['wa', 'conus']),
    rawLabel: undefined,
    before: { commit: 'fff0000', dirty: 3 },
    after: { commit: 'fff0000', dirty: 3 },
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'skip');
  assert.equal(plan.record, null);
  assert.deepEqual(plan.runs.map((r) => [r.profile, r.label]), [['wa', 'candidate'], ['conus', 'candidate']]);
  assert.equal(shouldCompareToBaseline(plan.runs[0]), true);
  assert.equal(shouldCompareToBaseline(plan.runs[1]), false);
});

test('planMeasurementWrite refuses two runs for one profile, which would share one slot', () => {
  assert.throws(
    () =>
      planMeasurementWrite({
        record: null,
        measured: measuredProfiles(['wa', 'wa']),
        rawLabel: 'candidate',
        before: CLEAN,
        after: CLEAN,
        recordedAt: 'T',
        viewport: { width: 1280, height: 800 }
      }),
    TypeError
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

// --- writePolicy ------------------------------------------------------

test('writePolicy skips a bare run (not baseline or candidate) with dirty 0', () => {
  assert.equal(writePolicy({ label: 'run', dirty: 0 }), 'skip');
});

test('writePolicy skips a bare run (not baseline or candidate) with dirty 3', () => {
  assert.equal(writePolicy({ label: 'run', dirty: 3 }), 'skip');
});

test('writePolicy writes for label baseline with dirty 0', () => {
  assert.equal(writePolicy({ label: 'baseline', dirty: 0 }), 'write');
});

test('writePolicy writes for label candidate with dirty 0', () => {
  assert.equal(writePolicy({ label: 'candidate', dirty: 0 }), 'write');
});

test('writePolicy refuses for label baseline with dirty 1', () => {
  assert.equal(writePolicy({ label: 'baseline', dirty: 1 }), 'refuse');
});

test('writePolicy refuses for label candidate with dirty 7', () => {
  assert.equal(writePolicy({ label: 'candidate', dirty: 7 }), 'refuse');
});

test('writePolicy throws a TypeError naming "dirty" for a negative dirty count', () => {
  assert.throws(
    () => writePolicy({ label: 'baseline', dirty: -1 }),
    (err) => err instanceof TypeError && /dirty/.test(err.message)
  );
});

test('writePolicy throws a TypeError naming "dirty" for a non-integer dirty count', () => {
  assert.throws(
    () => writePolicy({ label: 'candidate', dirty: 1.5 }),
    (err) => err instanceof TypeError && /dirty/.test(err.message)
  );
});

// --- renderReport and compareRuns: dirty (present, missing, and legacy) --

test('renderReport prints "dirty 0" beside a run recorded clean', () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline', { dirty: 0 }));
  const markdown = renderReport(record);
  assert.match(markdown, /dirty 0/);
});

test('renderReport prints "dirty N files" beside a run recorded dirty', () => {
  const record = mergeRun(emptyRecord(), makeRun('baseline', { dirty: 2 }));
  const markdown = renderReport(record);
  assert.match(markdown, /dirty 2 files/);
});

test('renderReport prints "dirty unknown" for a run with no dirty field, and does not throw', () => {
  const run = makeRun('baseline');
  delete run.dirty;
  const record = mergeRun(emptyRecord(), run);
  assert.doesNotThrow(() => renderReport(record));
  const markdown = renderReport(record);
  assert.match(markdown, /dirty unknown/);
});

test('compareRuns does not throw when a run has no dirty field', () => {
  const baseline = makeRun('baseline');
  delete baseline.dirty;
  const candidate = makeRun('candidate');
  delete candidate.dirty;
  assert.doesNotThrow(() => compareRuns(baseline, candidate));
});

test('renderReport renders the frozen historical record unchanged, including its baseline run with no dirty field', () => {
  const record = historicalRecord();
  assert.equal('dirty' in record.runs.baseline, false);
  assert.doesNotThrow(() => renderReport(record));
  const markdown = renderReport(record);
  assert.match(markdown, /dirty unknown/);
});

// --- the live docs/mode-switch-cost.json: shape-agnostic invariants only ---
// (F3: the historical-shape tests above pin the frozen fixture; this test
// pins nothing about how many profiles the live artifact carries, so it
// stays green whether the live record holds one profile's runs or several.)
//
// The fixture (tests/fixtures/mode-switch-cost-wa-only.json) is blob-identical
// to 0634a0d:docs/mode-switch-cost.json (git hash-object
// cd915393af6cb0cf5bb6b776558513b24232612e) and JSON-equal to it; the
// working-tree copy of docs/mode-switch-cost.json is CRLF on this machine, so
// the raw files differ in line endings. The assertions below compare parsed
// JSON, not raw bytes.

/**
 * The invariants both tests below prove: the historical Washington baseline
 * is JSON-equal to the frozen fixture's, every run key encodes its own
 * profile and label, no profile has a candidate without a baseline, and each
 * rendered table has either zero rows or one row per switch. Shared so the
 * live-artifact test and the built-record test below prove the same thing.
 */
function assertMeasurementRecordInvariants(record, historical) {
  assert.deepEqual(record.runs.baseline, historical.runs.baseline, 'the write-once Washington baseline changed');
  for (const [key, run] of Object.entries(record.runs)) {
    assert.equal(runKey(run.profile, run.label), key, `slot ${key} holds a ${run.profile ?? 'wa'} ${run.label} run`);
  }
  for (const profile of PROFILES) {
    if (record.runs[runKey(profile, 'candidate')]) {
      assert.ok(record.runs[runKey(profile, 'baseline')], `${profile} has a candidate without a baseline`);
    }
  }
  const markdown = renderReport(record);
  for (const heading of [/Washington/, /CONUS/]) {
    const rows = tableRows(sectionOf(markdown, heading)).length;
    assert.ok(rows === 0 || rows === SWITCHES.length, `${heading} table has ${rows} rows`);
  }
}

test('the live docs/mode-switch-cost.json renders under any profile shape and keeps the historical Washington baseline unchanged (JSON-equal to the frozen fixture)', () => {
  const live = JSON.parse(readFileSync(join(HERE, '..', 'docs', 'mode-switch-cost.json'), 'utf8'));
  assertMeasurementRecordInvariants(live, historicalRecord());
});

// The same invariant function proved against a built two-profile record (no
// network, no browser): planMeasurementWrite from the historical fixture,
// measuring both profiles on one clean fingerprint, so F3's live-artifact
// test is proved to hold on tomorrow's shape too, not only today's.
test('the live-artifact invariants also hold on a two-profile record built with planMeasurementWrite', () => {
  const plan = planMeasurementWrite({
    record: historicalRecord(),
    measured: measuredProfiles(['wa', 'conus']),
    rawLabel: 'baseline',
    before: CLEAN,
    after: CLEAN,
    recordedAt: 'T',
    viewport: { width: 1280, height: 800 }
  });
  assert.equal(plan.policy, 'write');
  assertMeasurementRecordInvariants(plan.record, historicalRecord());
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
