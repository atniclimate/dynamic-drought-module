import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EXPECTED_BOOT_LAYERS,
  LIVE_COMPARE_GRACE_MS,
  LIVE_INFLIGHT_STUCK_MS,
  TERMINAL_STATUSES,
  evaluateAssets,
  evaluateEmbedCorner,
  evaluateLayers,
  evaluateRange,
  evaluateStamp,
  expectedNonces,
  extractStamp,
  parseArgs,
  receiptOk,
  renderSummary,
  resolveLiveExpectation,
} from '../scripts/lib/live-receipts.mjs';

test('parseArgs applies the live defaults and reads every flag', () => {
  const d = parseArgs([]);
  assert.equal(d.base, 'https://atniclimate.github.io/dynamic-drought-module/');
  assert.equal(d.settleMs, 300_000);
  assert.equal(d.ceilingMs, 45_000);
  assert.equal(d.out, 'live-receipt.json');
  assert.equal(d.summary, null);
  const a = parseArgs([
    '--base', 'http://127.0.0.1:4174', '--expect-sha', 'abc', '--expect-nonce', '42',
    '--out', 'r.json', '--summary', 's.md', '--settle-ms', '1000', '--ceiling-ms', '2000', '--interval-ms', '100',
  ]);
  assert.equal(a.base, 'http://127.0.0.1:4174/');
  assert.equal(a.expectSha, 'abc');
  assert.equal(a.expectNonce, '42');
  assert.deepEqual(a.expectNonces, ['42']);
  assert.deepEqual(parseArgs(['--expect-nonce', '42,43']).expectNonces, ['42', '43']);
  assert.equal(a.summary, 's.md');
  assert.equal(a.settleMs, 1000);
  assert.equal(a.ceilingMs, 2000);
  assert.equal(a.intervalMs, 100);
  assert.equal(d.light, false);
  const light = parseArgs(['--light', '--expect-sha', 'abc']);
  assert.equal(light.light, true, '--light takes no value and does not eat the next flag');
  assert.equal(light.expectSha, 'abc');
  assert.throws(() => parseArgs(['--base', 'ftp://x']), /http/);
  assert.throws(() => parseArgs(['--bogus']), /unknown/i);
  assert.throws(() => parseArgs(['--settle-ms', 'soon']), /integer/);
});

test('evaluateStamp requires the expected SHA, a non-dev nonce, and the expected nonce when given', () => {
  assert.equal(evaluateStamp({ sha: 'abc', nonce: '7' }, { sha: 'abc', nonce: '7' }).ok, true);
  assert.match(evaluateStamp({ sha: 'abc', nonce: '7' }, { sha: 'def' }).reasons[0], /sha/);
  assert.match(evaluateStamp({ sha: 'abc', nonce: 'dev' }, { sha: 'abc' }).reasons[0], /dev/);
  assert.match(evaluateStamp({ sha: 'abc', nonce: '7' }, { sha: 'abc', nonce: '8' }).reasons[0], /nonce/);
  assert.match(evaluateStamp({}, { sha: 'abc' }).reasons[0], /missing/);
  assert.equal(evaluateStamp({ sha: 'abc-dirty', nonce: '7' }, { sha: 'abc' }).ok, false);
});

test('evaluateStamp accepts any member of the published-nonce set and records the match', () => {
  const expect = { sha: 'abc', nonces: ['100', '200'] };
  const first = evaluateStamp({ sha: 'abc', nonce: '100' }, expect);
  assert.equal(first.ok, true);
  assert.equal(first.matchedNonce, '100');
  const second = evaluateStamp({ sha: 'abc', nonce: '200' }, expect);
  assert.equal(second.ok, true);
  assert.equal(second.matchedNonce, '200');
  const other = evaluateStamp({ sha: 'abc', nonce: '300' }, expect);
  assert.equal(other.ok, false);
  assert.equal(other.matchedNonce, null);
  assert.match(other.reasons[0], /nonce 300 is none of the deploy runs .*100, 200/);
  // The workflow hands the set over as one comma-separated flag value.
  assert.deepEqual(expectedNonces({ nonce: ' 100 , 200 ,' }), ['100', '200']);
  assert.deepEqual(expectedNonces({}), []);
  assert.equal(evaluateStamp({ sha: 'abc', nonce: '200' }, { sha: 'abc', nonce: '100,200' }).ok, true);
});

