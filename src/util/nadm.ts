import type { Position } from 'geojson';

export const NADM_DROUGHT_CODES = ['D0', 'D1', 'D2', 'D3', 'D4'] as const;

export type NadmDroughtCode = (typeof NADM_DROUGHT_CODES)[number];

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function isRing(value: unknown): value is Position[] {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isPolygonCoordinates(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isRing);
}

function isMultiPolygonCoordinates(value: unknown): value is Position[][][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isPolygonCoordinates)
  );
}

/** Validate and normalize Polygon or MultiPolygon coordinates without mutation. */
export function nadmPolygonsFromGeometry(
  geometry: Record<string, unknown>,
): readonly (readonly (readonly Position[])[])[] {
  const geometryType = geometry['type'];
  const coordinates = geometry['coordinates'];
  if (geometryType === 'Polygon' && isPolygonCoordinates(coordinates)) {
    return [coordinates];
  }
  if (
    geometryType === 'MultiPolygon' &&
    isMultiPolygonCoordinates(coordinates)
  ) {
    return coordinates;
  }
  throw new Error('NADM response contains unsupported or malformed polygon geometry.');
}
