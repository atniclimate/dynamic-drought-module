// Page-free tests moved from layers-studio-behavior.spec.ts: they never open a page, so they run in the pure lane.
import { expect, test } from './offline-test';

import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';

test.describe('LAYERS studio behavior', () => {
  test('the six-label mapping is explicit by status key', () => {
    expect(STATUS_PILL_TEXT.loading).toBe('loading...');
    expect(STATUS_PILL_TEXT.ready).toBe('live');
    expect(STATUS_PILL_TEXT.degraded).toBe('live (partial)');
    expect(STATUS_PILL_TEXT.error).toBe('unavailable');
    expect(STATUS_PILL_TEXT['no-data']).toBe('no data');
    expect(STATUS_PILL_TEXT['zoom-in']).toBe('zoom in to load');
  });
});
