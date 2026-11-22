// Moved from tests/s4-minimap.spec.ts: this test never opens a page, so it runs in the pure lane (verify:pure).
import { test, expect } from './offline-test';
import { FRAMINGS, framingFitBounds } from '../src/config/framings';

test('the Alaska framing camera includes the wrapped western Aleutians', () => {
  const [[west], [east]] = framingFitBounds(FRAMINGS['alaska-northwest']);
  expect(west).toBeLessThanOrEqual(172);
  expect(east).toBeGreaterThanOrEqual(237);
});
