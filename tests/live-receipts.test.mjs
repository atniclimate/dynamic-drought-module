import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_COMPARE_GRACE_MS,
  TERMINAL_STATUSES,
  evaluateAssets,
  evaluateEmbedCorner,
  evaluateLayers,
  evaluateRange,
  evaluateStamp,
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
  assert.equal(a.summary, 's.md');
  assert.equal(a.settleMs, 1000);
  assert.equal(a.ceilingMs, 2000);
  assert.equal(a.intervalMs, 100);
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

test('evaluateAssets fails on any non-200 relative asset and on an empty list', () => {
  assert.equal(evaluateAssets([{ url: 'x/a.js', status: 200 }]).ok, true);
  const r = evaluateAssets([{ url: 'x/a.js', status: 200 }, { url: 'x/b.css', status: 404 }]);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /404 x\/b\.css/);
  assert.equal(evaluateAssets([]).ok, false);
});

test('evaluateRange requires 206 with a Content-Range from byte 0 and a body of the promised size', () => {
  assert.equal(evaluateRange({ name: 'a.pmtiles', status: 206, contentRange: 'bytes 0-16383/35252210', bytes: 16384 }).ok, true);
  assert.equal(evaluateRange({ name: 'a.pmtiles', status: 200, contentRange: null, bytes: 35252210 }).ok, false);
  assert.equal(evaluateRange({ name: 'a.pmtiles', status: 206, contentRange: 'bytes 100-16483/35252210', bytes: 16384 }).ok, false);
  assert.equal(evaluateRange({ name: 'a.pmtiles', status: 206, contentRange: 'bytes 0-16383/35252210', bytes: 10 }).ok, false);
});

test('evaluateLayers passes terminal states inside the ceiling, warns on unavailable, fails on stuck or late', () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['degraded', 'error', 'no-data', 'ready', 'zoom-in']);
  const ok = evaluateLayers([{ key: 'states', status: 'ready', settleMs: 900 }], 45_000);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  const warn = evaluateLayers([{ key: 'nifc-fires', status: 'error', settleMs: 15_200 }], 45_000);
  assert.equal(warn.ok, true);
  assert.match(warn.warnings[0], /nifc-fires unavailable/);
  const stuck = evaluateLayers([{ key: 'aiannh', status: 'loading', settleMs: 45_000 }], 45_000);
  assert.equal(stuck.ok, false);
  assert.match(stuck.reasons[0], /aiannh .*loading/);
  const late = evaluateLayers([{ key: 'aiannh', status: 'ready', settleMs: 46_000 }], 45_000);
  assert.equal(late.ok, false);
  const none = evaluateLayers([], 45_000);
  assert.equal(none.ok, false);
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

test('when the same commit deployed successfully twice, the latest successful run is the nonce', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [
      run({ databaseId: 100, createdAt: minutesBefore(80), updatedAt: minutesBefore(70) }),
      run({ databaseId: 200, createdAt: minutesBefore(50), updatedAt: minutesBefore(40) }),
    ],
  }));
  assert.equal(out.verdict, 'verify');
  assert.equal(out.nonce, '200');
});

test('a successful deploy still wins while a later rerun of the same commit is in progress', () => {
  const out = resolveLiveExpectation(scheduled({
    deployRuns: [
      run({ databaseId: 100 }),
      run({ databaseId: 300, conclusion: null, status: 'in_progress', createdAt: minutesBefore(5), updatedAt: minutesBefore(5) }),
    ],
  }));
  assert.equal(out.verdict, 'verify');
  assert.equal(out.nonce, '100');
});

test('a queued or running deploy of main head is in-flight, not a divergence', () => {
  const queued = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 900, conclusion: null, status: 'queued' })],
  }));
  assert.equal(queued.verdict, 'in-flight');
  assert.equal(queued.nonce, '');
  assert.match(queued.reason, /deploy run 900 .* is queued/);
  const running = resolveLiveExpectation(scheduled({
    deployRuns: [run({ databaseId: 901, conclusion: null, status: 'in_progress' })],
  }));
  assert.equal(running.verdict, 'in-flight');
  assert.match(running.reason, /is in_progress/);
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
