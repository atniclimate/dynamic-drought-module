#!/usr/bin/env node
/**
 * The browser suite's job matrix, its coverage proof and its red list
 * (owner, 2026-11-22: shards balanced by duration, a fast run on draft pull
 * requests and the full run once a pull request is ready).
 *
 *   node .github/scripts/plan-browser-shards.mjs --mode <fast|full|targeted>
 *       The matrix. Writes `matrix=<json>` to $GITHUB_OUTPUT and a table to
 *       $GITHUB_STEP_SUMMARY when they are set; prints the table either way.
 *   node .github/scripts/plan-browser-shards.mjs --verify <listing.json>
 *       Fails unless every case `playwright test --list --reporter=json`
 *       collected sits in exactly one planned job of its own project.
 *       The matrix is read from $MATRIX.
 *   node .github/scripts/plan-browser-shards.mjs --reds <report.json> --label <job> --out <dir> [--seconds-dir <dir>]
 *       One job's failed and retried cases, to <dir>/reds-<label>.json and,
 *       when any, to $GITHUB_STEP_SUMMARY. With --seconds-dir, also the
 *       measured seconds of every attempt to seconds-<label>.log there, in the
 *       case-line format scripts/refresh-spec-timings.mjs reads from a run log.
 *   node .github/scripts/plan-browser-shards.mjs --gather <dir>
 *       Every job's red list as one summary and one annotation per failed case.
 *   node .github/scripts/plan-browser-shards.mjs --merge-seconds <dir> --out <file>
 *       Every job's seconds log as one file:
 *       `node scripts/refresh-spec-timings.mjs <file>` rebuilds the timings.
 * The last three exit 0 whatever happens: the jobs already decided the
 * result; these only name it.
 *
 * Why whole spec files and not Playwright's `--shard`: `--shard=i/n` cuts a
 * project into equal-COUNT contiguous slices, so the expensive cases cluster
 * (run 45014874847: one 3D shard ran 22.2 minutes, another 0.7). Here each
 * job receives whole spec files, balanced by their seconds in
 * tests/spec-timings.json. A file too heavy for any one job is split with
 * `--shard=i/k` over that file alone, which keeps every case in exactly one
 * job however stale the timings are (a per-case list built from stale line
 * numbers would silently drop a moved case). A file the timings do not know
 * counts as the median file. Same inputs, same matrix.
 *
 * The fast tier runs every case not tagged `@landing` (the run adds
 * `--grep-invert @landing`); a file's fast seconds are estimated from the
 * tags in its source (fastSeconds below). Never landing evidence: only the
 * full tier decides a landing.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testSpans } from '../../scripts/spec-impact.mjs';

export const PROJECTS = ['chromium', 'chromium-interaction', 'chromium-3d'];

/** Jobs per project and tier. A targeted run keeps the count slices it always had. */
export const TIER_JOBS = {
  fast: { chromium: 12, 'chromium-interaction': 2, 'chromium-3d': 1 },
  full: { chromium: 8, 'chromium-interaction': 2, 'chromium-3d': 4 },
  targeted: { chromium: 8, 'chromium-interaction': 2, 'chromium-3d': 4 }
};

export const LANDING_TAG = '@landing';

// A conditional tag (`width > 1280 ? ['@landing'] : []`) keeps one variant in
// four of a width loop; its share of the loop's seconds is about this
// (run 45014874847: 14 to 25 percent of each loop at 1280 or narrower).
const CONDITIONAL_KEEP = 0.25;
// How many of the heaviest files the split search tries. More is slower and
// has never been needed: at most two files of any project outweigh one job.
const SPLIT_CANDIDATES = 4;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const normalize = (text) => text.replace(/\r\n/g, '\n');
const round = (seconds) => Math.round(seconds * 10) / 10;

// ---- Which project owns a spec file ------------------------------------------------------------

