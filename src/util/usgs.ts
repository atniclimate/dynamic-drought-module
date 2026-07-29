/**
 * United States Geological Survey (USGS) Water Services Instantaneous
 * Values (IV) fetch and parse, shared by the telemetry popup hydration and
 * the sidebar station-value hydration. Hoisted from `src/ui/popups.ts`
 * when the sidebar became the second consumer (the two-consumer rule in
 * the ddm-agency-data skill).
 *
 * Source: `URLS.usgsIV`. The endpoint has served the browser directly
 * since the v0.1.x vanilla baseline; no proxy is involved.
 *
 * Load-bearing caveats, handled here:
 *   - "No reading" is the literal string `'-999999'` on the value field,
 *     never null; those readings are dropped.
 *   - The payload nests series at `payload.value.timeSeries[i]`; every
 *     step of that walk is type-narrowed because the upstream JSON arrives
 *     as `unknown`. The parse boundary lives here, in one place.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from './fetch';
import { isObject } from './guards';
import type { StationValue, TelemetryFreshness } from '../types/station';

/** The vanilla-baseline timeout (8 seconds), carried over verbatim. */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Freshness window for an instantaneous reading. IV sites post every 15
 * to 60 minutes with some transmission lag; the tier-2 hourly window
 * (6 hours, matching the CWMS hourly series) is the honest cutoff.
 */
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface UsgsReading {
  readonly value: string;
  readonly dateTime?: string;
}

export type UsgsSeries = Record<string, unknown>;

/**
 * Pull the most recent instantaneous values for discharge (parameter code
 * 00060) and gage height (00065) from USGS Water Services. The optional
 * `signal` is the caller's AbortController (popup-close or telemetry
 * layer-off cancels the in-flight fetch).
 *
 * Returns the raw JSON payload as `unknown`; the guards below do the
 * structural validation.
 */
export async function fetchUsgsIV(
  siteId: string,
  signal: AbortSignal | null
): Promise<unknown> {
  const params = new URLSearchParams({
    format: 'json',
    sites: siteId,
    parameterCd: '00060,00065',
    // A 7-day window so the popup can draw a recent-trend sparkline, not just
    // the latest reading. The most recent value is still the series tail.
    period: 'P7D',
    siteStatus: 'all'
  });
  const resp = await fetchWithBudget(
    URLS.usgsIV + '?' + params.toString(),
    {},
    signal,
    FETCH_TIMEOUT_MS
  );
  if (!resp.ok) throw new Error('USGS HTTP ' + resp.status);
  return resp.json();
}

/* ---------------------------------------------------------------------------
 * Defensive type guards over the USGS IV JSON shape. Each helper takes the
 * `unknown` payload (or a node from it) and returns either a typed value or
 * a sensible empty default.
 * ------------------------------------------------------------------------- */

export function extractTimeSeries(payload: unknown): UsgsSeries[] {
  if (!isObject(payload)) return [];
  const value = payload.value;
  if (!isObject(value)) return [];
  const ts = value.timeSeries;
  if (!Array.isArray(ts)) return [];
  return ts.filter(isObject) as UsgsSeries[];
}

export function readVariableCode(series: UsgsSeries): string | null {
  const variable = series.variable;
  if (!isObject(variable)) return null;
  const codes = variable.variableCode;
  if (!Array.isArray(codes) || codes.length === 0) return null;
  const first = codes[0];
  if (!isObject(first)) return null;
  const v = first.value;
  return typeof v === 'string' ? v : null;
}

export function readUnitCode(series: UsgsSeries): string | null {
  const variable = series.variable;
  if (!isObject(variable)) return null;
  const unit = variable.unit;
  if (!isObject(unit)) return null;
  const code = unit.unitCode;
  return typeof code === 'string' ? code : null;
}

export function readVariableName(series: UsgsSeries): string | null {
  const variable = series.variable;
  if (!isObject(variable)) return null;
  const name = variable.variableName;
  return typeof name === 'string' ? name : null;
}

export function readValueArray(series: UsgsSeries): UsgsReading[] {
  const values = series.values;
  if (!Array.isArray(values) || values.length === 0) return [];
  const first = values[0];
  if (!isObject(first)) return [];
  const arr = first.value;
  if (!Array.isArray(arr)) return [];

  const out: UsgsReading[] = [];
  for (const r of arr) {
    if (!isObject(r)) continue;
    const v = r.value;
    if (typeof v !== 'string') continue;
    const dt = r.dateTime;
    if (typeof dt === 'string') {
      out.push({ value: v, dateTime: dt });
    } else {
      out.push({ value: v });
    }
  }
  return out;
}

/** Freshness for an instantaneous reading: within 6 hours is fresh. */
export function ivFreshness(timestampIso: string): TelemetryFreshness {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) return 'stale';
  return Date.now() - t <= FRESH_WINDOW_MS ? 'fresh' : 'stale';
}

/**
 * Normalize the latest IV reading to the canonical StationValue: discharge
 * (00060) preferred, then gage height (00065), then any series with a real
 * reading. Walks each series from the tail so a trailing sentinel does not
 * mask an earlier real value. Null when no series carries a reading.
 */
export function usgsLatestStationValue(
  stationId: string,
  payload: unknown
): StationValue | null {
  const series = extractTimeSeries(payload);
  const ranked = [
    series.find((s) => readVariableCode(s) === '00060'),
    series.find((s) => readVariableCode(s) === '00065'),
    ...series
  ];
  for (const s of ranked) {
    if (!s) continue;
    const values = readValueArray(s);
    for (let i = values.length - 1; i >= 0; i--) {
      const r = values[i];
      if (!r || r.value === '-999999') continue;
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;

      const code = readVariableCode(s);
      const label =
        code === '00060'
          ? 'Discharge'
          : code === '00065'
            ? 'Gage height'
            : readVariableName(s) || 'Value';
      const parameter =
        code === '00060'
          ? 'discharge_cfs'
          : code === '00065'
            ? 'gage_height_ft'
            : 'usgs_iv';
      const timestamp = typeof r.dateTime === 'string' ? r.dateTime : '';

      return {
        stationId,
        parameter,
        label,
        value: Math.round(n * 100) / 100,
        unit: readUnitCode(s) ?? '',
        timestamp,
        freshness: timestamp ? ivFreshness(timestamp) : 'stale',
        source: 'usgs-iv'
      };
    }
  }
  return null;
}
