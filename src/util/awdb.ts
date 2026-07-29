/**
 * NRCS Air-Water Database (AWDB) REST fetch and normalization, shared by the
 * telemetry popup hydration (src/ui/popups.ts) and the sidebar station-value
 * hydration (src/ui/sidebar.ts). Hoisted to src/util/ per the agency-data
 * consumer doctrine: a focused helper shared by two consumers, not a
 * speculative adapter layer.
 *
 * Route (verified 2026-07-01; see URLS.nrcsAwdbRest): the REST service
 * serves wildcard CORS, so the DIRECT fetch is primary. The Worker proxy
 * remains the verified resilience path: on a direct-fetch network failure,
 * and only when `URLS.workerProxy` is non-empty, the same request is retried
 * once through `${workerProxy}/proxy?url=<encoded>`. An empty workerProxy
 * simply skips the retry; the caller sees the failure and renders the
 * honest unavailable state (never an error dressed as data).
 *
 * Freshness (daily duration): SNOTEL daily values post once per day and are
 * dated by calendar day with no time component. A latest reading dated
 * today or yesterday is `fresh`; anything older is `stale`; no numeric
 * reading in the window is `unavailable`.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from './fetch';
import type { StationValue, TelemetryFreshness } from '../types/station';

/** Per-call network budget, matching the popup hydration budget. */
const FETCH_TIMEOUT_MS = 8000;

/** One AWDB element (parameter) series, in reading order. */
export interface AwdbElementSeries {
  readonly element: string;
  readonly unit: string;
  readonly readings: ReadonlyArray<{ date: string; value: number }>;
}

/** Canonical labels for the elements DDM requests. */
const ELEMENT_LABELS: Readonly<Record<string, { parameter: string; label: string }>> = {
  WTEQ: { parameter: 'snow_water_equivalent_in', label: 'Snow water equivalent' },
  SNWD: { parameter: 'snow_depth_in', label: 'Snow depth' },
  PREC: { parameter: 'precip_water_year_in', label: 'Precip (water year)' },
  SMS: { parameter: 'soil_moisture_pct', label: 'Soil moisture' }
};

/** Format a Date as the YYYY-MM-DD string the AWDB REST API expects. */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildDataUrl(triplet: string, elements: readonly string[], days: number): string {
  const end = new Date();
  const begin = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    stationTriplets: triplet,
    elements: elements.join(','),
    duration: 'DAILY',
    beginDate: isoDay(begin),
    endDate: isoDay(end)
  });
  return `${URLS.nrcsAwdbRest}?${params.toString()}`;
}

/**
 * Fetch daily series for one station triplet. Direct first; one retry
 * through the Worker when the direct fetch throws and a Worker is deployed.
 * Throws when both routes fail so the caller renders its unavailable state.
 */
export async function fetchAwdbDailySeries(
  triplet: string,
  elements: readonly string[],
  days: number,
  signal: AbortSignal | null
): Promise<AwdbElementSeries[]> {
  const directUrl = buildDataUrl(triplet, elements, days);

  let resp: Response;
  try {
    resp = await fetchWithBudget(directUrl, {}, signal, FETCH_TIMEOUT_MS);
    // The AWDB backend sits behind a load balancer with session affinity
    // and throws intermittent 5xx (observed live during verification,
    // 2026-07-01). The Worker's different egress path has a real chance of
    // landing on a healthy node, so a server error joins network failure
    // as a Worker-retry trigger. 4xx does not: a bad request through a
    // proxy is still a bad request.
    if (resp.status >= 500) throw new Error(`AWDB HTTP ${resp.status}`);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (URLS.workerProxy === '') throw err;
    const proxied = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(directUrl)}`;
    resp = await fetchWithBudget(proxied, {}, signal, FETCH_TIMEOUT_MS);
  }
  if (!resp.ok) throw new Error(`AWDB HTTP ${resp.status}`);
  return parseAwdbPayload(await resp.json());
}

/**
 * Parse the AWDB REST payload (an array of station blocks, each with
 * per-element series) into AwdbElementSeries. Defensive: every step is
 * narrowed because the payload arrives as `unknown`. Readings with
 * non-finite values are dropped; a reading of 0 is a real observation
 * (summer snow water equivalent is legitimately 0.0) and is kept.
 */
function parseAwdbPayload(payload: unknown): AwdbElementSeries[] {
  if (!Array.isArray(payload) || payload.length === 0) return [];
  const station = payload[0] as { data?: unknown };
  if (!station || !Array.isArray(station.data)) return [];

  const out: AwdbElementSeries[] = [];
  for (const block of station.data) {
    const el = (block as { stationElement?: unknown }).stationElement as
      | { elementCode?: unknown; storedUnitCode?: unknown }
      | undefined;
    const values = (block as { values?: unknown }).values;
    if (!el || typeof el.elementCode !== 'string' || !Array.isArray(values)) continue;

    const readings: Array<{ date: string; value: number }> = [];
    for (const v of values) {
      const date = (v as { date?: unknown }).date;
      const value = (v as { value?: unknown }).value;
      if (typeof date !== 'string') continue;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) continue;
      readings.push({ date, value: n });
    }

    out.push({
      element: el.elementCode,
      unit: typeof el.storedUnitCode === 'string' ? el.storedUnitCode : '',
      readings
    });
  }
  return out;
}

/**
 * Freshness for a daily-duration reading date (YYYY-MM-DD, no time
 * component): today or yesterday in local time is `fresh`, older is
 * `stale`. The caller maps "no readings at all" to `unavailable`.
 */
export function dailyFreshness(latestDate: string): TelemetryFreshness {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (latestDate === isoDay(today) || latestDate === isoDay(yesterday)) return 'fresh';
  return 'stale';
}

/**
 * Normalize one element series to the canonical StationValue handed to the
 * sidebar renderer (latest reading wins). Returns null for an element DDM
 * has no label for, so an upstream catalog change cannot inject an
 * unlabeled row.
 */
export function toStationValue(
  stationId: string,
  series: AwdbElementSeries
): StationValue | null {
  const meta = ELEMENT_LABELS[series.element];
  if (!meta) return null;
  const latest = series.readings[series.readings.length - 1];
  if (!latest) {
    return {
      stationId,
      parameter: meta.parameter,
      label: meta.label,
      value: null,
      unit: series.unit,
      timestamp: '',
      freshness: 'unavailable',
      source: 'nrcs-awdb'
    };
  }
  return {
    stationId,
    parameter: meta.parameter,
    label: meta.label,
    value: latest.value,
    unit: series.unit,
    timestamp: latest.date,
    freshness: dailyFreshness(latest.date),
    source: 'nrcs-awdb'
  };
}

/** The elements DDM requests for a SNOTEL station, in display order. */
export const SNOTEL_ELEMENTS: readonly string[] = ['WTEQ', 'SNWD', 'PREC'];

/** The elements DDM requests for a SCAN station, in display order. */
export const SCAN_ELEMENTS: readonly string[] = ['SMS'];

export function elementsForAwdbStationTriplet(triplet: string): readonly string[] {
  return triplet.endsWith(':SCAN') ? SCAN_ELEMENTS : SNOTEL_ELEMENTS;
}
