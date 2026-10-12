import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRange } from '../workers/terrain/src/index.ts';

const SIZE = 1000;

test('a normal range returns its offset and length', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { offset: 0, length: 100 });
  assert.deepEqual(parseRange('bytes=900-5000', SIZE), { offset: 900, length: 100 });
});

test('a suffix range returns the last n bytes, clamped to the object', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { offset: 900, length: 100 });
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { offset: 0, length: SIZE });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=250-', SIZE), { offset: 250, length: 750 });
});

test('a missing header is no range', () => {
  assert.equal(parseRange(null, SIZE), null);
});

test('an unsatisfiable range is reported as such', () => {
  for (const header of ['bytes=1000-', 'bytes=2000-3000', 'bytes=50-10', 'bytes=-0']) {
    assert.equal(parseRange(header, SIZE), 'unsatisfiable', header);
  }
});

test('garbage and multi-range headers are unsatisfiable', () => {
  for (const header of ['', 'bytes=-', 'bytes=a-b', 'items=0-9', 'bytes=0-9,20-29', '0-9']) {
    assert.equal(parseRange(header, SIZE), 'unsatisfiable', header);
  }
});