test('extractStamp reads the build sha and nonce out of a shipped script', () => {
  const minified = 'x.dataset.ddmBuildSha="4a78af",x.dataset.ddmBuildNonce="33246718167";';
  assert.deepEqual(extractStamp(minified), { sha: '4a78af', nonce: '33246718167' });
  const spaced = "document.documentElement.dataset.ddmBuildSha = 'abc';\ndocument.documentElement.dataset.ddmBuildNonce = 'dev';";
  assert.deepEqual(extractStamp(spaced), { sha: 'abc', nonce: 'dev' });
  assert.deepEqual(extractStamp('nothing here'), { sha: null, nonce: null });
  // A stamp that cannot be read is null, not an empty string that would
  // slide past evaluateStamp as a value.
  assert.equal(evaluateStamp(extractStamp('nothing here'), { sha: 'abc', nonces: ['1'] }).ok, false);
});

test('evaluateAssets fails on any non-200 relative asset and on an empty list', () => {
  assert.equal(evaluateAssets([{ url: 'x/a.js', status: 200 }]).ok, true);
  const r = evaluateAssets([{ url: 'x/a.js', status: 200 }, { url: 'x/b.css', status: 404 }]);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /404 x\/b\.css/);
  assert.equal(evaluateAssets([]).ok, false);
});

test('evaluateRange requires 206 with a Content-Range from byte 0 and a body of the promised size', () => {
  const row = { name: 'a.pmtiles', status: 206, contentRange: 'bytes 0-16383/35252210', bytes: 16384, localBytes: 35252210 };
  assert.equal(evaluateRange(row).ok, true);
  assert.equal(evaluateRange({ ...row, status: 200, contentRange: null, bytes: 35252210 }).ok, false);
  assert.equal(evaluateRange({ ...row, contentRange: 'bytes 100-16483/35252210' }).ok, false);
  assert.equal(evaluateRange({ ...row, bytes: 10 }).ok, false);
});

test('evaluateRange fails when the served archive is not the size of the checked-out one', () => {
  const stale = evaluateRange({
    name: 'hillshade-dem-pnw.pmtiles',
    status: 206,
    contentRange: 'bytes 0-16383/29000000',
    bytes: 16384,
    localBytes: 35252210,
  });
  assert.equal(stale.ok, false, 'a self-consistent range answer is not proof of identity');
  assert.match(stale.reasons[0], /served archive is 29000000 bytes, the checked-out hillshade-dem-pnw\.pmtiles is 35252210/);
  const unknown = evaluateRange({ name: 'a.pmtiles', status: 206, contentRange: 'bytes 0-16383/35252210', bytes: 16384, localBytes: null });
  assert.equal(unknown.ok, false, 'an unknown local size cannot silently pass as identity');
  assert.match(unknown.reasons[0], /checked-out size of a\.pmtiles is unknown/);
});

