import { URLS } from '../config/urls';
import { ExpiringLruCache } from '../util/bounded-cache';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';

const NWS_TIMEOUT_MS = 10_000;
const NWS_ACCEPT = {
  Accept: 'application/geo+json, application/json'
};
const COMPLETED_RESPONSE_CACHE = new ExpiringLruCache<string, unknown>(48);

export const NWS_CACHE_TTL = {
  point: 5 * 60_000,
  grid: 5 * 60_000,
  stations: 30 * 60_000,
  observation: 2 * 60_000,
  forecast: 5 * 60_000,
  alerts: 60_000
} as const;

export interface NwsPointMetadata {
  readonly pointUrl: string;
  readonly forecastGridDataUrl: string | null;
  readonly observationStationsUrl: string | null;
  readonly forecastUrl: string | null;
  readonly office: string | null;
  readonly gridId: string | null;
}

export interface NwsRequestSession {
  readonly signal: AbortSignal;
  fetchJson(url: string, ttlMs: number): Promise<unknown>;
}

/** NWS accepts coordinates rounded to at most four decimal places. */
export function nwsCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Convert one NWS upstream URL to the configured transport. Direct mode stays
 * active until the matching Worker revision has been explicitly deployed.
 */
export function nwsRequestUrl(upstreamUrl: string): string {
  if (!URLS.nwsApiUseWorker || URLS.workerProxy.trim() === '') {
    return upstreamUrl;
  }
  return `${URLS.workerProxy}/proxy?url=${encodeURIComponent(upstreamUrl)}`;
}

/**
 * One cancellable request session per briefing. It deduplicates concurrent
 * reads inside that briefing and promotes only completed responses into the
 * bounded shared cache. Failures and aborted work are never cached.
 */
export function createNwsRequestSession(
  signal: AbortSignal
): NwsRequestSession {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    signal,
    fetchJson(url: string, ttlMs: number): Promise<unknown> {
      if (signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      const cached = COMPLETED_RESPONSE_CACHE.get(url);
      if (cached !== undefined) return Promise.resolve(cached);

      const existing = inFlight.get(url);
      if (existing) return existing;

      const request = fetchJsonWithBudget(
        nwsRequestUrl(url),
        { headers: NWS_ACCEPT },
        signal,
        NWS_TIMEOUT_MS
      )
        .then((payload) => {
          if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          COMPLETED_RESPONSE_CACHE.set(url, payload, ttlMs);
          return payload;
        })
        .finally(() => {
          inFlight.delete(url);
        });
      inFlight.set(url, request);
      return request;
    }
  };
}

function stringProperty(
  properties: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = properties[key];
  return typeof value === 'string' && value.trim() !== ''
    ? value
    : null;
}

export function parseNwsPointMetadata(
  pointUrl: string,
  payload: unknown
): NwsPointMetadata {
  if (!isObject(payload) || !isObject(payload.properties)) {
    throw new Error('invalid NWS points payload');
  }
  const properties = payload.properties;
  return {
    pointUrl,
    forecastGridDataUrl: stringProperty(properties, 'forecastGridData'),
    observationStationsUrl: stringProperty(properties, 'observationStations'),
    forecastUrl: stringProperty(properties, 'forecast'),
    office:
      stringProperty(properties, 'cwa') ??
      stringProperty(properties, 'forecastOffice'),
    gridId: stringProperty(properties, 'gridId')
  };
}

export async function fetchNwsPointMetadata(
  lng: number,
  lat: number,
  session: NwsRequestSession
): Promise<NwsPointMetadata> {
  const pointUrl =
    `${URLS.nwsApi}/points/` +
    `${nwsCoordinate(lat)},${nwsCoordinate(lng)}`;
  const payload = await session.fetchJson(pointUrl, NWS_CACHE_TTL.point);
  return parseNwsPointMetadata(pointUrl, payload);
}

/** Test-only and maintenance hook for deterministic cache assertions. */
export function clearNwsResponseCache(): void {
  COMPLETED_RESPONSE_CACHE.clear();
}
