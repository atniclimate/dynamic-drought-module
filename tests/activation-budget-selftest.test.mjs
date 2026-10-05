import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The activation gate's own self-test (scripts/check-activation-budget.mjs
 * --self-test: the pinned in-script case table, run through the same checker
 * as the real tree) as a test-runner case, so a change to the checker reds
 * here as well as in `npm run check:activation`. S30D P1-FRAME added the
 * popup frame's sole-feature cases: the frame in a layer row's first-
 * activation closure by its own manifest key, the frame folded into a shared
 * chunk a layer row imports (sourcemap evidence), and the frame counted by its
 * own popup-frame row with a layer that reaches it only dynamically (clean).
 * Its repair round 1 added the blind chunks: a chunk of a layer row's closure
 * with a missing, unparseable or indexed sourcemap is a finding, and only a
 * MAP_EXEMPT helper under its size cap may lack a map (clean).
 *
 * Repair round 2: the script prints no case names, only its counts, so a
 * passing run alone cannot show WHICH cases ran (the script before this unit
 * passes too). The script runs every case of its table and fails its own
 * self-test unless that table's names are exactly EXPECTED_CASE_NAMES; so this
 * reads that pinned inventory from the script, requires every popup-frame
 * sole-feature and blind-chunk case in it, and requires the run's printed
 * fail and pass counts to be that inventory's. Together: those cases ran.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/check-activation-budget.mjs', import.meta.url));

const SOLE_FEATURE_CASES = [
  'fail-popup-frame-in-feature-closure',
  'fail-popup-frame-folded-in-feature-closure',
  'pass-popup-frame-own-row'
];
const BLIND_CHUNK_CASES = [
  'fail-popup-frame-closure-missing-map',
  'fail-popup-frame-closure-invalid-map',
  'fail-popup-frame-closure-indexed-map',
  'pass-popup-frame-closure-exempt-helper'
];

/** The script's pinned case inventory, read from its own source. */
function pinnedCaseNames() {
  const source = readFileSync(SCRIPT, 'utf8');
  const block = /^const EXPECTED_CASE_NAMES = \[([^\]]*)\];/m.exec(source);
  assert.ok(block, 'the script pins its case inventory in EXPECTED_CASE_NAMES');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the activation gate self-test passes, its popup-frame sole-feature cases included', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const summary = /self-test passed \((\d+) fail \+ (\d+) pass cases/.exec(run.stdout);
  assert.ok(summary, `the self-test reported its counts: ${run.stdout}`);

  const names = pinnedCaseNames();
  for (const name of SOLE_FEATURE_CASES) {
    assert.ok(names.includes(name), `the self-test ran the popup-frame sole-feature case ${name}`);
  }
  for (const name of BLIND_CHUNK_CASES) {
    assert.ok(names.includes(name), `the self-test ran the blind-chunk case ${name}`);
  }
  assert.deepEqual(
    [Number(summary[1]), Number(summary[2])],
    [names.filter((n) => n.startsWith('fail-')).length, names.filter((n) => n.startsWith('pass-')).length],
    'the run\'s fail and pass counts are the pinned inventory\'s'
  );
});
