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
type Point = readonly [number, number];
type Triangle = readonly [Point, Point, Point];

interface PreparedRing {
  readonly area: number;
  readonly triangles: ReadonlyArray<Triangle>;
  readonly weight: 1 | -1;
}

interface PreparedPolygon {
  readonly area: number;
  readonly rings: ReadonlyArray<PreparedRing>;
  readonly referenceLongitude: number;
}

interface PreparedGeometry {
  readonly area: number;
  readonly polygons: ReadonlyArray<PreparedPolygon>;
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
const COORDINATE_EPSILON = 1e-14;
const AREA_EPSILON = 1e-18;
const COVERAGE_EPSILON = 1e-10;

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

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) <= COORDINATE_EPSILON &&
    Math.abs(a[1] - b[1]) <= COORDINATE_EPSILON;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function signedArea(points: readonly Point[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  if (Math.abs(cross(start, end, point)) > COORDINATE_EPSILON) return false;
  return point[0] >= Math.min(start[0], end[0]) - COORDINATE_EPSILON &&
    point[0] <= Math.max(start[0], end[0]) + COORDINATE_EPSILON &&
    point[1] >= Math.min(start[1], end[1]) - COORDINATE_EPSILON &&
    point[1] <= Math.max(start[1], end[1]) + COORDINATE_EPSILON;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);

  if (((abC > COORDINATE_EPSILON && abD < -COORDINATE_EPSILON) ||
      (abC < -COORDINATE_EPSILON && abD > COORDINATE_EPSILON)) &&
    ((cdA > COORDINATE_EPSILON && cdB < -COORDINATE_EPSILON) ||
      (cdA < -COORDINATE_EPSILON && cdB > COORDINATE_EPSILON))) {
    return true;
  }

  return (Math.abs(abC) <= COORDINATE_EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= COORDINATE_EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= COORDINATE_EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= COORDINATE_EPSILON && pointOnSegment(b, c, d));
}

/**
 * A ring that visits the same vertex twice (a pinch point) is
 * self-touching even when no two segments properly cross:
 * segmentsIntersect deliberately ignores endpoint contact, so the
 * simplicity scan alone cannot see it.
 */
/** Collapse runs of consecutive equal vertices (cyclically). */
function removeAdjacentDuplicates(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && samePoint(last, point)) continue;
    result.push(point);
  }
  const first = result[0];
  const last = result[result.length - 1];
  if (result.length > 1 && first && last && samePoint(first, last)) result.pop();
  return result;
}

function hasRepeatedVertex(points: readonly Point[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const a = points[first];
    if (!a) continue;
    for (let second = first + 1; second < points.length; second += 1) {
      const b = points[second];
      if (b && samePoint(a, b)) return true;
    }
  }
  return false;
}