test('evaluateLayers passes terminal states inside the ceiling, warns on unavailable, fails on stuck or late', () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['degraded', 'error', 'no-data', 'ready', 'zoom-in']);
  const ok = evaluateLayers([{ key: 'states', status: 'ready', settleMs: 900 }], 45_000);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  const warn = evaluateLayers(
    [{ key: 'states', status: 'ready', settleMs: 900 }, { key: 'nifc-fires', status: 'error', settleMs: 15_200 }],
    45_000,
  );
  assert.equal(warn.ok, true);
  assert.match(warn.warnings[0], /nifc-fires unavailable/);
  const stuck = evaluateLayers([{ key: 'aiannh', status: 'loading', settleMs: 45_000 }], 45_000);
  assert.equal(stuck.ok, false);
  assert.match(stuck.reasons[0], /aiannh .*loading/);
  const late = evaluateLayers([{ key: 'aiannh', status: 'ready', settleMs: 46_000 }], 45_000);
  assert.equal(late.ok, false);
  const none = evaluateLayers([], 45_000);
  assert.equal(none.ok, false);
  assert.match(none.reasons[0], /no layer pill carried a status/);
});

test('evaluateLayers fails on a missing expected pill, a vanished pill, and a total blackout', () => {
  const rows = [
    { key: 'states', status: 'ready', settleMs: 900 },
    { key: 'aiannh', status: 'ready', settleMs: 1200 },
  ];
  assert.equal(evaluateLayers(rows, 45_000, { expectedKeys: ['states', 'aiannh'] }).ok, true);
  const missing = evaluateLayers(rows, 45_000, { expectedKeys: ['states', 'aiannh', 'hillshade'] });
  assert.equal(missing.ok, false, 'a layer that never carried a status is a failure, not an absence');
  assert.match(missing.reasons[0], /expected layer hillshade never carried a status/);
  const extra = evaluateLayers(rows, 45_000, { expectedKeys: ['states'] });
  assert.equal(extra.ok, true, 'an unexpected active layer is a warning, not a failure');
  assert.match(extra.warnings[0], /aiannh was active but is not in this boot's expected set/);
  const gone = evaluateLayers(
    [{ key: 'states', status: 'ready', settleMs: 900 }, { key: 'aiannh', status: 'ready', settleMs: 1200, disappeared: true }],
    45_000,
    { expectedKeys: ['states', 'aiannh'] },
  );
  assert.equal(gone.ok, false, 'a pill observed and then unmounted must not keep its earlier value');
  assert.match(gone.reasons[0], /aiannh was ready and then vanished/);
  const blackout = evaluateLayers(
    [{ key: 'states', status: 'error', settleMs: 900 }, { key: 'aiannh', status: 'error', settleMs: 1200 }],
    45_000,
    { expectedKeys: ['states', 'aiannh'] },
  );
  assert.equal(blackout.ok, false, 'every layer unavailable is this boot, not two upstream outages');
  assert.match(blackout.reasons[0], /every active layer is unavailable \(2 of 2\)/);
});

test('evaluateLayers fails a ready layer that is unavailable now, and only when a previous receipt exists', () => {
  const rows = [
    { key: 'states', status: 'ready', settleMs: 900 },
    { key: 'nifc-fires', status: 'error', settleMs: 15_200 },
  ];
  const options = { expectedKeys: ['states', 'nifc-fires'] };
  assert.equal(evaluateLayers(rows, 45_000, options).ok, true, 'no previous receipt, no comparison');
  const regressed = evaluateLayers(rows, 45_000, {
    ...options,
    previousStatuses: { states: 'ready', 'nifc-fires': 'ready' },
  });
  assert.equal(regressed.ok, false);
  assert.match(regressed.reasons[0], /nifc-fires was ready in the previous receipt .* unavailable now/);
  const alreadyDown = evaluateLayers(rows, 45_000, {
    ...options,
    previousStatuses: { states: 'ready', 'nifc-fires': 'error' },
  });
  assert.equal(alreadyDown.ok, true, 'an upstream that was already down stays a warning');
});

// The table in live-receipts.mjs is a copy of runtime behavior, so it is
// re-derived here from the two config files that own that behavior. A
// recipe or defaultOn change that the table does not follow fails here
// instead of letting the live proof pass with a layer missing.
test('EXPECTED_BOOT_LAYERS still matches src/config/layers.ts and src/config/clusters.ts', () => {
  const root = new URL('..', import.meta.url);
  const layersSrc = readFileSync(new URL('src/config/layers.ts', root), 'utf8');
  const clustersSrc = readFileSync(new URL('src/config/clusters.ts', root), 'utf8');

  const defs = new Map();
  const block = layersSrc.slice(layersSrc.indexOf('export const LAYER_DEFS'));
  for (const line of block.slice(0, block.indexOf('\n];')).split('\n')) {
    const key = /\{ key: '([^']+)'/.exec(line)?.[1];
    if (!key) continue;
    defs.set(key, {
      role: /role: '([^']+)'/.exec(line)?.[1] ?? null,
      defaultOn: /defaultOn: true/.test(line),
      coActivateWith: [...(/coActivateWith: \[([^\]]*)\]/.exec(line)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
    });
  }
  assert.ok(defs.size > 10, 'the layer definitions could not be parsed');

  const clusterBody = clustersSrc.slice(clustersSrc.indexOf('export const HAZARD_CLUSTERS'));
  const clusterObject = clusterBody.slice(0, clusterBody.indexOf('\n};'));
  const marks = [...clusterObject.matchAll(/\n {2}(\w+): \{/g)];
  const currentRecipe = new Map();
  for (const [i, mark] of marks.entries()) {
    const chunk = clusterObject.slice(mark.index, marks[i + 1]?.index ?? clusterObject.length);
    const list = /current: \[([^\]]*)\]/.exec(chunk)?.[1] ?? '';
    currentRecipe.set(mark[1], [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  }
  assert.deepEqual([...currentRecipe.keys()], ['drought', 'wildfire', 'heat', 'enso']);

  // composeClusterIntent: every default-on key that is not a surface, then
  // the cluster's recipe with coActivateWith partners expanded.
  const persistent = [...defs].filter(([, d]) => d.defaultOn && d.role !== 'surface').map(([key]) => key);
  const compose = (cluster) => {
    const out = [...persistent];
    for (const key of currentRecipe.get(cluster)) {
      if (!out.includes(key)) out.push(key);
      for (const partner of defs.get(key)?.coActivateWith ?? []) if (!out.includes(partner)) out.push(partner);
    }
    return out.sort();
  };
  // A bare URL is the default-on set exactly (src/state/url.ts).
  const defaultOn = [...defs].filter(([, d]) => d.defaultOn).map(([key]) => key).sort();

  const sorted = (keys) => [...keys].sort();
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS.root), defaultOn);
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS.root), compose('drought'), 'drought composes back to the default-on set');
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS.wildfire), compose('wildfire'));
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS.heat), compose('heat'));
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS.enso), compose('enso'));
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS['embed-1280']), compose('wildfire'));
  assert.deepEqual(sorted(EXPECTED_BOOT_LAYERS['embed-390']), compose('wildfire'));
  for (const [boot, keys] of Object.entries(EXPECTED_BOOT_LAYERS)) {
    for (const key of keys) assert.ok(defs.has(key), `${boot} expects unknown layer ${key}`);
  }
});

