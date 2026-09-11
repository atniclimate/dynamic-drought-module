/**
 * The PLACE studio exit hand-off (src/state/place-return.ts).
 *
 * Two callers queue work to run once the studio has unmounted and the
 * captured display is restored: the studio queues the BRIEFING of its
 * selected place, and the shell queues a sidebar DISPLAY COMMAND (a cluster
 * or horizon chosen while the studio was open). They shared one slot until
 * 2026-09-10, so a hazard click after a selection dropped the promised
 * briefing. These cases pin the two-slot contract: neither registration
 * wipes the other, each slot keeps "newest wins", the composed take runs the
 * display command before the briefing, and the studio-to-studio exit voids
 * both. The browser-level proof of the same regression is the
 * "sidebar hazard after a selection" case in tests/place-studio-brief.spec.ts.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `*.test.mjs` files, wired into `check:all`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearPlaceReturn,
  setPlaceReturnBriefing,
  setPlaceReturnDisplayCommand,
  takePlaceReturn
} from '../src/state/place-return.ts';

test.beforeEach(() => {
  clearPlaceReturn();
});

test('nothing queued takes null', () => {
  assert.equal(takePlaceReturn(), null);
});

test('a briefing alone runs alone, and take clears it', () => {
  const ran = [];
  setPlaceReturnBriefing(() => ran.push('brief'));
  const action = takePlaceReturn();
  assert.notEqual(action, null);
  action();
  assert.deepEqual(ran, ['brief']);
  assert.equal(takePlaceReturn(), null);
});

test('a display command queued after a briefing does not drop the briefing (the 2026-09-10 regression)', () => {
  const ran = [];
  // The studio registers the briefing of the selected place first...
  setPlaceReturnBriefing(() => ran.push('brief'));
  // ...then the user clicks Wildfire in the sidebar (shell runDisplayCommand).
  setPlaceReturnDisplayCommand(() => ran.push('wildfire'));

  takePlaceReturn()();

  // Both run, the display command first so the briefing opens over the
  // display that stands.
  assert.deepEqual(ran, ['wildfire', 'brief']);
});

test('a briefing registered after a display command does not drop the command', () => {
  const ran = [];
  // Click Wildfire first (history.back() is asynchronous), then the
  // studio's in-flight resolution completes and re-registers the briefing.
  setPlaceReturnDisplayCommand(() => ran.push('wildfire'));
  setPlaceReturnBriefing(() => ran.push('brief'));

  takePlaceReturn()();

  assert.deepEqual(ran, ['wildfire', 'brief']);
});

test('the studio clearing its briefing (a selection change) leaves the display command', () => {
  const ran = [];
  setPlaceReturnDisplayCommand(() => ran.push('wildfire'));
  setPlaceReturnBriefing(() => ran.push('stale brief'));
  setPlaceReturnBriefing(null);

  takePlaceReturn()();

  assert.deepEqual(ran, ['wildfire']);
});

test('newest wins inside each slot', () => {
  const ran = [];
  setPlaceReturnBriefing(() => ran.push('brief Oregon'));
  setPlaceReturnBriefing(() => ran.push('brief Washington'));
  setPlaceReturnDisplayCommand(() => ran.push('wildfire'));
  setPlaceReturnDisplayCommand(() => ran.push('drought'));

  takePlaceReturn()();

  assert.deepEqual(ran, ['drought', 'brief Washington']);
});

test('the studio-to-studio exit voids both hand-offs', () => {
  setPlaceReturnBriefing(() => {
    throw new Error('briefing must not run');
  });
  setPlaceReturnDisplayCommand(() => {
    throw new Error('display command must not run');
  });
  clearPlaceReturn();
  assert.equal(takePlaceReturn(), null);
});

test('take clears both slots so a second exit runs nothing twice', () => {
  const ran = [];
  setPlaceReturnBriefing(() => ran.push('brief'));
  setPlaceReturnDisplayCommand(() => ran.push('wildfire'));
  takePlaceReturn()();
  assert.equal(takePlaceReturn(), null);
  assert.deepEqual(ran, ['wildfire', 'brief']);
});
