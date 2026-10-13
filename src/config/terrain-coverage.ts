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

/** Degrees as the coverage sentences print them (exported for the spec's per-bound checks). */
export function formatLatitudeDeg(value: number): string {
  return `${Math.abs(value)}°${value >= 0 ? 'N' : 'S'}`;
}

/** See formatLatitudeDeg. */
export function formatLongitudeDeg(value: number): string {
  return `${Math.abs(value)}°${value >= 0 ? 'E' : 'W'}`;
}

/**
 * One terrain archive's coverage sentence, naming the layer that reads it.
 * The extent is the coverage claim (outside the box there is no archive, so
 * the ground renders flat); the zoom figure is a separate DETAIL clause,
 * because past it MapLibre overzooms the deepest level rather than going
 * flat (src/layers/hillshade.ts:7-11). The subject matters: the flat
 * Terrain Shading reads the bundled zoom 8 archive while the 3D scene may
 * read the deep zoom 10 one, and two sentences that both opened "Terrain
 * relief uses" made the two true figures read as one claim in conflict.
 * This file holds only a type import, so the eager map key can import it.
 */
export function terrainCoverageSentence(subject: string, coverage: TerrainCoverage): string {
  return (
    `${subject} uses the ${coverage.issuer}'s elevation data for ` +
    `${formatLongitudeDeg(coverage.west)} to ${formatLongitudeDeg(coverage.east)}, ` +
    `${formatLatitudeDeg(coverage.south)} to ${formatLatitudeDeg(coverage.north)}; ` +
    'outside that box the ground renders flat. ' +
    `The archive's detail ends at zoom ${coverage.maxZoom}; closer views stretch its deepest tiles.`
  );
}

/** The flat Terrain Shading layer's sentence: it only ever reads the bundled archive. */
export const HILLSHADE_COVERAGE_SENTENCE = terrainCoverageSentence(
  'Terrain Shading',
  FIRE3D_TERRAIN_COVERAGE
);

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
