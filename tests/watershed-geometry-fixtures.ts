// Watershed geometry shared by place-studio-watersheds.spec.ts and place-studio-watersheds-logic.spec.ts.
import type { MultiPolygon, Polygon } from 'geojson';

export function rectangle(
  west: number,
  south: number,
  east: number,
  north: number
): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south]
    ]]
  };
}

export const YAKIMA = rectangle(-121, 46, -120, 47);
export const PACIFIC_NORTHWEST: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    rectangle(-124, 44, -116, 50).coordinates,
    rectangle(-130, 50, -129, 51).coordinates
  ]
};
