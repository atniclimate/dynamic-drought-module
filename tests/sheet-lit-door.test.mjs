import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The door a raised phone sheet shows (owner direction 2026-11-09 (sprint),
 * DR-pending). A sheet raised by a map selection, a shared link or Locate was
 * pressed open by no door, so src/ui/mobile-sheet.ts lights the door whose
 * word the sheet's title reads. The title is written by another module
 * (`describe` in src/ui/sheet-motion.ts, lazy); the two rules are mirrors,
 * and this test fails when one moves without the other. Read as text: both
 * modules need a document, and the behaviour itself is proven in a browser.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const controller = await read('src/ui/mobile-sheet.ts');
const motion = await read('src/ui/sheet-motion.ts');

test('the lit door reads the same three tests, in the same order, as the title', () => {
  // The title: the pressed door, else Brief with the report open at full, else Layers in console, else Place.
  assert.match(
    motion,
    /app\.getAttribute\('data-sheet-tab'\) \?\?\s*\(stamped === 'full' && sheet\.querySelector\('#sheet-report \.impact-panel\.open'\)\s*\? 'brief'\s*: app\.classList\.contains\('view-console'\)\s*\? 'layers'\s*: 'place'\)/,
    'the title rule in sheet-motion.ts moved: impliedTab in mobile-sheet.ts must move with it'
  );
  assert.match(
    controller,
    /function impliedTab\(\): SheetTab \{\s*if \(\s*appEl\?\.getAttribute\('data-sheet-detent'\) === 'full' &&\s*sidebarEl\?\.querySelector\('#sheet-report \.impact-panel\.open'\)\s*\) \{\s*return 'brief';\s*\}\s*return appEl\?\.classList\.contains\('view-console'\) \? 'layers' : 'place';\s*\}/
  );
  // The pressed door wins in both, and a closed sheet lights none.
  assert.match(
    controller,
    /function litTab\(\): SheetTab \| null \{\s*return detent === null \|\| detent === 'closed' \? null : \(activeTab \?\? impliedTab\(\)\);\s*\}/
  );
});

test('the lit door re-reads when the title does', () => {
  // The title observes the stop, the pressed door and the view class on #app.
  assert.match(motion, /attributeFilter: \['data-sheet-detent', 'data-sheet-tab', 'class'\]/);
  // The pressed door changes only through syncFooterTab, which relights at once;
  // the other two are observed here.
  assert.match(
    controller,
    /new MutationObserver\(lightDoors\)\.observe\(appEl, \{\s*attributes: true,\s*attributeFilter: \['data-sheet-detent', 'class'\]\s*\}\);/
  );
  assert.match(controller, /function syncFooterTab\(tab: SheetTab \| null\): void \{\s*activeTab = tab;[\s\S]*?lightDoors\(\);\s*\}/);
});

test('an implied door is lit and nothing more', () => {
  // The content gates read data-sheet-tab, stamped from the pressed door alone.
  assert.match(
    controller,
    /if \(activeTab\) appEl\.setAttribute\('data-sheet-tab', activeTab\);\s*else appEl\.removeAttribute\('data-sheet-tab'\);/
  );
  assert.equal([...controller.matchAll(/setAttribute\('data-sheet-tab'/g)].length, 1);
  // The implied door never becomes the pressed one.
  assert.deepEqual(
    [...controller.matchAll(/\bactiveTab = ([^;]+);/g)].map((match) => match[1]),
    ['tab']
  );
  // Lighting writes the two things the stylesheets and the folded cell read.
  assert.match(controller, /btn\.classList\.toggle\('active', active\);/);
  assert.match(controller, /btn\.setAttribute\('aria-expanded', String\(active\)\);/);
});

test('the lit door closes the sheet, and takes focus back, pressed or implied', () => {
  assert.match(controller, /if \(litTab\(\) === tab\) \{\s*setSheetDetent\('closed'\);\s*return;\s*\}/);
  // Both closing roads find the door by the class lighting gives it, before it is cleared.
  const closing = /const door = document\.querySelector<HTMLElement>\(\s*'#mobile-footer-nav button\.active\[data-tab\]'\s*\);[\s\S]*?syncFooterTab\(null\);/;
  assert.match(controller, closing);
  assert.match(
    controller,
    /const active = document\.querySelector<HTMLButtonElement>\(\s*'#mobile-footer-nav button\.active\[data-tab\]'\s*\);\s*setSheetDetent\('closed'\);\s*active\?\.focus\(\);/
  );
});

test('the controller keeps every export it had', () => {
  const names = [...controller.matchAll(/^export (?:async )?(?:function|type|interface|const) (\w+)/gm)].map((match) => match[1]);
  for (const name of [
    'SheetDetent',
    'SheetTab',
    'SheetMotionHost',
    'SheetMotion',
    'isSheetActive',
    'getSheetDetent',
    'sheetAllowsAutoRaise',
    'sheetCameraInset',
    'onSheetDetentSettle',
    'setSheetDetent',
    'setSheetBriefing',
    'sheetReportHost',
    'driveSheetForReport',
    'restoreSheetDetent',
    'revealSheetAtPeek',
    'initMobileSheet'
  ]) {
    assert.ok(names.includes(name), `mobile-sheet.ts no longer exports ${name}`);
  }
});
