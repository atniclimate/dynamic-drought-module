/**
 * scripts/spec-impact.mjs: what a block removed that specs still name, and
 * the refusals that keep `--run` from becoming a local full suite. Inline
 * fixtures only; no git, no browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LOCAL_SPECS,
  findMentions,
  importsChanged,
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
        "await page.evaluate((d) => d.length, 'M0,0H660');"
      ].join('\n')
    },
    { path: 'tests/other.spec.ts', text: "expect(1).toBe(1);" }
  ];
  assert.deepEqual(findMentions(['Quick views', 'is-open', 'M0,0H660'], specs), [
    { file: 'tests/panel.spec.ts', line: 2, text: 'Quick views', absent: false },
    { file: 'tests/panel.spec.ts', line: 3, text: 'is-open', absent: true },
    { file: 'tests/panel.spec.ts', line: 6, text: 'M0,0H660', absent: true }
  ]);
});

test('touched specs: changed, mentioning, or directly importing a changed module', () => {
  const specs = [
    { path: 'tests/a.spec.ts', text: "import { x } from '../src/ui/panel';" },
    { path: 'tests/b.spec.ts', text: "const m = await import('../src/map/index.ts');" },
    { path: 'tests/c.spec.ts', text: "import { y } from '../src/ui/panel-extra';" },
    { path: 'tests/d.spec.ts', text: '' }
  ];
  assert.ok(importsChanged('tests/a.spec.ts', specs[0].text, ['src/ui/panel.ts']));
  assert.ok(importsChanged('tests/b.spec.ts', specs[1].text, ['src/map/index.ts']));
  assert.ok(!importsChanged('tests/c.spec.ts', specs[2].text, ['src/ui/panel.ts']));
  assert.deepEqual(
    touchedSpecs({
      changedSpecs: ['tests/d.spec.ts'],
      mentions: [{ file: 'tests/d.spec.ts' }, { file: 'tests/c.spec.ts' }],
      specs,
      changedSrc: ['src/ui/panel.ts', 'src/map/index.ts']
    }),
    ['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts', 'tests/d.spec.ts']
  );
});

test('--run refuses an empty list (the whole suite) and a list too broad for one local run', () => {
  assert.match(runRefusal([]), /whole suite/);
  const many = Array.from({ length: MAX_LOCAL_SPECS + 1 }, (_, i) => `tests/s${i}.spec.ts`);
  assert.match(runRefusal(many), /too broad for a local run; use the targeted GitHub run/);
  assert.equal(runRefusal(many.slice(0, MAX_LOCAL_SPECS)), null);
});
