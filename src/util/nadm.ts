import type { Position } from 'geojson';
import { hasPolygonCoordinates } from './geojson-checks';

/** Validate and normalize Polygon or MultiPolygon coordinates without mutation. */
export function nadmPolygonsFromGeometry(
  geometry: Record<string, unknown>,
): readonly (readonly (readonly Position[])[])[] {
  if (!hasPolygonCoordinates(geometry)) {
    throw new Error('NADM response contains unsupported or malformed polygon geometry.');
  }
  const coordinates = geometry['coordinates'];
  return geometry['type'] === 'Polygon'
    ? [coordinates as Position[][]]
    : (coordinates as Position[][][]);
}
