import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validationScope, requiredValidationJobs, verifyValidationResults } from './validation-scope.mjs';

test('docs outside the artifact report success without application jobs', () => {
  assert.equal(validationScope('pull_request', '', ['README.md', 'docs/guide.md', '.github/ISSUE_TEMPLATE/bug.yml']), 'docs');
  assert.equal(validationScope('pull_request', '', ['DEVELOPER.md', 'tests/README.md']), 'docs');
  assert.deepEqual(requiredValidationJobs('docs'), []);
});

test('proxy-only changes retain the proxy gate and exclude unrelated suites', () => {
  for (const path of ['workers/proxy/package-lock.json', 'workers/proxy/src/index.ts']) {
    assert.equal(validationScope('pull_request', '', [path]), 'proxy');
  }
  assert.deepEqual(requiredValidationJobs('proxy'), ['gate']);
});

test('artifact docs, shared config, unknown paths, mixed changes and empty diffs stay full', () => {
  for (const paths of [
    [], ['public/data/README.md'], ['src/app.ts'], ['package-lock.json'],
    ['.github/workflows/validate.yml'], ['workers/terrain/src/index.ts'],
    ['workers/proxy/src/index.ts', 'src/old-worker.ts'], // both sides of a move
    ['README.md', 'workers/proxy/package.json'], ['unknown'],
    ['tests/README.md', 'tests/boot.spec.ts'], ['tests/fixtures/README.md'],
  ]) assert.equal(validationScope('pull_request', '', paths), 'full', JSON.stringify(paths));
});

test('dispatches preserve explicit full integration and named browser-only requests', () => {
  assert.equal(validationScope('workflow_dispatch', '', []), 'full');
  assert.equal(validationScope('workflow_dispatch', 'tests/boot.spec.ts', []), 'targeted');
  assert.deepEqual(requiredValidationJobs('targeted'), ['browser']);
  assert.equal(validationScope('pull_request', 'tests/boot.spec.ts', ['src/app.ts']), 'full');
});

test('every required failure and unexpected skip fails the final status', () => {
  for (const mode of ['docs', 'proxy', 'targeted', 'full']) {
    const required = requiredValidationJobs(mode);
    const results = { scope: { result: 'success', outputs: { mode } } };
    for (const job of ['gate', 'landscape', 'browser']) {
      results[job] = { result: required.includes(job) ? 'success' : 'skipped' };
    }
    verifyValidationResults(mode, results);
    for (const job of ['scope', ...required]) {
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        assert.throws(() => verifyValidationResults(mode, { ...results, [job]: { result } }), undefined, `${mode}/${job}/${result}`);
      }
    }
    for (const job of ['gate', 'landscape', 'browser'].filter((job) => !required.includes(job))) {
      assert.throws(() => verifyValidationResults(mode, { ...results, [job]: { result: 'failure' } }));
    }
  }
  assert.throws(() => requiredValidationJobs('unknown'));
});

test('summary CLI exits nonzero on missing or invalid evidence', () => {
  const script = fileURLToPath(new URL('./validation-scope.mjs', import.meta.url));
  for (const evidence of ['{}', '{', JSON.stringify({ scope: { result: 'failure', outputs: { mode: 'docs' } } })]) {
    const run = spawnSync(process.execPath, [script, '--verify'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, JOB_RESULTS: evidence },
    });
    assert.ifError(run.error);
    assert.notEqual(run.status, 0);
  }
});

test('PR CLI uses the real diff, includes moved source paths and fails closed on missing history', () => {
  const root = mkdtempSync(join(tmpdir(), 'ddm-validation-scope-'));
  const script = fileURLToPath(new URL('./validation-scope.mjs', import.meta.url));
  const output = join(root, 'scope-output');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  const run = () => {
    writeFileSync(output, '');
    return spawnSync(process.execPath, [script], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: output, SPECS: '' },
    });
  };
  const commit = (message) => git('-c', 'user.name=Scope fixture', '-c', 'user.email=scope@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', message);
  try {
    git('init', '--quiet');
    const missing = run();
    assert.ifError(missing.error);
    assert.notEqual(missing.status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');

    writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
    git('add', 'source.js');
    commit('base');
    writeFileSync(join(root, 'guide with spaces.md'), 'guide\n');
    git('add', 'guide with spaces.md');
    commit('docs');
    const docs = run();
    assert.ifError(docs.error);
    assert.equal(docs.status, 0, docs.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'mode=docs\n');

    git('mv', 'source.js', 'source.md');
    commit('move source into docs');
    const moved = run();
    assert.ifError(moved.error);
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'mode=full\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
