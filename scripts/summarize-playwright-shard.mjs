#!/usr/bin/env node
/**
 * Summarize one Playwright JSON report for a CI job summary.
 *
 * Usage: node scripts/summarize-playwright-shard.mjs test-results/report.json
 *
 * Prints a Markdown block to stdout (the workflow appends it to
 * $GITHUB_STEP_SUMMARY): passed, failed, flaky (passed only on retry), and
 * skipped counts, then the file:line and title of every failed or flaky test
 * so the named-failure discipline (baseline set versus after set) reads off
 * the Actions page. Writes `flaky=<n>` and `failed=<n>` to $GITHUB_OUTPUT
 * when that file is set, so the workflow can keep the report for a shard
 * that passed only on retry. Exits 0 in every case: the test step already
 * decided the result; this step only names it. A missing or unreadable
 * report is reported as such rather than hidden.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const reportPath = process.argv[2] ?? 'test-results/report.json';

function collect(suite, file, out) {
  for (const child of suite.suites ?? []) collect(child, file ?? child.file, out);
  for (const spec of suite.specs ?? []) {
    const specFile = file ?? spec.file ?? '(unknown file)';
    for (const test of spec.tests ?? []) {
      out.push({
        file: basename(specFile),
        line: spec.line,
        title: spec.title,
        status: test.status,
        attempts: (test.results ?? []).length
      });
    }
  }
}

function writeOutput(name, value) {
  const target = process.env['GITHUB_OUTPUT'];
  if (!target) return;
  appendFileSync(target, `${name}=${value}\n`);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`### Browser shard\n\nNo readable JSON report at \`${reportPath}\`: ${reason}\n`);
  writeOutput('flaky', '0');
  writeOutput('failed', '0');
  process.exit(0);
}

const tests = [];
for (const suite of report.suites ?? []) collect(suite, suite.file, tests);

const byStatus = (status) => tests.filter((test) => test.status === status);
const failed = byStatus('unexpected');
const flaky = byStatus('flaky');
const passed = byStatus('expected');
const skipped = byStatus('skipped');
const project = process.env['PLAYWRIGHT_PROJECT'] ?? '';
const durationMinutes = ((report.stats?.duration ?? 0) / 60_000).toFixed(1);

const lines = [];
lines.push(`### Browser shard ${project}`.trimEnd());
lines.push('');
lines.push(
  `${tests.length} tests in ${durationMinutes} min: ${passed.length} passed, ${failed.length} failed, ${flaky.length} flaky, ${skipped.length} skipped.`
);
if (failed.length > 0) {
  lines.push('');
  lines.push('Failed:');
  for (const test of failed) {
    lines.push(`- \`${test.file}:${test.line}\` ${test.title} (${test.attempts} attempts)`);
  }
}
if (flaky.length > 0) {
  lines.push('');
  lines.push('Flaky (passed only on retry):');
  for (const test of flaky) {
    lines.push(`- \`${test.file}:${test.line}\` ${test.title} (${test.attempts} attempts)`);
  }
}
lines.push('');
console.log(lines.join('\n'));

writeOutput('flaky', String(flaky.length));
writeOutput('failed', String(failed.length));