/** The file names a `const NAME = ['**\/a.spec.ts', ...]` list of playwright.config.ts names. */
function configList(configText, name) {
  const body = configText.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1];
  if (body === undefined) throw new Error(`Cannot read ${name} from playwright.config.ts`);
  const files = [...body.matchAll(/['"](?:\*\*\/|tests\/)([\w.-]+\.spec\.ts)['"]/g)].map(([, file]) => `tests/${file}`);
  if (files.length === 0) throw new Error(`${name} in playwright.config.ts lists no spec file`);
  return new Set(files);
}

/**
 * `{ chromium, 'chromium-interaction', 'chromium-3d' }` spec paths, each
 * sorted, from the config's lists: 3D and interaction by their testMatch,
 * chromium everything else that is neither measurement nor browser-free.
 */
export function projectFiles(configText, specPaths) {
  const fire3d = configList(configText, 'FIRE3D_SPECS');
  const interaction = configList(configText, 'INTERACTION_SPECS');
  const measure = configList(configText, 'MEASURE_SPECS');
  const pure = configList(configText, 'PURE_SPECS');
  const sorted = [...new Set(specPaths)].sort();
  return {
    chromium: sorted.filter((path) => !fire3d.has(path) && !interaction.has(path) && !measure.has(path) && !pure.has(path)),
    'chromium-interaction': sorted.filter((path) => interaction.has(path)),
    'chromium-3d': sorted.filter((path) => fire3d.has(path))
  };
}

// ---- What a file costs -------------------------------------------------------------------------

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The median file of the timings: what an unknown file is taken to cost. */
export function medianFileSeconds(timings) {
  return median(Object.values(timings?.files ?? {})) ?? 23;
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * A function from a declared test's line to `null`, `'all'` or `'some'`:
 * whether that test carries `@landing` from its own declaration or an
 * enclosing describe, and whether the tag is conditional (an expression that
 * tags only some of a loop, `width > 1280 ? ['@landing'] : []`). Formatted
 * specs close a describe at its own indentation, which is what is read here.
 */
export function landingTagger(source) {
  const text = normalize(source);
  if (!text.includes(LANDING_TAG)) return () => null;
  const lines = text.split('\n');
  const spans = testSpans(text);
  // A declaration's header: its first line to the line that opens its body.
  const header = (from) => {
    const out = [];
    for (let at = from - 1; at < lines.length && out.length < 6; at += 1) {
      out.push(lines[at]);
      if (/=>\s*\{\s*$|\)\s*=>|async\s*\(/.test(lines[at])) break;
    }
    return out.join('\n');
  };
  const describes = [];
  lines.forEach((content, index) => {
    // A loop may declare its describe on its own line: `for (const x of xs) test.describe(`.
    if (!/^\s*(?:for\b.*?\)\s*)?test\.describe(?:\.\w+)*\(/.test(content)) return;
    const indent = indentOf(content);
    let end = lines.length;
    for (let at = index + 1; at < lines.length; at += 1) {
      const trimmed = lines[at].trim();
      if (!trimmed) continue;
      if (indentOf(lines[at]) < indent || (indentOf(lines[at]) === indent && /^[)}\]]/.test(trimmed))) {
        end = at + 1;
        break;
      }
    }
    describes.push({ line: index + 1, end, header: header(index + 1) });
  });
  const kind = (block) => {
    if (!block.includes(LANDING_TAG)) return null;
    // Conditional: either branch of a ternary (`c ? ['@landing'] : []` or `c ? [] : ['@landing']`). A plain
    // `tag: ['@landing']` is unconditional (review, 2026-11-22: the old second pattern matched its colon).
    return /\?\s*\[\s*['"]@landing['"]\s*\]\s*:|\?\s*\[[^\]]*\]\s*:\s*\[\s*['"]@landing['"]\s*\]/.test(block) ? 'some' : 'all';
  };
  return (line) => {
    const span = spans.find(({ line: from, end }) => line >= from && line <= end);
    if (!span) return null;
    const kinds = [kind(header(span.line)), ...describes.filter((d) => d.line < span.line && d.end >= span.end).map((d) => kind(d.header))].filter(Boolean);
    if (kinds.length === 0) return null;
    return kinds.includes('all') ? 'all' : 'some';
  };
}

/**
 * What one spec file costs in a tier: `{ seconds, cases }`, `cases` the
 * seconds of each test the file declares today, in line order (a loop is one
 * test line). The file's total is its timings entry, or the median file when
 * the timings do not know it. A test declared at a line the timings know
 * takes that line's seconds; the tests the timings do not place (moved or
 * new since the measured run) share the rest evenly. In the fast tier a test
 * tagged `@landing` costs nothing and is no test of a slice, and one tagged
 * on a condition keeps CONDITIONAL_KEEP of its seconds.
 */
export function fileCost(path, { timings, tier, text = '' }) {
  const total = timings?.files?.[path] ?? medianFileSeconds(timings);
  const spans = testSpans(normalize(text));
  if (spans.length === 0) return { seconds: total, cases: [total] };
  const timed = new Map();
  for (const [key, seconds] of Object.entries(timings?.cases ?? {})) {
    const at = key.lastIndexOf(':');
    if (key.slice(0, at) === path) timed.set(Number(key.slice(at + 1)), seconds);
  }
  const placed = spans.filter(({ line }) => timed.has(line));
  const raw = placed.reduce((sum, { line }) => sum + timed.get(line), 0);
  // Placed lines never claim more than the file's total.
  const scale = raw > total ? total / raw : 1;
  const unplaced = spans.length - placed.length;
  const share = unplaced > 0 ? (total - raw * scale) / unplaced : 0;
  const tagOf = tier === 'fast' ? landingTagger(text) : () => null;
  const cases = [];
  let seconds = 0;
  for (const { line } of spans) {
    const tag = tagOf(line);
    if (tag === 'all') continue;
    const full = timed.has(line) ? timed.get(line) * scale : share;
    const own = tag === 'some' ? full * CONDITIONAL_KEEP : full;
    cases.push(own);
    seconds += own;
  }
  return { seconds, cases };
}

/**
 * Seconds of each slice `--shard=i/k` makes of one file: Playwright's cut
 * (equal counts, the remainder to the first slices) over the file's timed
 * test lines in line order, one test a line. Without case timings, the file
 * split evenly.
 */
export function sliceSeconds(caseSeconds, total, k) {
  if (caseSeconds.length < k) return Array.from({ length: k }, () => total / k);
  const sizes = Array.from({ length: k }, () => Math.floor(caseSeconds.length / k));
  const remainder = caseSeconds.length - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i += 1) sizes[i % k] += 1;
  const known = caseSeconds.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return sizes.map((size) => {
    const slice = caseSeconds.slice(at, at + size).reduce((a, b) => a + b, 0);
    at += size;
    return (slice / known) * total;
  });
}

// ---- Balancing ---------------------------------------------------------------------------------

/** Longest first onto the lightest bin; ties by file name, then the lowest bin. Deterministic. */
export function packFiles(items, bins) {
  const loads = Array.from({ length: bins }, () => ({ files: [], seconds: 0 }));
  const ordered = [...items].sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));
  for (const item of ordered) {
    let best = 0;
    for (let i = 1; i < bins; i += 1) if (loads[i].seconds < loads[best].seconds) best = i;
    loads[best].files.push(item.file);
    loads[best].seconds += item.seconds;
  }
  return loads.filter((bin) => bin.files.length > 0).map((bin) => ({ files: [...bin.files].sort(), seconds: bin.seconds }));
}

