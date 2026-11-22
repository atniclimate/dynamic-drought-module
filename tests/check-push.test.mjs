/**
 * scripts/check-push.mjs: the decisions of the one command before a push,
 * its arguments, its range, the red run it reads, what it says about the
 * remainder and its exit codes. Pure functions only; no git, no gh, no
 * browser, no npm.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EXIT, exitCode, lastRedRun, nothingToPush, parseArgs, pushBase, remainderAdvice, remainderOf } from '../scripts/check-push.mjs';

test('arguments: a base, the block, a branch; a flag without its value or an unknown one is refused', () => {
  assert.deepEqual(parseArgs([]), { base: null, block: false, branch: null });
  assert.deepEqual(parseArgs(['--base', 'abc123', '--block', '--branch', 'work/x']), { base: 'abc123', block: true, branch: 'work/x' });
  assert.throws(() => parseArgs(['--base']), /--base needs a value/);
  assert.throws(() => parseArgs(['--branch', '--block']), /--branch needs a value/);
  assert.throws(() => parseArgs(['--dispatch']), /Unknown option --dispatch/);
});

test('the range: the unpushed commits after the work branch tip HEAD contains, else the block', () => {
  const at = { pushedTip: 'tip1', containsPushed: true, mergeBase: 'mb0' };
  assert.equal(pushBase({ ...at, base: null, block: false }), 'tip1');
  assert.equal(pushBase({ ...at, base: null, block: true }), 'mb0');
  assert.equal(pushBase({ ...at, base: 'given', block: true }), 'given');
  // A rewritten branch, or none on origin yet: the block's merge base.
  assert.equal(pushBase({ ...at, base: null, block: false, containsPushed: false }), 'mb0');
  assert.equal(pushBase({ ...at, base: null, block: false, pushedTip: null }), 'mb0');
  assert.match(nothingToPush(0, 'tip1'), /Nothing to push: HEAD has no commits after tip1/);
  assert.equal(nothingToPush(2, 'tip1'), null);
});

test('the last red joins Tier 1 only while it is the newest finished verdict', () => {
  const red = { databaseId: 2, status: 'completed', conclusion: 'failure' };
  assert.equal(lastRedRun([red]), red);
  assert.equal(lastRedRun([{ databaseId: 4, status: 'in_progress', conclusion: '' }, { databaseId: 3, status: 'completed', conclusion: 'cancelled' }, red]), red);
  assert.equal(lastRedRun([{ databaseId: 3, status: 'completed', conclusion: 'success' }, red]), null);
  assert.equal(lastRedRun([]), null);
});

const none = remainderOf({ over: [], threeD: [] }, []);
const some = remainderOf({ over: ['tests/a.spec.ts'], threeD: ['tests/fire3d-mode.spec.ts'] }, []);
const broad = remainderOf({ over: [], threeD: [] }, [{ broad: 'tests/helpers.ts changes TIMEOUT, which tests/helpers.ts\'s gotoApp reaches: every boot changes' }]);

test('the remainder: nothing, or what is over the limit, chromium-3d and BROAD', () => {
  assert.equal(none.any, false);
  assert.equal(some.any, true);
  assert.equal(broad.any, true);
  assert.deepEqual(remainderAdvice(none, { openPull: null, branch: 'work/x', base: 'b0' }), []);
});

test('an open pull request covers the remainder with its own run, so nothing is dispatched', () => {
  const lines = remainderAdvice(some, { openPull: { number: 121 }, branch: 'work/x', base: 'b0' });
  assert.match(lines.join('\n'), /chromium-3d, never run locally: tests\/fire3d-mode\.spec\.ts/);
  assert.match(lines.join('\n'), /Over the 10\.0 min local limit: tests\/a\.spec\.ts/);
  assert.match(lines.at(-1), /Pull request #121 is open on work\/x: the push runs the full Validate, which covers this remainder\. Do not dispatch\./);
  assert.ok(!lines.some((line) => /gh workflow run|--dispatch/.test(line)));
});

test('without a pull request: the targeted dispatch to run after the push, or the full run when BROAD', () => {
  assert.equal(remainderAdvice(some, { openPull: null, branch: 'work/x', base: 'b0' }).at(-1), 'After the push, the targeted run: npm run spec:impact -- --dispatch --base b0');
  const full = remainderAdvice(broad, { openPull: null, branch: 'work/x', base: 'b0' });
  assert.match(full[0], /^BROAD: tests\/helpers\.ts changes TIMEOUT/);
  assert.equal(full.at(-1), 'After the push, the full run: gh workflow run validate.yml --ref work/x -R atniclimate/dynamic-drought-module');
  // GitHub could not be asked, or there is no work branch yet: say so, and still give the command.
  assert.match(remainderAdvice(some, { openPull: undefined, branch: 'work/x', base: 'b0' }).join('\n'), /is unknown: if one is, its run covers this/);
  assert.match(remainderAdvice(broad, { openPull: null, branch: null, base: 'b0' }).join('\n'), /No work branch on origin contains HEAD yet[\s\S]*--ref the work branch/);
});

test('exit codes: 0 all ran and passed, 3 the rest is GitHub\'s, 1 a failure', () => {
  assert.deepEqual(EXIT, { passed: 0, failed: 1, refused: 2, remainder: 3 });
  assert.equal(exitCode({ localFailed: false, remainder: none }), 0);
  assert.equal(exitCode({ localFailed: false, remainder: some }), 3);
  assert.equal(exitCode({ localFailed: true, remainder: some }), 1);
  assert.equal(exitCode({ localFailed: true, remainder: none }), 1);
});
