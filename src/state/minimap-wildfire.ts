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
 * A framing that reaches British Columbia also counts the BC Wildfire
 * Service perimeters in the issuer's three active stages, from one bounded
 * read of the Province per load; where a BC and a NIFC perimeter are one
 * known fire area (src/layers/fire-areas.ts) it counts once. A failed BC
 * read never reads as zero there: with no NIFC perimeter the framing is
 * unavailable.
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
import { MINIMAP_ACTIVE_WILDFIRE_FILTER, bcwsStatusClass } from '../config/wildfire-presentation';
import { URLS } from '../config/urls';
import { countFireAreas, fireRecordKey, type CountedPerimeter } from '../layers/fire-areas';
import { bboxCoveredByEnvelope, type ViewEnvelope } from '../util/bbox';
import { BCWS_ACTIVE_WHERE, BCWS_COVERAGE, BCWS_READ_LIMITS, readBcwsPerimeters } from '../util/bcws-perimeter-read';
import { fetchJsonWithBudget } from '../util/fetch';
import { geometriesOverlap } from '../util/polygon-overlap';
import { registry } from './registry';
import type { Geometry } from 'geojson';

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * The declared count filter, this module's own
 * (`MINIMAP_ACTIVE_WILDFIRE_FILTER` in `src/config/wildfire-presentation.ts`,
 * the single source of truth for it; NOT shared with the briefing's NIFC
 * read, which counts a wider, undeclared-filter set on both of its own
 * paths, see `src/impact/sources.ts`); kept as its own export so the
 * existing callers and the pure-lane spec below need no rename.
 */
export const MINIMAP_WILDFIRE_WHERE = MINIMAP_ACTIVE_WILDFIRE_FILTER.where;

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
  /**
   * Current mapped wildfire perimeters, or null when that query failed: NIFC
   * alone, or, for a framing that reaches British Columbia, NIFC and BC
   * Wildfire Service together with each known fire area counted once. Where
   * no overlap between the two can be established it is the larger agency
   * count, a lower bound on distinct fire areas (`nifcPerimeterCount` is set).
   */
  readonly mappedWildfirePerimeterCount: number | null;
  readonly highOrVeryHighPercent: number | null;
  readonly moderateOrHigherPercent: number | null;
  readonly whpCoverage: MinimapWhpFramingSummary['coverage'];
  /** Absent for a framing outside British Columbia; null when the BC read failed (never read as zero). */
  readonly bcwsPerimeterCount?: number | null;
  /** Fire areas that joined a BC and a NIFC perimeter into one count; above zero, the count carries the ratified label. */
  readonly fireAreasMerged?: number;
  /** NIFC's own count, present only when its overlap with BC could not be established; each agency's count is then stated apart. */
  readonly nifcPerimeterCount?: number;
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

/** A framing's own `[west, south, east, north]` bbox, walked from the exact
 * authored rings `buildMinimapWildfireQueryBody` posts (DDM-P14-T07), or
 * null for a framing with no points (never true for a real `FramingKey`). */
function framingBbox(
  key: FramingKey,
): readonly [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const shape of framingShapes(key)) {
    for (const [lon, lat] of shape) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
    return null;
  }
  return [west, south, east, north];
}

/**
 * A framing's authored rings (the exact shapes `buildMinimapWildfireQueryBody`
 * posts) as a GeoJSON MultiPolygon geometry, one component per authored ring
 * and no holes. Neither `pointInPolygonGeometry`'s ray cast nor
 * `geometriesOverlap`'s edge walk (`src/util/point-in-polygon.ts`,
 * `src/util/polygon-overlap.ts`) requires a ring's last point to repeat its
 * first: both pair index `length - 1` back to index `0` themselves, so the
 * unclosed authored rings below are valid input as they are. Exported so
 * `tests/minimap-wildfire.spec.ts` can drive `geometriesOverlap` against the
 * real Hawaii multi-island shape directly, rather than a second, drift-prone
 * copy of it.
 */
export function framingGeometry(key: FramingKey): Geometry {
  return {
    type: 'MultiPolygon',
    coordinates: framingShapes(key).map((ring) => [ring.map(([lng, lat]) => [lng, lat])])
  };
}

