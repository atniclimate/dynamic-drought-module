import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The phone sheet's stops (owner direction 2026-11-09 (sprint), DR-pending):
 * the pure landing rules in src/config/sheet-detents.ts and their mirror in
 * src/styles/mobile-panels.css.
 *
 * A sheet that follows the hand must land where a person expects. These
 * cases pin the rules without a browser: stops stay in order whatever the
 * measured heights, a slow drag settles on the nearest stop, a flick can
 * travel a stop, a flick from half or full never throws the sheet off
 * screen, a drag below peek closes it, the grabber's keys step one stop at
 * a time, and the map furniture riding the sheet's top edge never ends up
 * under it below the half stop. The release cases compose the rules with
 * `projectRelease` and `nearestDetent` exactly as src/ui/sheet-motion.ts
 * does.
 *
 * Runs under plain `node --test`: both modules are import-free.
 */

const ROOT = new URL('..', import.meta.url);
const {
  SHEET_OPEN_STOPS,
  SHEET_TOKENS,
  drawerOffsets,
  releaseStops,
  riderLift,
  sheetOffsets,
  stepStop
} = await import(new URL('src/config/sheet-detents.ts', ROOT).href);
const { projectRelease, nearestDetent } = await import(new URL('src/util/gesture.ts', ROOT).href);

const css = (await readFile(new URL('src/styles/mobile-panels.css', ROOT), 'utf8')).replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);
const motion = await readFile(new URL('src/ui/sheet-motion.ts', ROOT), 'utf8');

/** A 390 by 844 phone: full ends 76 px from the top, half is half the screen. */
const PHONE = sheetOffsets({ peek: 136, half: 422, full: 768 });

/** Where a release lands, composed the way the motion module composes it. */
function land(form, start, offset, velocity, offsets) {
  const stops = releaseStops(form, start, offset, offsets);
  const landing = nearestDetent(projectRelease(offset, velocity), stops.map((stop) => offsets[stop]));
  return stops.find((stop) => offsets[stop] === landing);
}

test('the stylesheet declares the numbers the rules mirror', () => {
  assert.match(css, new RegExp(`--sheet-head-h:\\s*${SHEET_TOKENS.head}px`));
  assert.match(css, new RegExp(`--sheet-h-peek:\\s*calc\\(${SHEET_TOKENS.peek}px \\+ env\\(safe-area-inset-bottom`));
  assert.match(css, new RegExp(`calc\\(var\\(--sheet-h-peek\\) \\+ ${SHEET_TOKENS.halfStep}px\\)`));
  assert.match(css, new RegExp(`--sheet-rider-gap:\\s*${SHEET_TOKENS.riderGap}px`));
  for (const name of ['--sheet-h-peek', '--sheet-h-half', '--sheet-h-full']) {
    assert.ok(css.includes(`${name}:`), `${name} is declared`);
  }
  // Every open stop is one full-screen window (owner, 2026-11-13): the
  // motion module measures that one height by name through its probe.
  assert.ok(motion.includes('var(--sheet-h-full)'), '--sheet-h-full is measured');
  assert.match(css, /--sheet-h-full:\s*100dvh;/);
  // The glass runs further below the edge than a spring or a finger can lift it.
  const below = /inset:\s*0 0 -(\d+)px/.exec(css);
  assert.ok(below && Number(below[1]) > SHEET_TOKENS.rubber, 'the plate extends past the rubber band');
});

