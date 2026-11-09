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
const { projectRelease, nearestDetent, rubberBand, trackVelocity } = await import(
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
