/**
 * scripts/spec-impact.mjs: what a block removed that specs still name, the
 * selection by test and by rule, the BROAD verdict, the cost limit, the red
 * run's cases, and the refusals that keep `--run` from becoming a local full
 * suite. Also scripts/refresh-spec-timings.mjs's refusal. Inline fixtures
 * only; no git, no gh, no browser.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { refreshRefusal } from '../scripts/refresh-spec-timings.mjs';
import {
  BUILD_SECONDS,
  CROSS_CUTTING,
  LOCAL_LIMIT_SECONDS,
  MODULE_SPECS,
  RUN_PATHS,
  buildTimings,
  caseSelection,
  changedCodeLines,
  chooseWorkBranch,
  costModel,
  crossCuttingSpecs,
  describeSelection,
  diffHunks,
  dirtyRefusal,
  dispatchRefusal,
  entryFiles,
  estimateWait,
  failedCases,
  failedFromRedLists,
  findMentions,
  fire3dSpecs,
  helperChange,
  helperGraph,
  importsChanged,
  matchRedCases,
  measureSpecs,
  mergeEntries,
  newestFailedRun,
  parseCaseLog,
  planLocalRun,
  pureSpecs,
  readTimings,
  removedLiterals,
  runRefusal,
  selectSpecs,
  staleLiterals,
  testSpans,
  touchedSpecs
} from '../scripts/spec-impact.mjs';

const CONFIG = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
const REAL_COST = costModel(readTimings());

const DIFF = [
  'diff --git a/src/ui/panel.ts b/src/ui/panel.ts',
  '--- a/src/ui/panel.ts',
  '+++ b/src/ui/panel.ts',
  '@@ -10,4 +10,2 @@',
  "-  title.textContent = 'Quick views';",
  '-  root.innerHTML = `<button class="ddm-chip is-open" aria-label="Open the chips">${label} Chips row</button>`;',
  "-  // a comment naming 'Comment only'",
  "-  const id = 'ab';",
  "+  title.textContent = 'Layers';",
  'diff --git a/index.html b/index.html',
  '--- a/index.html',
  '+++ b/index.html',
  '@@ -3 +3 @@',
  '-<section id="quick-views" data-panel="quick">Pick a view</section>',
  "-const q = document.querySelector('#conditions-dock .metric-row[data-metric=\"drought\"]');",
  '+<section id="layers"></section>'
].join('\n');

test('removed lines yield literals, attribute values, kebab tokens and visible text', () => {
  const literals = removedLiterals(DIFF);
  for (const expected of [
    'Quick views',
    'ddm-chip is-open',
    'ddm-chip',
    'is-open',
    'Open the chips',
    'Chips row',
    'quick-views',
    'quick',
    'Pick a view',
    'conditions-dock',
    'metric-row',
    'data-metric'
  ]) {
    assert.ok(literals.includes(expected), `missing ${expected}`);
  }
  // Too short, a comment line, an added line, and a composed selector whole.
  for (const absent of ['ab', 'Comment only', 'Layers', 'layers']) {
    assert.ok(!literals.includes(absent), `unexpected ${absent}`);
  }
  assert.ok(!literals.some((text) => text.startsWith('#conditions-dock')));
});

test('a literal still present anywhere in HEAD source is not stale', () => {
  const head = "export const LABEL = 'Pick a view';\n<div class=\"ddm-chip\"></div>";
  const stale = staleLiterals(['Quick views', 'Pick a view', 'ddm-chip', 'is-open'], head);
  assert.deepEqual(stale, ['Quick views', 'is-open']);
});

test('a literal left only in a HEAD comment is stale; a URL is not a comment', () => {
  const head = [
    "// The old 'Quick views' row is retired.",
    "/* 'Chips row' too */ const url = 'https://example.gov/x'; // 'Pick a view'",
    '<!-- conditions-dock -->'
  ].join('\n');
  const stale = staleLiterals(['Quick views', 'Chips row', 'Pick a view', 'conditions-dock', 'https://example.gov/x'], head);
  assert.deepEqual(stale, ['Quick views', 'Chips row', 'Pick a view', 'conditions-dock']);
});

test('mentions name file and line, skip comments and mark absence checks', () => {
  const specs = [
    {
      path: 'tests/panel.spec.ts',
      text: [
        "// Quick views is retired",
        "await expect(page.getByText('Quick views')).toBeVisible();",
        "await expect(page.locator('.is-open'))",
        '  .toHaveCount(0);',
        '// spec-impact: intended, the retired path is sampled on purpose',
        "await page.evaluate((d) => d.length, 'M0,0H660');",
        "await expect(page.getByRole('button', { name: 'Quick views' })).not.toBeDisabled();",
        "await expect(page.locator('.is-open')).toBeHidden();",
        "await expect(page.locator('#dock')).not.toContainText('Quick views');"
      ].join('\n')
    },
    { path: 'tests/other.spec.ts', text: "expect(1).toBe(1);" }
  ];
  assert.deepEqual(findMentions(['Quick views', 'is-open', 'M0,0H660'], specs), [
    { file: 'tests/panel.spec.ts', line: 2, text: 'Quick views', absent: false },
    { file: 'tests/panel.spec.ts', line: 3, text: 'is-open', absent: true },
    { file: 'tests/panel.spec.ts', line: 6, text: 'M0,0H660', absent: true },
    // `.not.toBeDisabled()` still needs the control to exist: not an absence check.
    { file: 'tests/panel.spec.ts', line: 7, text: 'Quick views', absent: false },
    { file: 'tests/panel.spec.ts', line: 8, text: 'is-open', absent: true },
    { file: 'tests/panel.spec.ts', line: 9, text: 'Quick views', absent: true }
  ]);
});

