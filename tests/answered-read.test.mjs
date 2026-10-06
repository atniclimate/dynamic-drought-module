import assert from 'node:assert/strict';
import test from 'node:test';
import { untilAnswered } from './answered-read.ts';

function controlledClock(sleepExtra = 0) {
  let elapsed = 0;
  const sleeps = [];
  return {
    now: () => elapsed,
    advance: (ms) => { elapsed += ms; },
    sleep: async (ms) => { sleeps.push(ms); elapsed += ms + sleepExtra; },
    sleeps
  };
}

test('a blocked read spends only the existing 1 s charge, then a later answer can pass', async () => {
  const clock = controlledClock();
  let reads = 0;
  const result = await untilAnswered(async () => {
    clock.advance(++reads === 1 ? 8_000 : 300);
    return reads === 1 ? null : 'ready';
  }, (value) => value === 'ready', 3_000, 'blocked probe', clock);
  assert.equal(result, 'ready');
  assert.equal(reads, 2);
  assert.equal(clock.now(), 8_550);
});

test('a responsive never-ready page fails at its unchanged budget', async () => {
  const clock = controlledClock();
  await assert.rejects(
    untilAnswered(async () => 'loading', (value) => value === 'ready', 2_000, 'responsive probe', clock),
    /responsive probe: still "loading" after 2000 ms of answered reads \(2000 ms on the clock; longest read 0 ms\)/
  );
  assert.equal(clock.now(), 2_000);
});

test('a blocked read cannot turn a permanently loading page into success', async () => {
  const clock = controlledClock();
  let reads = 0;
  await assert.rejects(untilAnswered(async () => {
    if (++reads === 1) clock.advance(5_000);
    return 'loading';
  }, (value) => value === 'ready', 2_000, 'never ready', clock),
  /never ready: still "loading" after 2000 ms of answered reads \(6000 ms on the clock; longest read 5000 ms\)/);
  assert.equal(clock.now(), 6_000);
});

test('the final pause is clamped and no new read starts at the deadline', async () => {
  const clock = controlledClock();
  let reads = 0;
  await assert.rejects(untilAnswered(async () => {
    reads += 1;
    return reads > 2 ? 'ready' : 'loading';
  }, (value) => value === 'ready', 400, 'short budget', clock), /short budget: still "loading" after 400 ms/);
  assert.equal(reads, 2);
  assert.deepEqual(clock.sleeps, [250, 150]);
});

test('the full Node pause is charged and late success after that pause cannot pass', async () => {
  const clock = controlledClock(1_000);
  let reads = 0;
  await assert.rejects(untilAnswered(async () => ++reads === 1 ? null : 'ready',
    (value) => value === 'ready', 1_000, 'late pause', clock), /late pause: still null after 1250 ms/);
  assert.equal(reads, 1);
});

test('a responsive read returning success after the remaining budget cannot pass', async () => {
  const clock = controlledClock();
  let reads = 0;
  await assert.rejects(untilAnswered(async () => {
    clock.advance(600);
    return ++reads === 3 ? 'ready' : 'loading';
  }, (value) => value === 'ready', 2_000, 'late answer', clock), /late answer: still "ready" after 2300 ms/);
  assert.equal(clock.now(), 2_300);
});

test('a page exception is preserved by identity and is never retried', async () => {
  const clock = controlledClock();
  const error = new Error('Execution context was destroyed');
  let reads = 0;
  await assert.rejects(untilAnswered(async () => { reads += 1; throw error; },
    () => true, 1_000, 'page read', clock), (caught) => caught === error);
  assert.equal(reads, 1);
  assert.deepEqual(clock.sleeps, []);
});
