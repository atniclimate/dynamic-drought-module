/**
 * browser-suite.yml's targeted-run inputs: the shard step validates `workers`,
 * `retries` and `specs` and builds the Playwright command as an array, and a
 * `collect` job fails a run whose named files list zero tests. The shard script
 * runs for real under bash with a stand-in `npx`; targeted collection skips
 * empty shards before provisioning and leaves collection failures red.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = parse(readFileSync(new URL('../.github/workflows/browser-suite.yml', import.meta.url), 'utf8'));
function scriptFor(id) {
  return workflow.jobs.shard.steps.find((step) => step.id === id)
    .run.replace('${{ matrix.project }}', 'chromium')
    .replace('${{ matrix.shard }}', '3')
    .replace('${{ matrix.total }}', '8');
}
const shardScript = scriptFor('suite');

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


function selection({
  workers = '1', retries = '', specs = 'tests/view-contracts.spec.ts',
  report = '{"suites":[]}', exitCode = '0'
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ddm-shard-selection-'));
  const output = join(dir, 'output.txt');
  try {
    const run = spawnSync(bash, ['-c',
      'npx() { printf \'%s\' "$COLLECTION_REPORT"; return "$COLLECTION_EXIT"; }\n' + scriptFor('selection')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env, WORKERS: workers, RETRIES: retries, SPECS: specs,
        COLLECTION_REPORT: report, COLLECTION_EXIT: exitCode,
        RUNNER_TEMP: dir.replaceAll('\\', '/'), GITHUB_OUTPUT: output.replaceAll('\\', '/')
      }
    });
    assert.ifError(run.error);
    return {
      status: run.status, out: run.stdout + run.stderr,
      output: existsSync(output) ? readFileSync(output, 'utf8') : ''
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('targeted collection distinguishes empty and nested nonempty shards', () => {
  const empty = selection();
  assert.equal(empty.status, 0, empty.out);
  assert.equal(empty.output.trim(), 'has-tests=false');
  const selected = selection({
    report: JSON.stringify({ suites: [{ specs: [], suites: [{ specs: [{ tests: [{}] }] }] }] })
  });
  assert.equal(selected.status, 0, selected.out);
  assert.equal(selected.output.trim(), 'has-tests=true');
});

test('targeted collection preserves input failures before provisioning', () => {
  for (const input of [
    { workers: '1 --grep x' }, { retries: '-1' }, { specs: '   ' },
    { specs: 'tests/helpers.spec.ts' }, { specs: '--config=x' },
    { specs: 'tests/view-contracts.spec.ts;ls' }
  ]) {
    const result = selection(input);
    assert.notEqual(result.status, 0, JSON.stringify(input));
    assert.equal(result.output, '');
  }
});

test('failed or malformed collection never reports an empty successful shard', () => {
  for (const input of [
    { exitCode: '42' }, { report: 'not json' }, { report: '{}' },
    { report: '{"suites":[],"errors":[{"message":"load failed"}]}' }
  ]) {
    const result = selection(input);
    assert.notEqual(result.status, 0, JSON.stringify(input));
    assert.equal(result.output, '');
  }
});

test('only targeted shards with collected tests provision, run, summarize or upload', () => {
  const steps = workflow.jobs.shard.steps;
  const selected = steps.find((step) => step.id === 'selection');
  const provision = steps.find((step) => step.name === 'Provision Chromium');
  const suite = steps.find((step) => step.id === 'suite');
  assert.equal(selected.if, '${{ inputs.specs != \'\' }}');
  assert(steps.indexOf(selected) < steps.indexOf(provision));
  assert.match(selected.run, /npx playwright "\$\{args\[@\]\}" --list --reporter=json/);
  const hasTests = "inputs.specs == '' || steps.selection.outputs.has-tests == 'true'";
  assert.equal(provision.if, '${{ ' + hasTests + ' }}');
  assert.equal(suite.if, provision.if);
  const reports = steps.filter((step) => step.id === 'summary' || step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(reports.length, 4);
  for (const step of reports) {
    assert(step.if.includes('!cancelled() && (' + hasTests + ')'), step.name);
  }
});
