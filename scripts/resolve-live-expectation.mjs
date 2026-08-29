#!/usr/bin/env node
/**
 * Decide what the live Pages build should be serving (DDM-P0-T04).
 *
 * A thin driver around resolveLiveExpectation in scripts/lib/live-receipts.mjs:
 * it reads one JSON object of GitHub facts, writes the verdict as
 * `$GITHUB_OUTPUT` lines for the rest of the job to branch on, and appends
 * one line to the job summary. All of the judgment lives in the library and
 * is unit-tested offline (tests/live-receipts.test.mjs); this file only moves
 * bytes.
 *
 * Input (stdin, or --input <file>):
 *
 *   {
 *     "eventName": "workflow_run" | "schedule" | "workflow_dispatch",
 *     "workflowRun": { "id": 123, "headSha": "...", "conclusion": "success" } | null,
 *     "headSha": "<current head of main>",
 *     "headCommittedAt": "<committer date of that commit, ISO 8601>",
 *     "deployRuns": [ { "databaseId": 1, "headSha": "...", "conclusion": "...",
 *                       "status": "...", "createdAt": "...", "updatedAt": "..." } ],
 *     "now": "<ISO 8601>",
 *     "graceMs": 1800000
 *   }
 *
 * Output lines: `verdict=`, `sha=`, `nonce=`, `nonces=`, `warnings=`,
 * `reason=`. Every value is a single line, so it is also safe to copy into
 * `$GITHUB_ENV`. `nonces` is the comma-separated set of deploy runs that
 * published the commit, in creation order; the live proof accepts any
 * member, because more than one run can legitimately have put these bytes on
 * Pages and only the site can say which one it is serving. `nonce` is the
 * newest of them, the one the prose names.
 *
 * Usage: node scripts/resolve-live-expectation.mjs [--input <file>]
 *   [--output <path>] [--summary <path>]
 * --output defaults to $GITHUB_OUTPUT, --summary to nothing. Exit 0 when a
 * verdict was reached (the verdict itself is the answer, not the exit code),
 * 2 on a usage, parse, or resolution error.
 *
 * No response body, screenshot, or trace is read or written here (hard rule
 * 1; see src/layers/aiannh.ts): the inputs are commit ids, run ids, status
 * words, and timestamps.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import { LIVE_COMPARE_GRACE_MS, resolveLiveExpectation } from './lib/live-receipts.mjs';

const USAGE = [
  'Usage: node scripts/resolve-live-expectation.mjs [--input <file>] [--output <path>] [--summary <path>]',
  '',
  '  --input    JSON facts file; "-" or omitted reads stdin.',
  '  --output   Where to append verdict/sha/nonce/reason lines (default $GITHUB_OUTPUT).',
  '  --summary  Markdown file to append one verdict line to (default: none).',
  '',
  `Grace period default: ${LIVE_COMPARE_GRACE_MS / 60_000} minutes (override with graceMs in the input).`,
].join('\n');

function parse(argv) {
  const options = { input: '-', output: process.env.GITHUB_OUTPUT || '', summary: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return null;
    const key = { '--input': 'input', '--output': 'output', '--summary': 'summary' }[flag];
    if (!key) throw new Error(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[key] = value;
    i += 1;
  }
  return options;
}

/** GITHUB_OUTPUT and GITHUB_ENV are line oriented; keep every value on one line. */
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

let options;
try {
  options = parse(process.argv.slice(2));
} catch (error) {
  console.error(String(error.message ?? error));
  console.error(USAGE);
  process.exit(2);
}
if (options === null) {
  console.log(USAGE);
  process.exit(0);
}

let expectation;
try {
  const raw = options.input === '-' ? readFileSync(0, 'utf8') : readFileSync(options.input, 'utf8');
  if (!raw.trim()) throw new Error('no JSON facts were supplied');
  expectation = resolveLiveExpectation(JSON.parse(raw));
} catch (error) {
  console.error(`could not resolve what the live build should be: ${String(error.message ?? error)}`);
  process.exit(2);
}

const verdict = oneLine(expectation.verdict);
const sha = oneLine(expectation.sha);
const nonce = oneLine(expectation.nonce);
const nonces = oneLine((expectation.nonces ?? []).join(','));
const warnings = oneLine((expectation.warnings ?? []).join('; '));
const reason = oneLine(expectation.reason);

const lines = [
  `verdict=${verdict}`,
  `sha=${sha}`,
  `nonce=${nonce}`,
  `nonces=${nonces}`,
  `warnings=${warnings}`,
  `reason=${reason}`,
];
if (options.output) appendFileSync(options.output, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));

if (options.summary) {
  const headline = {
    verify: 'proving the live build',
    'in-flight': 'release in flight, nothing to compare yet',
    undeployed: 'main is ahead of the live build',
  }[verdict] ?? verdict;
  const accepted = nonces ? `\n\nAccepted build nonces: \`${nonces.split(',').join('`, `')}\`.` : '';
  const noted = warnings ? `\n\nWarnings: ${warnings}` : '';
  appendFileSync(
    options.summary,
    `## Live compare: ${headline}\n\nVerdict \`${verdict}\`. ${reason}${accepted}${noted}\n\n`,
  );
}
