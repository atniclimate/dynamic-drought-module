#!/usr/bin/env node
/**
 * Edge receipt for the optional Cross-Origin Resource Sharing Worker
 * (DDM-P0-T05, slice 2).
 *
 * Proves, by probing the PUBLIC Worker at --base, that the deployed edge
 * enforces the route, method, and CORS policy in the reviewed source at
 * workers/proxy/src/index.ts:
 *
 *   1. `GET /healthz` names the expected revision, with the reviewed CORS
 *      advertisement and no caching (plan rows 1 and 2);
 *   2. `HEAD /healthz` is refused 405 (row 3);
 *   3. every allow-listed route FAMILY relays, not a sample of three: both
 *      AWDB paths, both USBR paths, NWRFC, USDM DSCI, the USFS WHP
 *      exportImage tile, and all four NWS shapes (row 4);
 *   4. HEAD and OPTIONS answer only for an allow-listed target, and an
 *      unknown path answers 404 (rows 5, 6, 11);
 *   5. a POST on an allowed route is refused BY THE METHOD GATE, asserted on
 *      the status and the Worker's own error code, because a 403 from
 *      somewhere further along is not the same rejection (row 7);
 *   6. an off-route path of an allowed host, a host that was never
 *      allow-listed, and a host the reviewed revision removed are all
 *      refused (rows 8, 9, 10);
 *   7. the relay hands back upstream bytes unchanged, on one static,
 *      cache-busted endpoint (row 12);
 *   8. the request bounds hold: an oversized url, an http target,
 *      credentials, a port, a duplicated and a missing url parameter
 *      (row 13);
 *   9. every relay answers inside the Worker's own upstream deadline
 *      (row 14, recorded).
 *
 * Read-only against the edge. The only non-safe method is a single POST
 * with an EMPTY body to an allow-listed route, which the policy must refuse
 * before any upstream fetch; it is the probe that distinguishes a method
 * gate from a downstream refusal. Nothing here forces the upstream deadline
 * or the rate limiter: both need a hostile or slow upstream, and driving the
 * limiter is the abuse it exists to stop.
 *
 * Receipts hold the probe id, the method, the public request URL, the HTTP
 * status, the Worker's JSON error code, the `Access-Control-*` and `Allow`
 * header values, byte counts, SHA-256 digests, and milliseconds. No response
 * body and no error `detail` prose is written or logged, the same discipline
 * the live receipt keeps (hard rule 1; see the NON-REDISTRIBUTION GUARD in
 * src/layers/aiannh.ts).
 *
 * Usage: node scripts/verify-worker.mjs --expect-revision <revision>
 *   [--base <url>] [--expect-healthz-methods "GET, HEAD, OPTIONS"]
 *   [--out <json>] [--summary <markdown file to append>] [--timeout-ms n]
 * Exit 0 when every check passed, 1 when any failed, 2 on a usage error.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';

import {
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
} from './lib/worker-receipts.mjs';

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(String(error.message ?? error));
  console.error('usage: node scripts/verify-worker.mjs --expect-revision <revision> [--base <url>] [--expect-healthz-methods "GET, HEAD, OPTIONS"] [--out <json>] [--summary <md>] [--timeout-ms n]');
  process.exit(2);
}

const receipt = {
  base: args.base,
  expectRevision: args.expectRevision,
  expectHealthzMethods: args.expectHealthzMethods,
  observedRevision: null,
  startedAt: new Date().toISOString(),
  checks: [],
  probes: [],
  transparency: null,
  timing: null,
};

function record(probe, row, verdict) {
  receipt.checks.push({
    id: probe.id,
    row: probe.row,
    name: probe.name,
    method: probe.method,
    status: row.status,
    error: row.error,
    ok: verdict.ok,
    reasons: verdict.reasons,
    warnings: verdict.warnings ?? [],
  });
  const detail = verdict.reasons.length ? `: ${verdict.reasons.join('; ')}` : '';
  console.log(`${verdict.ok ? 'pass' : 'FAIL'} ${probe.id}${detail}`);
  for (const warning of verdict.warnings ?? []) console.log(`     warning: ${warning}`);
}

/** The headers a receipt may carry. Nothing here identifies a caller. */
function headersOfInterest(response) {
  return {
    allowOrigin: response.headers.get('access-control-allow-origin'),
    allowMethods: response.headers.get('access-control-allow-methods'),
    allowHeaders: response.headers.get('access-control-allow-headers'),
    maxAge: response.headers.get('access-control-max-age'),
    allow: response.headers.get('allow'),
    cacheControl: response.headers.get('cache-control'),
    contentType: response.headers.get('content-type'),
    age: response.headers.get('age'),
    retryAfter: response.headers.get('retry-after'),
  };
}

/**
 * One request, recorded. The body is consumed only to measure it: bytes
 * always, a SHA-256 when the probe asks for one, and, for a non-2xx JSON
 * answer, the Worker's `error` code. The `detail` string beside that code
 * and the bytes themselves are never kept.
 */
