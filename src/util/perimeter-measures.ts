import { validatePolygonForClip, type ClipValidationLimits } from './polygon-clip-validation';

/** Grouping-contract section 6: IUGG mean sphere, not ellipsoidal survey area. */
const RADIUS_M = 6_371_008.8;
const RADIANS = Math.PI / 180;
type Position = readonly [number, number];
export interface PerimeterComponentMeasures {
  readonly areaM2: number;
  readonly perimeterM: number;
}
export interface PerimeterGeometryMeasures {
  readonly areaM2: number;
  readonly components: readonly PerimeterComponentMeasures[];
}
export class PerimeterMeasurementError extends Error {
  constructor() {
    super('Spherical perimeter measurement is indeterminate.');
    this.name = 'PerimeterMeasurementError';
  }
}

// Canonical traversal makes ring start and winding immaterial even to floating
// summation order. Validation already excludes repeated nonclosing vertices.
function canonicalRing(ring: readonly Position[]): Position[] {
  const count = ring.length - 1;
  const compare = (a: Position, b: Position): number => a[0] - b[0] || a[1] - b[1];
  let start = 0;
  for (let i = 1; i < count; i++) if (compare(ring[i]!, ring[start]!) < 0) start = i;
  const direction = compare(ring[(start + 1) % count]!, ring[(start + count - 1) % count]!) < 0 ? 1 : -1;
  return Array.from({ length: count }, (_, i) => ring[(start + direction * i + count) % count]!);
}

function sum(values: number[]): number {
  // Neumaier compensation, with stable magnitude ordering for hole/component sums.
  values.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const next = total + value;
    correction += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    total = next;
  }
  return total + correction;
}

function measureRing(input: readonly Position[]): PerimeterComponentMeasures {
  const ring = canonicalRing(input);
  const referenceLatitude = ring[0]![1];
  const areaTerms: number[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const previous = ring[(i + ring.length - 1) % ring.length]!;
    const point = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    // Chamberlain-Duquette longitude/sine ring sum. Subtracting a constant
    // sine leaves the closed-ring integral unchanged; this identity preserves
    // small latitude differences instead of subtracting two nearly equal sines.
    const sineDifference = 2 * Math.cos((point[1] + referenceLatitude) * RADIANS / 2) *
      Math.sin((point[1] - referenceLatitude) * RADIANS / 2);
    areaTerms.push((next[0] - previous[0]) * RADIANS * sineDifference);
    const halfLatitude = (next[1] - point[1]) * RADIANS / 2;
    const halfLongitude = (next[0] - point[0]) * RADIANS / 2;
    const haversine = Math.sin(halfLatitude) ** 2 + Math.sin(halfLongitude) ** 2 *
      Math.cos(point[1] * RADIANS) * Math.cos(next[1] * RADIANS);
    // Roundoff at antipodal limits must not pass a negative radicand to sqrt.
    const bounded = Math.max(0, Math.min(1, haversine));
    lengths.push(2 * RADIUS_M * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded)));
  }
  const areaM2 = Math.abs(sum(areaTerms)) * RADIUS_M ** 2 / 2;
  const perimeterM = sum(lengths);
  if (!Number.isFinite(areaM2) || areaM2 <= 0 || !Number.isFinite(perimeterM) || perimeterM <= 0) {
    throw new PerimeterMeasurementError();
  }
  return { areaM2, perimeterM };
}

/**
 * Measure strict, non-antimeridian geometry under the adopted spherical model.
 * Holes subtract area and add boundary length. Components stay separate for
 * DR-137; their total must never replace a per-component overlap decision.
 * This is floating-point model arithmetic, not exact area or issuer acreage.
 * Invalid geometry, exhausted caller limits and numerical collapse throw;
 * callers must propagate undetermined, never a certified empty intersection.
 * Execute in the bounded grouping worker, not as a main-thread deadline claim.
 */
export function measurePerimeterGeometry(value: unknown, limits: ClipValidationLimits): PerimeterGeometryMeasures {
  const polygons = validatePolygonForClip(value, limits);
  const components = polygons.map(polygon => {
    const rings = polygon.map(measureRing);
    const areaM2 = sum(rings.map((ring, index) => index === 0 ? ring.areaM2 : -ring.areaM2));
    const perimeterM = sum(rings.map(ring => ring.perimeterM));
    if (!Number.isFinite(areaM2) || areaM2 <= 0 || !Number.isFinite(perimeterM) || perimeterM <= 0) {
      throw new PerimeterMeasurementError();
    }
    return { areaM2, perimeterM };
  });
  const areaM2 = sum(components.map(component => component.areaM2));
  if (!Number.isFinite(areaM2) || areaM2 <= 0) throw new PerimeterMeasurementError();
  return { areaM2, components };
}
