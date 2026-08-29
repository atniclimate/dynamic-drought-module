import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TERMINAL_STATUSES,
  evaluateAssets,
  evaluateEmbedCorner,
  evaluateLayers,
  evaluateRange,
  evaluateStamp,
  parseArgs,
  receiptOk,
  renderSummary,
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
