import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HEALTHZ_ALLOW_METHODS,
  EXPECTED_ALLOW_METHODS,
  PROBES,
  RELAY_BUDGET_MS,
  TRANSPARENCY_UPSTREAM,
  evaluateHealthz,
  evaluateProbe,
  evaluateTransparency,
  parseArgs,
  probeUrl,
  receiptOk,
  renderSummary,
} from '../scripts/lib/worker-receipts.mjs';

const LIVE_REVISION = '2026-07-29-nws-point-heat-v2';
const CANDIDATE_REVISION = '2026-08-29-options-policy-v4';

/**
 * The CORS advertisement the live 2026-07-29 Worker injects, and the one the
 * reviewed source injects. Every difference between these two strings is a
 * failing row, which is the point: the receipt is written against reviewed
 * source, so it must fail against the edge that is running today.
 */
const LIVE_CORS = { allowOrigin: '*', allowMethods: 'GET, POST, OPTIONS', allowHeaders: 'Content-Type' };
const CANDIDATE_CORS = { allowOrigin: '*', allowMethods: 'GET, HEAD, OPTIONS', allowHeaders: 'Accept' };

const row = (fields) => ({
  status: 0,
  error: null,
  bytes: 0,
  sha256: null,
  elapsedMs: 10,
  networkError: null,
  ...fields,
  headers: { maxAge: null, allow: null, cacheControl: null, age: null, ...fields.headers },
});

/* ------------------------------------------------------------------ *
 * parseArgs
 * ------------------------------------------------------------------ */

test('parseArgs applies the Worker defaults and reads every flag', () => {
  const d = parseArgs(['--expect-revision', CANDIDATE_REVISION]);
  assert.equal(d.base, 'https://ddm-proxy.atniclimate.workers.dev/');
  assert.equal(d.expectRevision, CANDIDATE_REVISION);
  assert.equal(d.out, 'worker-receipt.json');
  assert.equal(d.summary, null);
  assert.equal(d.expectHealthzMethods, DEFAULT_HEALTHZ_ALLOW_METHODS);
  assert.equal(d.expectHealthzMethods, EXPECTED_ALLOW_METHODS);
  // Longer than the Worker's own 12 second upstream deadline, so an honest
  // 504 is observed rather than aborted by the client measuring it.
  assert.equal(d.timeoutMs, 20_000);
  assert.ok(d.timeoutMs > RELAY_BUDGET_MS);

  const a = parseArgs([
    '--base', 'https://worker.example', '--expect-revision', 'r1',
    '--expect-healthz-methods', 'GET, OPTIONS',
    '--out', 'r.json', '--summary', 's.md', '--timeout-ms', '5000',
  ]);
  assert.equal(a.base, 'https://worker.example/');
  assert.equal(a.expectRevision, 'r1');
  assert.equal(a.expectHealthzMethods, 'GET, OPTIONS');
  assert.equal(a.out, 'r.json');
  assert.equal(a.summary, 's.md');
  assert.equal(a.timeoutMs, 5000);
});

