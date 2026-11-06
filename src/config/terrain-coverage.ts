import type { PmtilesHeader } from '../util/pmtiles-probe';

/** One geographic claim box, in degrees. */
export interface TerrainBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * A terrain archive's own geographic extent and detail, not camera state.
 * West/south/east/north are the header rectangle; `boxes`, when present, are
 * the only places inside it that carry elevation.
 */
export interface TerrainCoverage extends TerrainBox {
  readonly issuer: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly boxes?: readonly TerrainBox[];
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

/**
 * The national archive's claim boxes: CONUS, Alaska, Hawaii, Puerto Rico and
 * the U.S. Virgin Islands, American Samoa. Its header is their union, which
 * one rectangle cannot draw across the antimeridian, so Guam, CNMI, Wake and
 * the western Aleutians stay flat. scripts/build-terrain-archive.mjs bakes
 * these same numbers (tests/terrain-archive-plan.test.mjs).
 */
export const NATIONAL_TERRAIN_BOXES: readonly TerrainBox[] = [
  { west: -125.0, south: 24.4, east: -66.9, north: 49.5 },
  { west: -179.3, south: 51.1, east: -129.8, north: 71.5 },
  { west: -160.4, south: 18.8, east: -154.7, north: 22.4 },
  { west: -68.0, south: 17.7, east: -64.4, north: 18.7 },
  { west: -171.3, south: -14.7, east: -169.3, north: -10.9 }
];

const NATIONAL_TERRAIN_KEY = /^us-z1[01]-\d{4}-\d{2}-\d{2}\.pmtiles$/;

/**
 * Coverage for the archive that answered. The boxes attach only when its key
 * is a national one AND its header rectangle is the committed union; any
 * other archive keeps the header's single box, which is never wrong about the
 * bounds it reports.
 */
export function terrainCoverageFor(key: string, header: PmtilesHeader): TerrainCoverage {
  const coverage = terrainCoverageFromHeader(header);
  const b = NATIONAL_TERRAIN_BOXES;
  const union = [Math.min(...b.map((x) => x.west)), Math.min(...b.map((x) => x.south)),
    Math.max(...b.map((x) => x.east)), Math.max(...b.map((x) => x.north))];
  const matches = NATIONAL_TERRAIN_KEY.test(key) &&
    [coverage.west, coverage.south, coverage.east, coverage.north].every((v, i) => Math.abs(v - union[i]) < 1e-6);
  return matches ? { ...coverage, boxes: NATIONAL_TERRAIN_BOXES } : coverage;
}
