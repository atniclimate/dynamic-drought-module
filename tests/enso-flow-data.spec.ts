import { expect, test } from './offline-test';
import { gridBoxWords } from '../src/layers/enso-flow-data';
import { parseEnsoFlowParams, writeEnsoFlowParams } from '../src/state/enso-flow';

test('ENSO preferences preserve unrelated URL state and reject duplicate or unknown values', () => {
  const params = new URLSearchParams('embed=true&sst=2026-09-07&flow=waves&flowink=dark');
  expect(parseEnsoFlowParams(params)).toEqual({ kind: 'waves', ink: 'dark' });
  writeEnsoFlowParams(params, { kind: 'wind', ink: 'light' });
  expect(params.get('embed')).toBe('true');
  expect(params.get('sst')).toBe('2026-09-07');
  expect(params.get('flow')).toBe('wind');
  expect(params.has('flowink')).toBe(false);
  expect(parseEnsoFlowParams(new URLSearchParams('flow=wind&flow=waves&flowink=rainbow'))).toEqual({ kind: 'off', ink: 'light' });
  writeEnsoFlowParams(params, { kind: 'off', ink: 'dark' });
  expect(params.has('flow')).toBe(false);
});

test('a regional grid box is worded from its own nodes, continuous across the antimeridian', () => {
  // The currents frame's tropical grid (src/layers/flow/currents.ts): 120 columns east of 130 E end at 111 W.
  expect(gridBoxWords({ lon0: 130, lat0: 39, dlon: 1, dlat: 1, nx: 120, ny: 80 })).toBe('40 S to 39 N and 130 E to 111 W');
  expect(gridBoxWords({ lon0: -200, lat0: 0, dlon: 10, dlat: 5, nx: 5, ny: 3 })).toBe('10 S to 0 N and 160 E to 160 W');
});
