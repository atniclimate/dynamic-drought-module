import { expect, test } from './offline-test';
import { FLOW_VARIABLES, normalizeFlowLongitude, parseFlowFrame } from '../src/layers/enso-flow-data';
import { parseEnsoFlowParams, writeEnsoFlowParams } from '../src/state/enso-flow';

function row(values: Record<string, number | null>, units: Record<string, string>, time = 1789317900) {
  return { latitude: 0.041, longitude: -140.041,
    current: { time, interval: 900, ...values }, current_units: { time: 'unixtime', ...units } };
}

test('ocean-current TO bearings are travel directions; wind and waves are no longer sampled (ENSO-FLOW-PLAN E2-1)', () => {
  const currents = parseFlowFrame(row({ ocean_current_velocity: 3.6, ocean_current_direction: 90 },
    { ocean_current_velocity: 'km/h', ocean_current_direction: '°' }), 'currents', 1);
  expect(currents.points[0]).toMatchObject({ value: 1, bearing: 90 });
  // Wind and waves read NOAA NODD through src/layers/flow/ (their FROM-to-TO
  // turn is flow/source.ts's, tests/flow-nodd.test.mjs); the sampler refuses them.
  expect(() => parseFlowFrame(row({ wind_speed_10m: 6, wind_direction_10m: 90 },
    { wind_speed_10m: 'm/s', wind_direction_10m: '°' }), 'wind' as never, 1)).toThrow(/Only ocean currents/);
  expect(() => parseFlowFrame(row({ wave_height: 2, wave_direction: 180 },
    { wave_height: 'm', wave_direction: '°' }), 'waves' as never, 1)).toThrow(/Only ocean currents/);
  expect(Object.keys(FLOW_VARIABLES)).toEqual(['currents']);
});

test('marine masks stay missing while a verified zero remains a real sample', () => {
  const units = { ocean_current_velocity: 'm/s', ocean_current_direction: '°' };
  const result = parseFlowFrame([
    row({ ocean_current_velocity: null, ocean_current_direction: null }, units),
    row({ ocean_current_velocity: 0, ocean_current_direction: 0 }, units)
  ], 'currents', 2);
  expect(result.missing).toBe(1);
  expect(result.points).toHaveLength(1);
  expect(result.points[0]?.value).toBe(0);
});

test('mixed valid times, wrong location counts, invalid coordinates and unexpected units fail closed', () => {
  const value = row({ ocean_current_velocity: 2, ocean_current_direction: 80 }, { ocean_current_velocity: 'm/s', ocean_current_direction: '°' });
  expect(() => parseFlowFrame([value, { ...value, current: { ...value.current, time: value.current.time + 900 } }], 'currents', 2)).toThrow(/times disagree/);
  expect(() => parseFlowFrame([value], 'currents', 40)).toThrow(/location count/);
  expect(() => parseFlowFrame({ ...value, longitude: 400 }, 'currents', 1)).toThrow(/grid position/);
  expect(() => parseFlowFrame({ ...value, current_units: { ...value.current_units, ocean_current_velocity: 'kn' } }, 'currents', 1)).toThrow(/unexpected units/);
  expect(() => parseFlowFrame({ ...value, current: { ...value.current, ocean_current_direction: null } }, 'currents', 1)).toThrow(/invalid values/);
});

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

test('sample longitude normalization remains continuous across world copies', () => {
  expect(normalizeFlowLongitude(181)).toBe(-179);
  expect(normalizeFlowLongitude(-541)).toBe(179);
  expect(normalizeFlowLongitude(540)).toBe(-180);
});