/**
 * DDM-P14-T07 (fixed after the C3 report's own review flagged the earlier
 * bbox-vs-bbox spatial test: a perimeter sitting in the sea gap between two
 * islands of a multi-part framing could share a bounding box with the
 * framing while touching none of its actual rings): when the NIFC perimeters
 * layer is on the map, loaded, and its already-fetched collection (DDM-P1-T06's
 * `loadedNifcCollection`) fully covers this framing's own bbox (an
 * axis-aligned test against the layer's own axis-aligned query envelope,
 * which stays bbox-based on purpose), count under the declared
 * `MINIMAP_ACTIVE_WILDFIRE_FILTER` AND an honest polygon-versus-polygon
 * intersection against the framing's actual authored rings
 * (`geometriesOverlap`, already written and pure-lane tested in
 * `src/util/polygon-overlap.ts` for exactly this "vertex inside, or an edge
 * crossing" test; reused rather than reimplemented) from that collection
 * instead of this framing's usual count-only POST. Returns `null` (never a
 * false zero) when the layer is off, not yet loaded, or does not cover this
 * framing, so the caller keeps its normal network read for this framing (the
 * T06 rule: never read the collection as zero for a place it does not
 * cover). The layer module is reached only through a dynamic import, behind
 * the registry-status guard: a static import would pull
 * `src/layers/nifc-fires.ts` and its MapLibre/DOM dependency graph into this
 * module's own import graph, which the browser-free pure lane
 * (`tests/minimap-wildfire.spec.ts`, `playwright.pure.config.ts`) loads in
 * plain Node with no `window` or `document`; that lane's synthetic-fetch
 * runtime tests never activate the real layer, so
 * `registry.getStatus('nifc-fires')` reads undefined there and this function
 * returns before the dynamic import is ever reached.
 */