/**
 * One project's jobs: `[{ files, shard, seconds }]`, at most `jobs` of them.
 * `items` are `{ file, seconds, cases }` (cases: seconds of each timed test
 * line, in line order). Whole files are packed; the search also tries
 * splitting each of the heaviest files over `k` jobs of its own, and keeps
 * the plan whose slowest job is fastest (ties: fewer slices, then fewer jobs).
 */
export function planProject(items, jobs) {
  if (items.length === 0) return [];
  const total = items.reduce((sum, item) => sum + item.seconds, 0);
  const heavy = [...items]
    .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1))
    .filter((item) => item.seconds > total / jobs && item.cases.length > 1)
    .slice(0, SPLIT_CANDIDATES);
  let best = null;
  const tryPlan = (ks) => {
    const split = heavy.filter((_, i) => ks[i] > 1);
    const dedicated = ks.reduce((sum, k) => sum + (k > 1 ? k : 0), 0);
    const whole = items.filter((item) => !split.includes(item));
    const bins = jobs - dedicated;
    if (bins < (whole.length > 0 ? 1 : 0)) return;
    const plan = [];
    split.forEach((item) => {
      const k = ks[heavy.indexOf(item)];
      sliceSeconds(item.cases, item.seconds, k).forEach((seconds, i) => plan.push({ files: [item.file], shard: `${i + 1}/${k}`, seconds }));
    });
    for (const bin of packFiles(whole, Math.max(bins, 0))) plan.push({ files: bin.files, shard: '', seconds: bin.seconds });
    const slowest = Math.max(...plan.map((job) => job.seconds));
    const slices = dedicated;
    const better = !best
      || slowest < best.slowest - 1e-9
      || (Math.abs(slowest - best.slowest) <= 1e-9 && (slices < best.slices || (slices === best.slices && plan.length < best.plan.length)));
    if (better) best = { slowest, slices, plan };
  };
  const walk = (ks) => {
    if (ks.length === heavy.length) return tryPlan(ks);
    const item = heavy[ks.length];
    for (let k = 1; k <= Math.min(jobs, item.cases.length); k += 1) walk([...ks, k]);
  };
  walk([]);
  return best.plan;
}

