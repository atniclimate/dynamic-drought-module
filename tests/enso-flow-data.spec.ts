import { expect, test } from '@playwright/test';
import { normalizeFlowLongitude, parseFlowFrame } from '../src/layers/enso-flow-data';
import { parseEnsoFlowParams, writeEnsoFlowParams } from '../src/state/enso-flow';

function row(values: Record<string, number | null>, units: Record<string, string>, time = 1789317900) {
  return { latitude: 0.041, longitude: -140.041,
    current: { time, interval: 900, ...values }, current_units: { time: 'unixtime', ...units } };
}

test('ocean-current TO and atmospheric/wave FROM bearings all become travel directions', () => {
  const currents = parseFlowFrame(row({ ocean_current_velocity: 3.6, ocean_current_direction: 90 },
    { ocean_current_velocity: 'km/h', ocean_current_direction: '°' }), 'currents', 1);
  const wind = parseFlowFrame(row({ wind_speed_10m: 6, wind_direction_10m: 90 },
    { wind_speed_10m: 'm/s', wind_direction_10m: '°' }), 'wind', 1);
  const waves = parseFlowFrame(row({ wave_height: 2, wave_direction: 180 },
    { wave_height: 'm', wave_direction: '°' }), 'waves', 1);
  expect(currents.points[0]).toMatchObject({ value: 1, bearing: 90 });
  expect(wind.points[0]).toMatchObject({ value: 6, bearing: 270 });
  expect(waves.points[0]).toMatchObject({ value: 2, bearing: 0 });
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
  const value = row({ wave_height: 2, wave_direction: 80 }, { wave_height: 'm', wave_direction: '°' });
  expect(() => parseFlowFrame([value, { ...value, current: { ...value.current, time: value.current.time + 900 } }], 'waves', 2)).toThrow(/times disagree/);
  expect(() => parseFlowFrame([value], 'waves', 40)).toThrow(/location count/);
  expect(() => parseFlowFrame({ ...value, longitude: 400 }, 'waves', 1)).toThrow(/grid position/);
  expect(() => parseFlowFrame({ ...value, current_units: { ...value.current_units, wave_height: 'ft' } }, 'waves', 1)).toThrow(/unexpected units/);
  expect(() => parseFlowFrame({ ...value, current: { ...value.current, wave_direction: null } }, 'waves', 1)).toThrow(/invalid values/);
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
