/**
 * Live North American Drought Monitor (NADM) summaries for the framing
 * minimap.
 *
 * NADM publishes one monthly polygon feature per occupied D0 through D4
 * class. The minimap estimates the area share of those classes inside each
 * ATNI-authored framing with a 0.5 degree latitude-weighted sampling grid
 * (0.05 degree for Hawaii). Country-filtered extensions include southern
 * Mexico, Alaska and the Aleutians, and analyzed Canadian land omitted by the
 * original navigation silhouettes. Samples on assessed land that are not
 * covered by a drought polygon are the `none` class. The display fill is an
 * explicitly approximate area-weighted ordinal severity: None=0, D0=1,
 * through D4=5, rounded to the nearest display class with exact half-step
 * ties retained at the less severe class. This is a navigation overview, not
 * an official regional drought classification, a replacement for the source
 * polygons, or a local drought determination.
 *
 * The northern Canada qualification remains load-bearing: the NADM map marks
 * Nunavut as not analyzed, while the compact GeoJSON has no coverage-mask
 * field. A generalized Statistics Canada Nunavut boundary is therefore used
 * as a subtractive analysis-mask proxy, never as display geometry. Partial
 * summaries report the proxy-excluded share because this is not NADM's
 * production mask.
 *
 * Runtime work is single-flight, cancellable when the final minimap consumer
 * unmounts, and bounded by a 15-second fetch budget.
 */

import type { Position } from 'geojson';

import {
  FRAMING_ANALYSIS_AREAS,
  FRAMING_SHAPES,
  HAWAII_ISLAND_SHAPES,
} from '../config/framing-shapes';
import type {
  FramingAnalysisArea,
  LonLat,
  NadmCountryCode,
} from '../config/framing-shapes';
import type { FramingKey } from '../config/framings';
import { FRAMING_KEYS } from '../config/framings';
import type { DroughtSeverityCode } from '../config/palette';
import { URLS } from '../config/urls';
import {
  fetchJsonWithBudget,
  fetchSharedJsonWithBudget,
  invalidateSharedJsonRequest,
} from '../util/fetch';
import {
  nadmPolygonsFromGeometry,
  NADM_DROUGHT_CODES,
  normalizeNadmDroughtCode,
  normalizeNadmMonth,
  type NadmDroughtCode,
} from '../util/nadm';

const FETCH_TIMEOUT_MS = 15_000;
const MAINLAND_SAMPLE_STEP_DEGREES = 0.5;
const HAWAII_SAMPLE_STEP_DEGREES = 0.05;
const CLASSIFY_ORDER = ['D4', 'D3', 'D2', 'D1', 'D0'] as const;
const SUMMARY_ORDER: readonly DroughtSeverityCode[] = [
  'none',
  ...NADM_DROUGHT_CODES,
];

const SEVERITY_SCORE: Readonly<Record<DroughtSeverityCode, number>> = {
  none: 0,
  D0: 1,
  D1: 2,
  D2: 3,
  D3: 4,
  D4: 5,
};

type CoverageState = 'live' | 'live-partial';

export interface FramingDroughtSummary {
  /** Approximate area-weighted ordinal score, where None=0 through D4=5. */
  readonly averageSeverityScore: number;
  /** Presentation bucket nearest to averageSeverityScore; half ties round down. */
  readonly averageClass: DroughtSeverityCode;
  readonly dominant: DroughtSeverityCode;
  readonly dominantPercent: number;
  /** D1 through D4 share. D0 is dry, but is not a drought class. */
  readonly droughtPercent: number;
  /** D0 through D4 share. */
  readonly dryOrDroughtPercent: number;
  /** Share of framing land removed by the documented not-analyzed proxy. */
  readonly notAnalyzedPercent: number;
  readonly distribution: Readonly<Record<DroughtSeverityCode, number>>;
  /** Assessed grid samples used for the drought distribution. */
  readonly samples: number;
  /** Land grid samples removed by the not-analyzed proxy. */
  readonly excludedSamples: number;
  readonly coverage: CoverageState;
}

