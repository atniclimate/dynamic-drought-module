import type { EnsoFlowKind } from '../state/enso-flow';
import { isObject } from '../util/guards';

export type ActiveFlowKind = Exclude<EnsoFlowKind, 'off'>;
export interface FlowPoint {
  readonly longitude: number;
  readonly latitude: number;
  /** Direction towards which water, wind or waves travel, degrees clockwise from north. */
  readonly bearing: number;
  readonly value: number;
}
export interface FlowFrame {
  readonly time: number;
  readonly points: readonly FlowPoint[];
  readonly missing: number;
  readonly total: number;
}

export const FLOW_VARIABLES: Record<ActiveFlowKind, readonly [string, string]> = {
  currents: ['ocean_current_velocity', 'ocean_current_direction'],
  wind: ['wind_speed_10m', 'wind_direction_10m'],
  waves: ['wave_height', 'wave_direction']
};

/** Validate the complete bounded response. Never join values from different valid times. */
export function parseFlowFrame(json: unknown, kind: ActiveFlowKind, expectedCount: number): FlowFrame {
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length !== expectedCount || expectedCount < 1 || expectedCount > 40) {
    throw new Error('The flow response has an unexpected location count.');
  }
  const [valueKey, directionKey] = FLOW_VARIABLES[kind];
  const points: FlowPoint[] = [];
  let time: number | null = null;
  let missing = 0;
  for (const row of rows) {
    if (!isObject(row) || !isObject(row.current) || !isObject(row.current_units)) {
      throw new Error('The flow response is missing its current data.');
    }
    const current = row.current;
    const units = row.current_units;
    const stamp = current.time;
    if (typeof stamp !== 'number' || !Number.isSafeInteger(stamp) || stamp <= 0 || units.time !== 'unixtime') {
      throw new Error('The flow response has no verified valid time.');
    }
    if (time !== null && time !== stamp * 1000) throw new Error('Flow valid times disagree.');
    time = stamp * 1000;
    const longitude = row.longitude;
    const latitude = row.latitude;
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
        typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
      throw new Error('The flow response has an invalid grid position.');
    }
    const value = current[valueKey];
    const direction = current[directionKey];
    // A masked marine cell stays absent. Null is never a zero velocity.
    if (value === null && direction === null) { missing += 1; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        typeof direction !== 'number' || !Number.isFinite(direction) || direction < 0 || direction > 360 ||
        units[directionKey] !== '°') throw new Error('The flow response has invalid values.');
    const unit = units[valueKey];
    const factor = kind === 'waves' ? (unit === 'm' ? 1 : null)
      : unit === 'm/s' ? 1 : unit === 'km/h' ? 1 / 3.6 : null;
    if (factor === null) throw new Error('The flow response has unexpected units.');
    // Wind and wave direction are FROM; ocean-current direction is TO.
    const bearing = (direction + (kind === 'currents' ? 0 : 180)) % 360;
    points.push({ longitude, latitude, bearing, value: value * factor });
  }
  if (time === null) throw new Error('The flow response is empty.');
  return { time, points, missing, total: rows.length };
}

export function normalizeFlowLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}
