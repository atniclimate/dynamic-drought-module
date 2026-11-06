/**
 * United States Geological Survey (USGS) stream-gauge reads through the USGS
 * Water Data APIs (OGC API Features, `URLS.usgsWaterData`), shared by the
 * telemetry popup hydration, the sidebar station values and the viewport
 * discovery in src/config/station-registry.ts. They replaced the Water
 * Services Instantaneous Values service, which ends on 2027-02-22; the
 * popup and sidebar still call the same functions and get the same values.
 *
 * Load-bearing caveats, handled here:
 *   - One feature per observation, in no guaranteed order: rows are grouped
 *     per parameter and sorted by time, so the latest is the greatest time.
 *   - A reading is a finite value whose qualifier, if any, is ESTIMATED. A
 *     null value or any other qualifier is unknown, never a number.
 *   - The site id always carries the `USGS-` prefix: a bare number answers
 *     200 with no rows. With it, a week of no rows is the gauge's own "no
 *     recent values", read as the legacy service's empty answer was.
 *   - No API key, ever. A keyless address may make 50 requests an hour, so
 *     a refusal for rate (429) pauses every read here instead of retrying.
 */

import { URLS } from '../config/urls';
import { fetchBufferedWithBudget } from './fetch';
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

/**
 * Decoded bytes one answer page may carry. A week of one 15-minute gauge
 * measured 499,626 bytes for 1,338 rows (373 a row, 2026-11-06), so a full
 * 5,000-row page is about 1.87 MB; a 25-square-degree view's 712 rows, 345,451.
 */
const MAX_PAGE_BYTES = 2.5 * 1024 * 1024;
/** Pages one read may follow through the answer's own `next` links. */
const MAX_PAGES = 3;
/** Rows per series page: a 5-minute gauge's week of both parameters (4,032 rows) fits one page. */
const SERIES_PAGE_ROWS = 5_000;
/** How long a refusal for rate (HTTP 429) holds back every USGS read. */
const RATE_PAUSE_MS = 10 * 60 * 1000;
let pausedUntil = 0;

export interface UsgsReading {
  readonly value: string;
  readonly dateTime?: string;
}

/** One parameter's usable readings at a site, oldest first. */
export interface UsgsSeries {
  readonly code: string;
  readonly unit: string | null;
  readonly readings: UsgsReading[];
}

/** The id the API needs: a bare site number answers 200 with no rows. */
export function usgsLocationId(site: string): string {
  return site.startsWith('USGS-') ? site : `USGS-${site}`;
}

/**
 * Every feature of one USGS answer, following its own `next` links up to
 * MAX_PAGES. A non-OK status, a page past MAX_PAGE_BYTES, corrupt JSON, a
 * timeout, a link off the API or a read during a rate pause throws.
 */
export async function fetchUsgsFeatures(
  url: string,
  signal: AbortSignal | null,
  timeoutMs: number
): Promise<unknown[]> {
  const features: unknown[] = [];
  let next: string | null = url;
  for (let page = 0; next !== null; page++) {
    if (page === MAX_PAGES) throw new Error(`USGS answer ran past ${MAX_PAGES} pages`);
    if (!next.startsWith(URLS.usgsWaterData)) throw new Error('USGS next link left the API');
    if (Date.now() < pausedUntil) throw new Error('USGS reads paused after a refusal for rate');
    const resp = await fetchBufferedWithBudget(next, {}, signal, timeoutMs, MAX_PAGE_BYTES);
    if (resp.status === 429) pausedUntil = Date.now() + RATE_PAUSE_MS;
    if (!resp.ok) throw new Error('USGS HTTP ' + resp.status);
    const body: unknown = await resp.json();
    if (!isObject(body) || !Array.isArray(body.features)) throw new Error('USGS answer is not a feature collection');
    for (const feature of body.features) features.push(feature);
    next = nextLink(body.links);
  }
  return features;
}

function nextLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (isObject(link) && link.rel === 'next' && typeof link.href === 'string') return link.href;
  }
  return null;
}

/**
 * A row's reading, or null when it is not one: the value must be a finite
 * number at a readable time, and its qualifier, if any, only ESTIMATED.
 */
export function usgsReading(row: Record<string, unknown>): UsgsReading | null {
  const { value, time, qualifier } = row;
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value))) return null;
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time))) return null;
  const known =
    qualifier === null ||
    qualifier === undefined ||
    (Array.isArray(qualifier) && qualifier.every((q) => q === 'ESTIMATED'));
  return known ? { value, dateTime: time } : null;
}

