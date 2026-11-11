import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The shared settle spring and gesture arithmetic (owner direction
 * 2026-11-09 (sprint), DR-pending): src/util/spring.ts and
 * src/util/gesture.ts, and the motion tokens in src/styles/app.css that
 * mirror the spring.
 *
 * A surface that follows the hand must land where it says it lands. These
 * cases pin the closed-form spring (starts at 0, takes the release velocity,
 * settles on 1 inside its declared duration with under 1.5 percent
 * overshoot), the stylesheet's `--ease-spring` curve against the same
 * function, and the pure helpers a sheet uses to choose its detent.
 *
 * Runs under plain `node --test`: both modules are import-free.
 */

const ROOT = new URL('..', import.meta.url);
const {
  SETTLE_SPRING,
  SETTLE_DURATION_MS,
  springProgress,
  springSettleTime,
  springLinearEasing,
  runSpring
} = await import(new URL('src/util/spring.ts', ROOT).href);
const { projectRelease, nearestDetent, rubberBand, trackVelocity, attachDrag } = await import(
  new URL('src/util/gesture.ts', ROOT).href
);

const css = (await readFile(new URL('src/styles/app.css', ROOT), 'utf8')).replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

test('the spring starts at rest position 0 and settles on 1', () => {
  assert.equal(springProgress(0), 0);
  assert.equal(springProgress(-1), 0);
  assert.ok(Math.abs(springProgress(2) - 1) < 1e-6);
});

test('the settle spring barely overshoots and rests inside its declared duration', () => {
  let peak = 0;
  for (let t = 0; t <= 1.5; t += 0.001) peak = Math.max(peak, springProgress(t));
  assert.ok(peak < 1.015, `overshoot ${peak}`);
  const settle = springSettleTime();
  assert.ok(settle > 0.3 && settle <= SETTLE_DURATION_MS / 1000, `settle ${settle}s`);
  for (let t = SETTLE_DURATION_MS / 1000; t <= 2; t += 0.01) {
    assert.ok(Math.abs(springProgress(t) - 1) <= 0.001);
  }
});

test('the spring takes the release velocity as its opening slope', () => {
  const h = 1e-5;
  for (const v0 of [0, 2, 8, -3]) {
    const slope = (springProgress(h, v0) - springProgress(0, v0)) / h;
    assert.ok(Math.abs(slope - v0) < 0.02, `v0 ${v0} gave slope ${slope}`);
  }
  // A faster release is further along at the same moment.
  assert.ok(springProgress(0.05, 8) > springProgress(0.05, 0));
});

test('critically damped and overdamped springs settle without passing rest', () => {
  for (const config of [
    { stiffness: 400, damping: 40 },
    { stiffness: 400, damping: 80 }
  ]) {
    let peak = 0;
    for (let t = 0; t <= 3; t += 0.001) peak = Math.max(peak, springProgress(t, 0, config));
    assert.ok(peak <= 1 + 1e-9, `passed rest: ${peak}`);
    assert.ok(Math.abs(springProgress(3, 0, config) - 1) < 1e-3);
  }
});

test('the stylesheet motion tokens mirror the spring', () => {
  const declared = (property) => {
    const match = css.match(new RegExp(`${property}\\s*:\\s*([^;]+);`));
    assert.ok(match, `app.css does not declare ${property}`);
    return match[1].replace(/\s+/g, ' ').trim();
  };
  assert.equal(declared('--spring-stiffness'), String(SETTLE_SPRING.stiffness));
  assert.equal(declared('--spring-damping'), String(SETTLE_SPRING.damping));
  assert.equal(declared('--dur-settle'), `${SETTLE_DURATION_MS}ms`);
  const numbers = (value) =>
    value
      .replace(/^linear\(\s*/, '')
      .replace(/\s*\)$/, '')
      .split(',')
      .map((part) => Number(part.trim()));
  assert.deepEqual(numbers(declared('--ease-spring')), numbers(springLinearEasing(24)));
});

test('runSpring lands on the end value at once under reduced motion', () => {
  const seen = [];
  let rested = 0;
  runSpring({
    from: 120,
    to: 0,
    velocity: -900,
    reducedMotion: true,
    onUpdate: (value) => seen.push(value),
    onRest: () => {
      rested += 1;
    }
  });
  assert.deepEqual(seen, [0]);
  assert.equal(rested, 1);
});

test('a release projects forward by its velocity and snaps to the nearest detent', () => {
  assert.equal(projectRelease(300, 0), 300);
  assert.equal(projectRelease(300, 1000), 480);
  assert.equal(projectRelease(300, -1000, 0.1), 200);
  const detents = [0, 320, 640];
  // A slow drag settles where it was let go.
  assert.equal(nearestDetent(projectRelease(300, 40), detents), 320);
  // A short fast flick travels a full detent.
  assert.equal(nearestDetent(projectRelease(360, 1200), detents), 640);
  assert.equal(nearestDetent(projectRelease(300, -1200), detents), 0);
});

test('rubber-band resistance grows, keeps its sign and never exceeds the range', () => {
  let previous = 0;
  for (let overshoot = 1; overshoot <= 4000; overshoot += 37) {
    const moved = rubberBand(overshoot, 200);
    assert.ok(moved > previous && moved < 200 && moved < overshoot);
    previous = moved;
  }
  assert.equal(rubberBand(0, 200), 0);
  assert.equal(rubberBand(-80, 200), -rubberBand(80, 200));
  assert.equal(rubberBand(80, 0), 0);
});