export type MinimapDroughtStatus = 'idle' | 'loading' | 'live' | 'unavailable';

export interface MinimapDroughtSnapshot {
  readonly status: MinimapDroughtStatus;
  readonly month: string | null;
  readonly summaries: Readonly<
    Partial<Record<FramingKey, FramingDroughtSummary>>
  >;
}

interface PreparedPolygon {
  readonly rings: readonly (readonly Position[])[];
  readonly bbox: readonly [number, number, number, number];
}

interface PreparedLandPolygon extends PreparedPolygon {
  readonly country: NadmCountryCode;
}

interface PreparedCategory {
  readonly code: NadmDroughtCode;
  readonly polygons: readonly PreparedPolygon[];
}

interface PreparedNadm {
  readonly month: string;
  readonly categories: ReadonlyMap<NadmDroughtCode, PreparedCategory>;
  readonly landPolygons: readonly PreparedLandPolygon[];
  readonly analysisExclusionPolygons: readonly PreparedPolygon[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function ringBounds(
  ring: readonly Position[] | readonly LonLat[],
): readonly [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const point of ring) {
    const longitude = point[0];
    const latitude = point[1];
    if (longitude === undefined || latitude === undefined) continue;
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

function pointInRing(
  longitude: number,
  latitude: number,
  ring: readonly Position[] | readonly LonLat[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const a = ring[index];
    const b = ring[previous];
    if (!a || !b) continue;
    const ax = a[0];
    const ay = a[1];
    const bx = b[0];
    const by = b[1];
    if (
      ax === undefined ||
      ay === undefined ||
      bx === undefined ||
      by === undefined
    ) {
      continue;
    }
    const straddles = ay > latitude !== by > latitude;
    if (
      straddles &&
      longitude < ((bx - ax) * (latitude - ay)) / (by - ay) + ax
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(
  longitude: number,
  latitude: number,
  rings: readonly (readonly Position[])[],
): boolean {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(longitude, latitude, ring)) inside = !inside;
  }
  return inside;
}

function preparePolygon(
  rings: readonly (readonly Position[])[],
): PreparedPolygon {
  const outer = rings[0];
  if (!outer) throw new Error('NADM polygon is missing an outer ring.');
  return { rings, bbox: ringBounds(outer) };
}

function prepareLandPolygons(value: unknown): readonly PreparedLandPolygon[] {
  if (!isRecord(value) || value['type'] !== 'FeatureCollection') {
    throw new Error('NADM land base is not a FeatureCollection.');
  }
  const features = value['features'];
  if (!Array.isArray(features))
    throw new Error('NADM land base has no features.');

  const polygons: PreparedLandPolygon[] = [];
  for (const feature of features) {
    if (
      !isRecord(feature) ||
      !isRecord(feature['properties']) ||
      !isRecord(feature['geometry'])
    ) {
      throw new Error('NADM land base contains a malformed feature.');
    }
    const country = String(
      feature['properties']['FIPS_CNTRY'] ?? '',
    ).toUpperCase();
    if (!['US', 'CA', 'MX'].includes(country)) continue;
    const countryCode = country as NadmCountryCode;
    polygons.push(
      ...nadmPolygonsFromGeometry(feature['geometry']).map((rings) => ({
        ...preparePolygon(rings),
        country: countryCode,
      })),
    );
  }
  if (polygons.length === 0) {
    throw new Error('NADM land base has no US, Canada, or Mexico geometry.');
  }
  return polygons;
}

function prepareAnalysisExclusions(value: unknown): readonly PreparedPolygon[] {
  if (!isRecord(value) || value['type'] !== 'FeatureCollection') {
    throw new Error('NADM analysis-mask proxy is not a FeatureCollection.');
  }
  const features = value['features'];
  if (!Array.isArray(features) || features.length !== 1) {
    throw new Error('NADM analysis-mask proxy must contain Nunavut only.');
  }
  const feature = features[0];
  if (
    !isRecord(feature) ||
    !isRecord(feature['properties']) ||
    !isRecord(feature['geometry']) ||
    String(feature['properties']['PRUID'] ?? '') !== '62'
  ) {
    throw new Error('NADM analysis-mask proxy is not the Nunavut boundary.');
  }
  return nadmPolygonsFromGeometry(feature['geometry']).map(preparePolygon);
}

function prepareNadm(
  value: unknown,
  landValue: unknown,
  analysisExclusionValue: unknown,
): PreparedNadm {
  if (!isRecord(value) || value['type'] !== 'FeatureCollection') {
    throw new Error('NADM response is not a FeatureCollection.');
  }
  const features = value['features'];
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('NADM response has no classified features.');
  }

  let month: string | null = null;
  const polygonsByCode = new Map<NadmDroughtCode, PreparedPolygon[]>();
  for (const feature of features) {
    if (
      !isRecord(feature) ||
      !isRecord(feature['properties']) ||
      !isRecord(feature['geometry'])
    ) {
      throw new Error('NADM response contains a malformed feature.');
    }
    const code = normalizeNadmDroughtCode(feature['properties']['DROUGHTCAT']);
    const featureMonth = normalizeNadmMonth(feature['properties']['YEAR_MONTH']);
    if (code === null || featureMonth === null) {
      throw new Error('NADM feature has an invalid class or consensus month.');
    }
    if (month !== null && month !== featureMonth) {
      throw new Error('NADM response mixes consensus months.');
    }
    month = featureMonth;

    const polygons = nadmPolygonsFromGeometry(feature['geometry']);
    const bucket = polygonsByCode.get(code) ?? [];
    bucket.push(...polygons.map(preparePolygon));
    polygonsByCode.set(code, bucket);
  }
  if (month === null) throw new Error('NADM response has no consensus month.');

  const categories = new Map<NadmDroughtCode, PreparedCategory>();
  for (const code of NADM_DROUGHT_CODES) {
    const polygons = polygonsByCode.get(code);
    if (polygons) categories.set(code, { code, polygons });
  }
  return {
    month,
    categories,
    landPolygons: prepareLandPolygons(landValue),
    analysisExclusionPolygons: prepareAnalysisExclusions(
      analysisExclusionValue,
    ),
  };
}

function pointInPreparedPolygons(
  longitude: number,
  latitude: number,
  polygons: readonly PreparedPolygon[],
): boolean {
  for (const polygon of polygons) {
    if (pointInPreparedPolygon(longitude, latitude, polygon)) return true;
  }
  return false;
}

/** Western Aleutian sampling uses normalized longitudes below -180. Source
 * polygons retain conventional 172E coordinates, so test the wrapped value
 * without rewriting or redistributing source geometry. */
function longitudeCandidates(longitude: number): readonly number[] {
  if (longitude < -180) return [longitude, longitude + 360];
  if (longitude > 180) return [longitude, longitude - 360];
  return [longitude];
}

function pointInPreparedPolygon(
  longitude: number,
  latitude: number,
  polygon: PreparedPolygon,
): boolean {
  const [west, south, east, north] = polygon.bbox;
  if (latitude < south || latitude > north) return false;
  for (const candidate of longitudeCandidates(longitude)) {
    if (candidate < west || candidate > east) continue;
    if (pointInPolygon(candidate, latitude, polygon.rings)) return true;
  }
  return false;
}

function countriesAt(
  longitude: number,
  latitude: number,
  polygons: readonly PreparedLandPolygon[],
): readonly NadmCountryCode[] {
  const countries = new Set<NadmCountryCode>();
  for (const polygon of polygons) {
    if (pointInPreparedPolygon(longitude, latitude, polygon)) {
      countries.add(polygon.country);
    }
  }
  return [...countries];
}

function categoryAt(
  longitude: number,
  latitude: number,
  prepared: PreparedNadm,
): DroughtSeverityCode {
  for (const code of CLASSIFY_ORDER) {
    const category = prepared.categories.get(code);
    if (!category) continue;
    if (pointInPreparedPolygons(longitude, latitude, category.polygons))
      return code;
  }
  return 'none';
}

function emptyWeights(): Record<DroughtSeverityCode, number> {
  return { none: 0, D0: 0, D1: 0, D2: 0, D3: 0, D4: 0 };
}

function roundedPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1_000) / 10;
}

function roundedScore(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Map an ordinal mean to its nearest drought class without overstating ties. */
export function droughtAverageClassForScore(
  score: number,
): DroughtSeverityCode {
  const index = Math.max(
    0,
    Math.min(SUMMARY_ORDER.length - 1, Math.floor(score + 0.5 - 1e-9)),
  );
  return SUMMARY_ORDER[index] ?? 'none';
}

function summarizeShape(
  areas: readonly FramingAnalysisArea[],
  prepared: PreparedNadm,
  step: number,
): FramingDroughtSummary {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const area of areas) {
    const bounds = ringBounds(area.shape);
    west = Math.min(west, bounds[0]);
    south = Math.min(south, bounds[1]);
    east = Math.max(east, bounds[2]);
    north = Math.max(north, bounds[3]);
  }

  const weights = emptyWeights();
  let samples = 0;
  let excludedSamples = 0;
  let excludedWeight = 0;
  for (let latitude = south + step / 2; latitude < north; latitude += step) {
    for (let longitude = west + step / 2; longitude < east; longitude += step) {
      const containingAreas = areas.filter((area) =>
        pointInRing(longitude, latitude, area.shape),
      );
      if (containingAreas.length === 0) continue;
      const countries = countriesAt(longitude, latitude, prepared.landPolygons);
      if (countries.length === 0) continue;
      const isEligible = containingAreas.some(
        (area) =>
          area.countries === undefined ||
          area.countries.some((country) => countries.includes(country)),
      );
      if (!isEligible) continue;
      const sampleWeight = Math.cos((latitude * Math.PI) / 180);
      if (
        pointInPreparedPolygons(
          longitude,
          latitude,
          prepared.analysisExclusionPolygons,
        )
      ) {
        excludedWeight += sampleWeight;
        excludedSamples++;
        continue;
      }
      const code = categoryAt(longitude, latitude, prepared);
      weights[code] += sampleWeight;
      samples++;
    }
  }
  if (samples === 0)
    throw new Error('A minimap framing produced no area samples.');

  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  // Exact ties deterministically retain the first SUMMARY_ORDER class. This
  // is the less severe class, beginning with None, and avoids overstating a
  // condition when the coarse overview grid cannot distinguish the shares.
  let dominant: DroughtSeverityCode = 'none';
  for (const code of SUMMARY_ORDER) {
    if (weights[code] > weights[dominant]) dominant = code;
  }
  const distribution = Object.fromEntries(
    SUMMARY_ORDER.map((code) => [code, roundedPercent(weights[code], total)]),
  ) as Record<DroughtSeverityCode, number>;
  const averageSeverityScore =
    SUMMARY_ORDER.reduce(
      (sum, code) => sum + weights[code] * SEVERITY_SCORE[code],
      0,
    ) / total;

  return {
    averageSeverityScore: roundedScore(averageSeverityScore),
    averageClass: droughtAverageClassForScore(averageSeverityScore),
    dominant,
    dominantPercent: distribution[dominant],
    droughtPercent: roundedPercent(
      weights.D1 + weights.D2 + weights.D3 + weights.D4,
      total,
    ),
    dryOrDroughtPercent: roundedPercent(
      weights.D0 + weights.D1 + weights.D2 + weights.D3 + weights.D4,
      total,
    ),
    notAnalyzedPercent: roundedPercent(excludedWeight, total + excludedWeight),
    distribution,
    samples,
    excludedSamples,
    coverage: excludedWeight > 0 ? 'live-partial' : 'live',
  };
}

/** Validate a NADM response and derive all nine minimap summaries. */
export function deriveMinimapDroughtSnapshot(
  value: unknown,
  landValue: unknown,
  analysisExclusionValue: unknown,
): MinimapDroughtSnapshot {
  const prepared = prepareNadm(value, landValue, analysisExclusionValue);
  const summaries: Partial<Record<FramingKey, FramingDroughtSummary>> = {};
  for (const key of FRAMING_KEYS) {
    if (key === 'hawaii') {
      summaries[key] = summarizeShape(
        HAWAII_ISLAND_SHAPES.map((shape) => ({
          shape,
          countries: ['US'] as const,
        })),
        prepared,
        HAWAII_SAMPLE_STEP_DEGREES,
      );
      continue;
    }
    const areas = FRAMING_ANALYSIS_AREAS[key] ?? [
      { shape: FRAMING_SHAPES[key] },
    ];
    summaries[key] = summarizeShape(
      areas,
      prepared,
      MAINLAND_SAMPLE_STEP_DEGREES,
    );
  }
  return { status: 'live', month: prepared.month, summaries };
}

const EMPTY_SUMMARIES: Readonly<
  Partial<Record<FramingKey, FramingDroughtSummary>>
> = {};

let snapshot: MinimapDroughtSnapshot = {
  status: 'idle',
  month: null,
  summaries: EMPTY_SUMMARIES,
};
let controller: AbortController | null = null;
let retainCount = 0;
const listeners = new Set<(next: MinimapDroughtSnapshot) => void>();

function publish(next: MinimapDroughtSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener(next));
}

