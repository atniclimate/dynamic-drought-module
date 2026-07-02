/**
 * USBR Hydromet / AgriMet daily-arc fetch and normalization, shared by the
 * telemetry popup hydration and the sidebar station-value hydration.
 *
 * Source: the Pacific Northwest region legacy CGI (`URLS.usbrHydrometArcCsv`,
 * scout-proposed and verifier-confirmed 2026-07-01). Load-bearing caveats
 * from verification, all handled here:
 *   - No CORS in any configuration, so the route is Worker-proxy ONLY; an
 *     empty `workerProxy` throws so the consumer renders its honest
 *     unavailable state.
 *   - The body is CSV inside an HTML shell with `BEGIN DATA` / `END DATA`
 *     markers; parse only between the markers.
 *   - Fields are comma-delimited but space-padded; trim every field.
 *   - The most recent day commonly reads the literal `NO RECORD` (not yet
 *     posted, about one calendar day of lag); skipped, not an error.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from './fetch';
import { dailyFreshness } from './awdb';
import type { StationValue } from '../types/station';

const FETCH_TIMEOUT_MS = 15_000;

/** One Hydromet parameter series ("WIC AF"), readings in date order. */
export interface HydrometSeries {
  /** The requested "SITE PCODE" string, normalized to single spaces. */
  readonly param: string;
  readonly readings: ReadonlyArray<{ date: string; value: number }>;
}

/** Display metadata per Hydromet PCODE (the suffix of "SITE PCODE"). */
const PCODE_META: Readonly<Record<string, { parameter: string; label: string; unit: string }>> = {
  AF: { parameter: 'reservoir_storage_acft', label: 'Storage', unit: 'ac-ft' },
  ET: { parameter: 'reference_et_in', label: 'Daily ET', unit: 'in' },
  MM: { parameter: 'air_temp_mean_f', label: 'Mean temp', unit: 'F' },
  MX: { parameter: 'air_temp_max_f', label: 'Max temp', unit: 'F' },
  MN: { parameter: 'air_temp_min_f', label: 'Min temp', unit: 'F' }
};

/** "06/30/2026" (Hydromet) to "2026-06-30" (ISO). Returns null on mismatch. */
function hydrometDateToIso(raw: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * Fetch daily values for one or more "SITE PCODE" parameters over the last
 * `days` days, through the Worker proxy (the upstream has no CORS).
 */
export async function fetchHydrometDaily(
  params: readonly string[],
  days: number,
  signal: AbortSignal | null
): Promise<HydrometSeries[]> {
  if (URLS.workerProxy === '') {
    throw new Error('Hydromet requires the Worker proxy, which is not configured.');
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const query = new URLSearchParams({
    parameter: params.join(','),
    syer: String(start.getFullYear()),
    smnth: String(start.getMonth() + 1),
    sdy: String(start.getDate()),
    eyer: String(end.getFullYear()),
    emnth: String(end.getMonth() + 1),
    edy: String(end.getDate()),
    format: '2'
  });
  const upstream = `${URLS.usbrHydrometArcCsv}?${query.toString()}`;
  const proxied = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(upstream)}`;

  const resp = await fetchWithBudget(proxied, {}, signal, FETCH_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`Hydromet HTTP ${resp.status}`);
  return parseHydrometCsv(await resp.text());
}

/** Parse the HTML-wrapped, marker-delimited Hydromet CSV. */
function parseHydrometCsv(text: string): HydrometSeries[] {
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.includes('BEGIN DATA'));
  const end = lines.findIndex((l) => l.includes('END DATA'));
  if (begin < 0 || end < 0 || end <= begin + 1) return [];

  const block = lines
    .slice(begin + 1, end)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const header = block[0];
  if (!header || !header.toUpperCase().startsWith('DATE')) return [];

  // Header fields after DATE are "SITE  PCODE" with internal padding;
  // normalize runs of whitespace to single spaces for stable keys.
  const cols = header.split(',').map((c) => c.trim().replace(/\s+/g, ' '));
  const series: Array<{ param: string; readings: Array<{ date: string; value: number }> }> =
    cols.slice(1).map((param) => ({ param, readings: [] }));

  for (const line of block.slice(1)) {
    const fields = line.split(',').map((f) => f.trim());
    const dateField = fields[0];
    const iso = dateField ? hydrometDateToIso(dateField) : null;
    if (!iso) continue;
    for (let i = 0; i < series.length; i++) {
      const raw = fields[i + 1];
      if (raw === undefined || raw === '' || raw.toUpperCase().includes('NO RECORD')) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      series[i]?.readings.push({ date: iso, value: n });
    }
  }
  return series;
}

/**
 * Normalize one Hydromet series to the canonical StationValue (latest
 * reading wins). Returns null for a PCODE DDM has no display metadata for.
 */
export function hydrometStationValue(
  stationId: string,
  series: HydrometSeries
): StationValue | null {
  const pcode = series.param.split(' ').pop() ?? '';
  const meta = PCODE_META[pcode];
  if (!meta) return null;
  const latest = series.readings[series.readings.length - 1];
  if (!latest) {
    return {
      stationId,
      parameter: meta.parameter,
      label: meta.label,
      value: null,
      unit: meta.unit,
      timestamp: '',
      freshness: 'unavailable',
      source: 'usbr-hydromet'
    };
  }
  return {
    stationId,
    parameter: meta.parameter,
    label: meta.label,
    value: latest.value,
    unit: meta.unit,
    timestamp: latest.date,
    freshness: dailyFreshness(latest.date),
    source: 'usbr-hydromet'
  };
}
