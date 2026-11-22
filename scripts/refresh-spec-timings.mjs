#!/usr/bin/env node
/**
 * Rebuild tests/spec-timings.json, the seconds the local run's ten-minute
 * limit is estimated from, out of one full Validate run's log.
 *
 *   node scripts/refresh-spec-timings.mjs <run id>      reads `gh run view <id> --log`
 *   node scripts/refresh-spec-timings.mjs <log file>    a log saved from that command
 *
 * Refresh when a full run's evidence is read at a landing, not on every
 * push: the estimate needs to be about right, not current to the minute.
 * A targeted run names too few files to stand for the suite, so a log with
 * under 80 percent of the files the current timings know is refused.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, buildTimings, parseCaseLog, readTimings } from './spec-impact.mjs';

const TARGET = new URL('../tests/spec-timings.json', import.meta.url);
const MIN_SHARE = 0.8;

/** Why a rebuilt table must not replace the current one, or null. */
export function refreshRefusal(next, current) {
  const count = Object.keys(next.files).length;
  if (count === 0) return 'No browser case lines in that log: is it a `gh run view <id> --log` of a Validate run?';
  const known = Object.keys(current?.files ?? {}).length;
  if (count < known * MIN_SHARE) return `The log names ${count} spec files and the current timings ${known}: a targeted run cannot stand for the suite.`;
  return null;
}

function main(argv) {
  const [input] = argv;
  if (!input) {
    console.error('Usage: node scripts/refresh-spec-timings.mjs <run id | log file>');
    return 2;
  }
  let log;
  let source;
  if (existsSync(input)) {
    log = readFileSync(input, 'utf8');
    source = { log: basename(input) };
  } else if (/^\d+$/.test(input)) {
    const run = JSON.parse(execFileSync('gh', ['run', 'view', input, '--json', 'headSha,createdAt', '-R', REPO], { encoding: 'utf8' }));
    log = execFileSync('gh', ['run', 'view', input, '--log', '-R', REPO], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    source = { run: Number(input), sha: run.headSha, measured: run.createdAt };
  } else {
    console.error(`${input} is neither a file nor a run id.`);
    return 2;
  }
  const next = buildTimings(parseCaseLog(log), source);
  const refusal = refreshRefusal(next, readTimings(TARGET));
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  const total = Object.values(next.files).reduce((sum, seconds) => sum + seconds, 0);
  console.log(`tests/spec-timings.json: ${Object.keys(next.files).length} spec files, ${Object.keys(next.cases).length} test lines, ${(total / 60).toFixed(1)} GitHub minutes.`);
  return 0;
}

// Not import.meta.main: it is undefined before Node 24.2, and engines admits 24.0.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