test('evaluateEmbedCorner requires the satellite and attribution hits and no map-information button', () => {
  assert.equal(evaluateEmbedCorner({ satHit: 'satellite', attribHit: 'attribution', infoBtnVisible: false }).ok, true);
  assert.equal(evaluateEmbedCorner({ satHit: 'brand-pill', attribHit: 'attribution', infoBtnVisible: false }).ok, false);
  assert.equal(evaluateEmbedCorner({ satHit: 'satellite', attribHit: 'attribution', infoBtnVisible: true }).ok, false);
  assert.equal(evaluateEmbedCorner({ satHit: 'satellite', attribHit: 'attribution' }).ok, true);
});

test('renderSummary names every check with its verdict and carries the layer rows', () => {
  const receipt = {
    base: 'https://example.test/', expectSha: 'abc', expectNonce: '7', propagationMs: 1200,
    checks: [
      { name: 'stamp:root', ok: true, reasons: [], warnings: [] },
      { name: 'range:hillshade-dem-pnw.pmtiles', ok: false, reasons: ['status 200'], warnings: [] },
    ],
    boots: [{ name: 'root', url: 'https://example.test/', bootMs: 4000, sha: 'abc', nonce: '7', errors: [], layers: [{ key: 'states', status: 'ready', settleMs: 900 }] }],
  };
  const md = renderSummary(receipt);
  assert.match(md, /stamp:root \| pass/);
  assert.match(md, /range:hillshade-dem-pnw\.pmtiles \| FAIL \| status 200/);
  assert.match(md, /\| states \| ready \| 900 \|/);
  assert.equal(receiptOk(receipt), false);
  receipt.checks[1].ok = true;
  assert.equal(receiptOk(receipt), true);
  assert.match(renderSummary(receipt), /^## Live verification: pass/);
});

/* resolveLiveExpectation: what should be live, and can that be checked now. */

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLDER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = '2026-08-29T14:15:00Z';
const minutesBefore = (n) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

const scheduled = (overrides = {}) => ({
  eventName: 'schedule',
  workflowRun: null,
  headSha: HEAD,
  headCommittedAt: minutesBefore(90),
  deployRuns: [],
  now: NOW,
  ...overrides,
});

const run = (overrides) => ({
  databaseId: 1,
  headSha: HEAD,
  conclusion: 'success',
  status: 'completed',
  createdAt: minutesBefore(80),
  updatedAt: minutesBefore(70),
  ...overrides,
});

test('the grace period is 30 minutes', () => {
  assert.equal(LIVE_COMPARE_GRACE_MS, 30 * 60 * 1000);
});

test('a successful workflow_run verifies the commit and run id that deploy built', () => {
  const out = resolveLiveExpectation({
    eventName: 'workflow_run',
    workflowRun: { id: 33240334529, headSha: HEAD, conclusion: 'success' },
    headSha: OLDER,
    headCommittedAt: minutesBefore(1),
    deployRuns: [],
    now: NOW,
  });
  assert.equal(out.verdict, 'verify');
  assert.equal(out.sha, HEAD, 'the deploy run head sha wins over the current head of main');
  assert.equal(out.nonce, '33240334529');
  assert.match(out.reason, /post-deploy proof: deploy run 33240334529/);
});

test('a workflow_run that did not succeed is a caller error, not a verdict', () => {
  assert.throws(
    () => resolveLiveExpectation({ eventName: 'workflow_run', workflowRun: { id: 5, headSha: HEAD, conclusion: 'cancelled' }, now: NOW }),
    /job condition should have skipped/,
  );
  assert.throws(() => resolveLiveExpectation({ eventName: 'workflow_run', workflowRun: null, now: NOW }), /workflow_run/);
});

test('a scheduled compare verifies main head against its successful deploy run', () => {
  const out = resolveLiveExpectation(scheduled({ deployRuns: [run({ databaseId: 4242 })] }));
  assert.equal(out.verdict, 'verify');
  assert.equal(out.sha, HEAD);
  assert.equal(out.nonce, '4242');
  assert.match(out.reason, /schedule compare: main head aaaa.* was published by deploy run 4242/);
});

test('a dispatched compare behaves like the scheduled one and names its event', () => {
  const out = resolveLiveExpectation(scheduled({ eventName: 'workflow_dispatch', deployRuns: [run({ databaseId: 7 })] }));
  assert.equal(out.verdict, 'verify');
  assert.equal(out.nonce, '7');
  assert.match(out.reason, /^workflow_dispatch compare:/);
});

test('when the same commit deployed successfully twice, both runs are accepted and the newest is named', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [
      run({ databaseId: 100, createdAt: minutesBefore(80), updatedAt: minutesBefore(70) }),
      run({ databaseId: 200, createdAt: minutesBefore(50), updatedAt: minutesBefore(40) }),
    ],
  }));
  assert.equal(out.verdict, 'verify');
  assert.equal(out.nonce, '200');
  assert.deepEqual(out.nonces, ['100', '200'], 'creation order, oldest first');
  assert.match(out.reason, /accepting any of 100, 200/);
});

