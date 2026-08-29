/**
 * Pure evaluators for the live verification (DDM-P0-T04, DDM-P0-T08).
 *
 * No network, no browser, no file I/O: the drivers (scripts/verify-live.mjs
 * and scripts/resolve-live-expectation.mjs) gather facts and these functions
 * decide, so every verdict is unit-tested offline
 * (tests/live-receipts.test.mjs). Two kinds of decision live here: the
 * per-check evaluators the live proof records, and resolveLiveExpectation,
 * which decides what the live site should be serving and whether that can be
 * checked at all. Receipts carry URLs, HTTP status,
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

/* ------------------------------------------------------------------ *
 * What to expect from the live site, and whether to expect it at all.
 * ------------------------------------------------------------------ */

/**
 * How long main's head may go without a successful deploy before the
 * difference between main and the live build counts as a divergence
 * rather than a release in progress. A green push to main takes about 15
 * minutes through the gate, the sharded browser suite, and deploy-pages;
 * 30 minutes leaves room for a slow runner and for Pages propagation
 * without letting a red or cancelled deploy sit unreported for a day.
 */
export const LIVE_COMPARE_GRACE_MS = 30 * 60 * 1000;

/** A deploy run that has not finished cannot be judged yet. */
function isFinished(run) {
  const status = String(run?.status ?? '');
  if (status) return status === 'completed';
  return Boolean(run?.conclusion);
}

/**
 * Did this run ever put a build on Pages?
 *
 * `gh run list` reports ONE row per run carrying the LATEST attempt's
 * conclusion, so a run that deployed on attempt 1 and was then re-run into
 * a failure reads as `failure` even though Pages is still correctly serving
 * what attempt 1 published. The caller asks the attempts API about exactly
 * those runs and passes `anyAttemptSucceeded`; the run id is the build
 * nonce either way, because vite.config.ts stamps `github.run_id`, which is
 * stable across attempts.
 */
function isPublished(run) {
  return run?.conclusion === 'success' || run?.anyAttemptSucceeded === true;
}

const parsedMs = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

/** Newest first by updatedAt, then createdAt, then run id. */
function orderKey(run) {
  const at = [run?.updatedAt, run?.createdAt]
    .map((value) => Date.parse(String(value ?? '')))
    .find((ms) => Number.isFinite(ms));
  return { at: at ?? 0, id: Number(run?.databaseId) || 0 };
}

function newest(runs) {
  let best = null;
  let bestKey = null;
  for (const run of runs) {
    const key = orderKey(run);
    if (!best || key.at > bestKey.at || (key.at === bestKey.at && key.id > bestKey.id)) {
      best = run;
      bestKey = key;
    }
  }
  return best;
}

