/**
 * The Place Studio overlap engine: which listed candidates a selected
 * geometry contains, sits within, or merely overlaps, with the area evidence
 * behind each verdict.
 *
 * It lives beside its one consumer (`place-studio.tsx`) rather than in
 * `src/impact/` (DR-015 a). `src/impact/` builds claims; this builds a studio
 * listing, so keeping it here leaves the briefing's dependency graph readable
 * while the entry chunk sits near its line. Pure: geometry in, rows out, no
 * DOM and no application state.
 *
 * Areas are planar in (longitude in radians, sine of latitude), which is
 * equal-area on the sphere; the sweep-line clipper `polygon-clipping` does the
 * intersections and also normalizes each geometry once (self-crossing rings
 * and overlapping parts), so its area agrees with the intersection's.
 */

import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  MultiPolygon,
  Polygon,
  Position
} from 'geojson';
import polygonClipping, {
  type MultiPolygon as ClipMultiPolygon,
  type Polygon as ClipPolygon,
  type Ring as ClipRing
} from 'polygon-clipping';

import { geometryBboxAcrossAntimeridian } from '../../util/antimeridian';
import { bboxIntersects } from '../../util/bbox';

/** D-0.7.0-050: overlaps below this share of the smaller area are slivers. */
export const OVERLAP_SLIVER_SHARE = 0.02 as const;

export type OverlapRelationship = 'within' | 'contains' | 'overlaps';

/** Area evidence used for both the relationship and sliver decisions. */
export interface OverlapAreaEvidence {
  readonly selectedAreaSquareMetres: number;
  readonly candidateAreaSquareMetres: number;
  readonly intersectionAreaSquareMetres: number;
  readonly shareOfSelectedArea: number;
  readonly shareOfCandidateArea: number;
  readonly shareOfSmallerArea: number;
}

/** One listed candidate, classified from the selected geometry's perspective. */
export interface OverlapRow<
  G extends Geometry | null = Geometry,
  P = GeoJsonProperties
> {
  readonly candidate: Feature<G, P>;
  readonly relationship: OverlapRelationship;
  readonly evidence: OverlapAreaEvidence;
}

export type OverlapGeometryRejectionReason = 'invalid-polygon-component';

export interface OverlapSelectionRejection {
  readonly source: 'selection';
  readonly reason: OverlapGeometryRejectionReason;
}

export interface OverlapCandidateRejection<
  G extends Geometry | null = Geometry,
  P = GeoJsonProperties
> {
  readonly source: 'candidate';
  readonly reason: OverlapGeometryRejectionReason;
  readonly candidate: Feature<G, P>;
}

export type OverlapGeometryRejection<
  G extends Geometry | null = Geometry,
  P = GeoJsonProperties
> = OverlapSelectionRejection | OverlapCandidateRejection<G, P>;

export interface OverlapResult<
  G extends Geometry | null = Geometry,
  P = GeoJsonProperties
> {
  readonly rows: ReadonlyArray<OverlapRow<G, P>>;
  readonly hasSuppressedSlivers: boolean;
  readonly rejections?: ReadonlyArray<OverlapGeometryRejection<G, P>>;
}

type ArealGeometry = Polygon | MultiPolygon;

interface PreparedGeometry {
  readonly area: number;
  readonly polygons: ClipMultiPolygon;
  /** Projected `[west, south, east, north]` of each polygon's outer ring. */
  readonly boxes: ReadonlyArray<readonly [number, number, number, number]>;
  readonly referenceLongitude: number;
}

type GeometryPreparation =
  | { readonly status: 'prepared'; readonly geometry: PreparedGeometry }
  | { readonly status: 'omitted' }
  | {
    readonly status: 'rejected';
    readonly reason: OverlapGeometryRejectionReason;
  };

const EARTH_RADIUS_METRES = 6_371_008.8;
const SQUARE_METRES_PER_UNIT_AREA = EARTH_RADIUS_METRES * EARTH_RADIUS_METRES;
const AREA_EPSILON = 1e-18;
const COVERAGE_EPSILON = 1e-10;
const REJECTED: GeometryPreparation = { status: 'rejected', reason: 'invalid-polygon-component' };

function isArealGeometry(geometry: Geometry | null | undefined): geometry is ArealGeometry {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && longitude > 0 ? 180 : normalized;
}

function alignLongitudeToReference(longitude: number, reference: number): number {
  return longitude + 360 * Math.round((reference - longitude) / 360);
}

function signedArea(points: readonly ClipRing[number][]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
}

/** Area of clipper output: outer rings add, holes subtract. */
function clipArea(polygons: ClipMultiPolygon): number {
  let area = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      area += (index === 0 ? 1 : -1) * Math.abs(signedArea(ring));
    });
  }
  return area;
}

