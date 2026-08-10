/**
 * Retained Wildfire framing summaries for the North America minimap.
 *
 * Current context comes from nine concurrent, count-only spatial queries to
 * the National Interagency Fire Center (NIFC) WFIGS Current Interagency Fire
 * Perimeters service. Only active-candidate wildfire and incident-complex
 * records are eligible. Prescribed fire is deliberately excluded. A positive
 * count means at least one current mapped NIFC wildfire perimeter intersects
 * the ATNI-authored framing. It does not mean every active fire is mapped.
 *
 * When a framing has no intersecting mapped perimeter, the generated 2023
 * United States Forest Service Wildfire Hazard Potential (WHP) overview
 * supplies static strategic context. WHP is approximate, United States-only,
 * and not a forecast. Unknown current-fire state never falls through to the
 * lower-priority static metric.
 *
 * The shared feed is single-flight, cancellable when its final consumer
 * releases it, and refreshed five minutes after each completed request set.
 */

import {
  FRAMING_SHAPES,
  FRAMING_SUPPLEMENTAL_SHAPES,
  HAWAII_ISLAND_SHAPES,
} from '../config/framing-shapes';
import type { LonLat, MainlandFramingKey } from '../config/framing-shapes';
import { FRAMING_KEYS } from '../config/framings';
import type { FramingKey } from '../config/framings';
import { MINIMAP_WHP } from '../config/minimap-whp';
import type { MinimapWhpFramingSummary } from '../config/minimap-whp';
import { URLS } from '../config/urls';
import { fetchJsonWithBudget } from '../util/fetch';

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 5 * 60_000;

export const MINIMAP_WILDFIRE_WHERE =
  "attr_ActiveFireCandidate = 1 AND attr_IncidentTypeCategory IN ('WF','CX')";

export type MinimapWildfireCondition =
  | 'mapped-wildfire'
  | 'high-potential'
  | 'moderate-potential'
  | 'below-threshold'
  | 'no-data'
  | 'unavailable';

export type MinimapWildfireRegionStatus =
  | 'live'
  | 'live-partial'
  | 'no-data'
  | 'unavailable';

export interface MinimapWildfireSummary {
  readonly condition: MinimapWildfireCondition;
  readonly status: MinimapWildfireRegionStatus;
  /** Current mapped NIFC wildfire perimeters, or null when that query failed. */
  readonly mappedWildfirePerimeterCount: number | null;
  readonly highOrVeryHighPercent: number | null;
  readonly moderateOrHigherPercent: number | null;
  readonly whpCoverage: MinimapWhpFramingSummary['coverage'];
}

export type MinimapWildfireStatus =
  | 'idle'
  | 'loading'
  | 'live'
  | 'live-partial'
  | 'no-data'
  | 'unavailable';

export interface MinimapWildfireSnapshot {
  readonly status: MinimapWildfireStatus;
  /** Browser retrieval time, not an incident observation or update time. */
  readonly checkedAtUtc: string | null;
  readonly summaries: Readonly<
    Partial<Record<FramingKey, MinimapWildfireSummary>>
  >;
}

export type MinimapWildfireCountResult =
  | { readonly status: 'live'; readonly count: number }
  | { readonly status: 'unavailable'; readonly count: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the narrow ArcGIS returnCountOnly response contract. */
export function parseMinimapWildfireCount(value: unknown): number {
  if (!isRecord(value)) {
    throw new Error('NIFC count response is not an object.');
  }
  if (isRecord(value['error'])) {
    const message = value['error']['message'];
    throw new Error(
      `NIFC count query returned an ArcGIS error${
        typeof message === 'string' && message.length > 0
          ? `: ${message}`
          : '.'
      }`,
    );
  }
  const count = value['count'];
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error('NIFC count response has an invalid count.');
  }
  return Number(count);
}

function normalizedLongitude(longitude: number): number {
  if (longitude < -180) return longitude + 360;
  if (longitude > 180) return longitude - 360;
  return longitude;
}

