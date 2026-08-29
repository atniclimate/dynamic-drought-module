import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CACHE_HEADERS,
  COLLAPSE_ABOVE,
  EXPECTS_RECORDS,
  STUBBED_HOSTS,
  STUBBED_TILE_GLOBS,
  classifyUrl,
  countRecords,
  describeResponses,
  evaluateLayerHealth,
  parseHealthArgs,
  renderHealthSummary,
  renderIssueBody,
} from '../scripts/lib/source-health.mjs';

test('classifyUrl separates the served app, stubbed basemap tiles, and upstream sources', () => {
  const origin = 'http://127.0.0.1:4173';
  assert.equal(classifyUrl('http://127.0.0.1:4173/data/us-states.geojson', origin), 'app');
  assert.equal(classifyUrl('https://tile.openstreetmap.org/5/5/11.png', origin), 'stubbed');
  assert.equal(classifyUrl('https://a.tile.opentopomap.org/5/5/11.png', origin), 'stubbed');
  assert.equal(classifyUrl('https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer/exportImage?bbox=1,2,3,4&f=image', origin), 'stubbed');
  assert.equal(classifyUrl('https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGEDGC_Last_24hr/ImageServer/query?where=1%3D1&f=json', origin), 'source');
  assert.deepEqual(STUBBED_TILE_GLOBS, ['https://satellitemaps.nesdis.noaa.gov/**/exportImage**']);
  assert.equal(
    classifyUrl('https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?f=geojson', origin),
    'source',
  );
  assert.ok(STUBBED_HOSTS.includes('tile.openstreetmap.org'));
  assert.ok(CACHE_HEADERS.includes('age'));
});

test('every stubbed host and tile glob names a host the runtime registry actually uses', async () => {
  const urls = await readFile(new URL('../src/config/urls.ts', import.meta.url), 'utf8');
  for (const host of STUBBED_HOSTS) assert.ok(urls.includes(host), `${host} is not in src/config/urls.ts`);
  for (const glob of STUBBED_TILE_GLOBS) {
    const host = new URL(glob.replace(/\*+/g, 'x')).hostname;
    assert.ok(urls.includes(host), `${host} is not in src/config/urls.ts`);
  }
});

test('countRecords reads GeoJSON, ArcGIS JSON, WaterML, and arrays, and returns null otherwise', () => {
  assert.equal(countRecords('application/geo+json', JSON.stringify({ type: 'FeatureCollection', features: [{}, {}] })), 2);
  assert.equal(countRecords('application/json; charset=utf-8', JSON.stringify({ features: [{}] })), 1);
  assert.equal(countRecords('application/json', JSON.stringify({ value: { timeSeries: [{}, {}, {}] } })), 3);
  assert.equal(countRecords('application/json', JSON.stringify([1, 2])), 2);
  assert.equal(countRecords('image/png', 'not json'), null);
  assert.equal(countRecords('application/json', '{"error":{"code":400}}'), null);
  assert.equal(countRecords('application/json', 'not json at all'), null);
});

const opts = { ceilingMs: 45_000, warnSeconds: 10, warnBytes: 24_000_000, expectsRecords: new Set(['nadm-drought']) };
const goodResponse = { url: 'https://x/query', status: 200, bytes: 1_900_000, ms: 4_400, count: 239 };
const good = { key: 'nifc-fires', status: 'ready', settleMs: 4_500, responses: [goodResponse], failed: [], requests: 1 };

test('evaluateLayerHealth: ok, slow, large, and aborted answers', () => {
  assert.deepEqual(evaluateLayerHealth(good, opts), { verdict: 'ok', reasons: [] });
  const slow = { ...good, responses: [{ ...goodResponse, ms: 12_000 }] };
  assert.equal(evaluateLayerHealth(slow, opts).verdict, 'warn');
  assert.match(evaluateLayerHealth(slow, opts).reasons[0], /12\.0 s/);
  const large = { ...good, responses: [{ ...goodResponse, bytes: 30_000_000, ms: 3_000 }] };
  assert.equal(evaluateLayerHealth(large, opts).verdict, 'warn');
  assert.match(evaluateLayerHealth(large, opts).reasons[0], /30\.00 MB.*32 MiB/);
  const aborted = { ...good, failed: [{ url: 'https://x/tile', failure: 'net::ERR_ABORTED' }], requests: 2 };
  assert.equal(evaluateLayerHealth(aborted, opts).verdict, 'warn');
  assert.match(evaluateLayerHealth(aborted, opts).reasons[0], /aborted by the runtime/);
  const moved = { ...good, finalStatus: 'ready', status: 'ready' };
  assert.equal(evaluateLayerHealth(moved, opts).verdict, 'ok');
});

