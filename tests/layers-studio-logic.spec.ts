// Page-free tests moved from layers-studio.spec.ts: they never open a page, so they run in the pure lane.
import { test, expect } from './offline-test';

import { parseStudioParam } from '../src/state/url';
import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';

test.describe('minimal LAYERS studio', () => {
  test('the route token and six status labels stay canonical', () => {
    expect(parseStudioParam('layers')).toBe('layers');
    expect(parseStudioParam('place')).toBe('place');
    expect(parseStudioParam(null)).toBeNull();
    expect(STATUS_PILL_TEXT.loading).toBe('loading...');
    expect(STATUS_PILL_TEXT.ready).toBe('live');
    expect(STATUS_PILL_TEXT.degraded).toBe('live (partial)');
    expect(STATUS_PILL_TEXT.error).toBe('unavailable');
    expect(STATUS_PILL_TEXT['no-data']).toBe('no data');
    expect(STATUS_PILL_TEXT['zoom-in']).toBe('zoom in to load');
  });
});
