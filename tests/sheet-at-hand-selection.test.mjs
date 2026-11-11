import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The phone sheet's at-hand block and a place that is selected with no
 * briefing read for it yet (owner direction 2026-11-09 (sprint), DR-pending).
 * The Place studio's "Show on map" selects and frames a place and opens no
 * briefing, and a search in the console view does the same; before this the
 * block said "Pick a place" under a map that marked one. Read as text: the
 * module needs a document, and the behaviour itself is proven in a browser.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
const sheet = strip(await read('src/ui/mobile-sheet.ts'));
const panel = strip(await read('src/ui/impact-panel.ts'));

test('the block names a selected place, and says "Pick a place" only when none is selected', () => {
  assert.match(
    sheet,
    /function selectedWithoutBriefing\(\): PlaceSelection \| null \{\s*return sheetBriefing === null \? getPlaceSelection\(\) : null;\s*\}/
  );
  assert.match(
    sheet,
    /const title = briefing \? briefing\.landTitle : selected \? selected\.label : 'Pick a place';/
  );
  // A briefing that is read always wins: its own title, kind and line.
  assert.match(sheet, /const kind = briefing \? briefing\.landKind : '';/);
  // The selected place makes no claim about conditions: one plain line, no read.
  assert.match(sheet, /Selected on the map\. Open its briefing for sourced conditions, outlooks, and resources\./);
});

test('the one door is named for what it does next, and opens the briefing of a selected place', () => {
  assert.match(
    sheet,
    /const word = hasBriefing \|\| !offersBriefing \? 'Read the full report' : 'Open briefing';/
  );
  assert.match(sheet, /reportDoor\.hidden = !offersBriefing;/);
  assert.match(
    sheet,
    /const selected = selectedWithoutBriefing\(\);\s*if \(selected\) \{\s*openSelectedBriefing\?\.\(selected\);\s*return;\s*\}\s*setSheetDetent\('full'\);/
  );
  // The block follows the selection while no briefing is read.
  assert.match(sheet, /onPlaceSelectionChange\(\(\) => \{\s*if \(sheetBriefing === null\) renderAtHand\(\);\s*\}\);/);
});

test('the briefing module registers the opener, and the sheet never imports it', () => {
  assert.match(
    panel,
    /setSheetBriefingOpener\(\(selection\) => \{\s*openImpactPanel\(selection\.context\);\s*\}\);/
  );
  assert.doesNotMatch(sheet, /from '\.\/impact-panel(?:-runtime)?'/, 'no import cycle through the briefing facade');
  assert.match(sheet, /export function setSheetBriefingOpener\(/);
});

test('the glance replaces the kicker and the line only for a briefing that ranks a read', async () => {
  // The lazy runtime hands the markup over with the briefing; no briefing, no glance.
  assert.match(
    sheet,
    /export function setSheetBriefing\(briefing: ImpactBriefing \| null, glance = ''\): void \{/
  );
  assert.match(sheet, /sheetGlance = briefing \? glance : '';/);
  assert.match(sheet, /const glancing = briefing !== null && sheetGlance !== '';/);
  // The class the stylesheet keys the row's seat on is set from the same test.
  assert.match(sheet, /atHandBodyEl\.classList\.toggle\('has-glance', glancing\);\s*if \(glancing\) \{/);
  const css = await read('src/styles/briefing-lead.css');
  // Seen under the title; still read out after the kind (the document order is untouched).
  assert.match(css, /#sheet-at-hand-body\.has-glance \.sheet-glance-row \{\s*order: 1;\s*\}/);
  assert.match(css, /#sheet-at-hand-body\.has-glance \.sheet-at-hand-kind \{\s*order: 2;/);
  assert.match(sheet, /<h2 class="sheet-at-hand-title">\$\{escapeHtml\(title\)\}<\/h2>\s*\$\{kind \? `<p class="sheet-at-hand-kind">\$\{escapeHtml\(kind\)\}<\/p>` : ''\}\s*\$\{sheetGlance\}/);
  const runtime = strip(await read('src/ui/impact-panel-runtime.ts'));
  assert.equal([...runtime.matchAll(/setSheetBriefing\([^)]*renderLeadGlance\(/g)].length, 2);
  // The row raises the report and hands focus to its own tile there, by key.
  assert.match(
    sheet,
    /const key = row\?\.dataset\['glanceKey'\];\s*if \(!key\) return;\s*setSheetDetent\('full'\);/
  );
  assert.match(sheet, /node\.dataset\['leadKey'\] === key/);
});
