// Page-free tests moved from tests/studio-url-matrix.spec.ts so they run in the pure lane (npm run verify:pure).

import { expect, test } from './offline-test';

import { FRAMINGS, type FramingKey } from '../src/config/framings';
import { parseShellParams, parseStudioParam } from '../src/state/url';

const FRAMING = Object.keys(FRAMINGS)[0] as FramingKey;

test.describe('studio URL precedence matrix', () => {
  test('pure parsing keeps studio additive and shell precedence unchanged', () => {
    expect(parseStudioParam('layers')).toBe('layers');
    expect(parseStudioParam('place')).toBe('place');
    expect(parseStudioParam('invalid')).toBeNull();

    const granular = parseShellParams(
      new URLSearchParams(`framing=${encodeURIComponent(FRAMING)}&layers=places&cluster=enso&ocean=pacific`)
    );
    expect(granular.framing).toBe(FRAMING);
    expect(granular.cluster).toBe('drought');
    expect(granular.ocean).toBeNull();

    const enso = parseShellParams(new URLSearchParams('cluster=enso&ocean=pacific'));
    expect(enso.cluster).toBe('enso');
    expect(enso.ocean).toBe('pacific');
  });
});