test('evaluateLayerHealth: breaches from the terminal state', () => {
  const dead = { key: 'nifc-fires', status: 'error', settleMs: 15_100, responses: [{ ...goodResponse, bytes: 42_750_000, ms: 41_600, count: 243 }], failed: [], requests: 1 };
  assert.equal(evaluateLayerHealth(dead, opts).verdict, 'breach');
  assert.match(evaluateLayerHealth(dead, opts).reasons[0], /unavailable at 15\.1 s/);
  const http = { ...good, responses: [{ ...goodResponse, status: 503 }] };
  assert.equal(evaluateLayerHealth(http, opts).verdict, 'breach');
  const stuck = { key: 'aiannh', status: 'loading', settleMs: 45_000, responses: [], failed: [], requests: 1 };
  assert.equal(evaluateLayerHealth(stuck, opts).verdict, 'breach');
  const late = { ...good, settleMs: 46_000 };
  assert.equal(evaluateLayerHealth(late, opts).verdict, 'breach');
  assert.match(evaluateLayerHealth(late, opts).reasons[0], /over the 45\.0 s ceiling/);
  const dns = { ...good, responses: [], failed: [{ url: 'https://x/query', failure: 'net::ERR_NAME_NOT_RESOLVED' }], requests: 1 };
  assert.equal(evaluateLayerHealth(dns, opts).verdict, 'breach');
  assert.match(evaluateLayerHealth(dns, opts).reasons[0], /request failed \(net::ERR_NAME_NOT_RESOLVED\)/);
  const unobserved = { key: 'gridded-index', status: 'ready', settleMs: 500, responses: [], failed: [], requests: 9 };
  assert.equal(evaluateLayerHealth(unobserved, opts).verdict, 'breach');
  assert.match(evaluateLayerHealth(unobserved, opts).reasons[0], /9 request\(s\) issued but no response observed/);
});

test('evaluateLayerHealth: partial and empty answers depend on whether the source is always complete', () => {
  const partialEvent = { ...good, status: 'degraded' };
  assert.equal(evaluateLayerHealth(partialEvent, opts).verdict, 'warn');
  assert.match(evaluateLayerHealth(partialEvent, opts).reasons[0], /live \(partial\)/);
  const partialComplete = { ...good, key: 'nadm-drought', status: 'degraded' };
  assert.equal(evaluateLayerHealth(partialComplete, opts).verdict, 'breach');
  const empty = { key: 'nadm-drought', status: 'no-data', settleMs: 900, responses: [{ url: 'https://y', status: 200, bytes: 90, ms: 800, count: 0 }], failed: [], requests: 1 };
  assert.equal(evaluateLayerHealth(empty, opts).verdict, 'breach');
  const emptyOk = { ...empty, key: 'nws-alerts' };
  assert.equal(evaluateLayerHealth(emptyOk, opts).verdict, 'ok');
  const zeroRecordsReady = { ...good, key: 'nadm-drought', responses: [{ ...goodResponse, count: 0 }] };
  assert.equal(evaluateLayerHealth(zeroRecordsReady, opts).verdict, 'breach');
  assert.match(evaluateLayerHealth(zeroRecordsReady, opts).reasons[0], /0 records/);
  assert.ok(EXPECTS_RECORDS.has('nadm-drought'));
  assert.ok(EXPECTS_RECORDS.has('aiannh'));
  assert.ok(EXPECTS_RECORDS.has('bia-reservations'));
});

