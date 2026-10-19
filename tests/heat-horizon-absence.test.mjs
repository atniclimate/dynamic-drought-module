import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Extreme Heat's Near Term and Long Range chips are off by design, not by a
 * bug: Near Term repeats Current's one HeatRisk surface and Long Range has
 * no verified source. This pins both facts (so a later source admission
 * flips the test, not the copy by accident) and the chip's reason and the
 * all-zero statement that carry the reason in plain words.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { horizonSurfaceSignature } = await import('../src/state/timeline.ts');
const { TEMPORAL_HORIZON_KEYS } = await import('../src/config/clusters.ts');

const shellSource = readFileSync(
  new URL('../src/ui/island/shell.tsx', import.meta.url),
  'utf8'
);
const sequenceSource = readFileSync(
  new URL('../src/ui/heatrisk-sequence.ts', import.meta.url),
  'utf8'
);

test('heat: the first horizon has a surface, the other two are off for stated reasons', () => {
  const [first, ...others] = TEMPORAL_HORIZON_KEYS;
  const base = horizonSurfaceSignature('heat', first);
  assert.notEqual(base, null);
  const outcomes = others.map((key) => {
    const signature = horizonSurfaceSignature('heat', key);
    return signature === null ? 'no-source' : signature === base ? 'same-surface' : 'distinct';
  });
  assert.deepEqual(outcomes.sort(), ['no-source', 'same-surface']);
});

test('the shell carries the disabled-chip reasons on the chip; the visible text reads in Technical information', () => {
  assert.doesNotMatch(shellSource, /id="shell-horizon-note"/);
  assert.match(shellSource, /horizonDisabledReason\(snapshot, key\)/);
  assert.match(shellSource, /title=\{disabledReason \?\? undefined\}/);
});

test('the sequence states an all-zero week only when every day was read as 0', () => {
  assert.match(sequenceSource, /values\.length > 0 && values\.every\(\(value\) => value === 0\)/);
  assert.match(sequenceSource, /data-heatrisk-no-elevated/);
});

test('the all-zero line is a sentence', () => {
  assert.match(sequenceSource, /<strong>No elevated heat risk<\/strong> at this point on any of the seven days\./);
});

test('the all-zero line is read before the day cells, under the heading', () => {
  const heading = sequenceSource.indexOf('class="heatrisk-sequence-heading"');
  const line = sequenceSource.indexOf('data-heatrisk-no-elevated');
  const grid = sequenceSource.indexOf('class="heatrisk-sequence-grid"');
  assert.ok(heading < line && line < grid);
});

test('a superseded read never lands on unavailable; a current failed read still does', async () => {
  const { readFailureIsSuperseded } = await import('../src/ui/heatrisk-sequence.ts');
  assert.equal(readFailureIsSuperseded(true, 'k1', 'k1'), true, 'aborted controller');
  assert.equal(readFailureIsSuperseded(false, 'k1', 'k2'), true, 'a newer point or frame set owns the panel');
  assert.equal(readFailureIsSuperseded(false, 'k1', null), true, 'selection cleared');
  assert.equal(readFailureIsSuperseded(false, 'k1', 'k1'), false, 'a current read that failed is unavailable');
});
