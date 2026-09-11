/**
 * DDM-P14-T08: the pure core of the mode-switch cost report.
 *
 * A hazard-mode switch is a change of the region shell's cluster from one
 * of the four HazardClusterKey values (src/config/clusters.ts:36) to
 * another, at one desktop viewport, with stubbed upstreams. This module
 * decides which network requests a switch's cost should count, merges a
 * measured run into the committed record, compares a candidate run against
 * a baseline, and renders the committed markdown table. It touches no
 * browser, no network, no filesystem, and no clock: every timestamp and
 * commit is supplied by the caller.
 *
 * The Playwright spec that drives Chromium and produces a RUN below is a
 * separate microtask (not written by this module) and is runnable directly
 * as `npm run measure:mode-switch`, which runs
 * tests/mode-switch-cost.spec.ts; that spec, not this file, owns the fs
 * write of the committed doc this module renders.
 *
 * A RUN has this shape (both sides of the split agree on it):
 *
 *   { label: 'baseline' | 'candidate', commit: '<short sha>',
 *     recordedAt: '<ISO 8601>', viewport: { width: 1280, height: 800 },
 *     switches: [ { id, from, to, requests: <integer>,
 *                   quiescentMs: <integer>,
 *                   pendingAtStart: [<layer key>, ...],
 *                   counted: [{ url, n }, ...] }, ... ] }
 *
 * A RECORD is `{ schema: 1, note: <string>, runs: { baseline?: RUN,
 * candidate?: RUN } }`, the shape written to and read from the committed
 * doc.
 */

/** The four hazard cluster keys, in the fixed order used everywhere below. */
export const MODE_KEYS = ['drought', 'heat', 'wildfire', 'enso'];

/**
 * All twelve ordered pairs of MODE_KEYS with from !== to, generated from
 * MODE_KEYS in order (every "from" in MODE_KEYS order, and for each, every
 * "to" in MODE_KEYS order, skipping from === to). Frozen so a caller can
 * never reorder or mutate the canonical switch list.
 */
export const SWITCHES = Object.freeze(
  MODE_KEYS.flatMap((from) =>
    MODE_KEYS.filter((to) => to !== from).map((to) => Object.freeze({ from, to }))
  )
);

/** The stable key for a switch, used as the record and comparison key. */
export function switchId({ from, to }) {
  return `${from}->${to}`;
}

const SAME_ORIGIN_REJECT_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.cjs', '.css', '.map',
  '.ico', '.woff', '.woff2', '.ttf', '.otf'
]);

function sameOriginPathnameExtension(pathname) {
  const lastSlash = pathname.lastIndexOf('/');
  const lastDot = pathname.lastIndexOf('.');
  if (lastDot <= lastSlash) return '';
  return pathname.slice(lastDot).toLowerCase();
}

/**
 * True when `url` is a data read worth counting toward a switch's cost.
 * Never throws: an unparseable `url` or `appOrigin` is treated as "not
 * counted" rather than as an error, since the spec that calls this filters
 * a live request stream it does not fully control.
 */
export function isCountedRequest(url, appOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  let origin;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    return false;
  }

  if (parsed.origin !== origin) return true;

  const { pathname } = parsed;
  if (pathname.startsWith('/assets/')) return false;
  if (pathname === '/' || pathname.endsWith('/')) return false;
  if (SAME_ORIGIN_REJECT_EXTENSIONS.has(sameOriginPathnameExtension(pathname))) return false;
  return true;
}

const STRIPPED_MAX_LENGTH = 160;
const STRIPPED_ELLIPSIS = '...';

function truncateStripped(value) {
  if (value.length <= STRIPPED_MAX_LENGTH) return value;
  return `${value.slice(0, STRIPPED_MAX_LENGTH - STRIPPED_ELLIPSIS.length)}${STRIPPED_ELLIPSIS}`;
}

/**
 * A short, stable, deterministic form of `url` for the committed record: a
 * same-origin URL becomes its pathname plus search; a cross-origin URL
 * stays absolute. Never throws: an unparseable `url` is truncated as-is so
 * the caller always gets a string back.
 */
export function strippedUrl(url, appOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return truncateStripped(String(url));
  }

  let origin = null;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    origin = null;
  }

  const short =
    parsed.origin === origin
      ? `${parsed.pathname}${parsed.search}`
      : `${parsed.origin}${parsed.pathname}${parsed.search}`;
  return truncateStripped(short);
}

/**
 * Tallies an array of already-stripped URLs into `{ url, n }` entries,
 * sorted by descending count then ascending url, so the same input always
 * produces the same committed record.
 */