// The wrong-nonce defect the 2026-08-29 adversarial review found: R1
// published, R2 published later and is what Pages serves, then someone
// re-ran R1 and that rerun failed. Ranking by updatedAt made the stale R1
// the newest candidate, so the proof demanded R1's nonce and failed the
// correct live build. Both are now accepted and the site decides.
test('a failed rerun of an older publisher cannot outrank the run that published last', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [
      run({
        databaseId: 1001,
        createdAt: minutesBefore(180),
        updatedAt: minutesBefore(2),
        attempt: 2,
        conclusion: 'failure',
        status: 'completed',
        anyAttemptSucceeded: true,
      }),
      run({ databaseId: 1002, createdAt: minutesBefore(90), updatedAt: minutesBefore(85) }),
    ],
  }));
  assert.equal(out.verdict, 'verify');
  assert.deepEqual(out.nonces, ['1001', '1002']);
  assert.equal(out.nonce, '1002', 'the run created last is the one the prose names');
  const live = evaluateStamp({ sha: HEAD, nonce: '1002' }, { sha: out.sha, nonces: out.nonces });
  assert.equal(live.ok, true, "R2's nonce is accepted");
  assert.equal(live.matchedNonce, '1002');
  assert.equal(evaluateStamp({ sha: HEAD, nonce: '1001' }, { sha: out.sha, nonces: out.nonces }).ok, true);
  assert.equal(evaluateStamp({ sha: HEAD, nonce: '999' }, { sha: out.sha, nonces: out.nonces }).ok, false);
});

