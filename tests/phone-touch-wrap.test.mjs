import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Visual uniformity wave 1, D8 (2026-11-13): the phone and the tablet.
 *
 * Read as text: these are stylesheet and wiring facts a browser run measures
 * (tests/interface-responsive.spec.ts, tests/text-registration.spec.ts,
 * tests/mobile-sheet.spec.ts); this file fails first, with no browser, when
 * one of them is undone. Every pattern crosses line ends with \s, so the
 * checkout's line endings do not matter.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const app = strip(await read('src/styles/app.css'));
const panels = strip(await read('src/styles/mobile-panels.css'));
const column = strip(await read('src/styles/edge-column.css'));
const indicators = strip(await read('src/styles/hazard-indicators.css'));
const manager = await read('src/ui/edge-column.ts');
const mapKey = await read('src/ui/map-key.ts');

test('the phone sheet never re-admits the desktop header or footer, and hides the mode grid', () => {
  for (const [name, css] of [['app.css', app], ['mobile-panels.css', panels]]) {
    assert.doesNotMatch(
      css,
      /#app\[data-sheet-detent[^{]*\.sidebar-(header|footer)\s*\{\s*display:\s*(flex|block)/,
      `${name} shows the desktop header or footer inside the phone sheet again`
    );
  }
  assert.match(app, /#app\[data-sheet-detent\] \.sidebar-header,\s*#app\[data-sheet-detent\] \.sidebar-footer,/);
  assert.match(app, /#app\[data-sheet-detent\] \.shell-view\s*\{\s*display:\s*none;/);
  // The footer is a child of .sidebar-scroll (index.html), so a rule that
  // re-admits that column's children must leave it out by name.
  const readmits = [...app.matchAll(/([^{}]*\.sidebar-scroll\s*>\s*\*[^{}]*)\{\s*display:\s*(?:block|flex)/g)].map((m) => m[1]);
  assert.ok(readmits.length > 0, 'the full console stop no longer re-admits the sheet stack');
  for (const selector of readmits) {
    assert.ok(selector.includes(':not(.sidebar-footer)'), `the footer rides back in with: ${selector.trim()}`);
  }
});

test('the two wrapping rules sit outside the 721 px gate and name the D8 selectors', () => {
  // A rule inside a media block is indented in this file; these two start their line.
  const pretty = app.match(/^:where\(body:not\(:has\(> \.app-shell\.embed\)\)\)\s+:where\(p, li, dd,[^{]*\{\s*text-wrap:\s*pretty;/m);
  assert.ok(pretty, 'the prose rule is gated or gone');
  const balance = app.match(/^:where\(body:not\(:has\(> \.app-shell\.embed\)\)\)\s+:where\(h1, h2, h3, h4,([^{]*)\{\s*text-wrap:\s*balance;/m);
  assert.ok(balance, 'the heading and label rule is gated or gone');
  for (const selector of [
    '.impact-resource-label', '.time-bar-stamp-headline', '.shell-time-headline-detail', '.lead-together-class',
    '.lead-source-name', '.place-studio-option-name', '#sheet-report-door', '.ack-name', '#impact-panel-title'
  ]) {
    assert.ok(balance[1].includes(selector), `${selector} left the balance list`);
  }
});

test('one grouped rule floors the controls that measured under 44 px, for a coarse pointer and for a phone', () => {
  const blocks = [...app.matchAll(/@media \(pointer: coarse\), \(max-width: 720px\) \{([\s\S]*?)\r?\n\}/g)].map((m) => m[1]);
  const floor = blocks.find((block) => block.includes('.shell-fire3d-layer'));
  assert.ok(floor, 'the grouped floor rule is gone');
  const height = floor.match(/([^{}]*)\{\s*min-height:\s*var\(--touch-target\);\s*\}/);
  assert.ok(height, 'the floor is no longer --touch-target');
  for (const selector of [
    '.shell-fire3d-btn', '.shell-fire3d-layer', '.shell-fire3d-details > summary', '.layer-group-sources-toggle',
    '.panel-reveal', '.map-key-door', '.map-info-ack-link', '.map-info-tribal summary', '.impact-panel summary',
    '.popup-other-features > summary', '.popup-other-item', '.popup-impact-btn', '.overlay-btn',
    '.basemap-switcher-btn', '#map-key > .map-key-flow-pause'
  ]) {
    assert.ok(height[1].includes(selector), `${selector} lost its height floor`);
  }
  const width = floor.match(/([^{}]*)\{\s*min-width:\s*var\(--touch-target\);\s*\}/);
  assert.ok(width, 'the width floor is gone');
  for (const selector of ['#map-key > .map-key-flow-pause', '.time-bar-play', '.panel-response-close.icon-btn']) {
    assert.ok(width[1].includes(selector), `${selector} lost its width floor`);
  }
});

test('the popup close corner takes the floor and its seat on a phone as on a coarse pointer', () => {
  const blocks = [...app.matchAll(/@media \(pointer: coarse\), \(max-width: 720px\) \{([\s\S]*?)\r?\n\}/g)].map((m) => m[1]);
  assert.ok(
    blocks.some((block) =>
      /\.maplibregl-popup-close-button\s*\{\s*min-width:\s*var\(--touch-target\) !important;\s*min-height:\s*var\(--touch-target\) !important;/.test(block)
    ),
    'the close corner is under the floor on a phone'
  );
  assert.ok(
    blocks.some((block) => /\.maplibregl-popup-content\s*\{\s*--popup-close-seat:\s*var\(--touch-target\);/.test(block)),
    'the head no longer reserves the 44 px seat on a phone'
  );
  // The seat's padding starts its line: it is in no media block, so a phone reads it.
  assert.match(app, /^\.ddm-coordinated-popup \.coordinated-response-head\s*\{\s*padding-inline-end:\s*calc\(var\(--popup-close-seat\) - 16px\);/m);
  assert.match(
    app,
    /^\.ddm-coordinated-popup \.maplibregl-popup-content\.ddm-popup-compact \.coordinated-response-head\s*\{\s*padding-inline-end:\s*calc\(var\(--popup-close-seat\) - 8px\);/m
  );
});

// The repair batch after look 2 and the first Validate run (2026-11-13).
test('a narrow embed under a mouse keeps the compact popup corner and the full head', () => {
  const block = app.match(/@media \(pointer: fine\) and \(max-width: 720px\) \{([\s\S]*?)\r?\n\}/);
  assert.ok(block, 'the fine-pointer embed exception is gone');
  assert.match(
    block[1],
    /\.app-shell\.embed \.maplibregl-popup-close-button\s*\{\s*min-width:\s*var\(--pointer-target\) !important;\s*min-height:\s*var\(--pointer-target\) !important;/
  );
  assert.match(
    block[1],
    /\.app-shell\.embed \.ddm-coordinated-popup \.coordinated-response-head,\s*\.app-shell\.embed \.ddm-coordinated-popup \.maplibregl-popup-content\.ddm-popup-compact \.coordinated-response-head\s*\{\s*padding-inline-end:\s*0;/
  );
  // Every selector in it is an embed's: a phone-width full page keeps the touch floor.
  for (const selector of block[1].replace(/\{[^}]*\}/g, ',').split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(selector.startsWith('.app-shell.embed '), `the exception reaches the full page: ${selector}`);
  }
});

test('the repaired wrapping: stacked horizon titles, whole type chips, balanced last lines', async () => {
  const title = app.match(/^\.shell-horizon-btn-title\s*\{([^}]*)\}/m);
  assert.ok(title, 'the horizon title rule is gone');
  assert.match(title[1], /inline-size:\s*min-content;/);
  assert.match(title[1], /margin-inline:\s*auto;/);
  const balance = app.match(/^:where\(body:not\(:has\(> \.app-shell\.embed\)\)\)\s+:where\(h1, h2, h3, h4,([^{]*)\{\s*text-wrap:\s*balance;/m);
  for (const selector of ['.impact-resource-desc', '.impact-resource-agency', '.region-briefing-place', '.panel-response-context']) {
    assert.ok(balance?.[1].includes(selector), `${selector} is not balanced`);
  }
  const studios = strip(await read('src/styles/studios.css'));
  const chip = studios.match(/@media \(min-width: 721px\) \{[\s\S]*?#place-studio-root \.place-studio-type\s*\{([^}]*)\}/);
  assert.ok(chip, 'the desktop and tablet type chip rule is gone');
  assert.match(chip[1], /white-space:\s*nowrap;/);
  assert.match(chip[1], /flex:\s*1 1 clamp\(0px, \(var\(--place-type-row\) - 100%\) \* 999, 50% - var\(--ctl-gap\) \/ 2\);/);
  assert.ok(!/overflow-wrap|min-width:\s*0/.test(chip[1]), 'a type chip may break or shrink under its name again');
});

test('the Brief door drops the PLACE button, and only that door does', () => {
  const hides = [...app.matchAll(/([^{}]*#sheet-place-studio-entry[^{}]*)\{\s*display:\s*none;/g)].map((m) => m[1].trim());
  assert.deepEqual(hides, ["#app[data-sheet-detent][data-sheet-tab='brief'] #sheet-place-studio-entry"]);
});

test('the pre-release mark is off the column and still drawn on a phone', () => {
  assert.doesNotMatch(manager, /test-preview-badge|\.prepend\(/, 'the column manager seats the mark again');
  assert.doesNotMatch(column, /\.edge-column[^{]*\.test-preview-badge/, 'a column face for the mark is back');
  const mark = column.match(
    /#app\[data-sheet-detent\] \.map-overlay-controls > \.test-preview-badge\s*\{\s*display:\s*block;\s*position:\s*fixed;([^}]*)\}/
  );
  assert.ok(mark, 'the mark is no longer drawn on a phone');
  // Repair R3: one fixed corner at the top of the map, beside the column; it
  // no longer rides the sheet's top edge into the middle of the map, and it
  // is the lowest chrome, so what opens across that band covers it.
  assert.match(mark[1], /top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ var\(--edge-inset\)\);/);
  assert.match(mark[1], /right:\s*calc\(\s*env\(safe-area-inset-right, 0px\) \+ var\(--edge-inset\) \+ var\(--edge-column-w\) \+ var\(--edge-gap\)\s*\);/);
  assert.match(mark[1], /z-index:\s*var\(--z-map-chrome\);/);
  assert.ok(!/sheet-lift|bottom:/.test(mark[1]), 'the mark rides the sheet again');
  assert.match(column, /#app\[data-sheet-detent\] \.map-overlay-controls\s*\{[^}]*z-index:\s*auto;/);
});

test('the map title reads the mode table outside an embed, and the accessible name keeps the product', () => {
  assert.match(
    mapKey,
    /const chipTitle = app\?\.classList\.contains\('embed'\) \? spec\.label : chipFallbackLabel\(getSelectedHazard\(\)\);/
  );
  assert.match(mapKey, /keyLabel = chipTitle === spec\.label \? spec\.label : `\$\{chipTitle\}, \$\{spec\.label\}`;/);
  assert.match(mapKey, /chipGrammar\.label\.textContent = chipTitle;/);
  // One rule says the case once: no transform on the title at its source, so no override in app.css.
  // assert.ok, not doesNotMatch: a failure must not print a whole stylesheet.
  assert.ok(!/text-transform/.test(indicators),'the title is transformed at its source again');
  assert.ok(!/\.map-key-details-toggle\s*\{[^}]*text-transform/.test(app), 'app.css overrides the title case again');
});

test('the Tribal Nations key row keeps its swatch beside its word on a phone', () => {
  assert.match(
    app,
    /#app\[data-sheet-detent\] #map-key \.map-key-scale\[data-tribal-nations-key\]\s*\{\s*flex-direction:\s*row;\s*align-items:\s*center;\s*gap:\s*6px;\s*min-height:\s*18px;\s*font-size:\s*10\.5px;/
  );
});