test('evaluateLayerHealth: skipped rows are named, never counted as inside budget', () => {
  const zoom = { key: 'hydrography', status: 'zoom-in', settleMs: 200, responses: [], failed: [], requests: 0 };
  assert.equal(evaluateLayerHealth(zoom, opts).verdict, 'skipped');
  const local = { key: 'states', status: 'ready', settleMs: 300, responses: [], failed: [], requests: 0 };
  assert.equal(evaluateLayerHealth(local, opts).verdict, 'skipped');
  assert.match(evaluateLayerHealth(local, opts).reasons[0], /bundled or cached/);
  const ambientOnly = { key: 'nadm-drought', status: 'ready', settleMs: 2_000, responses: [], failed: [], requests: 0, shared: 3 };
  assert.equal(evaluateLayerHealth(ambientOnly, opts).verdict, 'skipped');
  assert.match(evaluateLayerHealth(ambientOnly, opts).reasons[0], /ambient-boot row/);
  const rows = [
    { ...local, verdict: 'skipped', reasons: ['bundled'] },
    { ...good, verdict: 'ok', reasons: [] },
  ];
  const md = renderHealthSummary(rows, { sha: 'abc', startedAt: 'now' });
  assert.match(md, /^## Source health: 1 measured source rows inside budget \(1 not measured\)/);
});

test('renderHealthSummary and renderIssueBody carry the receipt without bodies', () => {
  const rows = [{
    key: 'nifc-fires', status: 'ready', settleMs: 4_500, verdict: 'ok', reasons: [], requests: 1, shared: 3,
    responses: [{ url: 'https://x/query?f=geojson', status: 200, bytes: 1_900_000, ms: 4_400, count: 239, cache: { age: '120', 'x-cache': 'HIT' } }],
    failed: [],
  }];
  const md = renderHealthSummary(rows, { sha: 'abc', startedAt: '2026-08-29T13:30:00Z' });
  assert.match(md, /^## Source health: 1 measured source rows inside budget/);
  assert.match(md, /1 upstream requests, 1 responses, 0 failed, 3 ambient requests on layer boots/);
  assert.match(md, /\| nifc-fires \| ready \| 4\.5 s \| ok \|/);
  assert.match(md, /239 rec \(x-cache HIT, age 120\)/);
  assert.match(md, /1\.90 MB/);
  const breached = { ...rows[0], verdict: 'breach', reasons: ['unavailable at 15.1 s'], failed: [{ url: 'https://x/tile', failure: 'net::ERR_FAILED' }] };
  assert.match(renderHealthSummary([breached], { sha: 'abc', startedAt: 'now' }), /^## Source health: 1 breach in 1 measured source rows/);
  assert.match(renderHealthSummary([breached], { sha: 'abc', startedAt: 'now' }), /failed net::ERR_FAILED `https:\/\/x\/tile`/);
  const body = renderIssueBody(breached, 'https://github.test/run/1');
  assert.match(body, /<!-- ddm-source-health:nifc-fires -->/);
  assert.match(body, /- unavailable at 15\.1 s/);
  assert.match(body, /https:\/\/github\.test\/run\/1/);
  assert.match(body, /\| 200 \| 1,900,000 \| 4\.4 \| 239 \|/);
  assert.match(body, /\| failed \| \| \| \| `https:\/\/x\/tile` \(net::ERR_FAILED\) \|/);
});

test('describeResponses lists a few responses and collapses a tile fan-out per host', () => {
  const few = [{ url: 'https://x/a', status: 200, bytes: 1000, ms: 100, count: null }];
  assert.match(describeResponses(few), /200 0\.00 MB 0\.1 s `https:\/\/x\/a`/);
  assert.equal(describeResponses([]), '(none)');
  const many = Array.from({ length: COLLAPSE_ABOVE + 4 }, (_, i) => ({
    url: `https://tiles.example.test/z/${i}.png`, status: i === 3 ? 404 : 200, bytes: 10_000, ms: 100 * i, count: null,
  }));
  const text = describeResponses(many);
  assert.match(text, /10 responses from `tiles\.example\.test`: 200 x9, 404 x1; 0\.10 MB total; slowest 0\.9 s/);
  assert.equal(text.includes('/z/3.png'), false);
});

test('parseHealthArgs defaults to the preview origin, the byte and second lines, and a named User-Agent', () => {
  const d = parseHealthArgs([]);
  assert.equal(d.base, 'http://127.0.0.1:4173/');
  assert.equal(d.layers, null);
  assert.equal(d.warnSeconds, 10);
  assert.equal(d.warnBytes, 24_000_000);
  assert.equal(d.ceilingMs, 45_000);
  assert.match(d.userAgent, /dynamic-drought-module/);
  const a = parseHealthArgs(['--layers', 'nifc-fires, hms-smoke', '--warn-seconds', '5', '--warn-bytes', '1000', '--base', 'http://127.0.0.1:4174']);
  assert.deepEqual(a.layers, ['nifc-fires', 'hms-smoke']);
  assert.equal(a.warnSeconds, 5);
  assert.equal(a.warnBytes, 1000);
  assert.equal(a.base, 'http://127.0.0.1:4174/');
  assert.throws(() => parseHealthArgs(['--nope', '1']), /unknown/);
  assert.throws(() => parseHealthArgs(['--layers']), /needs a value/);
  assert.throws(() => parseHealthArgs(['--warn-bytes', '0']), /positive/);
});