test('release velocity reads only the last 100 ms, so a finger that stopped releases at rest', () => {
  const moving = [
    { t: 0, p: 0 },
    { t: 50, p: 50 },
    { t: 100, p: 100 }
  ];
  assert.equal(trackVelocity(moving, 100), 1000);
  const stopped = [...moving, { t: 400, p: 100 }, { t: 450, p: 100 }];
  assert.equal(trackVelocity(stopped, 450), 0);
  assert.equal(trackVelocity([{ t: 10, p: 4 }], 10), 0);
  assert.equal(trackVelocity([], 10), 0);
});

// ---------------------------------------------------------------------------
// The drag recognizer, driven with pointer events on a stand-in target.
// ---------------------------------------------------------------------------

/** The members of an element `attachDrag` uses: listeners and pointer capture. */
function dragTarget() {
  const listeners = new Map();
  const captured = new Set();
  return {
    captured,
    addEventListener(type, fn, options) {
      const key = type + (options === true ? ':capture' : '');
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    removeEventListener() {},
    setPointerCapture: (id) => captured.add(id),
    releasePointerCapture: (id) => captured.delete(id),
    hasPointerCapture: (id) => captured.has(id),
    fire(type, event) {
      for (const key of [`${type}:capture`, type]) for (const fn of listeners.get(key) ?? []) fn(event);
    }
  };
}

const pointer = (type, fields) => ({
  type,
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  buttons: 1,
  clientX: 100,
  clientY: 100,
  timeStamp: 0,
  cancelable: true,
  preventDefault() {},
  stopPropagation() {},
  ...fields
});

function recognizer() {
  globalThis.window ??= globalThis;
  const target = dragTarget();
  const log = [];
  attachDrag(target, {
    axis: 'y',
    canStart: () => true,
    onStart: () => log.push('start'),
    onMove: (sample) => log.push(`move ${sample.delta}`),
    onEnd: (sample, cancelled) => log.push(`end cancelled=${cancelled}`)
  });
  return { target, log };
}

test('an ordinary drag starts past the slop, follows the pointer and ends once', () => {
  const { target, log } = recognizer();
  target.fire('pointerdown', pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientY: 300 }));
  target.fire('pointermove', pointer('pointermove', { pointerId: 3, pointerType: 'touch', clientY: 304, timeStamp: 8 }));
  assert.deepEqual(log, [], 'under the 8 px slop nothing has started');
  target.fire('pointermove', pointer('pointermove', { pointerId: 3, pointerType: 'touch', clientY: 320, timeStamp: 16 }));
  target.fire('pointerup', pointer('pointerup', { pointerId: 3, pointerType: 'touch', clientY: 320, timeStamp: 32 }));
  assert.deepEqual(log, ['start', 'move 20', 'end cancelled=false']);
  assert.equal(target.captured.size, 0, 'the pointer is released at the end');
});

test('a mouse press released elsewhere does not turn a later hover into a drag', () => {
  const { target, log } = recognizer();
  target.fire('pointerdown', pointer('pointerdown', { clientY: 100 }));
  // Four pixels, under the slop, then the cursor leaves and the button is
  // released over the map: the target never hears the release.
  target.fire('pointermove', pointer('pointermove', { clientY: 104, timeStamp: 10 }));
  // Later the mouse hovers back across the target with no button down.
  target.fire('pointermove', pointer('pointermove', { clientY: 130, buttons: 0, timeStamp: 5000 }));
  target.fire('pointermove', pointer('pointermove', { clientY: 150, buttons: 0, timeStamp: 5016 }));
  assert.deepEqual(log, [], 'a hover moves nothing');
  assert.equal(target.captured.size, 0);
  // And the next real press still works.
  target.fire('pointerdown', pointer('pointerdown', { clientY: 200, timeStamp: 6000 }));
  target.fire('pointermove', pointer('pointermove', { clientY: 230, timeStamp: 6016 }));
  target.fire('pointerup', pointer('pointerup', { clientY: 230, timeStamp: 6032 }));
  assert.deepEqual(log, ['start', 'move 30', 'end cancelled=false']);
});

test('a touch whose release was never heard does not block the next touch', () => {
  const { target, log } = recognizer();
  target.fire('pointerdown', pointer('pointerdown', { pointerId: 7, pointerType: 'touch', clientY: 300 }));
  // No release for pointer 7 ever reaches the target. A new finger arrives.
  target.fire('pointerdown', pointer('pointerdown', { pointerId: 8, pointerType: 'touch', clientY: 300, timeStamp: 9000 }));
  target.fire('pointermove', pointer('pointermove', { pointerId: 8, pointerType: 'touch', clientY: 340, timeStamp: 9016 }));
  target.fire('pointerup', pointer('pointerup', { pointerId: 8, pointerType: 'touch', clientY: 340, timeStamp: 9032 }));
  assert.deepEqual(log, ['start', 'move 40', 'end cancelled=false']);
});

test('a second finger does not take over a drag that is under way', () => {
  const { target, log } = recognizer();
  target.fire('pointerdown', pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientY: 300 }));
  target.fire('pointermove', pointer('pointermove', { pointerId: 3, pointerType: 'touch', clientY: 330, timeStamp: 16 }));
  target.fire('pointerdown', pointer('pointerdown', { pointerId: 4, pointerType: 'touch', clientY: 500, timeStamp: 20 }));
  target.fire('pointermove', pointer('pointermove', { pointerId: 4, pointerType: 'touch', clientY: 560, timeStamp: 30 }));
  target.fire('pointermove', pointer('pointermove', { pointerId: 3, pointerType: 'touch', clientY: 350, timeStamp: 32 }));
  target.fire('pointerup', pointer('pointerup', { pointerId: 3, pointerType: 'touch', clientY: 350, timeStamp: 48 }));
  assert.deepEqual(log, ['start', 'move 30', 'move 50', 'end cancelled=false']);
});