test('a future-dated head does not stay in-flight forever', () => {
  const hours = (n) => new Date(Date.parse(NOW) + n * 3_600_000).toISOString();
  // No deploy run at all: the only clock is unusable, so the age reads as
  // zero and the compare says so instead of trusting the future date.
  const alone = resolveLiveExpectation(scheduled({ headCommittedAt: hours(48), deployRuns: [] }));
  assert.equal(alone.verdict, 'in-flight');
  assert.match(alone.warnings[0], /committer date .* is 2880 minutes in the future/);
  assert.match(alone.reason, /is 0 minutes old/);
  // With a deploy run for the head, the run clock is the whole answer: a
  // head whose only deploy failed three hours ago is a divergence no
  // matter what its committer date claims.
  const withRun = resolveLiveExpectation(scheduled({
    headCommittedAt: hours(48),
    deployRuns: [run({ databaseId: 808, conclusion: 'failure', createdAt: minutesBefore(180), updatedAt: minutesBefore(175) })],
  }));
  assert.equal(withRun.verdict, 'undeployed');
  assert.match(withRun.reason, /head for 180 minutes/);
  assert.match(withRun.reason, /warning: the committer date/);
});

// A real rerun keeps the run id and only bumps `attempt`, and gh run list
// then reports the LATEST attempt's conclusion for that one row.
test('a rerun that failed does not hide the attempt that published the same commit', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [run({
      databaseId: 100,
      attempt: 2,
      conclusion: 'failure',
      status: 'completed',
      anyAttemptSucceeded: true,
      updatedAt: minutesBefore(10),
    })],
  }));
  assert.equal(out.verdict, 'verify', 'Pages is still serving what attempt 1 published');
  assert.equal(out.nonce, '100', 'the run id is the build nonce across every attempt');
});