/** The unit as the legacy service wrote it ('ft^3/s' reads 'ft3/s'), or null. */
export function usgsUnit(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw.replaceAll('^', '') : null;
}

/**
 * Pull the last 7 days of discharge (parameter code 00060) and gage height
 * (00065) for one site, so the popup can draw a recent-trend sparkline, not
 * just the latest reading. The optional `signal` is the caller's
 * AbortController (popup-close or telemetry layer-off cancels the read).
 *
 * Returns the answer's features as `unknown`; the readers below do the
 * structural validation.
 */
export async function fetchUsgsIV(
  siteId: string,
  signal: AbortSignal | null
): Promise<unknown> {
  const params = new URLSearchParams({
    f: 'json',
    monitoring_location_id: usgsLocationId(siteId),
    parameter_code: '00060,00065',
    time: 'P7D',
    limit: String(SERIES_PAGE_ROWS),
    skipGeometry: 'true',
    properties: 'time_series_id,parameter_code,time,value,unit_of_measure,qualifier'
  });
  const features = await fetchUsgsFeatures(
    `${URLS.usgsWaterData}collections/continuous/items?${params.toString()}`,
    signal,
    FETCH_TIMEOUT_MS
  );
  return { features };
}

/* ---------------------------------------------------------------------------
 * Readers over that payload. `extractTimeSeries` groups the rows; the rest
 * read one series, so the popup and sidebar code above them is unchanged.
 * ------------------------------------------------------------------------- */

/**
 * One series per parameter code, in code order (00060 before 00065, as the
 * legacy service listed them), each holding its readings oldest first. A
 * site with two sensors on one code keeps the sensor with the newest reading.
 */
export function extractTimeSeries(payload: unknown): UsgsSeries[] {
  if (!isObject(payload) || !Array.isArray(payload.features)) return [];
  const sensors = new Map<string, UsgsSeries>();
  for (const feature of payload.features) {
    const row = isObject(feature) && isObject(feature.properties) ? feature.properties : null;
    if (!row || typeof row.parameter_code !== 'string') continue;
    const key = `${row.parameter_code} ${String(row.time_series_id)}`;
    let sensor = sensors.get(key);
    if (!sensor) {
      sensor = { code: row.parameter_code, unit: usgsUnit(row.unit_of_measure), readings: [] };
      sensors.set(key, sensor);
    }
    const reading = usgsReading(row);
    if (reading) sensor.readings.push(reading);
  }
  const byCode = new Map<string, UsgsSeries>();
  for (const sensor of sensors.values()) {
    sensor.readings.sort((a, b) => readingTime(a) - readingTime(b));
    const kept = byCode.get(sensor.code);
    if (!kept || newestTime(sensor) > newestTime(kept)) byCode.set(sensor.code, sensor);
  }
  return [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
}

function readingTime(reading: UsgsReading): number {
  return Date.parse(reading.dateTime ?? '');
}

function newestTime(series: UsgsSeries): number {
  const last = series.readings.at(-1);
  return last ? readingTime(last) : -Infinity;
}

export function readVariableCode(series: UsgsSeries): string | null {
  return series.code;
}

export function readUnitCode(series: UsgsSeries): string | null {
  return series.unit;
}

/** The Water Data rows carry no parameter name; callers label 00060 and 00065 themselves. */
export function readVariableName(_series: UsgsSeries): string | null {
  return null;
}

export function readValueArray(series: UsgsSeries): UsgsReading[] {
  return series.readings;
}

/** Newest reading: the series holds readings only, oldest first. */
export function readLatestUsgsReading(series: UsgsSeries): UsgsReading | null {
  return series.readings.at(-1) ?? null;
}

/** Freshness for an instantaneous reading: within 6 hours is fresh. */
export function ivFreshness(timestampIso: string): TelemetryFreshness {
  const t = Date.parse(timestampIso);
  if (Number.isNaN(t)) return 'stale';
  return Date.now() - t <= FRESH_WINDOW_MS ? 'fresh' : 'stale';
}

/**
 * Normalize the latest reading to the canonical StationValue: discharge
 * (00060) preferred, then gage height (00065), then any series with a real
 * reading. Null when no series carries a reading.
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
    const r = s && readLatestUsgsReading(s);
    if (!r) continue;
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
    const timestamp = r.dateTime ?? '';

    return {
      stationId,
      parameter,
      label,
      value: Math.round(Number(r.value) * 100) / 100,
      unit: readUnitCode(s) ?? '',
      timestamp,
      freshness: timestamp ? ivFreshness(timestamp) : 'stale',
      source: 'usgs-iv'
    };
  }
  return null;
}
