/**
 * .github/scripts/plan-browser-shards.mjs: the browser matrix is balanced,
 * deterministic and runs every spec file of its project exactly once; the
 * coverage proof refuses a plan that drops or repeats a file; a fast tier
 * leaves @landing out; the red list and the seconds log read back the way
 * spec-impact and refresh-spec-timings read a run log.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTimings, parseCaseLog } from '../../scripts/spec-impact.mjs';
import {
  TIER_JOBS,
  annotations,
  coverageRefusal,
  fileCost,
  firstErrorLine,
  gatheredSummary,
  landingTagger,
  listedTests,
  medianFileSeconds,
  packFiles,
  planMatrix,
  planProject,
  projectFiles,
  readGathered,
  redList,
  secondsLog,
  sliceSeconds,
  specsOnDisk
} from './plan-browser-shards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const CONFIG = `
export const PURE_SPECS = [
  'tests/pure.spec.ts'
] as const;
const FIRE3D_SPECS = ['**/scene.spec.ts', '**/ground.spec.ts'];
const INTERACTION_SPECS = [
  '**/popup.spec.ts'
];
const MEASURE_SPECS = ['**/measure.spec.ts'];
`;
const SPECS = ['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts', 'tests/new.spec.ts', 'tests/popup.spec.ts',
  'tests/pure.spec.ts', 'tests/measure.spec.ts', 'tests/scene.spec.ts', 'tests/ground.spec.ts'];
const TIMINGS = {
  files: { 'tests/a.spec.ts': 300, 'tests/b.spec.ts': 100, 'tests/c.spec.ts': 20, 'tests/popup.spec.ts': 50, 'tests/scene.spec.ts': 900, 'tests/ground.spec.ts': 300 },
  cases: { 'tests/scene.spec.ts:1': 300, 'tests/scene.spec.ts:2': 300, 'tests/scene.spec.ts:3': 300 }
};
const SCENE = "test('one', () => {});\ntest('two', () => {});\ntest('three', () => {});\n";

/** A listing that collects `n` tests in each planned project's files. */
function listing(files, n = 1) {
  return Object.entries(files).flatMap(([project, paths]) => paths.flatMap((file) => Array.from({ length: n }, () => ({ project, file }))));
}

test('each spec file belongs to one project: 3D and interaction by name, chromium the rest; pure and measurement none', () => {
  assert.deepEqual(projectFiles(CONFIG, SPECS), {
    chromium: ['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts', 'tests/new.spec.ts'],
    'chromium-interaction': ['tests/popup.spec.ts'],
    'chromium-3d': ['tests/ground.spec.ts', 'tests/scene.spec.ts']
  });
  assert.throws(() => projectFiles(CONFIG.replace('FIRE3D_SPECS', 'OTHER'), SPECS), /Cannot read FIRE3D_SPECS/);
  assert.throws(() => projectFiles(CONFIG.replace("'**/popup.spec.ts'", ''), SPECS), /INTERACTION_SPECS .* lists no spec file/);
});

test('a file the timings do not know costs the median file', () => {
  assert.equal(medianFileSeconds(TIMINGS), 200);
  assert.equal(fileCost('tests/new.spec.ts', { timings: TIMINGS, tier: 'full' }).seconds, 200);
  assert.equal(medianFileSeconds(null), 23);
});

test('whole files pack longest first onto the lightest job, and the same inputs give the same plan', () => {
  const items = [{ file: 'x', seconds: 5 }, { file: 'y', seconds: 3 }, { file: 'z', seconds: 3 }, { file: 'w', seconds: 1 }];
  assert.deepEqual(packFiles(items, 2), [{ files: ['w', 'x'], seconds: 6 }, { files: ['y', 'z'], seconds: 6 }]);
  assert.deepEqual(packFiles(items, 8).length, 4, 'no empty job');
  const args = { tier: 'full', configText: CONFIG, specs: SPECS, timings: TIMINGS, texts: new Map([['tests/scene.spec.ts', SCENE]]) };
  assert.deepEqual(planMatrix(args), planMatrix(args));
  assert.deepEqual(planMatrix({ ...args, specs: [...SPECS].reverse() }), planMatrix(args), 'file order does not matter');
});

test('a file heavier than a job is split over jobs of its own, and every slice runs', () => {
  const plan = planProject([
    { file: 'scene', seconds: 900, cases: [300, 300, 300] },
    { file: 'ground', seconds: 300, cases: [300] }
  ], 4);
  const scene = plan.filter((job) => job.files[0] === 'scene');
  assert.deepEqual(scene.map((job) => job.shard), ['1/3', '2/3', '3/3']);
  assert.ok(Math.max(...plan.map((job) => job.seconds)) <= 300 + 1e-9);
  // Slices follow Playwright's cut: equal counts, the remainder to the first.
  assert.deepEqual(sliceSeconds([10, 0, 0, 30, 20], 60, 2), [10, 50]);
  assert.deepEqual(sliceSeconds([], 60, 3), [20, 20, 20]);
  // One test line cannot be split, whatever it costs.
  assert.deepEqual(planProject([{ file: 'loop', seconds: 900, cases: [900] }, { file: 'b', seconds: 10, cases: [10] }], 4).map((job) => job.shard), ['', '']);
});

test('the coverage proof refuses a dropped, repeated or incompletely sliced file and an empty job', () => {
  const files = { chromium: ['tests/a.spec.ts', 'tests/b.spec.ts'], 'chromium-3d': ['tests/scene.spec.ts'] };
  const row = (project, files, shard = '') => ({ project, job: 1, jobs: 1, shard, files });
  const good = { include: [row('chromium', 'tests/a.spec.ts tests/b.spec.ts'), row('chromium-3d', 'tests/scene.spec.ts', '1/2'), row('chromium-3d', 'tests/scene.spec.ts', '2/2')] };
  assert.equal(coverageRefusal(good, listing(files, 2)), null);
  assert.match(coverageRefusal({ include: good.include.slice(1) }, listing(files)), /chromium collects tests\/a\.spec\.ts but no planned job runs it/);
  assert.match(coverageRefusal({ include: [...good.include, row('chromium', 'tests/a.spec.ts')] }, listing(files)), /more than once/);
  assert.match(coverageRefusal({ include: good.include.slice(0, 2) }, listing(files)), /incomplete set of slices/);
  assert.match(coverageRefusal(good, listing(files, 1)), /splits tests\/scene\.spec\.ts into 2 slices but collects only 1 tests/);
  // A file whose every case is tagged @landing collects nothing in a fast run; its job still has the others.
  assert.equal(coverageRefusal(good, listing({ chromium: ['tests/a.spec.ts'], 'chromium-3d': ['tests/scene.spec.ts'] }, 2)), null);
  assert.match(coverageRefusal(good, listing({ 'chromium-3d': ['tests/scene.spec.ts'] }, 2)), /chromium 1\/1 collects no test in tests\/a\.spec\.ts tests\/b\.spec\.ts/);
  assert.match(coverageRefusal({ include: [row('chromium', '')] }, []), /names no files/);
  // Listing JSON: nested describes keep their file.
  const report = { suites: [{ file: 'a.spec.ts', specs: [{ tests: [{ projectName: 'chromium' }] }], suites: [{ title: 'd', file: 'a.spec.ts', specs: [{ tests: [{ projectName: 'chromium' }] }] }] }] };
  assert.deepEqual(listedTests(report), [{ project: 'chromium', file: 'tests/a.spec.ts' }, { project: 'chromium', file: 'tests/a.spec.ts' }]);
  assert.throws(() => listedTests({ suites: [], errors: [{ message: 'load failed' }] }), /did not collect/);
});

test('@landing: a tag on the test or an enclosing describe, conditional or not; a closed sibling describe does not count', () => {
  const source = [
    "test.describe('heavy', { tag: '@landing' }, () => {",
    "  test('inside', async () => {",
    '  });',
    '});',
    "test.describe('light', () => {",
    "  test('plain', async () => {",
    '  });',
    "  test('tagged', { tag: '@landing' }, async () => {",
    '  });',
    '});',
    'for (const width of [1280, 1920]) {',
    "  test(`wide ${width}`, { tag: width > 1280 ? ['@landing'] : [] }, async () => {",
    '  });',
    '}',
    "for (const tier of [undefined, 'landing'] as const) test.describe('rows', { tag: tier ? ['@landing'] : [] }, () => {",
    '  for (const row of rows) {',
    '    test(row.id, async () => {',
    '    });',
    '  }',
    '});'
  ].join('\n');
  const tagOf = landingTagger(source);
  assert.equal(tagOf(2), 'all');
  assert.equal(tagOf(6), null);
  assert.equal(tagOf(8), 'all');
  assert.equal(tagOf(12), 'some');
  assert.equal(tagOf(17), 'some');
  assert.equal(landingTagger("test('x', async () => {});")(1), null);
});

test('the fast tier leaves @landing seconds out of a file and out of its slices', () => {
  const source = "test('kept', async () => {});\ntest('heavy', { tag: '@landing' }, async () => {});\n";
  const timings = { files: { 'tests/x.spec.ts': 110 }, cases: { 'tests/x.spec.ts:1': 10, 'tests/x.spec.ts:2': 100 } };
  assert.deepEqual(fileCost('tests/x.spec.ts', { timings, tier: 'full', text: source }), { seconds: 110, cases: [10, 100] });
  assert.deepEqual(fileCost('tests/x.spec.ts', { timings, tier: 'fast', text: source }), { seconds: 10, cases: [10] });
  // Lines the timings no longer place share what the placed ones leave.
  const moved = { files: { 'tests/x.spec.ts': 110 }, cases: { 'tests/x.spec.ts:40': 10, 'tests/x.spec.ts:41': 100 } };
  assert.deepEqual(fileCost('tests/x.spec.ts', { timings: moved, tier: 'full', text: source }).cases, [55, 55]);
});

test('this tree: fast and full plans run every browser spec file of its project exactly once, at most the tier\'s jobs', () => {
  const specs = specsOnDisk(ROOT);
  const configText = read('playwright.config.ts');
  const texts = new Map(specs.map((path) => [path, read(path)]));
  const timings = JSON.parse(read('tests/spec-timings.json'));
  const owned = projectFiles(configText, specs);
  for (const tier of ['fast', 'full']) {
    const matrix = planMatrix({ tier, configText, specs, timings, texts });
    assert.equal(coverageRefusal(matrix, listing(owned, 4)), null, tier);
    for (const [project, jobs] of Object.entries(TIER_JOBS[tier])) {
      const rows = matrix.include.filter((row) => row.project === project);
      assert.ok(rows.length >= 1 && rows.length <= jobs, `${tier} ${project}: ${rows.length} jobs`);
      assert.ok(rows.every((row) => row.jobs === rows.length));
    }
    for (const row of matrix.include) for (const file of row.files.split(' ')) assert.match(file, /^tests\/[A-Za-z0-9._-]+\.spec\.ts$/);
  }
  const targeted = planMatrix({ tier: 'targeted', configText, specs, timings, texts });
  assert.ok(targeted.include.every((row) => row.files === '' && /^\d+\/\d+$/.test(row.shard)));
});

test('this tree: the heavy 3D cases and the wide variants carry @landing', () => {
  const tagged = (path, line) => landingTagger(read(path))(line);
  const lineOf = (path, title) => read(path).split('\n').findIndex((text) => text.includes(title)) + 1;
  for (const [path, title] of [
    ['tests/fire3d-mode.spec.ts', 'a RAWS station marker in the active 3D scene'],
    ['tests/wildfire3d-ground.spec.ts', 're-entering Wildfire 3D after NOAA revises'],
    ['tests/popup-viewport.spec.ts', 'long desktop heads and panel responses preserve']
  ]) assert.equal(tagged(path, lineOf(path, title)), 'all', title);
  for (const [path, title] of [
    ['tests/fire3d-mode.spec.ts', 'the desktop toggle activates the 3D scene'],
    ['tests/fire3d-mode.spec.ts', 'a phone-width embed never fetches the 3D chunks']
  ]) assert.equal(tagged(path, lineOf(path, title)), null, title);
  assert.equal(tagged('tests/text-registration.spec.ts', lineOf('tests/text-registration.spec.ts', 'no chrome label or seat text overflows')), 'some');
  const rows = read('tests/view-contracts.yaml').split('\n');
  const tiers = rows.filter((line) => /^\s+tier:/.test(line));
  assert.ok(tiers.length > 0 && tiers.every((line) => line.trim() === 'tier: landing'));
});

const REPORT = {
  suites: [{
    title: 'x.spec.ts', file: 'x.spec.ts',
    specs: [{
      title: 'plain', line: 4, column: 1,
      tests: [{ projectName: 'chromium', status: 'unexpected', results: [
        { retry: 0, status: 'failed', duration: 1200, startTime: '2026-11-22T10:00:00.000Z', error: { message: '\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: #x' } },
        { retry: 1, status: 'failed', duration: 1100, startTime: '2026-11-22T10:00:02.000Z', error: { message: 'Error: again' } }
      ] }]
    }],
    suites: [{
      title: 'group', file: 'x.spec.ts',
      specs: [
        { title: 'flaky one', line: 9, column: 3, tests: [{ projectName: 'chromium', status: 'flaky', results: [
          { retry: 0, status: 'timedOut', duration: 60000, startTime: '2026-11-22T10:01:00.000Z', errors: [{ message: 'Test timeout of 60000ms exceeded.' }] },
          { retry: 1, status: 'passed', duration: 5000, startTime: '2026-11-22T10:02:00.000Z' }
        ] }] },
        { title: 'green', line: 12, column: 3, tests: [{ projectName: 'chromium', status: 'expected', results: [{ retry: 0, status: 'passed', duration: 2500, startTime: '2026-11-22T10:03:00.000Z' }] }] }
      ]
    }]
  }]
};

test('a red list names file, line, title, the first error line and whether a retry passed', () => {
  assert.equal(firstErrorLine('\n\u001b[31m  Error: boom \u001b[39m\nmore'), 'Error: boom');
  assert.equal(firstErrorLine('x'.repeat(300)).length, 240);
  const list = redList(REPORT, { label: 'chromium 3/12', tier: 'fast' });
  assert.deepEqual(list.cases, [
    { project: 'chromium', file: 'tests/x.spec.ts', line: 4, title: 'plain', error: 'Error: expect(locator).toBeVisible() failed', attempts: 2, passedOnRetry: false },
    { project: 'chromium', file: 'tests/x.spec.ts', line: 9, title: 'group › flaky one', error: 'Test timeout of 60000ms exceeded.', attempts: 2, passedOnRetry: true }
  ]);
  const summary = gatheredSummary([list, { label: 'chromium 4/12', cases: [] }], 3);
  assert.match(summary, /Red lists from 2 of 3 jobs/);
  assert.match(summary, /\*\*Failed \(1\):\*\*\n\n- `tests\/x\.spec\.ts:4` plain \(chromium 3\/12, 2 attempts\)\n {2}Error: expect/);
  assert.match(summary, /\*\*Passed only on retry \(1\):\*\*/);
  assert.match(gatheredSummary([], null), /None: no case failed an attempt/);
  assert.deepEqual(annotations([list]), ['::error file=tests/x.spec.ts,line=4,title=chromium 3/12%3A plain::Error: expect(locator).toBeVisible() failed']);
});

test('the seconds log reads back through the run-log parser into the timings shape', () => {
  const cases = parseCaseLog(secondsLog(REPORT, 'chromium 3/12'));
  assert.equal(cases.length, 5);
  assert.deepEqual(cases[0], { job: 'chromium 3/12', project: 'chromium', file: 'tests/x.spec.ts', line: 4, title: 'plain', status: 'fail', retry: false, ms: 1200 });
  assert.equal(cases[1].retry, true);
  assert.equal(cases[2].title, 'group › flaky one');
  const timings = buildTimings(cases);
  assert.deepEqual(timings.files, { 'tests/x.spec.ts': 63.7 });
  assert.deepEqual(timings.cases, { 'tests/x.spec.ts:4': 1.2, 'tests/x.spec.ts:9': 60, 'tests/x.spec.ts:12': 2.5 });
});

test('the command line: a plan to GITHUB_OUTPUT, a red list and seconds to files, a gathered summary, never a red from reporting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ddm-plan-'));
  const script = fileURLToPath(new URL('./plan-browser-shards.mjs', import.meta.url));
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env } });
  try {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const plan = run(['--mode', 'fast'], { GITHUB_OUTPUT: output });
    assert.equal(plan.status, 0, plan.stderr);
    const written = readFileSync(output, 'utf8');
    const matrix = JSON.parse(/^matrix=(.*)$/m.exec(written)[1]);
    assert.equal(Number(/^jobs=(\d+)$/m.exec(written)[1]), matrix.include.length);
    assert.notEqual(run(['--mode', 'quick']).status, 0, 'an unknown tier fails the plan');

    writeFileSync(join(dir, 'report.json'), JSON.stringify(REPORT));
    const reds = run(['--reds', join(dir, 'report.json'), '--label', 'chromium 3/12', '--out', join(dir, 'reds'), '--seconds-dir', join(dir, 'seconds')], { TIER: 'fast', PLANNED_JOBS: '15' });
    assert.equal(reds.status, 0, reds.stderr);
    const list = JSON.parse(readFileSync(join(dir, 'reds', 'reds-chromium-3-12.json'), 'utf8'));
    assert.equal(list.planned, 15);
    assert.equal(list.tier, 'fast');
    assert.equal(readGathered(join(dir, 'reds')).lists.length, 1);
    const missing = run(['--reds', join(dir, 'nothing.json'), '--label', 'chromium 4/12', '--out', join(dir, 'reds')]);
    assert.equal(missing.status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'reds', 'reds-chromium-4-12.json'), 'utf8')).unreadable, true);

    const gather = run(['--gather', join(dir, 'reds')], { PLANNED_JOBS: '15' });
    assert.equal(gather.status, 0);
    assert.match(gather.stdout, /^::error file=tests\/x\.spec\.ts,line=4/m);
    assert.match(gather.stdout, /Red lists from 2 of 15 jobs/);
    const merged = join(dir, 'case-seconds.log');
    assert.equal(run(['--merge-seconds', join(dir, 'seconds'), '--out', merged]).status, 0);
    assert.equal(parseCaseLog(readFileSync(merged, 'utf8')).length, 5);
    assert.equal(run(['--merge-seconds', join(dir, 'seconds')]).status, 0, 'a reporting mistake warns, never reds');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
