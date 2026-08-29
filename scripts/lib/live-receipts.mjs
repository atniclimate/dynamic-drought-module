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
  // An earlier receipt to compare layer health against. Optional: when it
  // is absent the driver records that the ready-to-unavailable regression
  // check was skipped rather than pretending it passed.
  previous: null,
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
  ['--previous', ['previous', 'string']],
  ['--settle-ms', ['settleMs', 'int']],
  ['--interval-ms', ['intervalMs', 'int']],
  ['--ceiling-ms', ['ceilingMs', 'int']],
]);

/**
 * The accepted build nonces as a list.
 *
 * More than one run id can legitimately be live for one commit: a run that
 * published, a later run of the same commit that published again, and a
 * rerun of the first that has since failed all name the same bytes on Pages
 * only by coincidence of ordering, and only the site itself can say which
 * one it is serving. The resolver therefore hands over EVERY run that
 * published the head and this check accepts any member, recording which one
 * matched rather than guessing beforehand.
 */
export function expectedNonces(expect) {
  const raw = Array.isArray(expect?.nonces)
    ? expect.nonces
    : String(expect?.nonces ?? expect?.nonce ?? '').split(',');
  return raw.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0);
}

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
  // `--expect-nonce` takes one run id or a comma-separated set of them.
  out.expectNonces = expectedNonces({ nonce: out.expectNonce });
  return out;
}

export function evaluateStamp(stamp, expect) {
  const reasons = [];
  const nonces = expectedNonces(expect);
  let matchedNonce = null;
  if (!stamp || !stamp.sha) reasons.push('missing data-ddm-build-sha');
  else if (expect.sha && stamp.sha !== expect.sha) reasons.push(`sha ${stamp.sha} differs from expected ${expect.sha}`);
  if (!stamp || !stamp.nonce) reasons.push('missing data-ddm-build-nonce');
  else if (stamp.nonce === 'dev') reasons.push('nonce is the local fallback dev');
  else if (nonces.length > 0 && !nonces.includes(String(stamp.nonce))) {
    reasons.push(`nonce ${stamp.nonce} is none of the deploy runs that published this commit (${nonces.join(', ')})`);
  } else if (nonces.length > 0) {
    matchedNonce = String(stamp.nonce);
  }
  return { ok: reasons.length === 0, reasons, matchedNonce };
}

