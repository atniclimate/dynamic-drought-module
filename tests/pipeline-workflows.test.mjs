import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const validate = workflow('validate');
const full = "${{ needs.scope.outputs.mode == 'full' }}";

test('Validate keeps privacy and scope checks unconditional and requires all selected results', () => {
  // The default three pull request types, and ready_for_review for the full run.
  assert.deepEqual(validate.on.pull_request, { types: ['opened', 'synchronize', 'reopened', 'ready_for_review'] });
  const scope = validate.jobs.scope;
  assert.equal(scope.if, undefined);
  assert.equal(scope.steps[0].with['fetch-depth'], 2);
  for (const command of ['node .github/scripts/validation-scope.mjs', 'node --test .github/scripts/validation-scope.test.mjs', 'node scripts/check-public-tree.mjs']) {
    assert.equal(scope.steps.find((step) => step.run === command)?.if, undefined);
    assert(scope.steps.some((step) => step.run === command), command);
  }
  const final = validate.jobs.validate;
  assert.equal(final.name, 'Validate');
  assert.equal(final.if, '${{ !cancelled() }}');
  assert.deepEqual(final.needs, ['gate', 'landscape', 'scope', 'browser']);
  const result = final.steps.find((step) => step.run === 'node .github/scripts/validation-scope.mjs --verify');
  assert.equal(result.env.JOB_RESULTS, '${{ toJSON(needs) }}');
  assert.equal(result.if, undefined);
});

test('proxy-only validation has no application, terrain, landscape or browser work', () => {
  const gate = validate.jobs.gate;
  assert.equal(gate.if, "${{ needs.scope.outputs.mode == 'full' || needs.scope.outputs.mode == 'proxy' }}");
  for (const command of ['npm ci', 'npm exec tsc -- --version', 'npm run gate', 'npm --prefix workers/terrain ci', 'npm --prefix workers/terrain run typecheck', 'npm --prefix workers/terrain audit']) {
    assert.equal(gate.steps.find((step) => step.run === command)?.if, full, command);
  }
  for (const command of ['npm --prefix workers/proxy ci', 'npm --prefix workers/proxy run typecheck', 'npm --prefix workers/proxy audit']) {
    const step = gate.steps.find((entry) => entry.run === command);
    assert(step, command);
    assert.equal(step.if, undefined);
  }
  const focused = gate.steps.find((step) => step.run === 'node --test tests/worker-client-contract.test.mjs tests/worker-receipts.test.mjs');
  assert.equal(focused.if, "${{ needs.scope.outputs.mode == 'proxy' }}");
  assert.equal(validate.jobs.landscape.if, full);
  assert.equal(validate.jobs.landscape['runs-on'], 'windows-latest');
  assert.equal(validate.jobs.browser.if, "${{ needs.scope.outputs.mode == 'full' || needs.scope.outputs.mode == 'targeted' }}");
  assert.equal(validate.jobs.browser.with.specs, "${{ inputs.specs || '' }}");
  assert.match(validate['run-name'], /Targeted browser run.*not a landing run/);
});