test('touched specs: changed, mentioning, or directly importing a changed module or helper', () => {
  const specs = [
    { path: 'tests/a.spec.ts', text: "import { x } from '../src/ui/panel';" },
    { path: 'tests/b.spec.ts', text: "const m = await import('../src/map/index.ts');" },
    { path: 'tests/c.spec.ts', text: "import { y } from '../src/ui/panel-extra';" },
    { path: 'tests/d.spec.ts', text: '' },
    { path: 'tests/e.spec.ts', text: "import { stubRecentSatellite } from './satellite-fixture';" },
    { path: 'tests/flow-measure.spec.ts', text: "import { x } from '../src/ui/panel';" }
  ];
  assert.ok(importsChanged('tests/a.spec.ts', specs[0].text, ['src/ui/panel.ts']));
  assert.ok(importsChanged('tests/b.spec.ts', specs[1].text, ['src/map/index.ts']));
  assert.ok(!importsChanged('tests/c.spec.ts', specs[2].text, ['src/ui/panel.ts']));
  assert.ok(importsChanged('tests/e.spec.ts', specs[4].text, ['tests/satellite-fixture.ts']));
  assert.deepEqual(
    touchedSpecs({
      changedSpecs: ['tests/d.spec.ts'],
      mentions: [{ file: 'tests/d.spec.ts' }, { file: 'tests/c.spec.ts' }],
      specs,
      changedModules: ['src/ui/panel.ts', 'src/map/index.ts', 'tests/satellite-fixture.ts'],
      measureOnly: new Set(['tests/flow-measure.spec.ts'])
    }),
    ['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts', 'tests/d.spec.ts', 'tests/e.spec.ts']
  );
});

test('cross-cutting rules: shared style, key and dock components, minimap and the test seam add fixed specs', () => {
  const all = new Set(CROSS_CUTTING.flatMap(({ specs }) => specs));
  const names = (changed) => Object.fromEntries(crossCuttingSpecs(changed, all));
  assert.deepEqual(crossCuttingSpecs(['src/ui/panel.ts', 'tests/a.spec.ts'], all).size, 0);
  assert.deepEqual(names(['src/styles/app.css']), {
    'tests/horizon-chips.spec.ts': ['shared style or markup'],
    'tests/interface-responsive.spec.ts': ['shared style or markup'],
    'tests/s4-shell.spec.ts': ['shared style or markup'],
    'tests/telemetry-hover-tokens.spec.ts': ['shared style or markup']
  });
  assert.deepEqual(Object.keys(names(['index.html'])).sort(), Object.keys(names(['src/styles/app.css'])).sort());
  for (const path of ['src/ui/map-key.ts', 'src/ui/legend-registry.ts', 'src/ui/island/shell.tsx']) {
    assert.deepEqual(Object.keys(names([path])).sort(), ['tests/flow-wire.spec.ts', 'tests/interface-responsive.spec.ts', 'tests/s4-shell.spec.ts'], path);
  }
  assert.deepEqual(Object.keys(names(['src/ui/island/minimap.tsx'])), ['tests/s4-minimap.spec.ts']);
  assert.deepEqual(Object.keys(names(['src/state/minimap-wildfire.ts'])), ['tests/s4-minimap.spec.ts']);
  // The seam rule adds its set; a spec two rules pick names both.
  assert.deepEqual(names(['playwright.config.ts', 'src/ui/island/minimap.tsx'])['tests/s4-minimap.spec.ts'], ['minimap component', 'shared test seam']);
  for (const path of ['tests/helpers.ts', 'tests/offline-test.ts']) assert.ok(crossCuttingSpecs([path], all).size > 0, path);
  // A rule's spec that does not exist at HEAD is dropped, not dispatched.
  assert.equal(crossCuttingSpecs(['index.html'], new Set(['tests/s4-shell.spec.ts'])).size, 1);
});