function signedRingArea(ring: readonly LonLat[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (!current || !next) continue;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
}

function arcGisOuterRing(shape: readonly LonLat[]): readonly LonLat[] {
  const normalized = shape.map(
    ([longitude, latitude]) =>
      [normalizedLongitude(longitude), latitude] as const,
  );
  const first = normalized[0];
  const last = normalized.at(-1);
  if (!first || !last) throw new Error('A minimap framing ring is empty.');
  if (first[0] === last[0] && first[1] === last[1]) normalized.pop();
  if (normalized.length < 3) {
    throw new Error('A minimap framing ring has fewer than three points.');
  }
  // ArcGIS exterior rings are clockwise in an x/y coordinate system.
  if (signedRingArea(normalized) > 0) normalized.reverse();
  const close = normalized[0];
  if (!close) throw new Error('A minimap framing ring is empty.');
  return [...normalized, close];
}

function framingShapes(key: FramingKey): readonly (readonly LonLat[])[] {
  if (key === 'hawaii') return HAWAII_ISLAND_SHAPES;
  const mainlandKey: MainlandFramingKey = key;
  return [
    FRAMING_SHAPES[mainlandKey],
    ...(FRAMING_SUPPLEMENTAL_SHAPES[mainlandKey] ?? []),
  ];
}

/** Build one compact, browser-safe ArcGIS POST body for a framing. */
export function buildMinimapWildfireQueryBody(
  key: FramingKey,
): URLSearchParams {
  return new URLSearchParams({
    where: MINIMAP_WILDFIRE_WHERE,
    geometry: JSON.stringify({
      rings: framingShapes(key).map(arcGisOuterRing),
      spatialReference: { wkid: 4326 },
    }),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnCountOnly: 'true',
    returnGeometry: 'false',
    f: 'json',
  });
}

/**
 * Apply strict red, then orange, then yellow precedence to one framing.
 * Exact 50 and 30 percent values do not pass their respective thresholds.
 */
export function deriveMinimapWildfireSummary(
  fire: MinimapWildfireCountResult,
  whp: MinimapWhpFramingSummary,
): MinimapWildfireSummary {
  const common = {
    mappedWildfirePerimeterCount: fire.count,
    highOrVeryHighPercent: whp.highOrVeryHighPercent,
    moderateOrHigherPercent: whp.moderateOrHigherPercent,
    whpCoverage: whp.coverage,
  } as const;

  if (fire.status === 'unavailable') {
    return { ...common, condition: 'unavailable', status: 'unavailable' };
  }

  if (fire.count > 0) {
    return {
      ...common,
      condition: 'mapped-wildfire',
      // This is an existential statement: one verified intersection is enough
      // to establish that a mapped perimeter is present. WHP coverage is not
      // involved in the red condition.
      status: 'live',
    };
  }

  if (
    whp.coverage === 'no-data' ||
    whp.highOrVeryHighPercent === null ||
    whp.moderateOrHigherPercent === null
  ) {
    return { ...common, condition: 'no-data', status: 'no-data' };
  }

  const status = whp.coverage === 'live' ? 'live' : 'live-partial';
  if (whp.highOrVeryHighPercent > 50) {
    return { ...common, condition: 'high-potential', status };
  }
  if (whp.moderateOrHigherPercent > 30) {
    return { ...common, condition: 'moderate-potential', status };
  }
  return { ...common, condition: 'below-threshold', status };
}

interface FramingCountOutcome {
  readonly key: FramingKey;
  readonly result: MinimapWildfireCountResult;
  readonly error?: unknown;
}

async function queryFramingCount(
  key: FramingKey,
  signal: AbortSignal,
): Promise<FramingCountOutcome> {
  try {
    const value = await fetchJsonWithBudget(
      `${URLS.nifcFires}/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: buildMinimapWildfireQueryBody(key),
        cache: 'no-store',
      },
      signal,
      FETCH_TIMEOUT_MS,
    );
    return {
      key,
      result: { status: 'live', count: parseMinimapWildfireCount(value) },
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      key,
      result: { status: 'unavailable', count: null },
      error,
    };
  }
}

function snapshotStatus(
  summaries: Readonly<Record<FramingKey, MinimapWildfireSummary>>,
): MinimapWildfireStatus {
  const values = FRAMING_KEYS.map((key) => summaries[key]);
  const usable = values.filter((summary) => summary.status !== 'unavailable');
  if (usable.length === 0) return 'unavailable';
  if (
    usable.length !== values.length ||
    usable.some(
      (summary) =>
        summary.status === 'live-partial' || summary.status === 'no-data',
    )
  ) {
    return 'live-partial';
  }
  if (usable.some((summary) => summary.status === 'live')) return 'live';
  return 'no-data';
}

const EMPTY_SUMMARIES: Readonly<
  Partial<Record<FramingKey, MinimapWildfireSummary>>
> = {};

let snapshot: MinimapWildfireSnapshot = {
  status: 'idle',
  checkedAtUtc: null,
  summaries: EMPTY_SUMMARIES,
};
let retainCount = 0;
let epoch = 0;
let controller: AbortController | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(next: MinimapWildfireSnapshot) => void>();

function publish(next: MinimapWildfireSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener(next));
}

function clearRefreshTimer(): void {
  if (refreshTimer === null) return;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

function scheduleRefresh(loadEpoch: number): void {
  clearRefreshTimer();
  if (retainCount === 0 || epoch !== loadEpoch) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (retainCount > 0 && epoch === loadEpoch) {
      void loadSummaries(loadEpoch, false);
    }
  }, REFRESH_INTERVAL_MS);
}

async function loadSummaries(
  loadEpoch: number,
  initial: boolean,
): Promise<void> {
  controller?.abort();
  const nextController = new AbortController();
  controller = nextController;
  const signal = nextController.signal;
  if (initial) {
    publish({ status: 'loading', checkedAtUtc: null, summaries: EMPTY_SUMMARIES });
  }

  try {
    const outcomes = await Promise.all(
      FRAMING_KEYS.map((key) => queryFramingCount(key, signal)),
    );
    if (signal.aborted || epoch !== loadEpoch || retainCount === 0) return;

    const failed = outcomes.filter((outcome) => outcome.error !== undefined);
    if (failed.length > 0) {
      console.warn(
        `[minimap-wildfire] ${failed.length} framing count ${
          failed.length === 1 ? 'query' : 'queries'
        } failed.`,
        failed.map(({ key, error }) => ({ key, error })),
      );
    }

    const summaries = Object.fromEntries(
      outcomes.map(({ key, result }) => [
        key,
        deriveMinimapWildfireSummary(result, MINIMAP_WHP.framings[key]),
      ]),
    ) as Record<FramingKey, MinimapWildfireSummary>;
    publish({
      status: snapshotStatus(summaries),
      checkedAtUtc: new Date().toISOString(),
      summaries,
    });
  } catch (error) {
    if (signal.aborted || epoch !== loadEpoch || retainCount === 0) return;
    console.warn('[minimap-wildfire] framing count load failed.', error);
    publish({
      status: 'unavailable',
      checkedAtUtc: new Date().toISOString(),
      summaries: EMPTY_SUMMARIES,
    });
  } finally {
    if (controller === nextController) controller = null;
    if (!signal.aborted && epoch === loadEpoch && retainCount > 0) {
      scheduleRefresh(loadEpoch);
    }
  }
}

/** Current state for the concurrently mounted minimap instances. */
export function getMinimapWildfireSnapshot(): MinimapWildfireSnapshot {
  return snapshot;
}

/**
 * Retain the shared live summary feed. The first consumer starts nine
 * concurrent count queries; the final release cancels work and its timer.
 */
export function retainMinimapWildfire(
  listener: (next: MinimapWildfireSnapshot) => void,
): () => void {
  retainCount++;
  const subscription = (next: MinimapWildfireSnapshot): void => listener(next);
  listeners.add(subscription);
  listener(snapshot);
  if (retainCount === 1) {
    const loadEpoch = ++epoch;
    void loadSummaries(loadEpoch, true);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    listeners.delete(subscription);
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount !== 0) return;
    epoch++;
    controller?.abort();
    controller = null;
    clearRefreshTimer();
    snapshot = {
      status: 'idle',
      checkedAtUtc: null,
      summaries: EMPTY_SUMMARIES,
    };
  };
}