async function probeOnce(url, { method = 'GET', hash = false, wantRevision = false, redirect = 'manual', headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const started = Date.now();
  const row = {
    method,
    url,
    status: 0,
    error: null,
    bytes: null,
    sha256: null,
    elapsedMs: null,
    headers: {},
    networkError: null,
  };
  try {
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      redirect,
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache', ...headers },
      ...(method === 'POST' ? { body: '' } : {}),
    });
    row.status = response.status;
    row.headers = headersOfInterest(response);
    if (method === 'HEAD') {
      await response.body?.cancel();
      row.bytes = Number(response.headers.get('content-length') ?? 0);
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      row.bytes = buffer.byteLength;
      if (hash) row.sha256 = createHash('sha256').update(buffer).digest('hex');
      const isJson = (row.headers.contentType ?? '').toLowerCase().includes('json');
      const isRefusal = response.status < 200 || response.status >= 300;
      if (isJson && (isRefusal || wantRevision)) {
        let parsed = null;
        try {
          parsed = JSON.parse(buffer.toString('utf8'));
        } catch {
          // A refusal whose body is not the Worker's JSON shape leaves the
          // code absent, which the evaluators report honestly.
        }
        // Two named scalars only. The `detail` prose beside the code, and
        // every other field, is discarded with the buffer.
        if (isRefusal && typeof parsed?.error === 'string') row.error = parsed.error;
        if (wantRevision) row.revision = typeof parsed?.revision === 'string' ? parsed.revision : null;
      } else if (wantRevision) {
        row.revision = null;
      }
    }
  } catch (error) {
    row.networkError = String(error?.message ?? error).slice(0, 160);
  } finally {
    clearTimeout(timer);
    row.elapsedMs = Date.now() - started;
  }
  return row;
}

async function runProbeTable() {
  for (const probe of PROBES) {
    const url = probeUrl(args.base, probe);
    const row = await probeOnce(url, {
      method: probe.method,
      hash: probe.hash === true,
      wantRevision: probe.health === true,
    });
    receipt.probes.push({ id: probe.id, row: probe.row, ...row });
    if (probe.health === true) {
      receipt.observedRevision = row.revision ?? null;
      record(
        probe,
        row,
        evaluateHealthz(row, {
          expectRevision: args.expectRevision,
          expectMethods: args.expectHealthzMethods,
        }),
      );
    } else {
      record(probe, row, evaluateProbe(row, probe.expect));
    }
  }
  const relays = receipt.probes.filter((p) => p.row === 4 && Number.isFinite(p.elapsedMs));
  const slowest = relays.reduce((best, p) => (best === null || p.elapsedMs > best.elapsedMs ? p : best), null);
  receipt.timing = {
    budgetMs: RELAY_BUDGET_MS,
    maxRelayMs: slowest?.elapsedMs ?? null,
    probe: slowest?.id ?? null,
  };
}

/**
 * Row 12. The direct leg goes FIRST so the relay cannot be what warmed an
 * upstream cache, and both legs carry the same fresh nonce so neither the
 * Worker's 60-second edge cache (keyed on the upstream URL) nor an
 * intermediary can answer from a stored copy. One retry with a new nonce
 * before failing, because a single mismatch on a static file is more likely
 * a mid-flight change than a transparency breach.
 */
async function runTransparency() {
  const probe = { id: 'body-transparency', row: 12, name: 'body transparency, static endpoint', method: 'GET' };
  let pair = null;
  let verdict = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomUUID();
    const upstream = `${TRANSPARENCY_UPSTREAM}?ddm_cache_bust=${nonce}`;
    // The direct leg follows redirects the way a browser would, so an
    // upstream that moved the file still yields comparable bytes; the
    // relayed leg does not, because a redirect reaching the client would
    // itself be a policy anomaly worth seeing.
    const direct = await probeOnce(upstream, { hash: true, redirect: 'follow' });
    const proxied = await probeOnce(
      `${args.base.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(upstream)}`,
      { hash: true },
    );
    pair = { nonce, direct, proxied };
    verdict = evaluateTransparency(pair);
    if (verdict.ok) break;
    if (attempt === 0) console.log('retrying the transparency pair once with a new cache-busting nonce');
  }
  receipt.transparency = pair;
  record(probe, { status: pair.proxied.status, error: pair.proxied.error }, verdict);
}

await runProbeTable();
await runTransparency();

receipt.failed = receipt.checks.filter((c) => !c.ok).map((c) => c.id);
await writeFile(args.out, JSON.stringify(receipt, null, 2));
const summary = renderSummary(receipt);
if (args.summary) await appendFile(args.summary, summary);
console.log(`\n${summary}`);
console.log(`receipt written to ${args.out}`);
process.exit(receiptOk(receipt) ? 0 : 1);