async function load(): Promise<void> {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  publish({ status: 'loading', month: null, summaries: EMPTY_SUMMARIES });
  try {
    const [value, landValue, analysisExclusionValue] = await Promise.all([
      fetchSharedJsonWithBudget(
        'nadm-current',
        URLS.nadmCurrentGeojson,
        { cache: 'no-store' },
        signal,
        FETCH_TIMEOUT_MS,
      ),
      fetchJsonWithBudget(
        URLS.nadmNorthAmericaBaseGeojson,
        { cache: 'no-store' },
        signal,
        FETCH_TIMEOUT_MS,
      ),
      fetchJsonWithBudget(
        URLS.statsCanNunavutBoundaryGeojson,
        { cache: 'no-store' },
        signal,
        FETCH_TIMEOUT_MS,
      ),
    ]);
    if (signal.aborted) return;
    publish(
      deriveMinimapDroughtSnapshot(value, landValue, analysisExclusionValue),
    );
  } catch (error) {
    if (signal.aborted) return;
    controller?.abort();
    invalidateSharedJsonRequest('nadm-current');
    console.warn('[minimap-drought] continental summary load failed.', error);
    publish({ status: 'unavailable', month: null, summaries: EMPTY_SUMMARIES });
  } finally {
    if (controller?.signal === signal) controller = null;
  }
}

/** Current state for the two concurrently mounted minimap instances. */
export function getMinimapDroughtSnapshot(): MinimapDroughtSnapshot {
  return snapshot;
}

/**
 * Retain the shared live summary feed. The first consumer starts it; the last
 * consumer aborts a still-running request.
 */
export function retainMinimapDrought(
  listener: (next: MinimapDroughtSnapshot) => void,
): () => void {
  retainCount++;
  listeners.add(listener);
  listener(snapshot);
  if (snapshot.status === 'idle') void load();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    listeners.delete(listener);
    retainCount = Math.max(0, retainCount - 1);
    if (
      retainCount === 0 &&
      (snapshot.status === 'loading' || snapshot.status === 'unavailable')
    ) {
      controller?.abort();
      controller = null;
      snapshot = { status: 'idle', month: null, summaries: EMPTY_SUMMARIES };
    }
  };
}
