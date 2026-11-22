/**
 * browser-suite.yml's inputs and plan: the shard step validates `workers`,
 * `retries`, `tier`, `specs` and the planned row (project, shard, files) and
 * builds the Playwright command as an array; the matrix comes from the plan
 * job; a `coverage` job proves the plan runs every collected case; a
 * `collect` job fails a targeted run whose named files list zero tests; each
 * job names its failed cases and a `report` job gathers them. The shard
 * script runs for real under bash with a stand-in `npx`; targeted collection
 * skips empty shards before provisioning and leaves collection failures red.
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
const scriptFor = (id) => workflow.jobs.shard.steps.find((step) => step.id === id).run;
const shardScript = scriptFor('suite');

// Windows' PATH can resolve bash to the WSL launcher instead of Git Bash.
const bash = process.platform === 'win32'
  ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash';

const PLANNED = 'tests/u4d.spec.ts tests/boot.spec.ts';

function shard({ workers = '1', retries = '', specs = '', tier = 'full', project = 'chromium', shard: slice = '', files = PLANNED }) {
  const run = spawnSync(bash, ['-c', 'npx() { printf \'ARG:%s\\n\' "$@"; }\n' + shardScript], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WORKERS: workers, RETRIES: retries, SPECS: specs, TIER: tier, PROJECT: project, SHARD: slice, FILES: files }
  });
  assert.ifError(run.error);
  const args = run.stdout.split('\n').filter((line) => line.startsWith('ARG:')).map((line) => line.slice(4));
  return { status: run.status, args, out: run.stdout + run.stderr };
}

test('a planned job runs its project\'s files: no shard, no retries flag, no grep', () => {
  const { status, args } = shard({});
  assert.equal(status, 0);
  assert.deepEqual(args, ['playwright', 'test', '--project=chromium', '--workers=1', 'tests/u4d.spec.ts', 'tests/boot.spec.ts']);
});

test('a split file runs its slice, and the fast tier leaves @landing out', () => {
  assert.deepEqual(shard({ project: 'chromium-3d', shard: '2/3', files: 'tests/fire3d-mode.spec.ts' }).args,
    ['playwright', 'test', '--project=chromium-3d', '--shard=2/3', '--workers=1', 'tests/fire3d-mode.spec.ts']);
  assert.deepEqual(shard({ tier: 'fast' }).args,
    ['playwright', 'test', '--project=chromium', '--workers=1', '--grep-invert', '@landing', 'tests/u4d.spec.ts', 'tests/boot.spec.ts']);
});

test('workers, retries, tier and the planned row are checked, and a space adds no argument', () => {
  for (const bad of ['1 --grep x', '-1', '1.5', 'two', '100']) {
    assert.notEqual(shard({ workers: bad }).status, 0, `workers ${bad}`);
    assert.notEqual(shard({ retries: bad }).status, 0, `retries ${bad}`);
  }
  assert.deepEqual(shard({ workers: '2', retries: '0' }).args.slice(2, 5), ['--project=chromium', '--workers=2', '--retries=0']);
  for (const tier of ['', 'quick', 'fast --grep x']) assert.notEqual(shard({ tier }).status, 0, `tier ${tier}`);
  for (const project of ['chromium-measure', 'chromium --grep x', '']) assert.notEqual(shard({ project }).status, 0, `project ${project}`);
  for (const slice of ['1', '1/2 --grep', 'a/b']) assert.notEqual(shard({ shard: slice }).status, 0, `shard ${slice}`);
  // A planned row names files; none would run the whole project under a planned name.
  assert.notEqual(shard({ files: '' }).status, 0);
  for (const files of ['tests/helpers.spec.ts', 'package.json', '--config=x', 'tests/u4d.spec.ts;ls']) {
    assert.notEqual(shard({ files }).status, 0, `files ${files}`);
  }
});

test('specs must be existing tests/*.spec.ts files, each one its own argument, and they replace the planned files', () => {
  const missing = shard({ specs: 'tests/u4d.spec.ts  tests/helpers.spec.ts', shard: '3/8', files: '' });
  assert.notEqual(missing.status, 0, 'tests/helpers.spec.ts does not exist');
  const good = shard({ specs: 'tests/u4d.spec.ts', shard: '3/8', files: '' });
  assert.equal(good.status, 0);
  assert.deepEqual(good.args, ['playwright', 'test', '--project=chromium', '--shard=3/8', '--workers=1', '--pass-with-no-tests', 'tests/u4d.spec.ts']);
  for (const bad of ['   ', 'package.json', 'tests/helpers.ts', '--config=x', 'tests/../package.json', 'tests/u4d.spec.ts;ls']) {
    assert.notEqual(shard({ specs: bad, shard: '3/8', files: '' }).status, 0, `specs ${JSON.stringify(bad)}`);
  }
});

test('the matrix is the plan job\'s, and the plan job checks the planner and validates the tier', () => {
  const { plan, shard: job, coverage } = workflow.jobs;
  assert.equal(job.needs, 'plan');
  assert.equal(job.strategy.matrix, '${{ fromJSON(needs.plan.outputs.matrix) }}');
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.name, '${{ matrix.project }} ${{ matrix.job }}/${{ matrix.jobs }}');
  assert.equal(plan.outputs.matrix, '${{ steps.plan.outputs.matrix }}');
  const runs = plan.steps.map((step) => step.run ?? '').join('\n');
  assert.match(runs, /node --test \.github\/scripts\/plan-browser-shards\.test\.mjs/);
  assert.match(runs, /\^\(fast\|full\)\$/);
  assert.match(runs, /mode=targeted/);
  assert.equal(plan.steps.find((step) => step.id === 'plan').env.TIER, "${{ inputs.tier || 'full' }}");
  assert.ok(!plan.steps.some((step) => step.run === 'npm ci'), 'the plan installs nothing');
  // The coverage proof lists with the same grep the shards use.
  assert.equal(coverage.needs, 'plan');
  assert.equal(coverage.if, "${{ inputs.specs == '' }}");
  const listing = coverage.steps.map((step) => step.run ?? '').join('\n');
  assert.match(listing, /--list --reporter=json --project=chromium --project=chromium-interaction --project=chromium-3d/);
  assert.match(listing, /if test "\$TIER" = fast; then args\+=\(--grep-invert @landing\); fi/);
  assert.match(listing, /plan-browser-shards\.mjs --verify/);
  assert.equal(workflow.on.workflow_call.inputs.tier.default, 'full');
  assert.deepEqual(Object.keys(workflow.on.schedule[0]), ['cron']);
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
        ...process.env, WORKERS: workers, RETRIES: retries, SPECS: specs, TIER: 'full', PROJECT: 'chromium', SHARD: '3/8',
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

test('only targeted shards with collected tests provision, run, summarize, name their reds or upload', () => {
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
  const reports = steps.filter((step) => step.id === 'summary' || step.name === 'Name the failed cases' || step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(reports.length, 7);
  for (const step of reports) {
    assert(step.if.includes('!cancelled() && (' + hasTests + ')'), step.name);
  }
});

test('each job names its failed cases in a red list, and the report job gathers them without ever failing the run', () => {
  const steps = workflow.jobs.shard.steps;
  const name = steps.find((step) => step.name === 'Name the failed cases');
  assert.equal(name['continue-on-error'], true);
  assert.match(name.run, /plan-browser-shards\.mjs "\$\{args\[@\]\}"/);
  assert.match(name.run, /--reds test-results\/report\.json --label "\$LABEL" --out "\$RUNNER_TEMP\/browser-reds"/);
  const keep = steps.find((step) => step.name === 'Keep the red list');
  assert.equal(keep.with.name, 'browser-reds-${{ matrix.project }}-${{ matrix.job }}-of-${{ matrix.jobs }}');
  assert.equal(keep.with['retention-days'], 3);
  // Measured seconds only on a full, untargeted run, where every case ran.
  assert.match(steps.find((step) => step.name === 'Keep the measured seconds').if, /inputs\.specs == '' && \(inputs\.tier \|\| 'full'\) == 'full'/);
  const report = workflow.jobs.report;
  assert.deepEqual(report.needs, ['plan', 'shard']);
  assert.equal(report.if, "${{ !cancelled() && needs.plan.result == 'success' }}");
  assert.equal(report['continue-on-error'], true);
  const fetch = report.steps.find((step) => step.name === 'Fetch every job\'s red list');
  assert.match(fetch.uses, /^actions\/download-artifact@[0-9a-f]{40}$/, 'pinned to a commit');
  assert.equal(fetch.with.pattern, 'browser-reds-*');
  assert.equal(fetch.with['github-token'], undefined, 'this run\'s own artifacts need no token');
  assert.ok(report.steps.some((step) => /--gather "\$RUNNER_TEMP\/browser-reds"/.test(step.run ?? '')));
  assert.equal(report.steps.find((step) => step.name === 'Keep the measured seconds for the timings file').with.name, 'browser-case-seconds');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions, undefined);
});