/**
 * The job matrix of a tier: `{ include: [{ project, job, jobs, shard, files, seconds }] }`,
 * heaviest job first. `files` is space-separated spec paths ('' runs the
 * whole project, only in the targeted tier), `shard` is `i/k` or ''.
 * `specs` lists every spec file on disk; `texts` maps a path to its source.
 */
export function planMatrix({ tier, configText, specs, timings, texts = new Map() }) {
  if (!TIER_JOBS[tier]) throw new Error(`Unknown tier ${tier}: fast, full or targeted.`);
  const include = [];
  if (tier === 'targeted') {
    // Every slot keeps its count slice of the named files (the shard step
    // adds the files); a slot that owns none of them skips itself.
    for (const project of PROJECTS) {
      const jobs = TIER_JOBS.targeted[project];
      for (let job = 1; job <= jobs; job += 1) include.push({ project, job, jobs, shard: `${job}/${jobs}`, files: '', seconds: 0 });
    }
    return { include };
  }
  const owned = projectFiles(configText, specs);
  for (const project of PROJECTS) {
    const items = owned[project].map((file) => ({ file, ...fileCost(file, { timings, tier, text: texts.get(file) ?? '' }) }));
    const planned = planProject(items, TIER_JOBS[tier][project]);
    planned.forEach((entry, i) => include.push({
      project, job: i + 1, jobs: planned.length, shard: entry.shard, files: entry.files.join(' '), seconds: round(entry.seconds)
    }));
  }
  include.sort((a, b) => b.seconds - a.seconds || PROJECTS.indexOf(a.project) - PROJECTS.indexOf(b.project) || a.job - b.job);
  return { include };
}

/** A Markdown table of a matrix, for the plan job's summary. */
export function describeMatrix(tier, matrix) {
  const rows = matrix.include;
  const slowest = Math.max(0, ...rows.map((row) => row.seconds));
  const out = [`### Browser plan: ${tier} tier, ${rows.length} jobs`, ''];
  if (tier === 'fast') out.push('Cases tagged `@landing` do not run. A fast run is never a landing run.', '');
  if (tier !== 'targeted') out.push(`Slowest job, estimated from tests/spec-timings.json: ${(slowest / 60).toFixed(1)} min of cases.`, '');
  out.push('| Job | Estimated min | Files |', '|---|---|---|');
  for (const row of rows) {
    const files = row.files ? row.files.split(' ').map((file) => basename(file)).join(', ') : '(the named specs of this slice)';
    out.push(`| ${row.project} ${row.job}/${row.jobs}${row.shard && row.files ? ` (slice ${row.shard})` : ''} | ${(row.seconds / 60).toFixed(1)} | ${files} |`);
  }
  return `${out.join('\n')}\n`;
}

// ---- Coverage proof ----------------------------------------------------------------------------

/** `[{ project, file }]` of every test a `playwright test --list --reporter=json` report collected. */
export function listedTests(report) {
  if (!Array.isArray(report?.suites) || report.errors?.length) throw new Error('The listing did not collect successfully.');
  const out = [];
  const walk = (suite, file) => {
    for (const child of suite.suites ?? []) walk(child, file ?? child.file);
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests ?? []) out.push({ project: entry.projectName, file: `tests/${(file ?? spec.file).replace(/\\/g, '/')}` });
    }
  };
  for (const suite of report.suites) walk(suite, suite.file);
  return out;
}

