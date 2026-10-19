import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validationScope(event, specs, paths) {
  if (event !== 'pull_request') return specs ? 'targeted' : 'full';
  if (!paths.length) return 'full';
  const docs = (path) => /^[^/]+\.md$/.test(path)
    || /^(?:docs\/|planning\/|\.github\/ISSUE_TEMPLATE\/)/.test(path);
  if (paths.every(docs)) return 'docs';
  if (paths.every((path) => path.startsWith('workers/proxy/'))) return 'proxy';
  return 'full';
}

export function requiredValidationJobs(mode) {
  switch (mode) {
    case 'docs': return [];
    case 'proxy': return ['gate'];
    case 'targeted': return ['browser'];
    case 'full': return ['gate', 'landscape', 'browser'];
    default: throw new Error(`Unknown validation scope: ${mode}`);
  }
}

export function verifyValidationResults(mode, results) {
  if (results.scope?.result !== 'success') throw new Error('Scope detection did not succeed');
  const required = requiredValidationJobs(mode);
  for (const job of ['gate', 'landscape', 'browser']) {
    const expected = required.includes(job) ? 'success' : 'skipped';
    if (results[job]?.result !== expected) {
      throw new Error(`${job}: expected ${expected}, got ${results[job]?.result}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--verify') {
    const results = JSON.parse(process.env.JOB_RESULTS);
    verifyValidationResults(results.scope?.outputs?.mode, results);
    console.log(`Validation passed for ${results.scope.outputs.mode} scope; other jobs were explicitly skipped.`);
  } else {
    // --no-renames includes both sides of moves; NUL preserves unusual filenames.
    const paths = process.env.GITHUB_EVENT_NAME === 'pull_request'
      ? execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', 'HEAD^1', 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean)
      : [];
    const mode = validationScope(process.env.GITHUB_EVENT_NAME, process.env.SPECS, paths);
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
    console.log(`Validation scope: ${mode}`);
  }
}
