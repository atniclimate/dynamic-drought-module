/**
 * USACE Corps Water Management System (CWMS) Data API fetch, shared by the
 * telemetry popup hydration and the sidebar station-value hydration.
 *
 * Source: `URLS.usaceCwmsData` (scout-proposed, verifier-confirmed
 * 2026-07-01). The host serves a genuine wildcard
 * `Access-Control-Allow-Origin: *`, so the DIRECT fetch is the route; the
 * Worker remains a verified resilience path but is not wired here because
 * the direct route needs a custom `Accept` header that the Worker forwards
 * anyway if ever needed.
 *
 * Load-bearing caveats from verification, handled here:
 *   - Every request needs `Accept: application/json;version=2`.
 *   - A wrong timeseries id returns HTTP 200 with an EMPTY values array,
 *     not an error; 200-with-empty triggers one catalog-discovery retry
 *     (`/catalog/TIMESERIES?office=<office>&like=<pattern>`) before giving
 *     up, per the verifier's discovery doctrine.
 *   - Units vary per series (`ft` vs `m` siblings); the response's own
 *     `units` field is always used, never assumed.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from './fetch';
import type { StationValue, TelemetryFreshness } from '../types/station';
import type { CwmsSource } from '../types/station';
import { isObject } from './guards';

const FETCH_TIMEOUT_MS = 12_000;
const ACCEPT_V2 = { Accept: 'application/json;version=2' };

/** Hourly-series freshness window (tier-2 doctrine: 2 to 6 hours). */
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The latest reading of a CWMS timeseries. */
export interface CwmsLatest {
  readonly value: number;
  readonly unit: string;
  /** ISO 8601 UTC timestamp of the reading. */
  readonly timestamp: string;
}

interface TsPayload {
  readonly units: string;
  readonly values: ReadonlyArray<readonly [number, number | null, number]>;
}

function parseTimeseries(json: unknown): TsPayload | null {
  if (!isObject(json)) return null;
  const units = typeof json.units === 'string' ? json.units : '';
  const values = Array.isArray(json.values) ? (json.values as TsPayload['values']) : [];
  return { units, values };
}

async function fetchTimeseriesWindow(
  office: string,
  tsId: string,
  signal: AbortSignal | null
): Promise<TsPayload | null> {
  const end = new Date();
  const begin = new Date(end.getTime() - 48 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    name: tsId,
    office,
    begin: begin.toISOString(),
    end: end.toISOString()
  });
  const resp = await fetchWithBudget(
    `${URLS.usaceCwmsData}/timeseries?${params.toString()}`,
    { headers: ACCEPT_V2 },
    signal,
    FETCH_TIMEOUT_MS
  );
  if (!resp.ok) throw new Error(`CWMS HTTP ${resp.status}`);
  return parseTimeseries(await resp.json());
}

/** Discover the first cataloged timeseries id matching `like`, or null. */
async function discoverTimeseriesId(
  office: string,
  like: string,
  signal: AbortSignal | null
): Promise<string | null> {
  const params = new URLSearchParams({ office, like });
  const resp = await fetchWithBudget(
    `${URLS.usaceCwmsData}/catalog/TIMESERIES?${params.toString()}`,
    { headers: ACCEPT_V2 },
    signal,
    FETCH_TIMEOUT_MS
  );
  if (!resp.ok) return null;
  const json: unknown = await resp.json();
  if (!isObject(json) || !Array.isArray(json.entries)) return null;
  for (const entry of json.entries) {
    if (isObject(entry) && typeof entry.name === 'string') return entry.name;
  }
  return null;
}

/**
 * Latest reading for a station's configured CWMS timeseries: the verified
 * id first, one catalog-discovery retry on 200-with-empty, null when
 * neither carries data.
 */
export async function fetchCwmsLatest(
  source: CwmsSource,
  signal: AbortSignal | null
): Promise<CwmsLatest | null> {
  let ts = await fetchTimeseriesWindow(source.office, source.tsId, signal);
  if (!ts || ts.values.length === 0) {
    const discovered = await discoverTimeseriesId(source.office, source.catalogLike, signal);
    if (!discovered || discovered === source.tsId) return null;
    ts = await fetchTimeseriesWindow(source.office, discovered, signal);
  }
  if (!ts) return null;

  for (let i = ts.values.length - 1; i >= 0; i--) {
    const row = ts.values[i];
    if (!row) continue;
    const [ms, value] = row;
    if (value === null || !Number.isFinite(value)) continue;
    return { value, unit: ts.units, timestamp: new Date(ms).toISOString() };
  }
  return null;
}

/** Freshness for an hourly reading: within 6 hours is fresh, else stale. */
export function hourlyFreshness(timestampIso: string): TelemetryFreshness {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) return 'stale';
  return Date.now() - t <= FRESH_WINDOW_MS ? 'fresh' : 'stale';
}

/** Normalize a CWMS latest reading to the canonical StationValue. */
export function cwmsStationValue(
  stationId: string,
  label: string,
  latest: CwmsLatest | null
): StationValue {
  if (!latest) {
    return {
      stationId,
      parameter: 'cwms_timeseries',
      label,
      value: null,
      unit: '',
      timestamp: '',
      freshness: 'unavailable',
      source: 'usace-cwms'
    };
  }
  return {
    stationId,
    parameter: 'cwms_timeseries',
    label,
    value: Math.round(latest.value * 100) / 100,
    unit: latest.unit,
    timestamp: latest.timestamp,
    freshness: hourlyFreshness(latest.timestamp),
    source: 'usace-cwms'
  };
}
