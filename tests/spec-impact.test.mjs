/**
 * scripts/spec-impact.mjs: what a block removed that specs still name, and
 * the refusals that keep `--run` from becoming a local full suite. Inline
 * fixtures only; no git, no browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CROSS_CUTTING,
  MAX_LOCAL_SPECS,
  crossCuttingSpecs,
  dispatchRefusal,
  findMentions,
  importsChanged,
  measureSpecs,
  pureSpecs,
  removedLiterals,
  runRefusal,
  staleLiterals,
  touchedSpecs
} from '../scripts/spec-impact.mjs';

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
  assert.ok(union.size <= MAX_LOCAL_SPECS / 2, `${union.size} fixed specs`);
  for (const { specs } of CROSS_CUTTING) assert.ok(specs.length <= 5);
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  for (const path of union) {
    assert.ok(path.endsWith('.spec.ts') && !measureSpecs(config).has(path), path);
    readFileSync(new URL(`../${path}`, import.meta.url));
  }
  assert.deepEqual(
    touchedSpecs({ changedSpecs: ['tests/z.spec.ts'], mentions: [], specs: [], changedModules: [], crossCutting: crossCuttingSpecs(['src/ui/island/minimap.tsx'], union) }),
    ['tests/s4-minimap.spec.ts', 'tests/z.spec.ts']
  );
});

test('the measurement-only specs are read from playwright.config.ts', () => {
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  assert.deepEqual([...measureSpecs(config)].sort(), ['tests/flow-measure.spec.ts', 'tests/mode-switch-cost.spec.ts']);
});

test('pure-only changes never become browser runs, while mixed changes retain browser coverage', () => {
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  const pureOnly = pureSpecs(config);
  assert.equal(pureOnly.size, 34);
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

test('--dispatch refuses an empty list (the full run), a detached HEAD and an unpushed tip', () => {
  assert.match(dispatchRefusal([], 'work/x', 'a1', 'a1'), /full run/);
  assert.match(dispatchRefusal(['tests/a.spec.ts'], 'HEAD', 'a1', ''), /detached/);
  assert.match(dispatchRefusal(['tests/a.spec.ts'], 'work/x', 'a1', 'b2'), /push first/);
  assert.equal(dispatchRefusal(['tests/a.spec.ts'], 'work/x', 'a1', 'a1'), null);
});

test('--run refuses an empty list (the whole suite) and a list too broad for one local run', () => {
  assert.match(runRefusal([]), /whole suite/);
  const many = Array.from({ length: MAX_LOCAL_SPECS + 1 }, (_, i) => `tests/s${i}.spec.ts`);
  assert.match(runRefusal(many), /too broad for a local run; use the targeted GitHub run/);
  assert.equal(runRefusal(many.slice(0, MAX_LOCAL_SPECS)), null);
});
