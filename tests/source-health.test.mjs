import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTS_RECORDS,
  STUBBED_HOSTS,
  classifyUrl,
  countRecords,
  evaluateLayerHealth,
  parseHealthArgs,
  renderHealthSummary,
  renderIssueBody,
} from '../scripts/lib/source-health.mjs';

test('classifyUrl separates the served app, stubbed basemaps, and upstream sources', () => {
  const origin = 'http://127.0.0.1:4173';
  assert.equal(classifyUrl('http://127.0.0.1:4173/data/us-states.geojson', origin), 'app');
  assert.equal(classifyUrl('https://tile.openstreetmap.org/5/5/11.png', origin), 'stubbed');
  assert.equal(classifyUrl('https://a.tile.opentopomap.org/5/5/11.png', origin), 'stubbed');
  assert.equal(classifyUrl('https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/x/ImageServer/query', origin), 'stubbed');
  assert.equal(
    classifyUrl('https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?f=geojson', origin),
    'source',
  );
  assert.ok(STUBBED_HOSTS.includes('tile.openstreetmap.org'));
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

test('evaluateLayerHealth turns statuses and responses into verdicts', () => {
  const opts = { ceilingMs: 45_000, warnSeconds: 10, expectsRecords: new Set(['nadm-drought']) };
  const good = {
    key: 'nifc-fires', status: 'ready', settleMs: 4_500,
    responses: [{ url: 'https://x/query', status: 200, bytes: 1_900_000, ms: 4_400, count: 239 }],
  };
  assert.deepEqual(evaluateLayerHealth(good, opts), { verdict: 'ok', reasons: [] });
  const slow = { ...good, responses: [{ ...good.responses[0], ms: 12_000 }] };
  assert.equal(evaluateLayerHealth(slow, opts).verdict, 'warn');
  assert.match(evaluateLayerHealth(slow, opts).reasons[0], /12\.0 s/);
  const dead = {
    key: 'nifc-fires', status: 'error', settleMs: 15_100,
    responses: [{ url: 'https://x/query', status: 200, bytes: 42_750_000, ms: 41_600, count: 243 }],
  };
  assert.equal(evaluateLayerHealth(dead, opts).verdict, 'breach');
  assert.match(evaluateLayerHealth(dead, opts).reasons[0], /unavailable at 15\.1 s/);
  const http = { ...good, responses: [{ ...good.responses[0], status: 503 }] };
  assert.equal(evaluateLayerHealth(http, opts).verdict, 'breach');
  const empty = {
    key: 'nadm-drought', status: 'no-data', settleMs: 900,
    responses: [{ url: 'https://y', status: 200, bytes: 90, ms: 800, count: 0 }],
  };
  assert.equal(evaluateLayerHealth(empty, opts).verdict, 'breach');
  const emptyOk = { ...empty, key: 'nws-alerts' };
  assert.equal(evaluateLayerHealth(emptyOk, opts).verdict, 'ok');
  const stuck = { key: 'aiannh', status: 'loading', settleMs: 45_000, responses: [] };
  assert.equal(evaluateLayerHealth(stuck, opts).verdict, 'breach');
  const zoom = { key: 'hydrography', status: 'zoom-in', settleMs: 200, responses: [] };
  assert.equal(evaluateLayerHealth(zoom, opts).verdict, 'skipped');
  const local = { key: 'states', status: 'ready', settleMs: 300, responses: [] };
  assert.equal(evaluateLayerHealth(local, opts).verdict, 'skipped');
  assert.match(evaluateLayerHealth(local, opts).reasons[0], /bundled or cached/);
  const ambientOnly = { key: 'nadm-drought', status: 'ready', settleMs: 2_000, responses: [], shared: 3 };
  assert.equal(evaluateLayerHealth(ambientOnly, opts).verdict, 'skipped');
  assert.match(evaluateLayerHealth(ambientOnly, opts).reasons[0], /ambient-boot row/);
  assert.ok(EXPECTS_RECORDS.has('nadm-drought'));
  assert.ok(EXPECTS_RECORDS.has('aiannh'));
  assert.ok(EXPECTS_RECORDS.has('bia-reservations'));
});

test('renderHealthSummary and renderIssueBody carry the receipt without bodies', () => {
  const rows = [{
    key: 'nifc-fires', status: 'ready', settleMs: 4_500, verdict: 'ok', reasons: [],
    responses: [{ url: 'https://x/query?f=geojson', status: 200, bytes: 1_900_000, ms: 4_400, count: 239 }],
  }];
  const md = renderHealthSummary(rows, { sha: 'abc', startedAt: '2026-08-29T13:30:00Z' });
  assert.match(md, /^## Source health: every probed source inside budget/);
  assert.match(md, /\| nifc-fires \| ready \| 4\.5 s \| ok \|/);
  assert.match(md, /239 rec/);
  assert.match(md, /1\.90 MB/);
  const breached = { ...rows[0], verdict: 'breach', reasons: ['unavailable at 15.1 s'] };
  assert.match(renderHealthSummary([breached], { sha: 'abc', startedAt: 'now' }), /^## Source health: 1 breach\b/);
  const body = renderIssueBody(breached, 'https://github.test/run/1');
  assert.match(body, /<!-- ddm-source-health:nifc-fires -->/);
  assert.match(body, /- unavailable at 15\.1 s/);
  assert.match(body, /https:\/\/github\.test\/run\/1/);
  assert.match(body, /\| 200 \| 1,900,000 \| 4\.4 \| 239 \|/);
});

test('parseHealthArgs defaults to the preview origin and a named User-Agent', () => {
  const d = parseHealthArgs([]);
  assert.equal(d.base, 'http://127.0.0.1:4173/');
  assert.equal(d.layers, null);
  assert.equal(d.warnSeconds, 10);
  assert.equal(d.ceilingMs, 45_000);
  assert.match(d.userAgent, /dynamic-drought-module/);
  const a = parseHealthArgs(['--layers', 'nifc-fires, hms-smoke', '--warn-seconds', '5', '--base', 'http://127.0.0.1:4174']);
  assert.deepEqual(a.layers, ['nifc-fires', 'hms-smoke']);
  assert.equal(a.warnSeconds, 5);
  assert.equal(a.base, 'http://127.0.0.1:4174/');
  assert.throws(() => parseHealthArgs(['--nope', '1']), /unknown/);
  assert.throws(() => parseHealthArgs(['--layers']), /needs a value/);
});
