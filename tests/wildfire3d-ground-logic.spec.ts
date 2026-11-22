// Moved from tests/wildfire3d-ground.spec.ts: this test never opens a page, so it runs in the pure lane (verify:pure).
import { expect, test } from './offline-test';
import {
  rgWeekLine,
  starCurrentWeek,
  starPreviousWeek,
  starWeekLine
} from '../src/layers/wildfire-dryness';

test('STAR weeks follow the issuer\'s 1-to-52 rule and the key states each week as dates (owner direction 2026-10-09)', () => {
  const at = (day: string) => new Date(`${day}T12:00:00Z`);
  expect(starCurrentWeek(at('2026-10-09'))).toBe('2026040');
  expect(starCurrentWeek(at('2026-01-05'))).toBe('2025052');
  expect(starCurrentWeek(at('2026-01-08'))).toBe('2026001');
  expect(starCurrentWeek(at('2026-12-31'))).toBe('2026052');
  expect(starPreviousWeek('2026001')).toBe('2025052');
  expect(starWeekLine('2026038')).toBe('Week 38: Sep 17 to Sep 23, 2026');
  expect(starWeekLine('2026052')).toBe('Week 52: Dec 24 to Dec 30, 2026');
  expect(starWeekLine('2024052')).toBe('Week 52: Dec 23 to Dec 29, 2024');
  expect(rgWeekLine('2026-09-28T00:00:00.000Z')).toBe('Week of Sep 28 to Oct 4, 2026');
  expect(rgWeekLine('2025-12-29T00:00:00.000Z')).toBe('Week of Dec 29, 2025 to Jan 4, 2026');
});