function isSimpleRing(points: readonly Point[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const a = points[first];
    const b = points[(first + 1) % points.length];
    if (!a || !b) return false;
    for (let second = first + 1; second < points.length; second += 1) {
      const adjacent = second === first + 1 || (first === 0 && second === points.length - 1);
      if (adjacent) continue;
      const c = points[second];
      const d = points[(second + 1) % points.length];
      if (!c || !d || segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

function removeCollinearPoints(points: readonly Point[]): Point[] {
  const result = [...points];
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    for (let index = 0; index < result.length; index += 1) {
      const previous = result[(index + result.length - 1) % result.length];
      const current = result[index];
      const next = result[(index + 1) % result.length];
      if (!previous || !current || !next) continue;
      if (samePoint(previous, current) || Math.abs(cross(previous, current, next)) <= AREA_EPSILON) {
        result.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function pointInTriangle(point: Point, triangle: Triangle): boolean {
  const [a, b, c] = triangle;
  return cross(a, b, point) >= -COORDINATE_EPSILON &&
    cross(b, c, point) >= -COORDINATE_EPSILON &&
    cross(c, a, point) >= -COORDINATE_EPSILON;
}

function triangulate(points: readonly Point[]): Triangle[] | null {
  const vertices = signedArea(points) > 0 ? [...points] : [...points].reverse();
  const indices = vertices.map((_, index) => index);
  const triangles: Triangle[] = [];
  let attemptsWithoutEar = 0;

  while (indices.length > 3) {
    let clipped = false;
    for (let offset = 0; offset < indices.length; offset += 1) {
      const previousIndex = indices[(offset + indices.length - 1) % indices.length];
      const currentIndex = indices[offset];
      const nextIndex = indices[(offset + 1) % indices.length];
      if (previousIndex === undefined || currentIndex === undefined || nextIndex === undefined) continue;
      const previous = vertices[previousIndex];
      const current = vertices[currentIndex];
      const next = vertices[nextIndex];
      if (!previous || !current || !next || cross(previous, current, next) <= AREA_EPSILON) continue;

      const triangle: Triangle = [previous, current, next];
      const containsVertex = indices.some((vertexIndex) => {
        if (vertexIndex === previousIndex || vertexIndex === currentIndex || vertexIndex === nextIndex) {
          return false;
        }
        const vertex = vertices[vertexIndex];
        return vertex ? pointInTriangle(vertex, triangle) : false;
      });
      if (containsVertex) continue;

      triangles.push(triangle);
      indices.splice(offset, 1);
      clipped = true;
      attemptsWithoutEar = 0;
      break;
    }

    if (!clipped) {
      attemptsWithoutEar += 1;
      if (attemptsWithoutEar > indices.length) return null;
    }
  }

  const aIndex = indices[0];
  const bIndex = indices[1];
  const cIndex = indices[2];
  if (aIndex === undefined || bIndex === undefined || cIndex === undefined) return null;
  const a = vertices[aIndex];
  const b = vertices[bIndex];
  const c = vertices[cIndex];
  if (!a || !b || !c || cross(a, b, c) <= AREA_EPSILON) return null;
  triangles.push([a, b, c]);
  return triangles;
}

function prepareRing(
  coordinates: readonly Position[],
  referenceLongitude: number | undefined,
  weight: 1 | -1
): { ring: PreparedRing; referenceLongitude: number } | null {
  const unwrapped: Array<readonly [number, number]> = [];
  let previousLongitude = referenceLongitude;

  for (const position of coordinates) {
    const longitude = position[0];
    const latitude = position[1];
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

  if (unwrapped.length > 1) {
    const first = unwrapped[0];
    const last = unwrapped[unwrapped.length - 1];
    if (first && last && first[0] === last[0] && first[1] === last[1]) unwrapped.pop();
  }
  if (unwrapped.length < 3) return null;
  // Reject rings that are degenerate in RAW coordinate space before
  // projecting: the sin(latitude) projection is nonlinear, so a ring of
  // exactly collinear longitude/latitude points (zero-area as authored)
  // acquires a tiny curvature-induced area that clears AREA_EPSILON and
  // would otherwise classify as a full-share row the relative sliver
  // rule cannot suppress.
  if (removeCollinearPoints(unwrapped).length < 3) return null;

  const meanLongitude = unwrapped.reduce((sum, point) => sum + point[0], 0) / unwrapped.length;
  const longitudeShift = referenceLongitude === undefined
    ? 0
    : 360 * Math.round((referenceLongitude - meanLongitude) / 360);
  const projected: Point[] = unwrapped.map(([longitude, latitude]) => [
    ((longitude + longitudeShift) * Math.PI) / 180,
    Math.sin((latitude * Math.PI) / 180)
  ]);
  // Order matters: collapse harmless ADJACENT duplicates first (common
  // in real agency data), then reject any surviving repeated vertex as
  // a true pinch BEFORE the collinear cleaning runs. A self-touching
  // spike arm (A -> B -> A) has an exactly-zero cross product at B, so
  // removeCollinearPoints would amputate the spike and silently repair
  // an authored-degenerate ring into a valid polygon.
  const deduped = removeAdjacentDuplicates(projected);
  if (deduped.length < 3 || hasRepeatedVertex(deduped)) return null;
  const cleaned = removeCollinearPoints(deduped);
  if (cleaned.length < 3 || !isSimpleRing(cleaned)) return null;
  const area = Math.abs(signedArea(cleaned));
  if (area <= AREA_EPSILON) return null;
  const triangles = triangulate(cleaned);
  if (!triangles) return null;

  return {
    ring: { area, triangles, weight },
    referenceLongitude: meanLongitude + longitudeShift
  };
}

function preparePolygon(
  coordinates: Polygon['coordinates'],
  referenceLongitude: number | undefined
): PreparedPolygon | null {
  const outerCoordinates = coordinates[0];
  if (!outerCoordinates) return null;
  const outer = prepareRing(outerCoordinates, referenceLongitude, 1);
  if (!outer) return null;

  const rings: PreparedRing[] = [outer.ring];
  let area = outer.ring.area;
  for (const holeCoordinates of coordinates.slice(1)) {
    const hole = prepareRing(holeCoordinates, outer.referenceLongitude, -1);
    if (!hole) return null;
    rings.push(hole.ring);
    area -= hole.ring.area;
  }
  if (area <= AREA_EPSILON) return null;

  return { area, rings, referenceLongitude: outer.referenceLongitude };
}

function prepareGeometry(
  geometry: Geometry | null | undefined,
  alignmentReference?: number
): GeometryPreparation {
  if (!isArealGeometry(geometry)) return { status: 'omitted' };
  const polygonCoordinates = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates;
  const polygons: PreparedPolygon[] = [];
  let invalidPolygonCount = 0;
  let area = 0;
  let referenceLongitude = alignmentReference;

  for (const coordinates of polygonCoordinates) {
    const polygon = preparePolygon(coordinates, referenceLongitude);
    if (!polygon) {
      invalidPolygonCount += 1;
      continue;
    }
    polygons.push(polygon);
    area += polygon.area;
    referenceLongitude = referenceLongitude === undefined
      ? polygon.referenceLongitude
      : (referenceLongitude * (polygons.length - 1) + polygon.referenceLongitude) / polygons.length;
  }

  // A malformed component is always reported, including the case where EVERY
  // component failed (IB-10). Gating this on `polygons.length > 0` made a
  // wholly malformed candidate indistinguishable from a non-areal one: it
  // fell through to `omitted` and left no rejection row.
  if (invalidPolygonCount > 0) {
    return { status: 'rejected', reason: 'invalid-polygon-component' };
  }
  if (polygons.length === 0 || area <= AREA_EPSILON || referenceLongitude === undefined) {
    return { status: 'omitted' };
  }
  return { status: 'prepared', geometry: { area, polygons, referenceLongitude } };
}

function lineIntersection(start: Point, end: Point, clipStart: Point, clipEnd: Point): Point {
  const startDistance = cross(clipStart, clipEnd, start);
  const endDistance = cross(clipStart, clipEnd, end);
  const denominator = startDistance - endDistance;
  if (Math.abs(denominator) <= AREA_EPSILON) return end;
  const fraction = startDistance / denominator;
  return [
    start[0] + fraction * (end[0] - start[0]),
    start[1] + fraction * (end[1] - start[1])
  ];
}

function triangleIntersectionArea(subject: Triangle, clip: Triangle): number {
  let output: Point[] = [...subject];
  for (let edge = 0; edge < clip.length; edge += 1) {
    const clipStart = clip[edge];
    const clipEnd = clip[(edge + 1) % clip.length];
    if (!clipStart || !clipEnd || output.length === 0) return 0;
    const input = output;
    output = [];
    let start = input[input.length - 1];
    if (!start) return 0;
    for (const end of input) {
      const startInside = cross(clipStart, clipEnd, start) >= -COORDINATE_EPSILON;
      const endInside = cross(clipStart, clipEnd, end) >= -COORDINATE_EPSILON;
      if (endInside) {
        if (!startInside) output.push(lineIntersection(start, end, clipStart, clipEnd));
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd));
      }
      start = end;
    }
  }
  return output.length < 3 ? 0 : Math.abs(signedArea(output));
}

function polygonIntersectionArea(first: PreparedPolygon, second: PreparedPolygon): number {
  let area = 0;
  for (const firstRing of first.rings) {
    for (const secondRing of second.rings) {
      const weight = firstRing.weight * secondRing.weight;
      for (const firstTriangle of firstRing.triangles) {
        for (const secondTriangle of secondRing.triangles) {
          area += weight * triangleIntersectionArea(firstTriangle, secondTriangle);
        }
      }
    }
  }
  return area;
}

function geometryIntersectionArea(first: PreparedGeometry, second: PreparedGeometry): number {
  let area = 0;
  for (const firstPolygon of first.polygons) {
    for (const secondPolygon of second.polygons) {
      area += polygonIntersectionArea(firstPolygon, secondPolygon);
    }
  }
  return Math.min(Math.max(area, 0), Math.min(first.area, second.area));
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

  const rows: Array<OverlapRow<G, P>> = [];
  const rejections: Array<OverlapGeometryRejection<G, P>> = [];
  let hasSuppressedSlivers = false;

  for (const candidate of candidates.features) {
    const candidatePreparation = prepareGeometry(candidate.geometry, selected.referenceLongitude);
    if (candidatePreparation.status === 'omitted') continue;
    if (candidatePreparation.status === 'rejected') {
      rejections.push({
        source: 'candidate',
        reason: candidatePreparation.reason,
        candidate
      });
      continue;
    }
    const preparedCandidate = candidatePreparation.geometry;
    const intersectionArea = geometryIntersectionArea(selected, preparedCandidate);
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