test('a draft pull request runs the fast tier and says so; ready, a plain dispatch and the schedule run the full tier', () => {
  const fast = "github.event.pull_request.draft || inputs.tier == 'fast'";
  // A targeted dispatch is never fast (its collect job lists files without the grep).
  assert.equal(validate.jobs.browser.with.tier, `\${{ inputs.specs == '' && (${fast}) && 'fast' || 'full' }}`);
  const tier = validate.on.workflow_dispatch.inputs.tier;
  assert.deepEqual([tier.type, tier.options, tier.default], ['choice', ['full', 'fast'], 'full']);
  // The run name: targeted first, then fast, else GitHub's own.
  assert.ok(validate['run-name'].includes(`|| ((${fast}) && format('Fast run on {0}, not a landing run', github.head_ref || github.ref_name))`));
  const say = validate.jobs.validate.steps.find((step) => step.name === 'Say that this is a fast run');
  assert.equal(say.if, `\${{ inputs.specs == '' && needs.scope.outputs.mode == 'full' && (${fast}) }}`);
  assert.match(say.run, /::notice::Fast run: .*Not a landing run/);
  // The step that decides the result stays the last one, unconditional.
  assert.equal(validate.jobs.validate.steps.at(-1).run, 'node .github/scripts/validation-scope.mjs --verify');
  // Unchanged: one concurrency group per ref, a targeted run apart, superseded runs cancelled.
  assert.deepEqual(validate.concurrency, { group: "validate-${{ github.ref }}${{ inputs.specs != '' && '-targeted' || '' }}", 'cancel-in-progress': true });
  assert.deepEqual(validate.permissions, { contents: 'read' });
  // The schedule calls the browser suite with no inputs, and its tier falls back to full.
  const suite = workflow('browser-suite');
  assert.deepEqual(suite.on.schedule, [{ cron: '13 15 * * 1' }]);
  assert.equal(suite.on.workflow_call.inputs.tier.default, 'full');
  assert.equal(suite.jobs.plan.steps.find((step) => step.id === 'plan').env.TIER, "${{ inputs.tier || 'full' }}");
});

test('Pages has one main-only publisher, isolated concurrency, freshness and minimal permissions', () => {
  const deploy = workflow('deploy');
  assert.deepEqual(deploy.on.push.branches, ['main']);
  assert.deepEqual(deploy.on.push['paths-ignore'], [
    '*.md', 'tests/README.md', 'docs/**', 'planning/**', '.github/ISSUE_TEMPLATE/**',
  ]);
  assert.deepEqual(deploy.permissions, { contents: 'read' });
  assert.equal(deploy.concurrency.group, "${{ github.ref == 'refs/heads/main' && 'pages' || format('pages-ineligible-{0}', github.run_id) }}");
  assert.deepEqual(Object.keys(deploy.jobs), ['build', 'deploy']);
  for (const job of Object.values(deploy.jobs)) assert.equal(job.if, "${{ github.ref == 'refs/heads/main' }}");
  assert.deepEqual(deploy.jobs.build.permissions, { contents: 'read', pages: 'read' });
  assert.deepEqual(deploy.jobs.deploy.permissions, { contents: 'read', pages: 'write', 'id-token': 'write' });
  assert.deepEqual(deploy.jobs.deploy.needs, ['build']);
  const steps = deploy.jobs.deploy.steps;
  assert.match(steps[0].run, /branches\/main/);
  assert.match(steps[0].run, /exit 1/);
  assert(steps.findIndex((step) => step.uses?.startsWith('actions/deploy-pages@')) > 0);
  const publishers = readdirSync(new URL('../.github/workflows/', import.meta.url)).filter((file) => {
    return /uses: actions\/deploy-pages@/.test(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
  });
  assert.deepEqual(publishers, ['deploy.yml']);
});

test('live proof follows deployment independently and Chromium provisioning remains bounded', () => {
  const live = workflow('verify-live');
  assert.deepEqual(live.on.workflow_run.workflows, ['Build and deploy DDM to GitHub Pages']);
  assert.match(live.jobs.verify.if, /head_branch == 'main'/);
  assert.match(live.jobs.verify.concurrency.group, /verify-live-/);
  const steps = live.jobs.verify.steps;
  assert(steps.findIndex((step) => step.id === 'policy') < steps.findIndex((step) => step.id === 'align'));
  assert.match(steps.find((step) => step.id === 'verify').run, /evaluateVerificationReceipt/);
  const action = parse(readFileSync(new URL('../.github/actions/playwright-chromium/action.yml', import.meta.url), 'utf8'));
  assert(action.runs.steps.some((step) => step.run === 'timeout 600 bash ./.github/actions/playwright-chromium/install-deps.sh'));
  assert.equal(action.runs.steps.find((step) => step.uses?.startsWith('actions/cache/save@')).if, "steps.playwright-cache.outputs.cache-hit != 'true' && github.ref == 'refs/heads/main'");
});