export function evaluateAssets(rows) {
  const reasons = rows.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.url}`);
  if (rows.length === 0) reasons.push('index.html referenced no assets');
  return { ok: reasons.length === 0, reasons };
}

/**
 * One PMTiles archive's byte-range answer.
 *
 * The 206, the Content-Range, and the body length only prove the protocol:
 * a stale or coherently truncated archive at the same stable path answers
 * all three self-consistently. `row.localBytes` is the size of the same file
 * in the checkout of the commit under proof, and the TOTAL the
 * Content-Range names must equal it, so the archive the site serves is the
 * archive that build shipped and not last month's.
 */
export function evaluateRange(row) {
  const reasons = [];
  if (row.status !== 206) reasons.push(`status ${row.status}`);
  const m = row.contentRange ? /^bytes 0-(\d+)\/(\d+)$/.exec(row.contentRange) : null;
  if (!m) reasons.push(`content-range ${row.contentRange ?? 'absent'}`);
  else if (row.bytes !== Number(m[1]) + 1) reasons.push(`body ${row.bytes} bytes, range promised ${Number(m[1]) + 1}`);
  if (m && Number.isFinite(row.localBytes)) {
    const served = Number(m[2]);
    if (served !== row.localBytes) {
      reasons.push(`served archive is ${served} bytes, the checked-out ${row.name} is ${row.localBytes}`);
    }
  } else if (!Number.isFinite(row.localBytes)) {
    reasons.push(`the checked-out size of ${row.name} is unknown, so the served archive cannot be identified`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The layer keys each live boot must show a status pill for.
 *
 * Derived from the runtime, not invented here. `src/config/layers.ts`
 * marks five layers `defaultOn`: hillshade, nadm-drought, aiannh,
 * bia-reservations, and states. `src/state/url.ts` turns a URL into a boot
 * set three ways: an explicit `?layers=` list wins; otherwise a
 * `?cluster=` other than the default composes
 * `composeClusterIntent(cluster, horizon)` from
 * `src/state/cluster-service.ts`, which is every default-on key whose role
 * is NOT `surface` (hillshade, aiannh, bia-reservations, states: the
 * persistent reference set that survives a cluster switch) plus that
 * cluster's recipe for the horizon, `coActivateWith` partners expanded;
 * and a bare URL is the default-on set exactly. No boot below passes
 * `?layers=`, and none passes `?horizon=`, so every cluster boot composes
 * at the `current` horizon: wildfire is nifc-fires plus hms-smoke, heat is
 * heatrisk plus nws-alerts, enso is sst-anomaly, and drought (the bare
 * root boot) is nadm-drought, which composes back to exactly the
 * default-on set.
 *
 * tests/live-receipts.test.mjs re-derives this table from those two config
 * files on every run, so a recipe or defaultOn change that this table does
 * not follow fails the unit suite rather than quietly letting the live
 * proof pass with a layer missing.
 */
const PERSISTENT_REFERENCE = ['hillshade', 'aiannh', 'bia-reservations', 'states'];
const WILDFIRE_BOOT = [...PERSISTENT_REFERENCE, 'nifc-fires', 'hms-smoke'];
export const EXPECTED_BOOT_LAYERS = Object.freeze({
  root: [...PERSISTENT_REFERENCE, 'nadm-drought'],
  wildfire: WILDFIRE_BOOT,
  heat: [...PERSISTENT_REFERENCE, 'heatrisk', 'nws-alerts'],
  enso: [...PERSISTENT_REFERENCE, 'sst-anomaly'],
  // Both embed boots carry `?embed=true&cluster=wildfire`; embed changes
  // the chrome, not the composed layer set.
  'embed-1280': WILDFIRE_BOOT,
  'embed-390': WILDFIRE_BOOT,
});

/**
 * Judge one boot's layer pills.
 *
 * `options.expectedKeys` is that boot's row of EXPECTED_BOOT_LAYERS: a
 * layer that never carries a status is a failure, not an absence, because
 * the previous shape of this check only asked whether the pills it happened
 * to observe were terminal and so could pass with a layer missing
 * altogether. `options.previousStatuses` is the same boot's key-to-status
 * map from an earlier receipt against the SAME base; when it is absent the
 * caller records that the comparison was skipped.
 *
 * `error` stays a warning on its own, because an upstream outage is not a
 * build failure and the runtime is reporting it honestly. It stops being
 * only a warning when every active layer is `error` (nothing upstream is
 * that unlucky; that shape is the boot's own network or the build) or when
 * a layer that was `ready` last time is `error` now against the same site.
 */
export function evaluateLayers(rows, ceilingMs, options = {}) {
  const reasons = [];
  const warnings = [];
  const expected = [...(options.expectedKeys ?? [])];
  const seen = new Set(rows.map((r) => r.key));
  if (rows.length === 0) reasons.push('no layer pill carried a status');
  for (const key of expected) {
    if (!seen.has(key)) reasons.push(`expected layer ${key} never carried a status`);
  }
  for (const key of seen) {
    if (expected.length > 0 && !expected.includes(key)) {
      warnings.push(`${key} was active but is not in this boot's expected set`);
    }
  }
  let terminal = 0;
  let unavailable = 0;
  for (const r of rows) {
    if (r.disappeared) {
      reasons.push(`${r.key} was ${r.status ?? 'without status'} and then vanished from the catalog`);
    } else if (!r.status || !TERMINAL_STATUSES.has(r.status)) {
      reasons.push(`${r.key} still ${r.status ?? 'without status'} after ${r.settleMs} ms`);
    } else if (r.settleMs > ceilingMs) {
      terminal += 1;
      reasons.push(`${r.key} reached ${r.status} at ${r.settleMs} ms, over the ${ceilingMs} ms ceiling`);
    } else if (r.status === 'error') {
      terminal += 1;
      unavailable += 1;
      warnings.push(`${r.key} unavailable at ${r.settleMs} ms (upstream, not the build)`);
    } else {
      terminal += 1;
    }
  }
  if (terminal > 0 && unavailable === terminal) {
    reasons.push(
      `every active layer is unavailable (${unavailable} of ${terminal}); that is this boot's own network or build, not ${unavailable} simultaneous upstream outages`,
    );
  }
  const previous = options.previousStatuses ?? null;
  if (previous) {
    for (const r of rows) {
      if (r.status === 'error' && previous[r.key] === 'ready') {
        reasons.push(`${r.key} was ready in the previous receipt for this base and is unavailable now`);
      }
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
  const matched = [...new Set((receipt.checks ?? []).map((c) => c.matchedNonce).filter(Boolean))];
  lines.push(
    `Base \`${receipt.base}\`; expected sha \`${receipt.expectSha || '(none)'}\`, ` +
      `nonce \`${receipt.expectNonce || '(non-dev)'}\`; propagation ${receipt.propagationMs ?? 'n/a'} ms.` +
      (matched.length ? ` Live nonce observed: \`${matched.join('`, `')}\`.` : ''),
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

/**
 * When a deploy run was CREATED, in milliseconds, or null when its
 * timestamp cannot be read.
 *
 * createdAt is the only ordering key these functions use. `updatedAt`
 * moves whenever a run is re-run, so ordering by it lets an older run whose
 * rerun just failed outrank the newer run that actually published the head
 * (the wrong-nonce selection the 2026-08-29 review found). Creation order is
 * fixed once and describes the sequence releases were attempted in.
 */
export function createdMs(run) {
  return parsedMs(run?.createdAt);
}

/** Newest first by createdAt, then run id. */
function orderKey(run) {
  return { at: createdMs(run) ?? 0, id: Number(run?.databaseId) || 0 };
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

/**
 * The FIRST deploy run of a set, by creation. Used to floor the grace
 * period: the question is when this commit first entered a release, not
 * when someone last retried it. A run whose createdAt cannot be read has no
 * place in a creation ordering and is skipped.
 */
function oldest(runs) {
  let best = null;
  let bestAt = null;
  for (const run of runs) {
    const at = createdMs(run);
    if (at === null) continue;
    if (bestAt === null || at < bestAt) {
      best = run;
      bestAt = at;
    }
  }
  return best;
}

/** Every run of a set in creation order, oldest first, run id breaking ties. */
function byCreation(runs) {
  return [...runs].sort((a, b) => {
    const ka = orderKey(a);
    const kb = orderKey(b);
    return ka.at - kb.at || ka.id - kb.id;
  });
}

/**
 * An elapsed span that refuses to be negative.
 *
 * A committer date or a run createdAt can sit in the future (a skewed
 * clock, a rebase, a hand-written date). A negative age is smaller than any
 * grace period, so left alone it reads as "just started" at every
 * evaluation and the compare stays green until real time catches up. Zero
 * plus a warning says the timestamp is unusable instead of silently
 * trusting it.
 */
function ageSince(nowMs, thenMs, label) {
  const raw = nowMs - thenMs;
  if (raw >= 0) return { ms: raw, warning: null };
  return {
    ms: 0,
    warning: `${label} is ${asMinutes(-raw)} minutes in the future; its age was read as zero`,
  };
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
 * @returns {{verdict: ('verify'|'in-flight'|'undeployed'), sha: string, nonce: string,
 *   nonces: string[], warnings: string[], reason: string}}
 *   `verify`: run the live proof against `sha`, accepting any build nonce in
 *   `nonces` (creation order, oldest first); `nonce` is the newest of them,
 *   the one the prose names.
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
      nonces: [String(run.id)],
      warnings: [],
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

  // Every deploy that ever published main's head is an acceptable answer,
  // even when a later rerun is still running or has since failed: any of
  // those builds is bytes the CDN could legitimately be serving, and only
  // the site itself can say which. Selecting ONE run here is what let an
  // older run whose rerun had just failed outrank the newer run that
  // actually published (the 2026-08-29 review's wrong-nonce defect), so the
  // whole set travels to the verifier in creation order and the receipt
  // records the member that matched.
  const publishedRuns = byCreation(forHead.filter(isPublished));
  if (publishedRuns.length > 0) {
    const nonces = publishedRuns.map((run) => String(run.databaseId));
    const primary = nonces[nonces.length - 1];
    const tail = nonces.length > 1 ? ` (accepting any of ${nonces.join(', ')})` : '';
    return {
      verdict: 'verify',
      sha: headSha,
      nonce: primary,
      nonces,
      warnings: [],
      reason: `${eventName} compare: main head ${headSha} was published by deploy run ${primary}${tail}`,
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
    const startedMs = createdMs(running);
    // An unreadable createdAt must not mean "started just now, wait
    // forever". An unfinished run whose start cannot be read is treated as
    // past the grace period: this workflow exists to end silence, so an
    // unusable timestamp resolves toward speaking, not toward waiting.
    if (startedMs === null) {
      return {
        verdict: 'undeployed',
        sha: headSha,
        nonce: '',
        nonces: [],
        warnings: [],
        reason: `main is ahead of the live build: no successful deploy of ${headSha}; deploy run ${running.databaseId} is ${running.status || 'unfinished'} and its start time (${running.createdAt ?? 'absent'}) could not be read, so its age cannot be bounded`,
      };
    }
    const started = ageSince(nowMs, startedMs, `deploy run ${running.databaseId} start time`);
    const warnings = started.warning ? [started.warning] : [];
    const note = started.warning ? ` (warning: ${started.warning})` : '';
    if (started.ms < graceMs) {
      return {
        verdict: 'in-flight',
        sha: headSha,
        nonce: '',
        nonces: [],
        warnings,
        reason: `deploy run ${running.databaseId} for main head ${headSha} is ${running.status || 'not finished'}; there is nothing to compare yet${note}`,
      };
    }
    return {
      verdict: 'undeployed',
      sha: headSha,
      nonce: '',
      nonces: [],
      warnings,
      reason: `main is ahead of the live build: no successful deploy of ${headSha}; deploy run ${running.databaseId} has been ${running.status || 'unfinished'} for ${asMinutes(started.ms)} minutes, past the ${asMinutes(graceMs)} minute grace period${note}`,
    };
  }

  // Grace runs from the commit date, which a rebase or a backdated
  // committer date controls, so floor it by this head's FIRST deploy run:
  // a commit dated last year whose only deploy started two minutes ago is
  // two minutes into its release, not a year overdue. The oldest run, not
  // the newest: flooring by the newest would let every retry reset the
  // clock, so a head retried more often than the grace period would keep
  // this compare green for as long as someone kept pressing re-run.
  const warnings = [];
  const head = ageSince(nowMs, headMs, `the committer date of ${headSha}`);
  if (head.warning) warnings.push(head.warning);
  const firstAttemptMs = createdMs(oldest(forHead));
  let ageMs = head.ms;
  if (firstAttemptMs !== null) {
    const firstAttempt = ageSince(nowMs, firstAttemptMs, "this head's first deploy run start time");
    if (firstAttempt.warning) warnings.push(firstAttempt.warning);
    // A future committer date carries no information, so it must not floor
    // the age at zero and keep a long-failed head green: when the commit
    // clock is unusable the run clock is the whole answer.
    ageMs = head.warning ? firstAttempt.ms : Math.min(head.ms, firstAttempt.ms);
  }
  const note = warnings.length ? ` (warning: ${warnings.join('; ')})` : '';
  if (ageMs < graceMs) {
    return {
      verdict: 'in-flight',
      sha: headSha,
      nonce: '',
      nonces: [],
      warnings,
      reason: `main head ${headSha} is ${asMinutes(ageMs)} minutes old, inside the ${asMinutes(graceMs)} minute grace period, and has no successful deploy yet${note}`,
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
    nonces: [],
    warnings,
    reason: `main is ahead of the live build: no successful deploy of ${headSha}, head for ${asMinutes(ageMs)} minutes; ${tail}${note}`,
  };
}