export function tallyUrls(urls) {
  const counts = new Map();
  for (const url of urls) {
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return Array.from(counts, ([url, n]) => ({ url, n })).sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

/** A fresh, empty committed record, before any run has been merged in. */
export function emptyRecord() {
  return {
    schema: 1,
    note:
      'This file is generated by the mode-switch cost report spec ' +
      '(tests/mode-switch-cost.spec.ts, run via `npm run measure:mode-switch`) ' +
      'using scripts/mode-switch-cost-report.mjs to render it; it is never hand edited.',
    runs: {}
  };
}

/**
 * Returns a NEW record with `run` stored under its label, leaving every
 * other run and the input record untouched.
 */
export function mergeRun(record, run) {
  return {
    ...record,
    runs: {
      ...record.runs,
      [run.label]: run
    }
  };
}

/**
 * Throws a TypeError when `value` is not a RUN: refuses `undefined`, `null`,
 * and a RECORD passed by mistake (a RECORD has no top-level `switches`
 * array; it has `switches` nested under `runs.baseline` or
 * `runs.candidate`). An array is required, but an empty array is a legal
 * run with no switches recorded yet, so it passes.
 */
function assertIsRun(value, argName) {
  if (!value || !Array.isArray(value.switches)) {
    throw new TypeError(
      `compareRuns: "${argName}" must be a RUN with a "switches" array, ` +
        'not a RECORD (which nests its runs under "runs.baseline" / ' +
        `"runs.candidate"); got ${value === null ? 'null' : typeof value}.`
    );
  }
}

/**
 * Compares a candidate run against a baseline run, switch by switch, in
 * SWITCHES order. A switch the baseline never recorded is skipped
 * entirely. A switch present in the baseline and absent from the
 * candidate is reported as `missing`, never as a fall. Throws a TypeError
 * if either argument is not a RUN (see `assertIsRun`).
 */
export function compareRuns(baseline, candidate) {
  assertIsRun(baseline, 'baseline');
  assertIsRun(candidate, 'candidate');

  const baselineById = new Map(baseline.switches.map((s) => [s.id, s]));
  const candidateById = new Map(candidate.switches.map((s) => [s.id, s]));

  const rises = [];
  const falls = [];
  const unchanged = [];
  const missing = [];

  for (const pair of SWITCHES) {
    const id = switchId(pair);
    const b = baselineById.get(id);
    if (!b) continue;
    const c = candidateById.get(id);
    if (!c) {
      missing.push({ id, from: pair.from, to: pair.to, baseline: b.requests, candidate: null });
      continue;
    }
    const entry = { id, from: pair.from, to: pair.to, baseline: b.requests, candidate: c.requests };
    if (c.requests > b.requests) rises.push(entry);
    else if (c.requests < b.requests) falls.push(entry);
    else unchanged.push(entry);
  }

  return { rises, falls, unchanged, missing };
}

function formatDelta(delta) {
  if (delta > 0) return `+${delta}`;
  return `${delta}`;
}

function renderCountedDetail(run) {
  const lines = [];
  lines.push('<details>');
  lines.push(`<summary>Counted requests per switch (${run.label}, ${run.commit})</summary>`);
  lines.push('');
  for (const pair of SWITCHES) {
    const id = switchId(pair);
    const entry = run.switches.find((s) => s.id === id);
    lines.push(`- \`${id}\`:`);
    if (!entry || entry.counted.length === 0) {
      lines.push('  - (no counted requests recorded)');
      continue;
    }
    for (const { url, n } of entry.counted) {
      lines.push(`  - ${url} (${n})`);
    }
  }
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

/**
 * Renders the committed markdown table for `record`. With only a baseline
 * run, the table has Requests and Time to quiescence columns; with both
 * runs, it adds Candidate requests, Candidate ms, and a Delta column
 * (candidate minus baseline, written with a leading + when positive and 0
 * when equal).
 */
export function renderReport(record) {
  const baseline = record.runs.baseline ?? null;
  const candidate = record.runs.candidate ?? null;
  const hasCandidate = Boolean(baseline && candidate);

  const lines = [];
  lines.push('# Mode-switch cost report');
  lines.push('');
  lines.push(
    '<!-- GENERATED FILE. Do not edit by hand: this table is produced by ' +
      'scripts/mode-switch-cost-report.mjs from the mode-switch cost spec ' +
      '(tests/mode-switch-cost.spec.ts, run via `npm run measure:mode-switch`); ' +
      'run that to regenerate it. -->'
  );
  lines.push('');
  lines.push(
    'Request count and time to quiescence (read from `window.__ddm`) for each of ' +
      'the twelve ordered switches among Drought, Heat, Wildfire, and ENSO, at one ' +
      'desktop viewport with stubbed upstreams (DDM-P14-T08).'
  );
  lines.push('');

  const header = ['From', 'To', 'Requests', 'Time to quiescence (ms)'];
  if (hasCandidate) header.push('Candidate requests', 'Candidate ms', 'Delta');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);

  const baselineById = new Map((baseline?.switches ?? []).map((s) => [s.id, s]));
  const candidateById = new Map((candidate?.switches ?? []).map((s) => [s.id, s]));

  for (const pair of SWITCHES) {
    const id = switchId(pair);
    const b = baselineById.get(id) ?? null;
    const row = [pair.from, pair.to, b ? String(b.requests) : 'n/a', b ? String(b.quiescentMs) : 'n/a'];
    if (hasCandidate) {
      const c = candidateById.get(id) ?? null;
      row.push(c ? String(c.requests) : 'n/a');
      row.push(c ? String(c.quiescentMs) : 'n/a');
      row.push(b && c ? formatDelta(c.requests - b.requests) : 'n/a');
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');

  for (const run of [baseline, candidate].filter(Boolean)) {
    lines.push(
      `Run \`${run.label}\`: commit \`${run.commit}\`, recorded ${run.recordedAt}, ` +
        `viewport ${run.viewport.width}x${run.viewport.height}.`
    );
  }
  lines.push('');

  for (const run of [baseline, candidate].filter(Boolean)) {
    lines.push(renderCountedDetail(run));
    lines.push('');
  }

  if (hasCandidate) {
    const { rises } = compareRuns(baseline, candidate);
    if (rises.length > 0) {
      const names = rises.map((r) => `\`${r.id}\` (${r.baseline} to ${r.candidate})`).join(', ');
      lines.push(`Request count rose for: ${names}.`);
    } else {
      lines.push("No switch's request count rose.");
    }
  }

  return lines.join('\n');
}