test('a rerun still running does not hide the attempt that published the same commit', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [run({
      databaseId: 100,
      attempt: 2,
      conclusion: null,
      status: 'in_progress',
      anyAttemptSucceeded: true,
      createdAt: minutesBefore(5),
      updatedAt: minutesBefore(5),
    })],
  }));
  assert.equal(out.verdict, 'verify');
  assert.equal(out.nonce, '100');
});

test('a rerun with no successful attempt is not treated as published', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 100, attempt: 3, conclusion: 'failure', anyAttemptSucceeded: false })],
  }));
  assert.equal(out.verdict, 'undeployed');
  assert.match(out.reason, /latest deploy run 100 concluded failure/);
});

test('a queued or running deploy of main head is in-flight, not a divergence', () => {
  const started = { createdAt: minutesBefore(6), updatedAt: minutesBefore(6) };
  const queued = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 900, conclusion: null, status: 'queued', ...started })],
  }));
  assert.equal(queued.verdict, 'in-flight');
  assert.equal(queued.nonce, '');
  assert.match(queued.reason, /deploy run 900 .* is queued/);
  const running = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 901, conclusion: null, status: 'in_progress', ...started })],
  }));
  assert.equal(running.verdict, 'in-flight');
  assert.match(running.reason, /is in_progress/);
});

test('a deploy stuck unfinished past the in-flight bound stops reading as in-flight', () => {
  const stuck = resolveLiveExpectation(scheduled({
    deployRuns: [run({
      databaseId: 902,
      conclusion: null,
      status: 'queued',
      createdAt: minutesBefore(75),
      updatedAt: minutesBefore(75),
    })],
  }));
  assert.equal(stuck.verdict, 'undeployed');
  assert.match(stuck.reason, /deploy run 902 has been queued for 75 minutes, past the 60 minute in-flight bound/);
  const waiting = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 903, conclusion: null, status: 'waiting', createdAt: minutesBefore(90), updatedAt: minutesBefore(90) })],
  }));
  assert.equal(waiting.verdict, 'undeployed', 'an environment protection hold is still a live build that never arrived');
  const fresh = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 904, conclusion: null, status: 'queued', createdAt: minutesBefore(4), updatedAt: minutesBefore(4) })],
  }));
  assert.equal(fresh.verdict, 'in-flight');
});

// The deploy's own envelope is longer than the head's grace: a 15 minute
// gate plus a 40 minute browser shard budget. A run 45 minutes in is late,
// not stuck, and answering both questions with 30 minutes accused it.
test('the head grace and the in-flight bound are separate envelopes', () => {
  assert.equal(LIVE_COMPARE_GRACE_MS, 30 * 60 * 1000);
  assert.equal(LIVE_INFLIGHT_STUCK_MS, 60 * 60 * 1000);
  const late = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 910, conclusion: null, status: 'in_progress', createdAt: minutesBefore(45), updatedAt: minutesBefore(45) })],
  }));
  assert.equal(late.verdict, 'in-flight', 'still inside the deploy budget the browser suite documents');
  const tightened = resolveLiveExpectation(scheduled({
    stuckMs: 20 * 60_000,
    deployRuns: [run({ databaseId: 911, conclusion: null, status: 'in_progress', createdAt: minutesBefore(45), updatedAt: minutesBefore(45) })],
  }));
  assert.equal(tightened.verdict, 'undeployed', 'the bound is an input, not a constant the caller cannot reach');
  assert.match(tightened.reason, /past the 20 minute in-flight bound/);
});

test('an unfinished deploy whose start time cannot be read is not waited on forever', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 905, conclusion: null, status: 'queued', createdAt: 'not a date', updatedAt: null })],
  }));
  assert.equal(out.verdict, 'undeployed');
  assert.match(out.reason, /deploy run 905 is queued and its start time \(not a date\) could not be read/);
});

