/**
 * browser-suite.yml's targeted-run inputs: the shard step validates `workers`,
 * `retries` and `specs` and builds the Playwright command as an array, and a
 * `collect` job fails a run whose named files list zero tests. The shard script
 * runs for real under bash with a stand-in `npx` that prints its arguments.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = parse(readFileSync(new URL('../.github/workflows/browser-suite.yml', import.meta.url), 'utf8'));
const shardScript = workflow.jobs.shard.steps
  .find((step) => step.id === 'suite')
  .run.replace('${{ matrix.project }}', 'chromium')
  .replace('${{ matrix.shard }}', '3')
  .replace('${{ matrix.total }}', '8');

// Windows' PATH can resolve bash to the WSL launcher instead of Git Bash.
const bash = process.platform === 'win32'
  ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash';

function shard({ workers = '1', retries = '', specs = '' }) {
  const run = spawnSync(bash, ['-c', 'npx() { printf \'ARG:%s\\n\' "$@"; }\n' + shardScript], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WORKERS: workers, RETRIES: retries, SPECS: specs }
  });
  assert.ifError(run.error);
  const args = run.stdout.split('\n').filter((line) => line.startsWith('ARG:')).map((line) => line.slice(4));
  return { status: run.status, args, out: run.stdout + run.stderr };
}

test('a plain call builds today\'s command: no retries flag, no specs', () => {
  const { status, args } = shard({});
  assert.equal(status, 0);
  assert.deepEqual(args, ['playwright', 'test', '--project=chromium', '--shard=3/8', '--workers=1']);
});

test('workers and retries must be small whole numbers, and a space adds no argument', () => {
  for (const bad of ['1 --grep x', '-1', '1.5', 'two', '100']) {
    assert.notEqual(shard({ workers: bad }).status, 0, `workers ${bad}`);
    assert.notEqual(shard({ retries: bad }).status, 0, `retries ${bad}`);
  }
  assert.deepEqual(shard({ workers: '2', retries: '0' }).args.slice(-2), ['--workers=2', '--retries=0']);
});

test('specs must be existing tests/*.spec.ts files, each one its own argument', () => {
  const missing = shard({ specs: 'tests/u4d.spec.ts  tests/helpers.spec.ts' });
  assert.notEqual(missing.status, 0, 'tests/helpers.spec.ts does not exist');
  const good = shard({ specs: 'tests/u4d.spec.ts' });
  assert.equal(good.status, 0);
  assert.deepEqual(good.args.slice(-2), ['--pass-with-no-tests', 'tests/u4d.spec.ts']);
  for (const bad of ['   ', 'package.json', 'tests/helpers.ts', '--config=x', 'tests/../package.json', 'tests/u4d.spec.ts;ls']) {
    assert.notEqual(shard({ specs: bad }).status, 0, `specs ${JSON.stringify(bad)}`);
  }
});

test('the collect job lists the matrix projects and fails on zero tests', () => {
  const job = workflow.jobs.collect;
  assert.equal(job.if, '${{ inputs.specs != \'\' }}');
  const listing = job.steps.map((step) => step.run ?? '').join('\n');
  assert.match(listing, /playwright test --list --project=chromium --project=chromium-interaction --project=chromium-3d "\$\{files\[@\]\}"/);
  assert.doesNotMatch(listing, /pass-with-no-tests/);
  assert.match(listing, /\^tests\/\[A-Za-z0-9\._-\]\+\\\.spec\\\.ts\$/);
});
