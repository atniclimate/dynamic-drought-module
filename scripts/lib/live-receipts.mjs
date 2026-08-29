/**
 * Pure evaluators for the live verification (DDM-P0-T04, DDM-P0-T08).
 *
 * No network, no browser, no file I/O: the driver (scripts/verify-live.mjs)
 * gathers facts and these functions decide, so every verdict is unit-tested
 * offline (tests/live-receipts.test.mjs). Receipts carry URLs, HTTP status,
 * byte counts, milliseconds, and status words only; never a response body
 * or a screenshot, because an ordinary boot fetches live AIANNH and BIA
 * geometry that the runtime keeps in memory (hard rule 1; see the
 * NON-REDISTRIBUTION GUARD in src/layers/aiannh.ts).
 */

/** The registry statuses that end a layer's activation (the catalog pill
 * carries one of these as a class; `loading` is the only non-terminal one).
 * `error` is the honest `unavailable`: terminal, but recorded as a warning
 * by evaluateLayers because an upstream outage is not a build failure. */
export const TERMINAL_STATUSES = new Set(['ready', 'degraded', 'error', 'no-data', 'zoom-in']);

const DEFAULTS = Object.freeze({
  base: 'https://atniclimate.github.io/dynamic-drought-module/',
  expectSha: '',
  expectNonce: '',
  out: 'live-receipt.json',
  summary: null,
  // Pages propagation wait: the CDN can serve the previous build briefly
  // after deploy-pages returns, so the driver polls the referenced assets
  // for the expected SHA up to this long, at this interval.
  settleMs: 300_000,
  intervalMs: 15_000,
  // Every active layer pill must be terminal inside this ceiling after
  // boot. The longest per-layer runtime budget is 15 s (NIFC perimeters);
  // the ceiling leaves room for the software renderer and a slow upstream
  // while still catching a layer that never resolves.
  ceilingMs: 45_000,
});

const FLAGS = new Map([
  ['--base', ['base', 'string']],
  ['--expect-sha', ['expectSha', 'string']],
  ['--expect-nonce', ['expectNonce', 'string']],
  ['--out', ['out', 'string']],
  ['--summary', ['summary', 'string']],
  ['--settle-ms', ['settleMs', 'int']],
  ['--interval-ms', ['intervalMs', 'int']],
  ['--ceiling-ms', ['ceilingMs', 'int']],
]);

export function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const spec = FLAGS.get(argv[i]);
    if (!spec) throw new Error(`unknown argument ${argv[i]}`);
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`${argv[i]} needs a value`);
    const [key, kind] = spec;
    if (kind === 'int') {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
        throw new Error(`${argv[i]} must be a non-negative integer`);
      }
      out[key] = n;
    } else {
      out[key] = raw;
    }
    i += 1;
  }
  if (!/^https?:\/\//.test(out.base)) throw new Error('--base must be an http(s) URL');
  if (!out.base.endsWith('/')) out.base += '/';
  return out;
}

export function evaluateStamp(stamp, expect) {
  const reasons = [];
  if (!stamp || !stamp.sha) reasons.push('missing data-ddm-build-sha');
  else if (expect.sha && stamp.sha !== expect.sha) reasons.push(`sha ${stamp.sha} differs from expected ${expect.sha}`);
  if (!stamp || !stamp.nonce) reasons.push('missing data-ddm-build-nonce');
  else if (stamp.nonce === 'dev') reasons.push('nonce is the local fallback dev');
  else if (expect.nonce && stamp.nonce !== expect.nonce) reasons.push(`nonce ${stamp.nonce} differs from expected ${expect.nonce}`);
  return { ok: reasons.length === 0, reasons };
}

export function evaluateAssets(rows) {
  const reasons = rows.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.url}`);
  if (rows.length === 0) reasons.push('index.html referenced no assets');
  return { ok: reasons.length === 0, reasons };
}

export function evaluateRange(row) {
  const reasons = [];
  if (row.status !== 206) reasons.push(`status ${row.status}`);
  const m = row.contentRange ? /^bytes 0-(\d+)\/\d+$/.exec(row.contentRange) : null;
  if (!m) reasons.push(`content-range ${row.contentRange ?? 'absent'}`);
  else if (row.bytes !== Number(m[1]) + 1) reasons.push(`body ${row.bytes} bytes, range promised ${Number(m[1]) + 1}`);
  return { ok: reasons.length === 0, reasons };
}

export function evaluateLayers(rows, ceilingMs) {
  const reasons = [];
  const warnings = [];
  if (rows.length === 0) reasons.push('no layer pills were active');
  for (const r of rows) {
    if (!r.status || !TERMINAL_STATUSES.has(r.status)) {
      reasons.push(`${r.key} still ${r.status ?? 'without status'} after ${r.settleMs} ms`);
    } else if (r.settleMs > ceilingMs) {
      reasons.push(`${r.key} reached ${r.status} at ${r.settleMs} ms, over the ${ceilingMs} ms ceiling`);
    } else if (r.status === 'error') {
      warnings.push(`${r.key} unavailable at ${r.settleMs} ms (upstream, not the build)`);
    }
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

export function evaluateEmbedCorner(row) {
  const reasons = [];
  if (row.satHit !== 'satellite') reasons.push(`satellite control hit ${row.satHit ?? 'nothing'}`);
  if (row.attribHit !== 'attribution') reasons.push(`attribution control hit ${row.attribHit ?? 'nothing'}`);
  if (row.infoBtnVisible === true) reasons.push('map-information button visible in embed');
  return { ok: reasons.length === 0, reasons };
}

export function receiptOk(receipt) {
  return receipt.checks.length > 0 && receipt.checks.every((c) => c.ok);
}

export function renderSummary(receipt) {
  const lines = [];
  lines.push(`## Live verification: ${receiptOk(receipt) ? 'pass' : 'FAIL'}`);
  lines.push('');
  lines.push(
    `Base \`${receipt.base}\`; expected sha \`${receipt.expectSha || '(none)'}\`, ` +
      `nonce \`${receipt.expectNonce || '(non-dev)'}\`; propagation ${receipt.propagationMs ?? 'n/a'} ms.`,
  );
  lines.push('');
  lines.push('| Check | Verdict | Detail |');
  lines.push('| --- | --- | --- |');
  for (const c of receipt.checks) {
    const detail = [...c.reasons, ...(c.warnings ?? []).map((w) => `warning: ${w}`)].join('; ');
    lines.push(`| ${c.name} | ${c.ok ? 'pass' : 'FAIL'} | ${detail} |`);
  }
  for (const b of receipt.boots ?? []) {
    lines.push('');
    lines.push(
      `### Boot ${b.name}: \`${b.url}\` in ${b.bootMs ?? '?'} ms, sha \`${b.sha ?? '?'}\`, ` +
        `nonce \`${b.nonce ?? '?'}\`, page errors ${b.errors.length}`,
    );
    if (b.layers?.length) {
      lines.push('');
      lines.push('| Layer | Status | Settled (ms) |');
      lines.push('| --- | --- | --- |');
      for (const l of b.layers) lines.push(`| ${l.key} | ${l.status ?? '(none)'} | ${l.settleMs} |`);
    }
  }
  return lines.join('\n') + '\n';
}
