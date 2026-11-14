import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Grants.gov open-opportunity reader (src/impact/grants.ts), ported from
 * Policy Sentinel's Worker adapter (worker/src/sources/grants.ts there) and its
 * source review of 2026-10-23. Not wired into any screen yet.
 *
 * Pinned here: the request (a text/plain POST, so a browser sends no
 * preflight), the parser (made-up opportunities in the live response's shape),
 * entity decoding, the open filter, the hazard tags keyed to the project's own
 * mode keys, and the status and cancellation matrix: blank success, corrupt
 * body, a truncated body, an error envelope, a partial page, an abort during
 * the body read, a late answer after supersession, and no pending work after
 * cancel. Off-coverage does not apply: the search is national and has no
 * coverage edge. No request reaches the network; `fetch` is stubbed.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const grants = await import('../src/impact/grants.ts');
const { HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
const {
  GRANTS_GOV_SEARCH_URL, TRIBAL_GOVERNMENT_ELIGIBILITY, GRANT_TOPIC_RULES,
  decodeEntities, grantsSearchRequest, parseGrantsSearch, openTribalGrants, grantsForMode, grantTopics, readTribalGrants
} = grants;

const READ_AT = '2026-11-13T18:00:00.000Z';

/** Made-up opportunities, shaped like a live search2 answer (Policy Sentinel review, 2026-10-23). */
function hit(over = {}) {
  return {
    id: '900001', number: 'EX-DROUGHT-01', title: 'Example Tribal Drought Resilience Program',
    agencyCode: 'DOI-EX', agency: 'Example Bureau', openDate: '10/01/2026', closeDate: '12/15/2026',
    oppStatus: 'posted', docType: 'synopsis', cfdaList: ['15.999'],
    ...over
  };
}
const answer = (hits, hitCount = hits.length, extra = {}) =>
  ({ errorcode: 0, msg: 'Webservice Succeeds', token: 'not-kept', data: { hitCount, startRecord: 0, oppHits: hits }, ...extra });

test('the request: one text/plain POST for open and forecast rows listed for federally recognized Tribal governments', () => {
  assert.equal(GRANTS_GOV_SEARCH_URL, 'https://api.grants.gov/v1/api/search2');
  assert.deepEqual(TRIBAL_GOVERNMENT_ELIGIBILITY, { code: '07', label: 'Native American tribal governments (Federally recognized)' });
  const init = grantsSearchRequest();
  assert.equal(init.method, 'POST');
  // A JSON content type would need a preflight, which Grants.gov refuses (403).
  assert.deepEqual(init.headers, { 'Content-Type': 'text/plain' });
  assert.deepEqual(JSON.parse(init.body), { rows: 1000, eligibilities: '07', oppStatuses: 'forecasted|posted' });
});

test('the parser keeps only whitelisted fields, converts dates exactly and links the issuer page', () => {
  const read = parseGrantsSearch(answer([hit({ agencyContactEmail: 'someone@example.gov' })]), READ_AT);
  assert.equal(read.state, 'live');
  assert.equal(read.readAt, READ_AT);
  assert.equal(read.partial, false);
  assert.deepEqual(read.rows, [{
    id: '900001', number: 'EX-DROUGHT-01', title: 'Example Tribal Drought Resilience Program',
    agency: 'Example Bureau', status: 'posted', opens: '2026-10-01', closes: '2026-12-15',
    listings: ['15.999'], url: 'https://www.grants.gov/search-results-detail/900001'
  }]);
  assert.doesNotMatch(JSON.stringify(read), /someone@example|not-kept/);
});

test('titles: HTML entities decode to characters, the agency wording is kept, unknown entities stay as written', () => {
  assert.equal(decodeEntities('Fiscal Year 2026 &ndash; Flood &amp; Water &#8217;s &#x41; &bogus;'), 'Fiscal Year 2026 – Flood & Water ’s A &bogus;');
  const read = parseGrantsSearch(answer([hit({ title: 'Example Watershed&nbsp;Program &ndash; Tribes', agency: 'Example  Office of   Water' })]), READ_AT);
  assert.equal(read.rows[0].title, 'Example Watershed Program – Tribes');
  assert.equal(read.rows[0].agency, 'Example Office of Water');
});

test('a forecast keeps no close date (the issuer calls it an estimate); an empty close date stays absent, never "no deadline"', () => {
  const read = parseGrantsSearch(answer([
    hit({ id: '900002', oppStatus: 'forecasted', docType: 'forecast', closeDate: '03/01/2027' }),
    hit({ id: '900003', closeDate: '' })
  ]), READ_AT);
  assert.deepEqual(read.rows.map((r) => [r.status, r.closes]), [['forecasted', null], ['posted', null]]);
});

test('an issuer status outside the whitelist stays unknown and is never read as open', () => {
  const read = parseGrantsSearch(answer([hit({ oppStatus: null }), hit({ id: '900004', oppStatus: 'Posted ' })]), READ_AT);
  assert.deepEqual(read.rows.map((r) => r.status), ['unknown', 'unknown']);
  assert.deepEqual(openTribalGrants(read.rows, '2026-11-13'), []);
});

test('a malformed row is dropped and counted, which makes the read partial; a repeated id is kept once', () => {
  const read = parseGrantsSearch(answer([
    hit(),
    hit({ id: 900005 }),                       // numeric id
    hit({ id: '900006', closeDate: '02/30/2027' }), // impossible date
    hit({ id: '900007', openDate: '2026-10-01' }),  // ISO, not the issuer's form
    hit({ id: '900008', title: '   ' }),
    hit({ id: '900009', number: ' EX-1' }),
    hit()                                       // same id again
  ]), READ_AT);
  assert.equal(read.state, 'live');
  assert.deepEqual(read.rows.map((r) => r.id), ['900001']);
  assert.equal(read.dropped, 5);
  assert.equal(read.partial, true);
});

test('a page shorter than the stated hit count is partial, not complete', () => {
  const read = parseGrantsSearch(answer([hit()], 3), READ_AT);
  assert.equal(read.state, 'live');
  assert.equal(read.hitCount, 3);
  assert.equal(read.partial, true);
});

test('an empty answer is an honest empty read; an error envelope or a missing list is unavailable, never empty', () => {
  const empty = parseGrantsSearch(answer([]), READ_AT);
  assert.deepEqual(empty, { state: 'live', readAt: READ_AT, hitCount: 0, rows: [], dropped: 0, partial: false });
  for (const raw of [
    { errorcode: 1, msg: 'fail', data: {} },
    { errorcode: 0, data: { hitCount: 1 } },
    { errorcode: 0, data: { hitCount: -1, oppHits: [] } },
    { data: { hitCount: 0, oppHits: [] } },
    null, [], 'text'
  ]) {
    assert.equal(parseGrantsSearch(raw, READ_AT).state, 'unavailable', JSON.stringify(raw));
  }
});

test('the open filter keeps posted rows not yet closed and forecasts, and tags each from the one rule table', () => {
  const read = parseGrantsSearch(answer([
    hit({ id: '1', title: 'Example Drought and Water Supply Grants' }),
    hit({ id: '2', title: 'Example Community Wildfire Defense', closeDate: '11/13/2026' }),
    hit({ id: '3', title: 'Example Flood Mitigation Assistance', closeDate: '11/12/2026' }),
    hit({ id: '4', title: 'Example Extreme Heat Preparedness', closeDate: '' }),
    hit({ id: '5', title: 'Example Youth Health Research', oppStatus: 'forecasted' })
  ]), READ_AT);
  const open = openTribalGrants(read.rows, '2026-11-13');
  // Closed yesterday is gone; closing today stays; no close date stays as posted.
  assert.deepEqual(open.map((r) => [r.id, r.topics]), [
    ['1', ['drought', 'water']],
    ['2', ['wildfire']],
    ['4', ['heat']],
    ['5', []]
  ]);
});

test('the rule table tags plain words only, never by guess', () => {
  assert.deepEqual(grantTopics('Fire Prevention and Safety Grants'), []);
  assert.deepEqual(grantTopics('Assistance to Firefighters'), []);
  assert.deepEqual(grantTopics('Hazardous Fuels Reduction on Tribal Lands'), ['wildfire']);
  assert.deepEqual(grantTopics('Floodplain Mapping'), ['flood']);
  assert.deepEqual(grantTopics('Low Income Home Energy Assistance'), []);
  // Every rule names a mode key or one of the two non-mode topics.
  const allowed = new Set([...HAZARD_CLUSTER_KEYS, 'flood', 'water']);
  for (const rule of GRANT_TOPIC_RULES) assert.ok(allowed.has(rule.topic), rule.topic);
});

test('the mode filter takes any mode key from src/config/clusters.ts', () => {
  const read = parseGrantsSearch(answer([
    hit({ id: '1', title: 'Example Drought Response' }),
    hit({ id: '2', title: 'Example Wildfire Risk Reduction' })
  ]), READ_AT);
  const open = openTribalGrants(read.rows, '2026-11-13');
  for (const mode of HAZARD_CLUSTER_KEYS) {
    const rows = grantsForMode(open, mode);
    assert.ok(rows.every((r) => r.topics.includes(mode)), mode);
  }
  assert.deepEqual(grantsForMode(open, 'drought').map((r) => r.id), ['1']);
});

/* ---------- the network read: status and cancellation matrix ---------- */

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}
const restore = () => { globalThis.fetch = realFetch; };
const ok = (text) => Promise.resolve(new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }));