test('parseArgs refuses a run with no expected revision, and every malformed flag', () => {
  assert.throws(() => parseArgs([]), /--expect-revision/);
  assert.throws(() => parseArgs(['--expect-revision', '']), /--expect-revision/);
  assert.throws(() => parseArgs(['--expect-revision']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown/i);
  assert.throws(() => parseArgs(['--base', 'ftp://x', '--expect-revision', 'r']), /http/);
  assert.throws(() => parseArgs(['--expect-revision', 'r', '--timeout-ms', 'soon']), /positive integer/);
  assert.throws(() => parseArgs(['--expect-revision', 'r', '--timeout-ms', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--expect-revision', 'r', '--expect-healthz-methods', '']), /--expect-healthz-methods/);
});

test('probeUrl builds the public request URL for each probe shape', () => {
  const base = 'https://worker.example/';
  assert.equal(probeUrl(base, { path: '/healthz' }), 'https://worker.example/healthz');
  assert.equal(
    probeUrl(base, { path: '/proxy', upstream: 'https://example.com/a b' }),
    'https://worker.example/proxy?url=https%3A%2F%2Fexample.com%2Fa%20b',
  );
  assert.equal(
    probeUrl('https://worker.example', { path: '/proxy', rawQuery: 'url=a&url=b' }),
    'https://worker.example/proxy?url=a&url=b',
  );
});

/* ------------------------------------------------------------------ *
 * evaluateHealthz (plan rows 1 and 2)
 * ------------------------------------------------------------------ */

const healthzLive = row({
  status: 200,
  revision: LIVE_REVISION,
  headers: { ...LIVE_CORS, cacheControl: 'no-store' },
});
const healthzCandidate = row({
  status: 200,
  revision: CANDIDATE_REVISION,
  headers: { ...CANDIDATE_CORS, cacheControl: 'no-store' },
});

test('evaluateHealthz passes the candidate answer and fails the live one on revision and CORS', () => {
  assert.equal(evaluateHealthz(healthzCandidate, { expectRevision: CANDIDATE_REVISION }).ok, true);

  const live = evaluateHealthz(healthzLive, { expectRevision: CANDIDATE_REVISION });
  assert.equal(live.ok, false);
  assert.ok(live.reasons.some((r) => r.includes(LIVE_REVISION) && r.includes(CANDIDATE_REVISION)));
  assert.ok(live.reasons.some((r) => r.includes('Access-Control-Allow-Methods') && r.includes('GET, POST, OPTIONS')));
  assert.ok(live.reasons.some((r) => r.includes('Access-Control-Allow-Headers') && r.includes('Content-Type')));

  // Naming the live revision removes exactly one reason: the CORS policy is
  // wrong no matter which string the caller expects.
  const liveExpected = evaluateHealthz(healthzLive, { expectRevision: LIVE_REVISION });
  assert.equal(liveExpected.ok, false);
  assert.equal(liveExpected.reasons.length, live.reasons.length - 1);
  assert.ok(!liveExpected.reasons.some((r) => r.includes('revision')));
});

test('evaluateHealthz fails a missing revision, a non-200, a cached health document, and a dead endpoint', () => {
  assert.match(
    evaluateHealthz(row({ status: 200, revision: null, headers: { ...CANDIDATE_CORS, cacheControl: 'no-store' } }), {
      expectRevision: CANDIDATE_REVISION,
    }).reasons[0],
    /no revision field/,
  );
  assert.match(
    evaluateHealthz(row({ status: 503, revision: CANDIDATE_REVISION, headers: { ...CANDIDATE_CORS, cacheControl: 'no-store' } }), {
      expectRevision: CANDIDATE_REVISION,
    }).reasons[0],
    /status 503/,
  );
  assert.ok(
    evaluateHealthz(
      row({ status: 200, revision: CANDIDATE_REVISION, headers: { ...CANDIDATE_CORS, cacheControl: 'public, max-age=60' } }),
      { expectRevision: CANDIDATE_REVISION },
    ).reasons.some((r) => r.includes('Cache-Control')),
  );
  const dead = evaluateHealthz(row({ networkError: 'fetch failed' }), { expectRevision: CANDIDATE_REVISION });
  assert.equal(dead.ok, false);
  assert.match(dead.reasons[0], /request failed/);
});

test('evaluateHealthz takes the advertised method set as an input, not a constant', () => {
  const narrow = row({
    status: 200,
    revision: CANDIDATE_REVISION,
    headers: { ...CANDIDATE_CORS, allowMethods: 'GET, OPTIONS', cacheControl: 'no-store' },
  });
  const againstDefault = evaluateHealthz(narrow, { expectRevision: CANDIDATE_REVISION });
  assert.equal(againstDefault.ok, false);
  assert.ok(againstDefault.reasons.some((r) => r.includes('Access-Control-Allow-Methods "GET, OPTIONS"')));
  assert.equal(
    evaluateHealthz(narrow, { expectRevision: CANDIDATE_REVISION, expectMethods: 'GET, OPTIONS' }).ok,
    true,
  );
});

/* ------------------------------------------------------------------ *
 * evaluateProbe
 * ------------------------------------------------------------------ */

const probeById = (id) => {
  const probe = PROBES.find((p) => p.id === id);
  assert.ok(probe, `probe ${id} is missing from the table`);
  return probe;
};

test('evaluateProbe asserts the status AND the error code, so a 403 from upstream is not read as a Worker rejection', () => {
  const post = probeById('post-allowed-route');
  // Live today: the method gate never fired and something further along
  // refused with 403 and no Worker error code. Status alone would score a
  // "rejected" pass; the code is what tells the two apart.
  const live = evaluateProbe(row({ status: 403, error: null, headers: LIVE_CORS }), post.expect);
  assert.equal(live.ok, false);
  assert.ok(live.reasons.some((r) => r.includes('status 403, expected 405')));
  assert.ok(live.reasons.some((r) => r.includes('error code absent') && r.includes('method_not_allowed')));

  // The candidate refuses by method BEFORE any host lookup and names the
  // methods it accepts, which RFC 9110 section 15.5.6 requires of a 405.
  const withAllow = evaluateProbe(
    row({ status: 405, error: 'method_not_allowed', headers: { ...CANDIDATE_CORS, allow: EXPECTED_ALLOW_METHODS } }),
    post.expect,
  );
  assert.equal(withAllow.ok, true);
  assert.deepEqual(withAllow.warnings, []);

  const wrongAllow = evaluateProbe(
    row({ status: 405, error: 'method_not_allowed', headers: { ...CANDIDATE_CORS, allow: 'GET, POST, OPTIONS' } }),
    post.expect,
  );
  assert.equal(wrongAllow.ok, false);
  assert.ok(wrongAllow.reasons.some((r) => r.includes('Allow "GET, POST, OPTIONS"')));

  // The header is required here, so its absence fails rather than warns.
  const missingAllow = evaluateProbe(row({ status: 405, error: 'method_not_allowed', headers: CANDIDATE_CORS }), post.expect);
  assert.equal(missingAllow.ok, false);
  assert.ok(missingAllow.reasons.some((r) => r.includes('Allow absent')));

  // A row that only records the header warns instead.
  const optional = evaluateProbe(row({ status: 405, error: 'method_not_allowed', headers: CANDIDATE_CORS }), {
    ...post.expect,
    allow: { value: EXPECTED_ALLOW_METHODS, required: false },
  });
  assert.equal(optional.ok, true);
  assert.ok(optional.warnings.some((w) => w.includes('Allow absent')));
});

test('evaluateProbe separates a refusal by host from a refusal by route', () => {
  const foreign = probeById('foreign-host').expect;
  // Live answers 403 host_not_allowed: the right status for the wrong
  // reason, because the reviewed source has no host-only gate left.
  const live = evaluateProbe(row({ status: 403, error: 'host_not_allowed', headers: LIVE_CORS }), foreign);
  assert.equal(live.ok, false);
  assert.ok(live.reasons.some((r) => r.includes('host_not_allowed') && r.includes('route_not_allowed')));
  assert.equal(
    evaluateProbe(row({ status: 403, error: 'route_not_allowed', headers: CANDIDATE_CORS }), foreign).ok,
    true,
  );
});

test('evaluateProbe fails the off-route relay that live still performs', () => {
  const offRoute = probeById('off-route-allowed-host').expect;
  const live = evaluateProbe(row({ status: 200, error: null, bytes: 50, headers: LIVE_CORS }), offRoute);
  assert.equal(live.ok, false);
  assert.ok(live.reasons.some((r) => r.includes('status 200, expected 403')));
  assert.equal(
    evaluateProbe(row({ status: 403, error: 'route_not_allowed', headers: CANDIDATE_CORS }), offRoute).ok,
    true,
  );
});

test('evaluateProbe fails the preflight that answers 204 before validating anything', () => {
  const offRoute = probeById('options-off-route').expect;
  const unknownPath = probeById('options-unknown-path').expect;
  const liveOffRoute = evaluateProbe(row({ status: 204, headers: { ...LIVE_CORS, maxAge: '86400' } }), offRoute);
  assert.equal(liveOffRoute.ok, false);
  assert.ok(liveOffRoute.reasons.some((r) => r.includes('status 204, expected 403')));
  const liveUnknown = evaluateProbe(row({ status: 204, headers: { ...LIVE_CORS, maxAge: '86400' } }), unknownPath);
  assert.equal(liveUnknown.ok, false);
  assert.ok(liveUnknown.reasons.some((r) => r.includes('status 204, expected 404')));

  assert.equal(
    evaluateProbe(row({ status: 403, error: 'route_not_allowed', headers: CANDIDATE_CORS }), offRoute).ok,
    true,
  );
  assert.equal(
    evaluateProbe(row({ status: 404, error: 'not_found', headers: CANDIDATE_CORS }), unknownPath).ok,
    true,
  );

  // The allowed preflight must still advertise the one-day cache lifetime.
  const allowed = probeById('options-allowed').expect;
  assert.equal(evaluateProbe(row({ status: 204, headers: { ...CANDIDATE_CORS, maxAge: '86400' } }), allowed).ok, true);
  const noMaxAge = evaluateProbe(row({ status: 204, headers: CANDIDATE_CORS }), allowed);
  assert.equal(noMaxAge.ok, false);
  assert.ok(noMaxAge.reasons.some((r) => r.includes('Access-Control-Max-Age absent')));
});

test('evaluateProbe records an upstream outage as a warning but never masks a Worker refusal', () => {
  const relayExpect = probeById('relay-nwrfc-ws').expect;
  const outage = evaluateProbe(row({ status: 504, error: 'upstream_timeout', headers: CANDIDATE_CORS }), relayExpect);
  assert.equal(outage.ok, true);
  assert.ok(outage.warnings.some((w) => w.includes('upstream unavailable')));

  // A 403 on an allowed route is a policy failure, not an outage, so the
  // tolerance must not swallow it.
  const refused = evaluateProbe(row({ status: 403, error: 'route_not_allowed', headers: CANDIDATE_CORS }), relayExpect);
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some((r) => r.includes('status 403')));

  // `error: null` means no Worker code at all, so a JSON refusal riding a
  // 200 cannot pass as a relay.
  const refusalOn200 = evaluateProbe(row({ status: 200, error: 'route_not_allowed', headers: CANDIDATE_CORS }), relayExpect);
  assert.equal(refusalOn200.ok, false);
  assert.ok(refusalOn200.reasons.some((r) => r.includes('refused with "route_not_allowed"')));
});

test('evaluateProbe warns past the upstream deadline and fails a dead request', () => {
  const relayExpect = probeById('relay-agrimet-sites').expect;
  const slow = evaluateProbe(row({ status: 200, elapsedMs: 15_884, headers: CANDIDATE_CORS }), relayExpect);
  assert.equal(slow.ok, true);
  assert.ok(slow.warnings.some((w) => w.includes('15884 ms') && w.includes('12000 ms')));
  // A relay that never answered is an agency problem, recorded, not a
  // policy failure. A row that asserts a refusal is not given that grace.
  const deadRelay = evaluateProbe(row({ networkError: 'This operation was aborted', elapsedMs: 20_017 }), relayExpect);
  assert.equal(deadRelay.ok, true);
  assert.ok(deadRelay.warnings.some((w) => w.includes('upstream unavailable') && w.includes('20017 ms')));
  const deadRefusal = evaluateProbe(row({ networkError: 'fetch failed' }), probeById('foreign-host').expect);
  assert.equal(deadRefusal.ok, false);
  assert.match(deadRefusal.reasons[0], /request failed/);
});

test('the probe table covers every allow-listed route family and every negative shape', () => {
  const ids = PROBES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'probe ids must be unique');
  // Row 4 is every route FAMILY, not a sample: both AWDB paths, both USBR
  // paths, NWRFC, USDM DSCI, the WHP tile, and all four NWS shapes.
  assert.equal(PROBES.filter((p) => p.row === 4).length, 11);
  for (const id of [
    'healthz', 'healthz-head', 'head-allowed', 'head-off-route',
    'options-allowed', 'options-off-route', 'options-unknown-path',
    'post-allowed-route', 'off-route-allowed-host', 'foreign-host',
    'removed-host', 'unknown-path', 'bounds-missing-url',
    'bounds-two-url-params', 'bounds-url-too-long', 'bounds-http-scheme',
    'bounds-credentials', 'bounds-port',
  ]) {
    assert.ok(ids.includes(id), `probe ${id} is missing`);
  }
  // No HEAD row asserts an error code: a HEAD response has no body to read
  // one from, so such a row could only ever fail.
  for (const probe of PROBES.filter((p) => p.method === 'HEAD')) {
    assert.equal(probe.expect.error, undefined, `${probe.id} asserts a code no HEAD response can carry`);
  }
  // Only one non-safe method reaches the edge, with an empty body, on a
  // route the policy must refuse before any upstream fetch.
  assert.deepEqual(PROBES.filter((p) => !['GET', 'HEAD', 'OPTIONS'].includes(p.method)).map((p) => p.method), ['POST']);
});

/* ------------------------------------------------------------------ *
 * evaluateTransparency (plan row 12)
 * ------------------------------------------------------------------ */

const HASH = '627510f7af047d84103bcd05c24867528d0a98c5d6fe070c56040a97cb9e4443';

test('evaluateTransparency passes byte-identical legs and fails a changed body', () => {
  const direct = row({ status: 200, bytes: 139_288, sha256: HASH });
  const proxied = row({ status: 200, bytes: 139_288, sha256: HASH });
  const ok = evaluateTransparency({ direct, proxied });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);

  const changed = evaluateTransparency({
    direct,
    proxied: row({ status: 200, bytes: 139_288, sha256: 'f'.repeat(64) }),
  });
  assert.equal(changed.ok, false);
  assert.ok(changed.reasons.some((r) => r.includes('sha256')));

  const truncated = evaluateTransparency({
    direct,
    proxied: row({ status: 200, bytes: 12, sha256: 'f'.repeat(64) }),
  });
  assert.equal(truncated.ok, false);
  assert.ok(truncated.reasons.some((r) => r.includes('relayed 12 bytes')));
});

test('evaluateTransparency calls a non-200 direct leg inconclusive and warns when an edge copy answered', () => {
  const inconclusive = evaluateTransparency({
    direct: row({ status: 503 }),
    proxied: row({ status: 200, bytes: 1, sha256: HASH }),
  });
  assert.equal(inconclusive.ok, false);
  assert.match(inconclusive.reasons[0], /inconclusive/);

  const refused = evaluateTransparency({
    direct: row({ status: 200, bytes: 1, sha256: HASH }),
    proxied: row({ status: 403 }),
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some((r) => r.includes('relayed leg answered 403')));

  const cached = evaluateTransparency({
    direct: row({ status: 200, bytes: 1, sha256: HASH }),
    proxied: row({ status: 200, bytes: 1, sha256: HASH, headers: { age: '54' } }),
  });
  assert.equal(cached.ok, true);
  assert.ok(cached.warnings.some((w) => w.includes('Age 54')));

  const dead = evaluateTransparency({ direct: row({ networkError: 'fetch failed' }), proxied: row({ status: 200 }) });
  assert.equal(dead.ok, false);
  assert.match(dead.reasons[0], /direct leg failed/);

  assert.ok(TRANSPARENCY_UPSTREAM.startsWith('https://'), 'the transparency endpoint must be a static https read');
});

/* ------------------------------------------------------------------ *
 * A whole receipt, both worlds.
 * ------------------------------------------------------------------ */

/**
 * What the live 2026-07-29 edge answered on 2026-08-29, transcribed from a
 * read-only run of scripts/verify-worker.mjs against the public Worker.
 */
const LIVE_ANSWERS = new Map([
  ['healthz', { status: 200, revision: LIVE_REVISION, headers: { cacheControl: 'no-store' } }],
  ['healthz-head', { status: 405 }],
  ['relay-awdb-data', { status: 200 }],
  ['relay-awdb-stations', { status: 200 }],
  ['relay-agrimet-sites', { status: 200 }],
  ['relay-hydromet-arc', { status: 200 }],
  ['relay-nwrfc-ws', { status: 200, elapsedMs: 12_661 }],
  ['relay-usdm-dsci', { status: 200 }],
  ['relay-whp-export', { status: 200 }],
  ['relay-nws-point', { status: 200 }],
  ['relay-nws-gridpoint', { status: 200 }],
  ['relay-nws-observation', { status: 200 }],
  ['relay-nws-alerts', { status: 200 }],
  ['head-allowed', { status: 200 }],
  ['head-off-route', { status: 520 }],
  ['options-allowed', { status: 204, headers: { maxAge: '86400' } }],
  ['options-off-route', { status: 204, headers: { maxAge: '86400' } }],
  ['options-unknown-path', { status: 204, headers: { maxAge: '86400' } }],
  ['post-allowed-route', { status: 403 }],
  ['off-route-allowed-host', { status: 200, bytes: 50 }],
  ['foreign-host', { status: 403, error: 'host_not_allowed' }],
  ['removed-host', { status: 200, bytes: 42_192 }],
  ['unknown-path', { status: 404, error: 'not_found' }],
  ['bounds-missing-url', { status: 400, error: 'missing_url' }],
  ['bounds-two-url-params', { status: 200, bytes: 139_288 }],
  ['bounds-url-too-long', { status: 414, error: 'url_too_long' }],
  ['bounds-http-scheme', { status: 504, error: 'upstream_timeout' }],
  ['bounds-credentials', { status: 500, headers: { allowOrigin: null, allowMethods: null, allowHeaders: null } }],
  ['bounds-port', { status: 504, error: 'upstream_timeout' }],
]);

/**
 * What the reviewed source must answer once it is published: the route,
 * method, and CORS policy read off workers/proxy/src/index.ts, with slice
 * 0's route-validated preflight. NWRFC is given the honest 504 its slow
 * upstream earns against the Worker's 12 second deadline, to prove an
 * outage does not fail the receipt.
 */
const CANDIDATE_ANSWERS = new Map([
  ['healthz', { status: 200, revision: CANDIDATE_REVISION, headers: { cacheControl: 'no-store' } }],
  ['healthz-head', { status: 405, headers: { cacheControl: 'no-store' } }],
  ['relay-awdb-data', { status: 200 }],
  ['relay-awdb-stations', { status: 200 }],
  ['relay-agrimet-sites', { status: 200 }],
  ['relay-hydromet-arc', { status: 200 }],
  ['relay-nwrfc-ws', { status: 504, error: 'upstream_timeout', elapsedMs: 12_100 }],
  ['relay-usdm-dsci', { status: 200 }],
  ['relay-whp-export', { status: 200 }],
  ['relay-nws-point', { status: 200 }],
  ['relay-nws-gridpoint', { status: 200 }],
  ['relay-nws-observation', { status: 200 }],
  ['relay-nws-alerts', { status: 200 }],
  ['head-allowed', { status: 200 }],
  ['head-off-route', { status: 403 }],
  ['options-allowed', { status: 204, headers: { maxAge: '86400' } }],
  ['options-off-route', { status: 403, error: 'route_not_allowed' }],
  ['options-unknown-path', { status: 404, error: 'not_found' }],
  ['post-allowed-route', { status: 405, error: 'method_not_allowed', headers: { allow: EXPECTED_ALLOW_METHODS } }],
  ['off-route-allowed-host', { status: 403, error: 'route_not_allowed' }],
  ['foreign-host', { status: 403, error: 'route_not_allowed' }],
  ['removed-host', { status: 403, error: 'route_not_allowed' }],
  ['unknown-path', { status: 404, error: 'not_found' }],
  ['bounds-missing-url', { status: 400, error: 'missing_url' }],
  ['bounds-two-url-params', { status: 400, error: 'invalid_url_count' }],
  ['bounds-url-too-long', { status: 414, error: 'url_too_long' }],
  ['bounds-http-scheme', { status: 400, error: 'unsupported_scheme' }],
  ['bounds-credentials', { status: 400, error: 'credentials_not_allowed' }],
  ['bounds-port', { status: 400, error: 'port_not_allowed' }],
]);

function buildReceipt(answers, cors, expectRevision) {
  const checks = [];
  let observedRevision = null;
  for (const probe of PROBES) {
    const answer = answers.get(probe.id);
    assert.ok(answer, `no fixture answer for ${probe.id}`);
    const observed = row({ ...answer, headers: { ...cors, ...answer.headers } });
    const verdict = probe.health
      ? evaluateHealthz(observed, { expectRevision })
      : evaluateProbe(observed, probe.expect);
    if (probe.health) observedRevision = observed.revision ?? null;
    checks.push({
      id: probe.id,
      row: probe.row,
      name: probe.name,
      method: probe.method,
      status: observed.status,
      error: observed.error,
      ok: verdict.ok,
      reasons: verdict.reasons,
      warnings: verdict.warnings,
    });
  }
  const transparency = {
    direct: row({ status: 200, bytes: 139_288, sha256: HASH }),
    proxied: row({ status: 200, bytes: 139_288, sha256: HASH }),
  };
  const t = evaluateTransparency(transparency);
  checks.push({
    id: 'body-transparency',
    row: 12,
    name: 'body transparency, static endpoint',
    method: 'GET',
    status: 200,
    error: null,
    ok: t.ok,
    reasons: t.reasons,
    warnings: t.warnings,
  });
  return {
    base: 'https://ddm-proxy.atniclimate.workers.dev/',
    expectRevision,
    expectHealthzMethods: DEFAULT_HEALTHZ_ALLOW_METHODS,
    observedRevision,
    checks,
    transparency,
    timing: { budgetMs: RELAY_BUDGET_MS, maxRelayMs: 12_661, probe: 'relay-nwrfc-ws' },
  };
}

test('the receipt FAILS against the edge running today, on the rows the plan names', () => {
  const receipt = buildReceipt(LIVE_ANSWERS, LIVE_CORS, CANDIDATE_REVISION);
  assert.equal(receiptOk(receipt), false);
  const failed = new Set(receipt.checks.filter((c) => !c.ok).map((c) => c.id));
  for (const id of [
    'healthz', 'options-allowed', 'options-off-route', 'options-unknown-path',
    'post-allowed-route', 'off-route-allowed-host', 'foreign-host', 'removed-host',
  ]) {
    assert.ok(failed.has(id), `${id} must fail against the live edge`);
  }
  // Byte transparency is the one thing live already gets right.
  assert.ok(!failed.has('body-transparency'));
  assert.equal(failed.size, receipt.checks.length - 1);
});

test('naming the live revision leaves the policy failures standing', () => {
  const receipt = buildReceipt(LIVE_ANSWERS, LIVE_CORS, LIVE_REVISION);
  assert.equal(receiptOk(receipt), false);
  const healthz = receipt.checks.find((c) => c.id === 'healthz');
  assert.equal(healthz.ok, false);
  assert.ok(!healthz.reasons.some((r) => r.includes('revision')));
  // Every row that fails on route, method, or preflight policy fails for a
  // reason that has nothing to do with the revision string.
  for (const id of ['options-off-route', 'post-allowed-route', 'off-route-allowed-host', 'removed-host']) {
    assert.equal(receipt.checks.find((c) => c.id === id).ok, false);
  }
});

test('the receipt PASSES against the reviewed candidate', () => {
  const receipt = buildReceipt(CANDIDATE_ANSWERS, CANDIDATE_CORS, CANDIDATE_REVISION);
  const failing = receipt.checks.filter((c) => !c.ok);
  assert.deepEqual(failing.map((c) => `${c.id}: ${c.reasons.join('; ')}`), []);
  assert.equal(receiptOk(receipt), true);
  // The unavailable upstream is still visible in the receipt.
  assert.ok(receipt.checks.find((c) => c.id === 'relay-nwrfc-ws').warnings.some((w) => w.includes('upstream unavailable')));
});

test('receiptOk refuses an empty receipt, and renderSummary shows every row plus the caveats', () => {
  assert.equal(receiptOk({ checks: [] }), false);
  const live = renderSummary(buildReceipt(LIVE_ANSWERS, LIVE_CORS, CANDIDATE_REVISION));
  assert.match(live, /## Worker edge receipt: FAIL/);
  assert.ok(live.includes(LIVE_REVISION) && live.includes(CANDIDATE_REVISION));
  assert.match(live, /\| 8 \| GET an off-route path of an allowed host \| GET \| 200 \|/);
  assert.match(live, /Allow absent/);
  assert.match(live, /expected health methods `GET, HEAD, OPTIONS`/);
  assert.match(live, /Body transparency \(row 12\)/);
  assert.match(live, /Slowest relay 12661 ms/);
  // One table row per check, plus the heading, the preamble, and the two
  // trailing notes.
  assert.equal(live.split('\n').filter((l) => l.startsWith('| ')).length, PROBES.length + 1 + 2);

  const pass = renderSummary(buildReceipt(CANDIDATE_ANSWERS, CANDIDATE_CORS, CANDIDATE_REVISION));
  assert.match(pass, /## Worker edge receipt: pass/);
  assert.match(pass, /0 of \d+ checks failing/);
});