test('cross-cutting rules stay small, name real non-measurement specs, and join touchedSpecs', () => {
  const union = new Set(CROSS_CUTTING.flatMap(({ specs }) => specs));
  assert.ok(union.size <= 6, `${union.size} fixed specs`);
  // At this machine's measured speed they no longer fit one local run together (about 17 min):
  // the plan takes Tier 1 first and names the rest as GitHub's, so the rules only need to stay few.
  for (const { specs } of CROSS_CUTTING) assert.ok(specs.length <= 5);
  const config = CONFIG;
  for (const path of union) {
    assert.ok(path.endsWith('.spec.ts') && !measureSpecs(config).has(path), path);
    readFileSync(new URL(`../${path}`, import.meta.url));
  }
  assert.deepEqual(
    touchedSpecs({ changedSpecs: ['tests/z.spec.ts'], mentions: [], specs: [], changedModules: [], crossCutting: crossCuttingSpecs(['src/ui/island/minimap.tsx'], union) }),
    ['tests/s4-minimap.spec.ts', 'tests/z.spec.ts']
  );
});

test('modules the browser specs reach only through the app pick their own specs', () => {
  // The nine changed in the week of 2026-11-02 that picked no spec at all, then the
  // two whose specs went red unpicked on 2026-11-13 (map chrome, Tribal Lands).
  assert.deepEqual(Object.keys(MODULE_SPECS), [
    'src/main.ts',
    'src/map/interaction-coordinator.ts',
    'src/layers/telemetry.ts',
    'src/ui/island/place-studio.tsx',
    'src/ui/sidebar.ts',
    'src/ui/time-bar.ts',
    'src/ui/heatrisk-sequence.ts',
    'src/ui/sheet-alerts.ts',
    'src/ui/popup-conditions.ts',
    'src/config/map-chrome.ts',
    'src/layers/aiannh.ts',
    'src/ui/hazard-rail.ts'
  ]);
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  const specPaths = new Set(readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.spec.ts')).map((name) => `tests/${name}`));
  const browserOnly = { measureOnly: measureSpecs(config), pureOnly: pureSpecs(config) };
  for (const [module, specs] of Object.entries(MODULE_SPECS)) {
    readFileSync(new URL(`../${module}`, import.meta.url));
    for (const spec of specs) assert.ok(specPaths.has(spec), `${module}: ${spec} is not a spec file`);
    const crossCutting = crossCuttingSpecs([module], specPaths);
    const picked = touchedSpecs({ changedSpecs: [], mentions: [], specs: [], changedModules: [module], crossCutting, ...browserOnly });
    assert.ok(picked.length > 0 && picked.length <= 5, `${module}: ${picked.length} specs`);
    assert.equal(picked.length, crossCutting.size, `${module}: a mapped spec is missing, pure or measurement-only`);
    // Some of what a module change picks always runs here; the plan names the rest as GitHub's.
    assert.ok(planLocalRun({ tier1: picked, fire3d: new Set(), cost: REAL_COST }).run.length > 0, module);
  }
  // A module named only by the coordinator's spec, through the popup's Conditions slot.
  assert.deepEqual(Object.keys(Object.fromEntries(crossCuttingSpecs(['src/ui/popup-conditions.ts'], specPaths))).sort(), ['tests/interaction-coordinator.spec.ts', 'tests/place-popups.spec.ts']);
  assert.equal(crossCuttingSpecs(['src/ui/panel.ts'], specPaths).size, 0);
});

test('the measurement-only specs are read from playwright.config.ts', () => {
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  assert.deepEqual([...measureSpecs(config)].sort(), ['tests/flow-measure.spec.ts', 'tests/mode-switch-cost.spec.ts']);
});

test('pure-only changes never become browser runs, while mixed changes retain browser coverage', () => {
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  const pureOnly = pureSpecs(config);
  assert.equal(pureOnly.size, 69);
  assert(pureOnly.has('tests/antimeridian.spec.ts'));
  assert.throws(() => pureSpecs(''), /Cannot read PURE_SPECS/);
  const selection = {
    changedSpecs: ['tests/antimeridian.spec.ts'],
    mentions: [{ file: 'tests/antimeridian.spec.ts' }],
    specs: [{ path: 'tests/point-in-polygon.spec.ts', text: "import { x } from '../src/util/point-in-polygon';" }],
    changedModules: ['src/util/point-in-polygon.ts'], pureOnly,
  };
  assert.deepEqual(touchedSpecs(selection), []);
  assert.deepEqual(touchedSpecs({ ...selection, changedSpecs: [...selection.changedSpecs, 'tests/studio-options.spec.ts'] }), ['tests/studio-options.spec.ts']);
  assert.match(runRefusal(touchedSpecs(selection)), /empty list/i);
  assert.match(dispatchRefusal(touchedSpecs(selection)), /empty list/i);
  assert.equal(findMentions(['retired control'], [{ path: 'tests/antimeridian.spec.ts', text: "expect('retired control').toBe('retired control');" }]).length, 1);
});

test('--dispatch refuses an empty list (the full run), a detached HEAD, no work branch, an open pull request and an unpushed tip', () => {
  assert.match(dispatchRefusal([], 'work/x', 'a1', 'a1'), /full run/);
  assert.match(dispatchRefusal(['tests/a.spec.ts'], 'HEAD', 'a1', ''), /detached/);
  assert.match(dispatchRefusal(['tests/a.spec.ts'], null, 'a1', ''), /No work branch/);
  // The pull request's own Validate run tests the push; a dispatch would only duplicate it.
  assert.match(dispatchRefusal(['tests/a.spec.ts'], 'work/x', 'a1', 'a1', { number: 121 }), /#121 is open on work\/x: its own Validate run covers/);
  assert.match(dispatchRefusal(['tests/a.spec.ts'], 'work/x', 'a1', 'b2'), /push first/);
  assert.equal(dispatchRefusal(['tests/a.spec.ts'], 'work/x', 'a1', 'a1'), null);
  assert.equal(dispatchRefusal(['tests/a.spec.ts'], 'work/x', 'a1', 'a1', null), null);
});

test('--run refuses an empty list (the whole suite) and an estimate over ten minutes, never a file count', () => {
  assert.match(runRefusal([]), /whole suite/);
  const many = Array.from({ length: 40 }, (_, i) => `tests/s${i}.spec.ts:${i + 1}`);
  assert.equal(runRefusal(many, LOCAL_LIMIT_SECONDS), null);
  assert.match(runRefusal(['tests/a.spec.ts'], LOCAL_LIMIT_SECONDS + 1), /estimated 10\.0 min at 2 workers \(limit 10\.0 min\): too broad for a local run; use the targeted GitHub run/);
});

test('--run and --red refuse uncommitted changes the build reads, since the selection reads commits', () => {
  assert.equal(dirtyRefusal(''), null);
  assert.equal(dirtyRefusal('\n'), null);
  const refusal = dirtyRefusal(' M src/main.ts\nM  playwright.config.ts\n');
  assert.match(refusal, /src\/main\.ts, playwright\.config\.ts/);
  assert.match(refusal, /Commit first/);
  assert.match(dirtyRefusal(Array.from({ length: 10 }, (_, i) => ` M tests/s${i}.spec.ts`).join('\n')), /and 2 more/);
  for (const path of ['src', 'tests', 'index.html', 'public', 'playwright.config.ts', 'vite.config.ts']) assert.ok(RUN_PATHS.includes(path), path);
});

test('the chromium-3d specs are read from playwright.config.ts and are never local', () => {
  const fire3d = fire3dSpecs(CONFIG);
  assert.deepEqual([...fire3d].sort(), ['tests/fire3d-mode.spec.ts', 'tests/view-contracts.spec.ts', 'tests/wildfire3d-ground.spec.ts']);
  assert.throws(() => fire3dSpecs(''), /Cannot read FIRE3D_SPECS/);
  const plan = planLocalRun({ tier1: ['tests/fire3d-mode.spec.ts:91'], tier2: ['tests/view-contracts.spec.ts'], fire3d, cost: () => 1 });
  assert.deepEqual(plan.run, []);
  assert.deepEqual(plan.threeD, ['tests/fire3d-mode.spec.ts', 'tests/view-contracts.spec.ts']);
});

// A spec in the house style: a describe with a hook, two tests, a runtime
// skip, a loop-declared test and a one-line test.
const DOCK_SPEC = [
  "import { test, expect } from './offline-test';",
  "import { gotoApp, layerCheckbox } from './helpers';",
  '',
  'const WIDTH = 390;',
  '',
  "test.describe('the dock', () => {",
  '  test.beforeEach(async ({ page }) => {',
  '    await gotoApp(page);',
  '  });',
  '',
  "  test('opens', async ({ page }) => {",
  "    await expect(page.locator('#dock')).toBeVisible();",
  '  });',
  '',
  "  test.skip(process.env.CI === undefined, 'CI only');",
  "  test('closes', async ({ page }) => {",
  '    const close = /\\)/;',
  "    await layerCheckbox(page, 'usdm').click();",
  '  });',
  '});',
  '',
  "for (const name of ['a', 'b']) test(`row ${name}`, async () => {",
  '  expect(name).toBeTruthy();',
  '});',
  "test('one line', () => expect(WIDTH).toBe(390));"
].join('\n');

test('test spans: declarations with their describes, a loop-declared test, and no runtime skip', () => {
  assert.deepEqual(testSpans(DOCK_SPEC), [
    { line: 11, end: 13, title: 'opens', describes: ['the dock'] },
    { line: 16, end: 19, title: 'closes', describes: ['the dock'] },
    { line: 22, end: 24, title: 'row ${name}', describes: [] },
    { line: 25, end: 25, title: 'one line', describes: [] }
  ]);
  // CRLF working copies give the same spans.
  assert.deepEqual(testSpans(DOCK_SPEC.replace(/\n/g, '\r\n')), testSpans(DOCK_SPEC));
  // A test that closes at the wrong indentation still ends before the next one.
  const skewed = ["test('a', async () => {", '  x();', '  });', '', "  test('b', async () => {", '  });'].join('\n');
  assert.deepEqual(testSpans(skewed).map(({ line, end }) => [line, end]), [[1, 4], [5, 6]]);
});

test('case selection: edits inside tests select those tests; an edit outside every test selects the file', () => {
  const path = 'tests/dock.spec.ts';
  assert.deepEqual(caseSelection(path, DOCK_SPEC, []), []);
  assert.deepEqual(caseSelection(path, DOCK_SPEC, [12]), ['tests/dock.spec.ts:11']);
  assert.deepEqual(caseSelection(path, DOCK_SPEC, [18, 12, 17]), ['tests/dock.spec.ts:11', 'tests/dock.spec.ts:16']);
  assert.deepEqual(caseSelection(path, DOCK_SPEC, [23]), ['tests/dock.spec.ts:22']);
  // A hook, a shared constant, an import and a describe header reach every test.
  for (const line of [8, 4, 2, 6]) assert.deepEqual(caseSelection(path, DOCK_SPEC, [12, line]), [path], `line ${line}`);
});

test('a -U0 diff gives new-side code lines; comments, blank lines and deleted files give none', () => {
  const diff = [
    'diff --git a/tests/dock.spec.ts b/tests/dock.spec.ts',
    'index 1111111..2222222 100644',
    '--- a/tests/dock.spec.ts',
    '+++ b/tests/dock.spec.ts',
    '@@ -12 +12 @@',
    "-    await expect(page.locator('#dock')).toBeHidden();",
    "+    await expect(page.locator('#dock')).toBeVisible();",
    '@@ -17,0 +18,2 @@',
    '+    // why this waits',
    '+',
    '@@ -30,2 +29,0 @@',
    '-  const gone = 1;',
    '-  // and its note',
    '@@ -40 +39 @@',
    '-  // an old note',
    '+  // a new note',
    'diff --git a/tests/old.spec.ts b/tests/old.spec.ts',
    'deleted file mode 100644',
    '--- a/tests/old.spec.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    "-test('x', () => {});"
  ].join('\r\n');
  const hunks = diffHunks(diff);
  assert.deepEqual([...hunks.keys()], ['tests/dock.spec.ts']);
  assert.equal(hunks.get('tests/dock.spec.ts').length, 4);
  assert.deepEqual(hunks.get('tests/dock.spec.ts')[1].added, [{ line: 18, text: '    // why this waits' }, { line: 19, text: '' }]);
  // Removed code with nothing added belongs to both new-side neighbours.
  assert.deepEqual(changedCodeLines(hunks.get('tests/dock.spec.ts')), [12, 29, 30]);
});

test('entries: a whole file absorbs its cases, and a dispatch names files', () => {
  const entries = ['tests/b.spec.ts:20', 'tests/a.spec.ts:9', 'tests/b.spec.ts', 'tests/a.spec.ts:10', 'tests/a.spec.ts:9'];
  assert.deepEqual(mergeEntries(entries), ['tests/a.spec.ts:9', 'tests/a.spec.ts:10', 'tests/b.spec.ts']);
  assert.deepEqual(entryFiles(entries), ['tests/a.spec.ts', 'tests/b.spec.ts']);
});

test('cost: timed files and cases, the file median for a moved case, the median file for an unknown one', () => {
  const timings = { files: { 'tests/a.spec.ts': 600, 'tests/b.spec.ts': 100, 'tests/c.spec.ts': 1200 }, cases: { 'tests/a.spec.ts:10': 30, 'tests/a.spec.ts:20': 50 } };
  const cost = costModel(timings);
  assert.equal(cost('tests/a.spec.ts'), 600);
  assert.equal(cost('tests/a.spec.ts:10'), 30);
  assert.equal(cost('tests/a.spec.ts:99'), 40);
  assert.equal(cost('tests/new.spec.ts'), 600);
  assert.equal(cost('tests/new.spec.ts:5'), 600);
  assert.equal(costModel(null)('tests/x.spec.ts'), 23);
  assert.equal(estimateWait([], cost), 0);
  // One build, then the cases at twice their GitHub seconds, shared by two workers.
  assert.equal(estimateWait(['tests/b.spec.ts', 'tests/a.spec.ts:10'], cost), BUILD_SECONDS + 130);
});

test('the local plan runs everything that fits, otherwise Tier 1 up to the limit, and names the rest', () => {
  const cost = costModel({ files: { 'tests/a.spec.ts': 600, 'tests/b.spec.ts': 100, 'tests/c.spec.ts': 1200 }, cases: { 'tests/a.spec.ts:10': 30 } });
  const fire3d = new Set(['tests/c.spec.ts']);
  assert.deepEqual(planLocalRun({ tier1: ['tests/a.spec.ts:10'], tier2: ['tests/b.spec.ts', 'tests/c.spec.ts'], fire3d, cost }), {
    run: ['tests/a.spec.ts:10', 'tests/b.spec.ts'], seconds: BUILD_SECONDS + 130, threeD: ['tests/c.spec.ts'], over: []
  });
  const tight = planLocalRun({ tier1: ['tests/a.spec.ts:10', 'tests/b.spec.ts'], tier2: ['tests/a.spec.ts', 'tests/new.spec.ts'], fire3d, cost });
  assert.deepEqual(tight.run, ['tests/a.spec.ts:10', 'tests/b.spec.ts']);
  assert.deepEqual(tight.over, ['tests/a.spec.ts', 'tests/new.spec.ts']);
  // Tier 1 itself over the limit: its entries in order while they fit.
  const heavy = planLocalRun({ tier1: ['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/new.spec.ts'], fire3d, cost });
  // a alone (600 s on GitHub, 660 s here with the build) does not fit; b after it does.
  assert.deepEqual(heavy.run, ['tests/b.spec.ts']);
  assert.deepEqual(heavy.over, ['tests/a.spec.ts', 'tests/new.spec.ts']);
  assert.ok(heavy.seconds <= LOCAL_LIMIT_SECONDS);
});

const HELPERS = [
  {
    path: 'tests/helpers.ts',
    text: [
      "import { installStub } from './fixtures';",
      '',
      '/** Every boot goes through here. */',
      'export async function gotoApp(page) {',
      '  await installStub(page);',
      '  await settle(page);',
      '}',
      '',
      'async function settle(page) {',
      '  await page.waitForTimeout(TIMEOUT);',
      '}',
      '',
      'const TIMEOUT = 10;',
      '',
      'export function layerCheckbox(page, key) {',
      '  // Unlike gotoApp, this boots nothing: a comment is no call.',
      '  return page.locator(`#${key}`);',
      '}',
      '',
      'export function selectRegion(page, key) {',
      '  return layerCheckbox(page, key);',
      '}'
    ].join('\n')
  },
  {
    path: 'tests/fixtures.ts',
    text: [
      'export async function installStub(page) {',
      "  await page.route('**/x', (route) => route.fulfill({ body: BODY }));",
      '}',
      "export const BODY = 'x';",
      'export function unusedByBoot() {',
      '  return 1;',
      '}'
    ].join('\n')
  }
];
const HELPER_SPECS = [
  { path: 'tests/a.spec.ts', text: "import { gotoApp } from './helpers';" },
  { path: 'tests/b.spec.ts', text: "import { selectRegion } from './helpers';" },
  { path: 'tests/c.spec.ts', text: "import { layerCheckbox as box } from './helpers';" },
  { path: 'tests/d.spec.ts', text: "import { unusedByBoot } from './fixtures.ts';" },
  { path: 'tests/e.spec.ts', text: "import * as h from './helpers';" },
  { path: 'tests/f.spec.ts', text: "import { gotoApp } from './helpers';" },
  { path: 'tests/g.spec.ts', text: "import {\n  gotoApp,\n  type Mode\n} from './helpers';" }
];

test('a helper change reaching gotoApp is BROAD; a narrow one selects the specs importing what it reaches', () => {
  const graph = helperGraph(HELPERS);
  const change = (path, line) => helperChange(graph, path, [line], HELPER_SPECS);
  // layerCheckbox and selectRegion, which calls it: three specs of seven.
  assert.deepEqual(change('tests/helpers.ts', 17), { path: 'tests/helpers.ts', names: ['layerCheckbox'], specs: ['tests/b.spec.ts', 'tests/c.spec.ts', 'tests/e.spec.ts'], broad: null });
  // A constant settle reads, and a stub in another file that gotoApp installs, both change every boot.
  assert.match(change('tests/helpers.ts', 13).broad, /tests\/helpers\.ts changes TIMEOUT, which tests\/helpers\.ts's gotoApp reaches: every boot changes/);
  assert.match(change('tests/fixtures.ts', 2).broad, /tests\/fixtures\.ts changes installStub, which .*gotoApp reaches/);
  assert.deepEqual(change('tests/fixtures.ts', 6), { path: 'tests/fixtures.ts', names: ['unusedByBoot'], specs: ['tests/d.spec.ts'], broad: null });
  // An import line changes nothing by itself.
  assert.deepEqual(change('tests/helpers.ts', 1), { path: 'tests/helpers.ts', names: [], specs: [], broad: null });
  // A name most specs import is BROAD without gotoApp.
  assert.match(helperChange(graph, 'tests/helpers.ts', [17], HELPER_SPECS.slice(1, 3)).broad, /2 of 2 browser specs import/);
});

test('the whole selection: edited tests in Tier 1, rules and narrow helpers in Tier 2, BROAD helpers left out', () => {
  const specs = [
    ...HELPER_SPECS,
    { path: 'tests/dock.spec.ts', text: DOCK_SPEC },
    { path: 'tests/panel.spec.ts', text: "import { x } from '../src/ui/panel';" },
    { path: 'tests/pure.spec.ts', text: "import { x } from '../src/ui/panel';" },
    { path: 'tests/s4-shell.spec.ts', text: '' }
  ];
  const hunks = (path, line) => [path, [{ start: line, count: 1, added: [{ line, text: '  changed();' }], removed: ['  was();'] }]];
  const base = { specs, helpers: HELPERS, mentions: [], pureOnly: new Set(['tests/pure.spec.ts']) };
  const broad = selectSpecs({
    ...base,
    changed: ['src/ui/panel.ts', 'tests/dock.spec.ts', 'tests/helpers.ts'],
    hunks: new Map([hunks('tests/dock.spec.ts', 12), hunks('tests/helpers.ts', 13)])
  });
  assert.deepEqual(broad.tier1, ['tests/dock.spec.ts:11']);
  assert.deepEqual(broad.tier2, ['tests/panel.spec.ts']);
  assert.deepEqual(broad.broad.map(({ path }) => path), ['tests/helpers.ts']);
  // The test seam rule is the same helpers change: it is GitHub's too.
  assert.equal(broad.crossCutting.size, 0);
  assert.deepEqual(broad.pureTouched, ['tests/pure.spec.ts']);
  assert.ok(describeSelection(broad, null).some((line) => /^BROAD: .*GitHub's full Validate run is the test for that part/.test(line)));

  const narrow = selectSpecs({ ...base, changed: ['tests/helpers.ts'], hunks: new Map([hunks('tests/helpers.ts', 17)]) });
  assert.deepEqual(narrow.broad, []);
  // dock imports layerCheckbox too; s4-shell comes from the test seam rule, which a narrow change keeps.
  assert.deepEqual(narrow.tier2, ['tests/b.spec.ts', 'tests/c.spec.ts', 'tests/dock.spec.ts', 'tests/e.spec.ts', 'tests/s4-shell.spec.ts']);
  assert.deepEqual([...narrow.helperReasons.get('tests/b.spec.ts')], ['tests/helpers.ts: layerCheckbox']);

  // A stale mention inside a test selects that test; a spec with no readable hunk is taken whole.
  const mentioned = selectSpecs({ ...base, changed: ['tests/dock.spec.ts'], hunks: new Map(), mentions: [{ file: 'tests/dock.spec.ts', line: 18 }] });
  assert.deepEqual(mentioned.tier1, ['tests/dock.spec.ts']);
  assert.deepEqual(mentioned.tier2, ['tests/dock.spec.ts:16']);
});

const LOG = [
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:53:18.9Z   ✘   27 [chromium] › tests/dock.spec.ts:30:3 › the dock › opens (11.9s)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:53:31.0Z   ✘   28 [chromium] › tests/dock.spec.ts:30:3 › the dock › opens (retry #1) (11.7s)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:53:33.0Z   ✘   29 [chromium] › tests/dock.spec.ts:35:3 › the dock › closes (2s)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:53:36.0Z   ✓   30 [chromium] › tests/dock.spec.ts:35:3 › the dock › closes (retry #1) (3s)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:54:00.0Z   ✘   31 [chromium] › tests/dock.spec.ts:40:1 › row b (1.2m)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:55:00.0Z   ✘   32 [chromium] › tests/dock.spec.ts:99:1 › gone (1s)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:55:01.0Z   ✘   33 [chromium] › tests/basemap.spec.ts:45:3 › DEG-2 › a removed switcher releases (2ms)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:55:02.0Z   -   34 [chromium] › tests/dock.spec.ts:50:3 › skipped one',
  'Gate and Worker typecheck\tUNKNOWN STEP\t2026-11-11T23:50:00.0Z   ✘    1 [pure] › tests/acknowledgements.spec.ts:80:1 › every row (14ms)',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t2026-11-11T23:55:03.0Z ##[error]  1) [chromium] › tests/dock.spec.ts:30:3 › the dock › opens ',
  'Browser suite / chromium 1/8\tUNKNOWN STEP\t  154 passed (10.3m)'
].join('\r\n');

test('a run log yields its cases, the timings table and the cases that failed every attempt', () => {
  const cases = parseCaseLog(LOG);
  assert.equal(cases.length, 9);
  assert.deepEqual(cases[0], { job: 'chromium 1/8', project: 'chromium', file: 'tests/dock.spec.ts', line: 30, title: 'the dock › opens', status: 'fail', retry: false, ms: 11900 });
  assert.equal(cases[1].retry, true);
  assert.equal(cases[4].ms, 72000);
  assert.equal(cases[7].status, 'skip');
  assert.equal(cases[8].project, 'pure');
  // First attempts of browser cases only; a pure case and a skip cost no browser time.
  assert.deepEqual(buildTimings(cases, { run: 1 }), {
    run: 1,
    unit: 'GitHub seconds, one worker, first attempt',
    files: { 'tests/basemap.spec.ts': 0, 'tests/dock.spec.ts': 86.9 },
    cases: { 'tests/basemap.spec.ts:45': 0, 'tests/dock.spec.ts:30': 11.9, 'tests/dock.spec.ts:35': 2, 'tests/dock.spec.ts:40': 72, 'tests/dock.spec.ts:99': 1 }
  });
  // `closes` passed on retry: flaky, not failed.
  assert.deepEqual(failedCases(cases).map(({ project, file, title }) => `${project} ${file} ${title}`), [
    'chromium tests/dock.spec.ts the dock › opens',
    'chromium tests/dock.spec.ts row b',
    'chromium tests/dock.spec.ts gone',
    'chromium tests/basemap.spec.ts DEG-2 › a removed switcher releases',
    'pure tests/acknowledgements.spec.ts every row'
  ]);
});

test('a run\'s red lists give its failed cases when every planned job left one, never a retry-only pass', () => {
  const list = (label, cases, extra = {}) => ({ label, tier: 'full', planned: 2, cases, ...extra });
  const opens = { project: 'chromium', file: 'tests/dock.spec.ts', line: 30, title: 'the dock › opens', error: 'Error: x', attempts: 2, passedOnRetry: false };
  const closes = { project: 'chromium', file: 'tests/dock.spec.ts', line: 35, title: 'the dock › closes', error: 'Error: y', attempts: 2, passedOnRetry: true };
  const both = failedFromRedLists([list('chromium 1/2', [opens, closes]), list('chromium 2/2', [])]);
  assert.equal(both.complete, true);
  assert.deepEqual(both.failed, [{ project: 'chromium', file: 'tests/dock.spec.ts', line: 30, title: 'the dock › opens' }]);
  // The same shape the log gives, so the same matcher places them at HEAD.
  assert.deepEqual(matchRedCases(both.failed, [{ path: 'tests/dock.spec.ts', text: DOCK_SPEC }]).entries, ['tests/dock.spec.ts:11']);
  // A job that left no list, an unreadable one, or no lists at all: the log decides.
  assert.equal(failedFromRedLists([list('chromium 1/2', [opens])]).complete, false);
  assert.equal(failedFromRedLists([list('chromium 1/2', [opens]), list('chromium 2/2', [], { unreadable: true })]).complete, false);
  assert.equal(failedFromRedLists([list('chromium 1/2', [opens], { planned: null }), list('chromium 2/2', [], { planned: null })]).complete, false);
  assert.equal(failedFromRedLists([]).complete, false);
});

test('red cases match by file and title where they are now: moved lines, loop titles, a test moved to another file', () => {
  const specs = [
    { path: 'tests/dock.spec.ts', text: DOCK_SPEC },
    { path: 'tests/basemap-logic.spec.ts', text: "test('a removed switcher releases', () => {\n  expect(1).toBe(1);\n});" },
    { path: 'tests/acknowledgements.spec.ts', text: "\n\ntest('every row', () => {});" }
  ];
  const { entries, moved, unmatched } = matchRedCases(failedCases(parseCaseLog(LOG)), specs);
  assert.deepEqual(entries, ['tests/acknowledgements.spec.ts:3', 'tests/basemap-logic.spec.ts:1', 'tests/dock.spec.ts:11', 'tests/dock.spec.ts:22']);
  assert.deepEqual(moved.map(({ now }) => now), ['tests/basemap-logic.spec.ts:1']);
  assert.deepEqual(unmatched.map(({ title }) => title), ['gone']);
  assert.deepEqual(newestFailedRun([{ databaseId: 3, conclusion: 'success' }, { databaseId: 2, conclusion: 'failure' }, { databaseId: 1, conclusion: 'failure' }]), { databaseId: 2, conclusion: 'failure' });
  assert.equal(newestFailedRun([{ databaseId: 3, conclusion: 'cancelled' }]), null);
});

test('the work branch: a checked-out work branch, else the newest origin work branch HEAD contains', () => {
  assert.equal(chooseWorkBranch('work/x', [], () => false), 'work/x');
  const remotes = [{ name: 'work/newest' }, { name: 'feature/y' }, { name: 'work/older' }, { name: 'work/oldest' }];
  assert.equal(chooseWorkBranch('main', remotes, (name) => name !== 'work/newest'), 'work/older');
  assert.equal(chooseWorkBranch('HEAD', remotes, () => true), 'work/newest');
  assert.equal(chooseWorkBranch('main', [{ name: 'feature/y' }], () => true), null);
});

test('tests/spec-timings.json holds seconds for browser spec files and their test lines', () => {
  const timings = readTimings();
  assert.ok(timings, 'tests/spec-timings.json is missing or not JSON');
  assert.ok(Object.keys(timings.files).length >= 100, 'a full run names well over 100 browser spec files');
  for (const [file, seconds] of Object.entries(timings.files)) {
    assert.match(file, /^tests\/[\w.-]+\.spec\.ts$/);
    assert.ok(Number.isFinite(seconds) && seconds >= 0, file);
  }
  for (const [key, seconds] of Object.entries(timings.cases)) {
    assert.match(key, /^tests\/[\w.-]+\.spec\.ts:\d+$/);
    assert.ok(key.slice(0, key.lastIndexOf(':')) in timings.files, key);
    assert.ok(Number.isFinite(seconds) && seconds >= 0, key);
  }
});

test('a refresh refuses a log with no cases, or one too small to stand for the suite', () => {
  assert.match(refreshRefusal({ files: {} }, null), /No browser case lines/);
  const known = { files: { a: 1, b: 1, c: 1, d: 1, e: 1 } };
  assert.match(refreshRefusal({ files: { a: 1, b: 1, c: 1 } }, known), /targeted run cannot stand for the suite/);
  assert.equal(refreshRefusal({ files: { a: 1, b: 1, c: 1, d: 1 } }, known), null);
  assert.equal(refreshRefusal({ files: { a: 1 } }, null), null);
});