test('a backdated head commit cannot skip the grace period its deploy is still inside', () => {
  const out = resolveLiveExpectation(scheduled({
    headCommittedAt: '2019-01-01T00:00:00Z',
    deployRuns: [run({
      databaseId: 700,
      conclusion: 'failure',
      status: 'completed',
      createdAt: minutesBefore(3),
      updatedAt: minutesBefore(2),
    })],
  }));
  assert.equal(out.verdict, 'in-flight', 'age is floored by this head\'s first deploy run');
  assert.match(out.reason, /is 3 minutes old, inside the 30 minute grace period/);
});

// Flooring by the NEWEST run would report 3 minutes here and stay green
// for as long as someone kept pressing re-run.
test('retrying a deploy does not reset the grace period the head has already spent', () => {
  const out = resolveLiveExpectation(scheduled({
    headCommittedAt: '2019-01-01T00:00:00Z',
    deployRuns: [
      run({ databaseId: 700, conclusion: 'failure', status: 'completed', createdAt: minutesBefore(200), updatedAt: minutesBefore(190) }),
      run({ databaseId: 701, conclusion: 'failure', status: 'completed', createdAt: minutesBefore(3), updatedAt: minutesBefore(2) }),
    ],
  }));
  assert.equal(out.verdict, 'undeployed', 'the head first entered a release 200 minutes ago');
  assert.match(out.reason, /head for 200 minutes; latest deploy run 701 concluded failure/);
});

test('a commit younger than the grace period with no successful deploy is in-flight', () => {
  const out = resolveLiveExpectation(scheduled({ headCommittedAt: minutesBefore(12), deployRuns: [] }));
  assert.equal(out.verdict, 'in-flight');
  assert.match(out.reason, /12 minutes old, inside the 30 minute grace period/);
  const custom = resolveLiveExpectation(scheduled({ headCommittedAt: minutesBefore(12), graceMs: 5 * 60_000 }));
  assert.equal(custom.verdict, 'undeployed', 'a shorter grace period ends sooner');
});

test('a failed deploy of main head past the grace period is an undeployed divergence', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 555, conclusion: 'failure' })],
  }));
  assert.equal(out.verdict, 'undeployed');
  assert.equal(out.sha, HEAD);
  assert.equal(out.nonce, '');
  assert.match(out.reason, /main is ahead of the live build: no successful deploy of aaaa/);
  assert.match(out.reason, /latest deploy run 555 concluded failure/);
});

test('a cancelled deploy of main head reads as undeployed and names the cancellation', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [
      run({ databaseId: 556, conclusion: 'cancelled', updatedAt: minutesBefore(60) }),
      run({ databaseId: 557, conclusion: 'cancelled', updatedAt: minutesBefore(35) }),
    ],
  }));
  assert.equal(out.verdict, 'undeployed');
  assert.match(out.reason, /latest deploy run 557 concluded cancelled/);
});

test('a successful deploy of an older commit only is still a divergence for main head', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 42, headSha: OLDER })],
  }));
  assert.equal(out.verdict, 'undeployed');
  assert.match(out.reason, /no deploy run for that commit was found; the newest deploy run 42 built bbbb/);
});

test('no deploy runs at all past the grace period is a divergence that says so', () => {
  const out = resolveLiveExpectation(scheduled({ deployRuns: [] }));
  assert.equal(out.verdict, 'undeployed');
  assert.match(out.reason, /no deploy run for main was found at all/);
});

test('resolveLiveExpectation rejects inputs it cannot judge', () => {
  assert.throws(() => resolveLiveExpectation({}), /eventName is required/);
  assert.throws(() => resolveLiveExpectation({ eventName: 'push' }), /unsupported event push/);
  assert.throws(() => resolveLiveExpectation(scheduled({ headSha: '' })), /headSha is required/);
  assert.throws(() => resolveLiveExpectation(scheduled({ now: 'soon' })), /now is not a parseable timestamp/);
  assert.throws(() => resolveLiveExpectation(scheduled({ headCommittedAt: null })), /headCommittedAt is not a parseable/);
});
