/**
 * The conditions strip's Hide hand-off (src/ui/island/strip-focus.ts).
 *
 * The Alerts and Fires tiles render only while their layer is on, so a
 * keyboard Hide unmounts the focused button. Desktop Brief's dock also hides
 * off tiles and collapses with its last live reading. These cases pin where
 * focus goes instead of the page body. Fake elements stand in for the DOM:
 * `rendered` is what getClientRects reports.
 *
 * It registers no Playwright tests: it runs under `node --test`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { stripFocusAfterHide } from '../src/ui/island/strip-focus.ts';

function el(name, { rendered = true, closest = {}, query = {} } = {}) {
  return {
    name,
    tabIndex: 0,
    parentElement: null,
    getClientRects: () => ({ length: rendered ? 1 : 0 }),
    closest: (sel) => closest[sel] ?? null,
    querySelector: (sel) => query[sel] ?? null
  };
}

function row(tiles) {
  const parent = { children: tiles };
  for (const t of tiles) t.parentElement = parent;
  return tiles;
}

test('the next rendered tile takes focus, skipping a hidden one', () => {
  const [, fires] = row([el('alerts'), el('fires'), el('drought', { rendered: false }), el('later')]);
  assert.equal(stripFocusAfterHide(fires)?.name, 'later');
});

test('with no rendered tile after it, the previous rendered tile takes focus', () => {
  const [alerts, fires] = row([el('alerts'), el('fires'), el('drought', { rendered: false })]);
  assert.equal(stripFocusAfterHide(fires)?.name, alerts.name);
});

// Not the Layer legends summary: hiding the last legend-bearing layer hides
// the whole disclosure, which would drop focus to the page body.
test('the last live reading in the Brief dock hands focus to the strip, not Layer legends', () => {
  const summary = el('legends-summary');
  const dock = el('dock', { query: { '.sidebar-legend-disclosure > summary': summary } });
  const strip = el('strip');
  const fires = el('fires', { closest: { '.sidebar-bottom-dock': dock, '#conditions-strip': strip } });
  row([fires, el('drought', { rendered: false })]);
  assert.equal(stripFocusAfterHide(fires)?.name, 'strip');
  assert.equal(strip.tabIndex, -1);
});

test('outside the dock, a lone tile hands focus to the strip, made focusable', () => {
  const strip = el('strip');
  const fires = el('fires', { closest: { '#conditions-strip': strip } });
  row([fires]);
  const target = stripFocusAfterHide(fires);
  assert.equal(target?.name, 'strip');
  assert.equal(strip.tabIndex, -1);
});