test('every phone window opens full screen, with a "Back to map" that needs no chunk', async () => {
  const text = async (path) => (await readFile(new URL(path, ROOT), 'utf8')).replace(/\r\n/g, '\n');
  const html = await text('index.html');
  const controller = await text('src/ui/mobile-sheet.ts');
  const panel = await text('src/ui/impact-panel.ts');
  // The way back is static markup in the header row, wired by the eager controller.
  assert.match(html, /<div class="sheet-grabber-row">\s*<button type="button" id="sheet-close" class="sheet-close">Back to map<\/button>\s*<\/div>/);
  assert.match(controller, /getElementById\('sheet-close'\)\?\.addEventListener\('click', \(\) => \{\s*setSheetDetent\('closed'\);/);
  assert.doesNotMatch(motion, /sheet-close|sheet-grabber'|attachDrag/, 'the lazy chunk builds no way back and no drag');
  // Every door, the report and the camera treat the window as the whole screen.
  assert.match(controller, /const target: SheetDetent = 'full';/);
  assert.match(controller, /export function sheetCameraInset\(\): number \{\s*return 0;\s*\}/);
  assert.match(panel, /setSheetDetent\('full'\);/);
  assert.doesNotMatch(panel, /setSheetDetent\('half'\)/);
  // What the window covers leaves the tab order while it is open, before any focus moves.
  assert.match(controller, /for \(const id of \['map-container', 'edge-column'\]\)/);
  assert.match(controller, /detent = next;\s*\/\/[^\n]*\n\s*coverMap\(next !== 'closed'\);/);
  // Open, the window is the screen and sits over the edge column (z-sheet + 60);
  // its side padding keeps Back and the content clear of a notch on a phone on its side.
  assert.match(
    css,
    /#app\[data-sheet-detent\]:not\(\[data-sheet-detent='closed'\]\) \.sidebar \{\s*top: 0;\s*left: 0;\s*right: 0;\s*height: auto;\s*padding-left: env\(safe-area-inset-left, 0px\);\s*padding-right: env\(safe-area-inset-right, 0px\);\s*z-index: calc\(var\(--z-sheet\) \+ 100\);/
  );
  // The report's own Back is not drawn in the window; the window's is the one way back.
  assert.match(css, /#app\[data-sheet-detent\] #sheet-report \.impact-panel-close \{\s*display: none;/);
  assert.match(css, /#app\[data-sheet-detent\] \.sheet-close \{[^}]*min-height: var\(--touch-target\);/);
  // The pill keeps the shared hover and focus face its id-scoped colours would otherwise outrank.
  assert.match(css, /#app\[data-sheet-detent\] \.sheet-close:hover,\s*#app\[data-sheet-detent\] \.sheet-close:focus-visible \{\s*border-color: var\(--accent-strong\);/);
});

test('stops keep their order whatever heights are measured', () => {
  assert.deepEqual(PHONE, { full: 0, half: 346, peek: 632, closed: 768 });
  for (const heights of [
    { peek: 136, half: 100, full: 300 },
    { peek: 400, half: 200, full: 300 },
    { peek: 136, half: 500, full: 300 },
    { peek: 0, half: 0, full: 0 },
    { peek: -5, half: 50, full: -1 }
  ]) {
    const o = sheetOffsets(heights);
    assert.equal(o.full, 0);
    assert.ok(o.full <= o.half && o.half <= o.peek && o.peek <= o.closed, JSON.stringify(o));
  }
  assert.deepEqual(drawerOffsets(360), { full: 0, half: 0, peek: 0, closed: 360 });
});

test('a slow release settles on the nearest stop', () => {
  assert.equal(land('sheet', 'half', 300, 0, PHONE), 'half');
  assert.equal(land('sheet', 'half', 120, 0, PHONE), 'full');
  assert.equal(land('sheet', 'half', 520, 0, PHONE), 'peek');
  assert.equal(land('sheet', 'full', 30, 0, PHONE), 'full');
});

test('a short fast flick travels a stop, and a hard one may skip one', () => {
  // 20 px of travel at 1200 px/s carries about 216 px further.
  assert.equal(land('sheet', 'peek', PHONE.peek - 20, -1200, PHONE), 'half');
  assert.equal(land('sheet', 'half', PHONE.half + 20, 1200, PHONE), 'peek');
  assert.equal(land('sheet', 'peek', PHONE.peek - 20, -3500, PHONE), 'full');
});

test('a flick from half or full lowers the sheet and never throws it away', () => {
  for (const velocity of [800, 2000, 5000, 20000]) {
    assert.notEqual(land('sheet', 'full', 10, velocity, PHONE), 'closed', `full at ${velocity}`);
    assert.notEqual(land('sheet', 'half', PHONE.half + 10, velocity, PHONE), 'closed', `half at ${velocity}`);
  }
  assert.equal(land('sheet', 'full', 10, 20000, PHONE), 'peek');
});

test('a flick down from peek, or a drag well below it, closes the sheet', () => {
  assert.equal(land('sheet', 'peek', PHONE.peek + 10, 900, PHONE), 'closed');
  // A slow drag from half that ends most of the way below peek.
  assert.equal(land('sheet', 'half', PHONE.peek + 90, 0, PHONE), 'closed');
  // The same drag let go just under peek returns to peek.
  assert.equal(land('sheet', 'half', PHONE.peek + 30, 0, PHONE), 'peek');
  // A tap-sized wobble at peek does not close it.
  assert.equal(land('sheet', 'peek', PHONE.peek + 6, 0, PHONE), 'peek');
});

test('a drawer has one open seat and closes on a leftward release', () => {
  const drawer = drawerOffsets(360);
  assert.deepEqual(releaseStops('drawer', 'full', 0, drawer), ['full', 'closed']);
  assert.equal(land('drawer', 'half', 40, 0, drawer), 'half');
  assert.equal(land('drawer', 'half', 200, 0, drawer), 'closed');
  assert.equal(land('drawer', 'full', 30, 1500, drawer), 'closed');
  assert.equal(land('drawer', 'full', 120, -900, drawer), 'full');
});

test('the grabber steps one stop at a time and never closes the sheet', () => {
  assert.deepEqual(SHEET_OPEN_STOPS, ['peek', 'half', 'full']);
  assert.deepEqual(['peek', 'half', 'full'].map((stop) => stepStop(stop, 'next')), ['half', 'full', 'peek']);
  assert.deepEqual(['peek', 'half', 'full'].map((stop) => stepStop(stop, 'up')), ['half', 'full', 'full']);
  assert.deepEqual(['peek', 'half', 'full'].map((stop) => stepStop(stop, 'down')), ['peek', 'peek', 'half']);
  for (const step of ['next', 'up', 'down']) {
    assert.equal(stepStop('closed', step), 'closed');
    for (const stop of SHEET_OPEN_STOPS) assert.notEqual(stepStop(stop, step), 'closed');
  }
});

test('map furniture rides the top edge up to half and is never under the glass below it', () => {
  const half = 422;
  // Closed: its own seat (the bottom safe area).
  assert.equal(riderLift(0, half, 0), 0);
  assert.equal(riderLift(0, half, 34), 34);
  // At rest on peek and half it sits the gap above the edge, as the stylesheet seats it.
  assert.equal(riderLift(136, half, 0), 136 + SHEET_TOKENS.riderGap);
  assert.equal(riderLift(half, half, 0), half + SHEET_TOKENS.riderGap);
  // Above half it waits where it was: the sheet covers it, as it covers the map.
  assert.equal(riderLift(768, half, 0), half + SHEET_TOKENS.riderGap);
  // Continuous from closed, never below the edge, never below its own seat.
  let previous = riderLift(0, half, 34);
  for (let visible = 1; visible <= half; visible += 1) {
    const lift = riderLift(visible, half, 34);
    assert.ok(lift >= Math.min(visible, half), `under the glass at ${visible}`);
    assert.ok(lift >= 34 && lift - previous <= 2 && lift >= previous, `jump at ${visible}`);
    previous = lift;
  }
});
