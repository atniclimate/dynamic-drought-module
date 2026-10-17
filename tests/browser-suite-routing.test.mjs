import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
const step = workflow.jobs['browser-report'].steps[0];
const marker = '<!-- ddm-browser-suite -->';

async function route(result, artifacts = [], existing = true) {
  const writes = [];
  const info = [];
  const warnings = [];
  const actions = { listWorkflowRunArtifacts() {} };
  const issues = {
    listForRepo() {},
    async createComment(value) { writes.push({ method: 'comment', ...value }); },
    async update(value) { writes.push({ method: 'update', ...value }); },
    async create(value) {
      writes.push({ method: 'create', ...value });
      return { data: { number: 42 } };
    },
  };
  await runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
    process: { env: { BROWSER_RESULT: result } },
    context: { serverUrl: 'https://github.com', repo: { owner: 'owner', repo: 'repo' }, runId: 123, sha: 'abc' },
    core: { info: (value) => info.push(value), warning: (value) => warnings.push(value) },
    github: {
      rest: { actions, issues },
      async paginate(method) {
        if (method === actions.listWorkflowRunArtifacts) return artifacts;
        assert.equal(method, issues.listForRepo);
        return existing ? [{ number: 42, body: marker }] : [];
      },
    },
  });
  return { writes, info, warnings };
}

test('missing failure markers cannot close an issue or claim a pass after an incomplete suite', async () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    for (const existing of [true, false]) {
      const actual = await route(result, [], existing);
      assert.deepEqual(actual.writes, [], String(result));
      assert.equal(actual.info.length, 0);
      assert.equal(actual.warnings.length, 1);
    }
  }
});

test('a successful suite without failure markers closes the standing issue', async () => {
  assert.equal(step.env.BROWSER_RESULT, '${{ needs.browser.result }}');
  const actual = await route('success', [{ name: 'playwright-json-chromium-1-of-8' }]);
  assert.deepEqual(actual.writes.map((write) => write.method), ['comment', 'update']);
  assert.match(actual.writes[0].body, /passed on main/);
  assert.equal(actual.writes[1].state, 'closed');
  assert.equal(actual.writes[1].issue_number, 42);
  assert.deepEqual((await route('success', [], false)).writes, []);
});

test('a failure marker still reports an advisory failure even when the job result is success', async () => {
  for (const result of ['success', 'failure']) {
    for (const existing of [true, false]) {
      const actual = await route(result, [{ name: 'browser-suite-failure-chromium-7-of-8' }], existing);
      assert.equal(actual.writes.length, 1);
      assert.equal(actual.writes[0].method, existing ? 'comment' : 'create');
      assert.match(actual.writes[0].body, /chromium-7-of-8/);
      assert.match(actual.writes[0].body, /browser suite failed/);
    }
  }
});