/** Why a matrix does not run every listed test exactly once, or null. */
export function coverageRefusal(matrix, listed) {
  const owners = new Map();
  for (const row of matrix.include) {
    if (!row.files) return `${row.project} ${row.job}/${row.jobs} names no files: only a targeted run may leave the files to the slice.`;
    for (const file of row.files.split(' ')) {
      const key = `${row.project}\t${file}`;
      const entry = owners.get(key) ?? { slices: [], whole: 0 };
      if (row.shard) entry.slices.push(row.shard);
      else entry.whole += 1;
      owners.set(key, entry);
    }
  }
  for (const [key, { slices, whole }] of owners) {
    const [project, file] = key.split('\t');
    const totals = new Set(slices.map((shard) => shard.split('/')[1]));
    const complete = slices.length === 0 || (totals.size === 1 && slices.length === Number([...totals][0]) && new Set(slices).size === slices.length);
    if (whole > 1 || (whole === 1 && slices.length > 0) || !complete) return `${project} runs ${file} more than once or in an incomplete set of slices.`;
  }
  const counts = new Map();
  for (const { project, file } of listed) counts.set(`${project}\t${file}`, (counts.get(`${project}\t${file}`) ?? 0) + 1);
  for (const key of counts.keys()) {
    if (!owners.has(key)) return `${key.replace('\t', ' collects ')} but no planned job runs it.`;
  }
  for (const [key, { slices }] of owners) {
    const count = counts.get(key) ?? 0;
    if (slices.length > count) return `${key.replace('\t', ' splits ')} into ${slices.length} slices but collects only ${count} tests.`;
  }
  // A file may collect nothing (every case of it tagged @landing in a fast
  // run), but a job that collects nothing at all would fail Playwright's run.
  for (const row of matrix.include) {
    const count = row.files.split(' ').reduce((sum, file) => sum + (counts.get(`${row.project}\t${file}`) ?? 0), 0);
    if (count === 0) return `${row.project} ${row.job}/${row.jobs} collects no test in ${row.files}: the job would run nothing.`;
  }
  return null;
}

// ---- Red lists ---------------------------------------------------------------------------------

// Terminal colour codes in a Playwright error message.
const ANSI = /\u001b\[[0-9;]*m/g;

/** The first non-empty line of an error message, colour codes removed, at most 240 characters. */
export function firstErrorLine(message) {
  const line = String(message ?? '').replace(ANSI, '').split('\n').map((text) => text.trim()).find(Boolean) ?? '';
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

/**
 * Every case of a Playwright JSON report, `{ project, file, line, column,
 * title, status, attempts }`, `title` as the list reporter prints it
 * (describes and the test, joined by ` › `), `attempts` its results.
 */
export function reportCases(report) {
  const out = [];
  // The top suites are the files, whose titles are no describe.
  const walk = (suite, file, titles) => {
    for (const child of suite.suites ?? []) walk(child, file ?? child.file, [...titles, child.title]);
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests ?? []) {
        out.push({
          project: entry.projectName,
          file: `tests/${String(file ?? spec.file).replace(/\\/g, '/')}`,
          line: spec.line,
          column: spec.column ?? 1,
          title: [...titles, spec.title].filter(Boolean).join(' › ').replace(/\s+/g, ' '),
          status: entry.status,
          attempts: entry.results ?? []
        });
      }
    }
  };
  for (const suite of report?.suites ?? []) walk(suite, suite.file, []);
  // File order, then line order, as the list reporter runs them.
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * One job's red list: `{ label, project, tier, cases: [{ file, line, title,
 * error, attempts, passedOnRetry }] }` for every case that failed an attempt
 * (`unexpected`, or `flaky`: passed on retry).
 */
export function redList(report, { label, tier }) {
  const cases = reportCases(report).filter(({ status }) => status === 'unexpected' || status === 'flaky');
  return {
    label,
    tier,
    project: cases[0]?.project ?? null,
    cases: cases.map(({ project, file, line, title, status, attempts }) => {
      const failed = attempts.find((attempt) => attempt.status !== 'passed' && attempt.status !== 'skipped');
      return {
        project, file, line, title,
        error: firstErrorLine(failed?.error?.message ?? failed?.errors?.[0]?.message),
        attempts: attempts.length,
        passedOnRetry: status === 'flaky'
      };
    })
  };
}

/** A red list as Markdown lines: failed first, then the retry-only passes. */
export function describeReds(lists) {
  const all = lists.flatMap((list) => list.cases.map((entry) => ({ ...entry, label: list.label })));
  const failed = all.filter((entry) => !entry.passedOnRetry);
  const flaky = all.filter((entry) => entry.passedOnRetry);
  if (all.length === 0) return [];
  const row = (entry) => `- \`${entry.file}:${entry.line}\` ${entry.title} (${entry.label}, ${entry.attempts} attempts)${entry.error ? `\n  ${entry.error.replace(/\|/g, '\\|')}` : ''}`;
  const out = [];
  if (failed.length > 0) out.push(`**Failed (${failed.length}):**`, '', ...failed.map(row), '');
  if (flaky.length > 0) out.push(`**Passed only on retry (${flaky.length}):**`, '', ...flaky.map(row), '');
  return out;
}