async function countFromLoadedNifcCollection(
  key: FramingKey,
): Promise<{ readonly count: number; readonly rows: readonly CountedPerimeter[] } | null> {
  const bbox = framingBbox(key);
  if (bbox === null || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
  const status = registry.getStatus('nifc-fires');
  if (status !== 'ready' && status !== 'degraded') return null;

  const { loadedNifcCollection } = await import('../layers/nifc-fires');
  const loaded = loadedNifcCollection();
  // The status check above ran before the import; a refresh can publish a
  // truncated collection in between, so completeness is read from this
  // snapshot itself (S30D P3-MINIMAP, found-129; the briefing's reader does
  // the same, src/impact/sources.ts). A set the service truncated can omit
  // perimeters: neither its zero nor its count is exact, so the framing
  // takes its count-only POST.
  if (loaded === null || loaded.truncated) return null;
  if (!bboxCoveredByEnvelope(loaded.envelope, bbox)) return null;

  const frame = framingGeometry(key);
  const rows: CountedPerimeter[] = [];
  for (const feature of loaded.collection.features) {
    if (typeof feature !== 'object' || feature === null) continue;
    const properties = (feature as { properties?: unknown }).properties;
    if (typeof properties !== 'object' || properties === null) continue;
    if (!MINIMAP_ACTIVE_WILDFIRE_FILTER.matches(properties as Record<string, unknown>)) continue;
    const geometry = (feature as { geometry?: Geometry | null }).geometry;
    if (!geometriesOverlap(geometry, frame)) continue;
    // The perimeter count stays per feature, as it was; the record key lets a known fire area count once.
    const recordKey = fireRecordKey('nifc', properties as Record<string, unknown>);
    rows.push({ identity: `nifc-feature:${rows.length}`, recordKey });
  }
  return { count: rows.length, rows };
}

/** The framings whose authored rings reach British Columbia's box, where BC perimeters can be. */
let bcwsFramings: ReadonlySet<FramingKey> | null = null;
function framingReachesBc(key: FramingKey): boolean {
  if (bcwsFramings === null) {
    const [west, south, east, north] = BCWS_COVERAGE;
    const box: Geometry = { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
    bcwsFramings = new Set(FRAMING_KEYS.filter((framing) => geometriesOverlap(framingGeometry(framing), box)));
  }
  return bcwsFramings.has(key);
}

/**
 * The province's active BC perimeters (the issuer's three active stages), one
 * bounded, reload-bracketed read per summary load; null when it failed or
 * was incomplete, which a framing never reads as zero.
 */
async function readBcwsActive(signal: AbortSignal): Promise<readonly { readonly properties: Record<string, unknown> | null; readonly geometry: Geometry | null }[] | null> {
  try {
    const result = await readBcwsPerimeters({
      ...BCWS_READ_LIMITS,
      endpoint: `${URLS.bcwsFirePerimeters}/query`,
      bounds: BCWS_COVERAGE,
      where: BCWS_ACTIVE_WHERE,
      signal,
    });
    if (!result.complete) return null;
    return result.collection.features
      .filter((feature) => bcwsStatusClass(feature.properties?.['FIRE_STATUS']) === 'active')
      .map((feature) => ({ properties: feature.properties, geometry: feature.geometry }));
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * The BC layer's fire areas when its complete answer has been grouped, so a
 * known overlapping pair counts once, with the view that answer covers; null
 * when no grouping can say (the layer off, failed or partial, or its
 * grouping pending or failed).
 */
async function knownFireAreas(): Promise<{ readonly areaOf: (recordKey: string) => string | null; readonly coverage: ViewEnvelope } | null> {
  const status = registry.getStatus('bcws-fires');
  if (status !== 'ready' && status !== 'no-data') return null;
  const { fireAreas, loadedBcwsCollection } = await import('../layers/bcws-fires');
  const areas = fireAreas();
  const coverage = loadedBcwsCollection()?.coverage ?? null;
  if (coverage === null || (areas.status !== 'complete' && areas.status !== 'none')) return null;
  return { areaOf: (recordKey) => areas.areaOf.get(recordKey) ?? null, coverage };
}

/** Whether the BC layer's grouped view reaches over all of a framing's British Columbia part (pairs outside it were never grouped). */
function groupedViewCovers(coverage: ViewEnvelope, key: FramingKey): boolean {
  const bbox = framingBbox(key);
  if (bbox === null) return false;
  const [west, south, east, north] = BCWS_COVERAGE;
  return bboxCoveredByEnvelope(coverage, [Math.max(bbox[0], west), Math.max(bbox[1], south), Math.min(bbox[2], east), Math.min(bbox[3], north)]);
}

/**
 * One framing's current-fire result with BC beside NIFC. A framing outside
 * British Columbia keeps its NIFC result. Inside it: BC unknown and no NIFC
 * perimeter is unavailable (never a zero for the Province, never a WHP
 * fallback); NIFC perimeters with BC unknown are still mapped-wildfire, BC
 * marked unavailable. Fire areas merge only when both agencies' records are
 * in hand (NIFC from the layer's loaded answer) and the BC layer has grouped
 * them over the whole framing. Otherwise no overlap can be established, so
 * the two counts are never added: the framing takes the larger, a lower bound
 * on distinct fire areas, and states each agency's own.
 */
function combineWithBc(
  outcome: FramingCountOutcome,
  bc: readonly { readonly properties: Record<string, unknown> | null; readonly geometry: Geometry | null }[] | null,
  known: { readonly areaOf: (recordKey: string) => string | null; readonly coverage: ViewEnvelope } | null,
): { readonly result: MinimapWildfireCountResult; readonly bcwsPerimeterCount?: number | null; readonly fireAreasMerged?: number; readonly nifcPerimeterCount?: number } {
  if (!framingReachesBc(outcome.key) || outcome.result.status === 'unavailable') return { result: outcome.result };
  if (bc === null) {
    return outcome.result.count > 0
      ? { result: outcome.result, bcwsPerimeterCount: null, fireAreasMerged: 0 }
      : { result: { status: 'unavailable', count: null }, bcwsPerimeterCount: null, fireAreasMerged: 0 };
  }
  const frame = framingGeometry(outcome.key);
  const bcRows: CountedPerimeter[] = bc
    .filter((feature) => geometriesOverlap(feature.geometry, frame))
    .map((feature, i) => {
      const recordKey = fireRecordKey('bcws', feature.properties);
      return { identity: recordKey ?? `bcws-row:${i}`, recordKey };
    });
  if (outcome.rows === undefined || known === null || !groupedViewCovers(known.coverage, outcome.key)) {
    const both = outcome.result.count > 0 && bcRows.length > 0;
    return {
      result: { status: 'live', count: Math.max(outcome.result.count, bcRows.length) },
      bcwsPerimeterCount: bcRows.length, fireAreasMerged: 0, ...(both ? { nifcPerimeterCount: outcome.result.count } : {})
    };
  }
  const { count, merged } = countFireAreas([...outcome.rows, ...bcRows], known.areaOf);
  return { result: { status: 'live', count }, bcwsPerimeterCount: bcRows.length, fireAreasMerged: merged };
}

/**
 * The mapped-wildfire mark's fill opacity by intersecting perimeter count,
 * ascending lower bounds, roughly log-spaced so one perimeter and a busy
 * framing read differently. The hue stays the one borrowed NIFC mark; only
 * its depth over the dark card follows the count.
 */
export const MINIMAP_WILDFIRE_COUNT_TIERS: readonly {
  readonly min: number;
  readonly opacity: number;
}[] = [
  { min: 1, opacity: 0.4 },
  { min: 2, opacity: 0.6 },
  { min: 10, opacity: 0.8 },
  { min: 50, opacity: 1 },
];

export function mappedWildfireFillOpacity(count: number): number {
  let opacity = MINIMAP_WILDFIRE_COUNT_TIERS[0]!.opacity;
  for (const tier of MINIMAP_WILDFIRE_COUNT_TIERS) {
    if (count >= tier.min) opacity = tier.opacity;
  }
  return opacity;
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
  /** The counted NIFC records, when the count came from the layer's loaded answer. */
  readonly rows?: readonly CountedPerimeter[];
}

async function queryFramingCount(
  key: FramingKey,
  signal: AbortSignal,
): Promise<FramingCountOutcome> {
  // Synchronous guard BEFORE any `await`: when the layer is off (the
  // pure-lane runtime tests never activate it, and every real boot the
  // layer is off), this never touches a promise, so all nine framings'
  // POSTs still fire in the SAME synchronous tick as before this task (the
  // existing "shares nine concurrent POSTs" and "final release aborts all
  // pending requests" cases depend on exactly that).
  const nifcLayerStatus = registry.getStatus('nifc-fires');
  if (nifcLayerStatus === 'ready' || nifcLayerStatus === 'degraded') {
    const fromCollection = await countFromLoadedNifcCollection(key);
    if (fromCollection !== null) {
      return { key, result: { status: 'live', count: fromCollection.count }, rows: fromCollection.rows };
    }
  }
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
    // The nine NIFC reads start in this tick, as before; the BC read beside them.
    const nifcOutcomes = Promise.all(
      FRAMING_KEYS.map((key) => queryFramingCount(key, signal)),
    );
    const bcActive = readBcwsActive(signal);
    const [counted, bc, known] = await Promise.all([nifcOutcomes, bcActive, knownFireAreas()]);
    if (signal.aborted || epoch !== loadEpoch || retainCount === 0) return;
    const combined = counted.map((outcome) => ({ outcome, ...combineWithBc(outcome, bc, known) }));
    const outcomes = combined.map(({ outcome, result }) => ({ ...outcome, result }));

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
      combined.map(({ outcome, result, bcwsPerimeterCount, fireAreasMerged, nifcPerimeterCount }) => [
        outcome.key,
        {
          ...deriveMinimapWildfireSummary(result, MINIMAP_WHP.framings[outcome.key]),
          ...(bcwsPerimeterCount === undefined ? {} : { bcwsPerimeterCount, fireAreasMerged: fireAreasMerged ?? 0 }),
          ...(nifcPerimeterCount === undefined ? {} : { nifcPerimeterCount }),
        },
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