/**
 * Unwrap a ring across the antimeridian and project it. Returns null for
 * non-finite or out-of-range coordinates (reject), and 'empty' for fewer than
 * three vertices or zero area in RAW longitude/latitude (skip): real agency
 * shapes carry such pieces (Lummi, Navajo), and the sine projection would
 * give an authored collinear ring a tiny curvature-induced area, a
 * full-share row the relative sliver rule cannot suppress.
 */
function projectRing(
  coordinates: readonly Position[],
  referenceLongitude: number | undefined
): { ring: ClipRing; referenceLongitude: number } | 'empty' | null {
  const unwrapped: ClipRing = [];
  let previousLongitude = referenceLongitude;

  for (const [longitude, latitude] of coordinates) {
    if (longitude === undefined || latitude === undefined ||
      !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      latitude < -90 || latitude > 90) {
      return null;
    }
    const normalized = normalizeLongitude(longitude);
    const unwrappedLongitude = previousLongitude === undefined
      ? normalized
      : alignLongitudeToReference(normalized, previousLongitude);
    unwrapped.push([unwrappedLongitude, latitude]);
    previousLongitude = unwrappedLongitude;
  }

  const first = unwrapped[0];
  const last = unwrapped[unwrapped.length - 1];
  if (unwrapped.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) {
    unwrapped.pop();
  }
  if (unwrapped.length < 3 || Math.abs(signedArea(unwrapped)) <= AREA_EPSILON) return 'empty';

  const meanLongitude = unwrapped.reduce((sum, point) => sum + point[0], 0) / unwrapped.length;
  const longitudeShift = referenceLongitude === undefined
    ? 0
    : 360 * Math.round((referenceLongitude - meanLongitude) / 360);
  return {
    ring: unwrapped.map(([longitude, latitude]) => [
      ((longitude + longitudeShift) * Math.PI) / 180,
      Math.sin((latitude * Math.PI) / 180)
    ]),
    referenceLongitude: meanLongitude + longitudeShift
  };
}

function projectPolygon(
  coordinates: Polygon['coordinates'],
  referenceLongitude: number | undefined
): { polygon: ClipPolygon; referenceLongitude: number } | 'empty' | null {
  const outerCoordinates = coordinates[0];
  if (!outerCoordinates) return null;
  const outer = projectRing(outerCoordinates, referenceLongitude);
  if (outer === null) return null;
  // A zero-area outer ring still has its holes checked for bad coordinates.
  const polygon: ClipPolygon = outer === 'empty' ? [] : [outer.ring];
  for (const holeCoordinates of coordinates.slice(1)) {
    const hole = projectRing(
      holeCoordinates,
      outer === 'empty' ? referenceLongitude : outer.referenceLongitude
    );
    if (hole === null) return null;
    if (hole !== 'empty') polygon.push(hole.ring);
  }
  if (outer === 'empty') return 'empty';
  return { polygon, referenceLongitude: outer.referenceLongitude };
}

function prepareGeometry(
  geometry: Geometry | null | undefined,
  alignmentReference?: number
): GeometryPreparation {
  if (!isArealGeometry(geometry)) return { status: 'omitted' };
  const polygonCoordinates = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates;
  const polygons: ClipPolygon[] = [];
  let referenceLongitude = alignmentReference;

  for (const coordinates of polygonCoordinates) {
    const projected = projectPolygon(coordinates, referenceLongitude);
    // A malformed component is always reported, including the case where
    // EVERY component failed (IB-10), so a wholly malformed geometry never
    // reads like a non-areal one. A zero-area component is skipped, but a
    // geometry with no real area left is rejected the same way.
    if (!projected) return REJECTED;
    if (projected === 'empty') continue;
    polygons.push(projected.polygon);
    referenceLongitude = referenceLongitude === undefined
      ? projected.referenceLongitude
      : (referenceLongitude * (polygons.length - 1) + projected.referenceLongitude) / polygons.length;
  }
  if (polygons.length === 0 && polygonCoordinates.length > 0) return REJECTED;
  if (polygons.length === 0 || referenceLongitude === undefined) return { status: 'omitted' };

  let normalized: ClipMultiPolygon;
  try {
    normalized = polygonClipping.union(polygons);
  } catch {
    return REJECTED;
  }
  const area = clipArea(normalized);
  if (area <= AREA_EPSILON) return { status: 'omitted' };
  const boxes = normalized.map(([outer = []]) => outer.reduce<[number, number, number, number]>(
    (box, [x, y]) => [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity]
  ));
  return { status: 'prepared', geometry: { area, polygons: normalized, boxes, referenceLongitude } };
}

