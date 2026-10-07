import type { PmtilesHeader } from '../util/pmtiles-probe';

/** A terrain archive's own geographic extent and detail, not camera state. */
export interface TerrainCoverage {
  readonly issuer: string;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** Pinned to the bundled hillshade header; remote resolution never mutates it. */
export const FIRE3D_TERRAIN_COVERAGE = {
  issuer: 'USGS 3D Elevation Program',
  label: 'Pacific Northwest',
  west: -125,
  south: 41.5,
  east: -110.5,
  north: 49.5,
  minZoom: 0,
  maxZoom: 8
} as const;

/** Both currently allowlisted DEM archives contain this same USGS product. */
export function terrainCoverageFromHeader(header: PmtilesHeader): TerrainCoverage {
  return {
    issuer: FIRE3D_TERRAIN_COVERAGE.issuer,
    west: header.west,
    south: header.south,
    east: header.east,
    north: header.north,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom
  };
}