test('the read posts the request through the budget helper and parses the answer', async (t) => {
  t.after(restore);
  const calls = stubFetch(() => ok(JSON.stringify(answer([hit()]))));
  const read = await readTribalGrants(new AbortController().signal, new Date(READ_AT));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GRANTS_GOV_SEARCH_URL);
  assert.equal(calls[0].init.headers['Content-Type'], 'text/plain');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(read.state, 'live');
  assert.equal(read.rows.length, 1);
});

test('a blank 200, a corrupt body, a truncated body and an HTTP error are unavailable, never an empty list', async (t) => {
  t.after(restore);
  const full = JSON.stringify(answer([hit()]));
  for (const [label, respond] of [
    ['blank 200', () => ok('')],
    ['corrupt', () => ok('<html>Service Unavailable</html>')],
    ['truncated', () => ok(full.slice(0, full.length - 20))],
    ['HTTP 503', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['HTTP 429', () => Promise.resolve(new Response('{}', { status: 429 }))],
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))]
  ]) {
    stubFetch(respond);
    const read = await readTribalGrants(new AbortController().signal, new Date(READ_AT));
    assert.equal(read.state, 'unavailable', label);
  }
});

/** A body that sends half of an answer, then waits; records whether it was cancelled. */
function stalledBody() {
  const state = { cancelled: false };
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"errorcode":0,"data":{"hitCount":1,')); },
    cancel() { state.cancelled = true; }
  });
  return { state, response: new Response(stream, { status: 200 }) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an abort during the body read rejects as an abort, cancels the stream and leaves nothing pending', async (t) => {
  t.after(restore);
  const { state, response } = stalledBody();
  let sentSignal;
  stubFetch((_url, init) => { sentSignal = init.signal; return Promise.resolve(response); });
  const ctrl = new AbortController();
  const pending = readTribalGrants(ctrl.signal, new Date(READ_AT));
  await settle();
  ctrl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sentSignal.aborted, true);
  assert.equal(state.cancelled, true);
});

test('a late answer after supersession is dropped: the superseded read rejects as an abort and returns no rows', async (t) => {
  t.after(restore);
  let release;
  stubFetch(() => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify(answer([hit()])), { status: 200 })); }));
  const first = new AbortController();
  const superseded = readTribalGrants(first.signal, new Date(READ_AT));
  await settle();
  first.abort();
  release();
  await assert.rejects(superseded, { name: 'AbortError' });
});

test('a read that runs past its time budget is unavailable, and its stream is cancelled', async (t) => {
  t.after(restore);
  const { state, response } = stalledBody();
  stubFetch(() => Promise.resolve(response));
  const read = await readTribalGrants(new AbortController().signal, new Date(READ_AT), 30);
  assert.equal(read.state, 'unavailable');
  assert.match(read.reason, /time/);
  assert.equal(state.cancelled, true);
});

test('a read cancelled before it starts sends nothing', async (t) => {
  t.after(restore);
  const calls = stubFetch(() => ok('{}'));
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(readTribalGrants(ctrl.signal, new Date(READ_AT)), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});