const STATUS_MARK = { passed: '✓', skipped: '-' };

/**
 * The seconds of every attempt, one `gh run view --log` case line each, so
 * scripts/refresh-spec-timings.mjs reads the gathered file as it reads a log:
 * `<job>\t<step>\t<time> <mark> <n> [<project>] › <file>:<line>:<col> › <title>[ (retry #r)] (<ms>ms)`.
 */
export function secondsLog(report, label) {
  const lines = [];
  let n = 0;
  for (const entry of reportCases(report)) {
    for (const attempt of entry.attempts) {
      n += 1;
      const mark = STATUS_MARK[attempt.status] ?? '✘';
      const retry = attempt.retry ? ` (retry #${attempt.retry})` : '';
      const time = attempt.startTime ?? '1970-01-01T00:00:00.000Z';
      lines.push(`Browser suite / ${label}\tRun the browser shard\t${time} ${mark}  ${n} [${entry.project}] › ${entry.file}:${entry.line}:${entry.column} › ${entry.title}${retry} (${Math.round(attempt.duration ?? 0)}ms)`);
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Every red list (`reds-*.json`) and seconds log (`seconds-*.log`) under a gathered directory. */
export function readGathered(dir) {
  const lists = [];
  const logs = [];
  if (!existsSync(dir)) return { lists, logs };
  const visit = (at) => {
    for (const name of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(at, name.name);
      if (name.isDirectory()) visit(path);
      else if (/^reds-.+\.json$/.test(name.name)) {
        try {
          lists.push(JSON.parse(readFileSync(path, 'utf8')));
        } catch {
          lists.push({ label: name.name, cases: [], unreadable: true });
        }
      } else if (/^seconds-.+\.log$/.test(name.name)) logs.push(readFileSync(path, 'utf8'));
    }
  };
  visit(dir);
  return { lists, logs };
}

/** The gathered summary: one heading and the cases of every job, or a line saying none failed. */
export function gatheredSummary(lists, planned = null) {
  const out = ['### Browser cases that failed an attempt', ''];
  const unreadable = lists.filter((list) => list.unreadable).map((list) => list.label);
  if (planned !== null && lists.length < planned) out.push(`Red lists from ${lists.length} of ${planned} jobs: a job that was cancelled, timed out before its report, or ran nothing left none.`, '');
  if (unreadable.length > 0) out.push(`Unreadable red lists: ${unreadable.join(', ')}.`, '');
  const lines = describeReds(lists.filter((list) => !list.unreadable));
  out.push(...(lines.length > 0 ? lines : ['None: no case failed an attempt in the jobs that reported.', '']));
  return `${out.join('\n')}\n`;
}

/** One GitHub annotation per failed case, at most ten (the summary holds the rest). */
export function annotations(lists) {
  const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (text) => escape(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return lists
    .flatMap((list) => list.cases.filter((entry) => !entry.passedOnRetry).map((entry) => ({ ...entry, label: list.label })))
    .slice(0, 10)
    .map((entry) => `::error file=${property(entry.file)},line=${entry.line},title=${property(`${entry.label}: ${entry.title}`.slice(0, 200))}::${escape(entry.error || 'failed')}`);
}

// ---- Command line ------------------------------------------------------------------------------

function valueOf(argv, flag) {
  const at = argv.indexOf(flag);
  if (at < 0) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** Every spec file under tests/, posix paths. */
export function specsOnDisk(root = ROOT) {
  const out = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) visit(path);
      } else if (entry.name.endsWith('.spec.ts')) out.push(path);
    }
  };
  visit('tests');
  return out.sort();
}

function readTimings() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'tests/spec-timings.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** `--mode`: the matrix to $GITHUB_OUTPUT (`matrix=`, `jobs=`) and a table to the summary and stdout. */
function planCommand(mode) {
  const specs = specsOnDisk();
  const texts = new Map(specs.map((path) => [path, normalize(readFileSync(join(ROOT, path), 'utf8'))]));
  const matrix = planMatrix({ tier: mode, configText: readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8'), specs, timings: readTimings(), texts });
  const table = describeMatrix(mode, matrix);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\njobs=${matrix.include.length}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  console.log(table);
  return 0;
}

/** `--verify`: exit 1 unless the planned matrix ($MATRIX) runs every listed case once. */
function verifyCommand(listing) {
  const matrix = JSON.parse(process.env.MATRIX ?? '');
  const listed = listedTests(JSON.parse(readFileSync(listing, 'utf8')));
  const refusal = coverageRefusal(matrix, listed);
  if (refusal) {
    console.log(`::error::The browser plan does not run every collected case exactly once: ${refusal}`);
    return 1;
  }
  const byProject = PROJECTS.map((project) => `${project} ${listed.filter((entry) => entry.project === project).length}`).join(', ');
  console.log(`Every collected case sits in one planned job: ${listed.length} cases (${byProject}).`);
  return 0;
}

/** `--reds`: one job's red list, and with `--seconds-dir` its measured seconds. */
function redsCommand(reportPath, argv) {
  const label = valueOf(argv, '--label') ?? 'browser';
  const out = valueOf(argv, '--out') ?? '.';
  const secondsDir = valueOf(argv, '--seconds-dir');
  const safe = label.replace(/[^\w.-]+/g, '-');
  const tier = process.env.TIER || 'full';
  const planned = Number(process.env.PLANNED_JOBS) || null;
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.log(`No readable JSON report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = report ? { ...redList(report, { label, tier }), planned } : { label, tier, planned, project: null, cases: [], unreadable: true };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `reds-${safe}.json`), `${JSON.stringify(list, null, 2)}\n`);
  if (report && secondsDir) {
    mkdirSync(secondsDir, { recursive: true });
    writeFileSync(join(secondsDir, `seconds-${safe}.log`), secondsLog(report, label));
  }
  const lines = describeReds([list]);
  if (lines.length > 0 && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${label}: cases that failed an attempt\n\n${lines.join('\n')}\n`);
  console.log(`${label}: ${list.cases.length} cases failed an attempt.`);
  return 0;
}

/** `--gather`: one summary of every job's red list, and one annotation per failed case. */
function gatherCommand(dir) {
  const { lists } = readGathered(dir);
  const planned = Number(process.env.PLANNED_JOBS) || null;
  // Workflow commands are read from stdout, so the summary goes to its own file.
  for (const line of annotations(lists)) console.log(line);
  const summary = gatheredSummary(lists, planned);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  return 0;
}

/** `--merge-seconds`: every job's seconds log as one file refresh-spec-timings.mjs reads. */
function mergeSecondsCommand(dir, argv) {
  const out = valueOf(argv, '--out');
  if (!out) throw new Error('--merge-seconds needs --out <file>');
  const { logs } = readGathered(dir);
  writeFileSync(out, logs.join(''));
  console.log(`${logs.length} seconds logs merged into ${out}.`);
  return 0;
}

const USAGE = 'Usage: plan-browser-shards.mjs --mode <fast|full|targeted> | --verify <listing.json> | --reds <report.json> --label <job> --out <dir> [--seconds-dir <dir>] | --gather <dir> | --merge-seconds <dir> --out <file>';

function main(argv) {
  const mode = valueOf(argv, '--mode');
  if (mode) return planCommand(mode);
  const listing = valueOf(argv, '--verify');
  if (listing) return verifyCommand(listing);
  const report = valueOf(argv, '--reds');
  if (report) return redsCommand(report, argv);
  const gathered = valueOf(argv, '--gather');
  if (gathered) return gatherCommand(gathered);
  const seconds = valueOf(argv, '--merge-seconds');
  if (seconds) return mergeSecondsCommand(seconds, argv);
  console.error(USAGE);
  return 2;
}

// Not import.meta.main: it is undefined before Node 24.2, and engines admits 24.0.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  // Naming the reds only reports: the jobs already decided the result.
  const reporting = argv.some((arg) => ['--reds', '--gather', '--merge-seconds'].includes(arg));
  try {
    process.exitCode = main(argv);
  } catch (error) {
    console.log(`${reporting ? '::warning::' : '::error::'}${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = reporting ? 0 : 1;
  }
}