function toMs(value, label) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a parseable timestamp`);
  return ms;
}

const asMinutes = (ms) => Math.max(0, Math.round(ms / 60_000));

/**
 * Decide what the live site should be serving, and whether that can be
 * checked right now (DDM-P0-T04).
 *
 * The post-deploy proof answers only "did the build this successful
 * deploy produced reach the CDN". The likelier divergence is a deploy
 * that never succeeded: a red browser shard, the `pages` concurrency
 * group cancelling a superseded run, or the freshness gate refusing an
 * obsolete rerun. No workflow_run success fires for any of those, so
 * nothing is verified, no issue opens, and the live site quietly keeps
 * serving an older commit. A scheduled compare asks the opposite
 * question: main's head is X, is X actually live?
 *
 * Pure: every fact is passed in (`input`), nothing is fetched or written.
 *
 * @param {object} input
 * @param {string} input.eventName `workflow_run`, `schedule`, or `workflow_dispatch`.
 * @param {?{id: (string|number), headSha: string, conclusion: ?string}} input.workflowRun
 *   The deploy run that raised a `workflow_run` event, else null.
 * @param {string} input.headSha Current head commit of main.
 * @param {(string|number)} input.headCommittedAt Committer date of that commit.
 * @param {Array<{databaseId: (string|number), headSha: string, conclusion: ?string,
 *   status: ?string, createdAt: ?string, updatedAt: ?string,
 *   anyAttemptSucceeded: ?boolean}>} input.deployRuns
 *   Recent deploy.yml runs for main, newest first or in any order.
 *   `conclusion` is the LATEST attempt's, so the caller sets
 *   `anyAttemptSucceeded` for a run whose earlier attempt published.
 * @param {(string|number)} input.now
 * @param {number} [input.graceMs] Defaults to LIVE_COMPARE_GRACE_MS.
 * @returns {{verdict: ('verify'|'in-flight'|'undeployed'), sha: string, nonce: string, reason: string}}
 *   `verify`: run the live proof against `sha`, expecting build nonce `nonce`.
 *   `in-flight`: a release is under way (or still inside the grace period);
 *   record the reason and stop, green, without touching issues.
 *   `undeployed`: main's head has no successful deploy and the grace period
 *   has passed; file the divergence and fail.
 */
export function resolveLiveExpectation(input) {
  const eventName = String(input?.eventName ?? '');
  if (!eventName) throw new Error('eventName is required');

  if (eventName === 'workflow_run') {
    const run = input?.workflowRun ?? null;
    if (!run || run.conclusion !== 'success' || !run.headSha || !run.id) {
      throw new Error(
        'a workflow_run event must carry a successful deploy run with a head sha and an id; the job condition should have skipped this run',
      );
    }
    return {
      verdict: 'verify',
      sha: String(run.headSha),
      nonce: String(run.id),
      reason: `post-deploy proof: deploy run ${run.id} published ${run.headSha}`,
    };
  }
  if (eventName !== 'schedule' && eventName !== 'workflow_dispatch') {
    throw new Error(`unsupported event ${eventName}`);
  }

  const headSha = String(input?.headSha ?? '');
  if (!headSha) throw new Error('headSha is required for a scheduled or dispatched compare');
  const graceMs = Number.isFinite(input?.graceMs) ? Number(input.graceMs) : LIVE_COMPARE_GRACE_MS;
  const nowMs = toMs(input?.now, 'now');
  const headMs = toMs(input?.headCommittedAt, 'headCommittedAt');
  const runs = Array.isArray(input?.deployRuns) ? input.deployRuns : [];
  const forHead = runs.filter((run) => String(run?.headSha ?? '') === headSha);

  // A deploy that ever published main's head wins even when a later rerun
  // is still running or has since failed: that build is what the CDN is
  // serving.
  const published = newest(forHead.filter(isPublished));
  if (published) {
    return {
      verdict: 'verify',
      sha: headSha,
      nonce: String(published.databaseId),
      reason: `${eventName} compare: main head ${headSha} was published by deploy run ${published.databaseId}`,
    };
  }

  // An unfinished run is only a release under way for as long as the grace
  // period. A deploy stuck in `queued`, `waiting` (an environment
  // protection rule), or `requested` would otherwise keep this compare
  // green forever, which is the silence DDM-P0-T04 exists to end. Measured
  // from the RUN's creation, not the commit's: the run is the thing that
  // is stuck.
  const running = newest(forHead.filter((run) => !isFinished(run)));
  if (running) {
    const startedMs = parsedMs(running.createdAt);
    const stuckMs = startedMs === null ? 0 : nowMs - startedMs;
    if (stuckMs < graceMs) {
      return {
        verdict: 'in-flight',
        sha: headSha,
        nonce: '',
        reason: `deploy run ${running.databaseId} for main head ${headSha} is ${running.status || 'not finished'}; there is nothing to compare yet`,
      };
    }
    return {
      verdict: 'undeployed',
      sha: headSha,
      nonce: '',
      reason: `main is ahead of the live build: no successful deploy of ${headSha}; deploy run ${running.databaseId} has been ${running.status || 'unfinished'} for ${asMinutes(stuckMs)} minutes, past the ${asMinutes(graceMs)} minute grace period`,
    };
  }

  // Grace runs from the commit date, which a rebase or a backdated
  // committer date controls, so floor it by the newest deploy run for this
  // head: a commit dated last year whose deploy started two minutes ago is
  // two minutes into its release, not a year overdue.
  let ageMs = nowMs - headMs;
  const firstAttemptMs = parsedMs(newest(forHead)?.createdAt);
  if (firstAttemptMs !== null) ageMs = Math.min(ageMs, nowMs - firstAttemptMs);
  if (ageMs < graceMs) {
    return {
      verdict: 'in-flight',
      sha: headSha,
      nonce: '',
      reason: `main head ${headSha} is ${asMinutes(ageMs)} minutes old, inside the ${asMinutes(graceMs)} minute grace period, and has no successful deploy yet`,
    };
  }

  const lastForHead = newest(forHead);
  const lastOverall = newest(runs);
  let tail;
  if (lastForHead) {
    tail = `latest deploy run ${lastForHead.databaseId} concluded ${lastForHead.conclusion || 'nothing'}`;
  } else if (lastOverall) {
    tail = `no deploy run for that commit was found; the newest deploy run ${lastOverall.databaseId} built ${lastOverall.headSha}`;
  } else {
    tail = 'no deploy run for main was found at all';
  }
  return {
    verdict: 'undeployed',
    sha: headSha,
    nonce: '',
    reason: `main is ahead of the live build: no successful deploy of ${headSha}, head for ${asMinutes(ageMs)} minutes; ${tail}`,
  };
}