/** Intersection area, clipping only the selected parts whose box meets one of the candidate's. */
function clippedArea(selected: PreparedGeometry, candidate: PreparedGeometry): number {
  const nearby = selected.polygons.filter((_, index) => {
    const a = selected.boxes[index];
    return a !== undefined && candidate.boxes.some((b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]);
  });
  return nearby.length === 0 ? 0 : clipArea(polygonClipping.intersection(nearby, candidate.polygons));
}

function areasAreEqual(first: number, second: number): boolean {
  return Math.abs(first - second) <= Math.max(first, second) * COVERAGE_EPSILON;
}

function classifyRelationship(
  selectedArea: number,
  candidateArea: number,
  intersectionArea: number
): OverlapRelationship {
  if (areasAreEqual(intersectionArea, selectedArea)) return 'within';
  if (areasAreEqual(intersectionArea, candidateArea)) return 'contains';
  return 'overlaps';
}

function toSquareMetres(unitArea: number): number {
  return unitArea * SQUARE_METRES_PER_UNIT_AREA;
}

/**
 * Classify areal candidates against a selected Polygon or MultiPolygon.
 * Non-areal and wholly degenerate geometries are omitted. Mixed-validity
 * MultiPolygons are reported through rejections instead of being repaired.
 * Candidate order is preserved. Touching at an edge or point is not overlap.
 */
export function computeOverlapRows<
  G extends Geometry | null = Geometry,
  P = GeoJsonProperties
>(
  selectedGeometry: Geometry | null | undefined,
  candidates: FeatureCollection<G, P>
): OverlapResult<G, P> {
  const selectedPreparation = prepareGeometry(selectedGeometry);
  if (selectedPreparation.status === 'omitted') {
    return { rows: [], hasSuppressedSlivers: false };
  }
  if (selectedPreparation.status === 'rejected') {
    return {
      rows: [],
      hasSuppressedSlivers: false,
      rejections: [{
        source: 'selection',
        reason: selectedPreparation.reason
      }]
    };
  }
  const selected = selectedPreparation.geometry;
  const selectedBbox = geometryBboxAcrossAntimeridian(selectedGeometry);

  const rows: Array<OverlapRow<G, P>> = [];
  const rejections: Array<OverlapGeometryRejection<G, P>> = [];
  let hasSuppressedSlivers = false;

  for (const candidate of candidates.features) {
    // A candidate whose box misses the selection's box cannot overlap, so
    // skip it before projecting and clipping.
    const candidateBbox = isArealGeometry(candidate.geometry)
      ? geometryBboxAcrossAntimeridian(candidate.geometry)
      : null;
    // A latitude beyond 90 skips the prefilter (bboxIntersects throws on it); prepareGeometry then rejects it.
    if (selectedBbox && candidateBbox && candidateBbox[1] >= -90 && candidateBbox[3] <= 90 &&
      !bboxIntersects(selectedBbox, candidateBbox)) continue;
    const candidatePreparation = prepareGeometry(candidate.geometry, selected.referenceLongitude);
    if (candidatePreparation.status === 'omitted') continue;
    let preparedCandidate: PreparedGeometry | null = null;
    let rawIntersectionArea = 0;
    if (candidatePreparation.status === 'prepared') {
      preparedCandidate = candidatePreparation.geometry;
      try {
        rawIntersectionArea = clippedArea(selected, preparedCandidate);
      } catch {
        preparedCandidate = null;
      }
    }
    if (!preparedCandidate) {
      rejections.push({ source: 'candidate', reason: 'invalid-polygon-component', candidate });
      continue;
    }
    const intersectionArea = Math.min(
      Math.max(rawIntersectionArea, 0),
      Math.min(selected.area, preparedCandidate.area)
    );
    if (intersectionArea <= AREA_EPSILON) continue;

    const smallerArea = Math.min(selected.area, preparedCandidate.area);
    const shareOfSmallerArea = intersectionArea / smallerArea;
    const isAtSliverBoundary = areasAreEqual(shareOfSmallerArea, OVERLAP_SLIVER_SHARE);
    if (shareOfSmallerArea < OVERLAP_SLIVER_SHARE && !isAtSliverBoundary) {
      hasSuppressedSlivers = true;
      continue;
    }

    rows.push({
      candidate,
      relationship: classifyRelationship(selected.area, preparedCandidate.area, intersectionArea),
      evidence: {
        selectedAreaSquareMetres: toSquareMetres(selected.area),
        candidateAreaSquareMetres: toSquareMetres(preparedCandidate.area),
        intersectionAreaSquareMetres: toSquareMetres(intersectionArea),
        shareOfSelectedArea: intersectionArea / selected.area,
        shareOfCandidateArea: intersectionArea / preparedCandidate.area,
        shareOfSmallerArea
      }
    });
  }

  return rejections.length > 0
    ? { rows, hasSuppressedSlivers, rejections }
    : { rows, hasSuppressedSlivers };
}
