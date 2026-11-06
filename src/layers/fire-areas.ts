/**
 * Fire areas: where a BC Wildfire Service perimeter and a NIFC WFIGS
 * perimeter overlap, they are one fire area (the acceptance of 2026-09-25 and
 * the owner's rulings of 2026-09-26). The link rule, identity and clipping
 * are the grouping kernel's (src/util/perimeter-grouping.ts, run whole in
 * the perimeter Worker, src/util/perimeter-job*.ts); this module only picks
 * which records go to it and reads its answer back.
 *
 * The Worker, and the polygon-clipping package folded into it, start only
 * when a cross-border pair exists: a BC and a NIFC record whose bounding
 * boxes share area, the same first filter the kernel applies (perimeter-job.ts),
 * so no record left out here could have linked. The pre-pass is a
 * bounding-box walk only; validation, identity and measurement stay in the
 * Worker. Membership is by the kernel's record keys (FIRE_YEAR plus
 * FIRE_NUMBER for BC, the UniqueFireIdentifier for NIFC), never OBJECTID,
 * which the BC service renumbers at every reload.
 */

import type { Feature, GeoJsonProperties, Geometry } from 'geojson';

import { FIRE_PERIMETER_ISSUERS } from '../config/fire-perimeter-issuers';
import type { PerimeterJobLimits, PerimeterJobResult } from '../util/perimeter-job-contract';
import type { ClipCoordinates } from '../util/polygon-clip-validation';
import type { FireAreaMember } from './fire-records';

export type FireIssuer = 'nifc' | 'bcws';

/** The kernel's record key for a keyed record (normalizePerimeterIdentity), or null for an unkeyed one. */
export function fireRecordKey(issuer: FireIssuer, properties: GeoJsonProperties): string | null {
  const row = FIRE_PERIMETER_ISSUERS.find((candidate) => candidate.id === issuer);
  const id = row?.recordId(properties ?? {}) ?? null;
  return id === null ? null : `${issuer}:${id}`;
}

export interface FireArea {
  readonly key: string;
  readonly members: readonly FireAreaMember[];
  /** The union outline when the Worker returned one, else the members' polygons side by side (never drawn as an outline). */
  readonly coordinates: ClipCoordinates;
  readonly outlined: boolean;
}

export interface FireAreaState {
  /** `none`: no pair to group; `pending`: the Worker is running; `unavailable`: it failed or did not finish. */
  readonly status: 'none' | 'pending' | 'complete' | 'unavailable';
  readonly computedAt: number | null;
  /** Record key to fire-area key, for records in an area of two or more. */
  readonly areaOf: ReadonlyMap<string, string>;
  readonly areas: readonly FireArea[];
  /** Records whose grouping is not known: every candidate when the job failed, else those in an unresolved pair. */
  readonly unresolved: ReadonlySet<string>;
}

export const NO_FIRE_AREAS: FireAreaState = {
  status: 'none',
  computedAt: null,
  areaOf: new Map(),
  areas: [],
  unresolved: new Set()
};

/**
 * Production allowances for the grouping Worker, sized from the measured
 * province (2026-11-06: 319 BC records, 11,444 vertices, the largest 1,802;
 * the Border 2 pair grouped in 1.4 s in Node). Only candidate records are
 * sent. A record or job past these is refused whole and grouping reads
 * unavailable, never a partial graph.
 */
export const FIRE_AREA_JOB_LIMITS: PerimeterJobLimits = {
  maxInputChars: 8_000_000,
  maxTotalVertices: 200_000,
  maxCandidatePairs: 500,
  fingerprint: { geometry: { maxVertices: 50_000, maxSegmentTests: 100_000_000 }, maxNodes: 1_000_000, maxDepth: 16, maxChars: 8_000_000 },
  kernel: { maxVersions: 2_000, maxRecords: 2_000, maxPairChecks: 4_000_000, maxIdentityChars: 16_000_000, maxComponentsPerPair: 500 },
  clip: {
    input: { maxVertices: 50_000, maxSegmentTests: 100_000_000 },
    output: { maxVertices: 100_000, maxSegmentTests: 200_000_000 }
  }
};

/** The Worker's wall-clock allowance for one job. */
export const FIRE_AREA_JOB_DEADLINE_MS = 30_000;

type Box = readonly [number, number, number, number];

function boxOf(geometry: Geometry | null | undefined): Box | null {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) for (const p of ring) {
    if (p[0]! < west) west = p[0]!;
    if (p[0]! > east) east = p[0]!;
    if (p[1]! < south) south = p[1]!;
    if (p[1]! > north) north = p[1]!;
  }
  return Number.isFinite(west) && Number.isFinite(south) ? [west, south, east, north] : null;
}

/** The kernel's first filter (perimeter-job.ts): boxes sharing positive area. */
function boxesShareArea(a: Box, b: Box): boolean {
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
}

export interface CandidateRow {
  readonly issuer: FireIssuer;
  readonly feature: Feature;
}

/** The BC and NIFC records with a cross-border bounding-box candidate, BC first, each once. */
export function crossBorderCandidates(bcws: readonly Feature[], nifc: readonly Feature[]): CandidateRow[] {
  const bcBoxes = bcws.map((feature) => boxOf(feature.geometry));
  const nifcBoxes = nifc.map((feature) => boxOf(feature.geometry));
  const bcUsed = new Set<number>();
  const nifcUsed = new Set<number>();
  bcBoxes.forEach((a, i) => {
    if (!a) return;
    nifcBoxes.forEach((b, j) => {
      if (b && boxesShareArea(a, b)) {
        bcUsed.add(i);
        nifcUsed.add(j);
      }
    });
  });
  return [
    ...[...bcUsed].sort((x, y) => x - y).map((i) => ({ issuer: 'bcws' as const, feature: bcws[i]! })),
    ...[...nifcUsed].sort((x, y) => x - y).map((j) => ({ issuer: 'nifc' as const, feature: nifc[j]! }))
  ];
}

/** The polygons of the members side by side: the fill that answers a click when no union outline came back. */
function sideBySide(members: readonly CandidateRow[]): ClipCoordinates {
  return members.flatMap(({ feature }) => {
    const g = feature.geometry;
    if (g?.type === 'Polygon') return [g.coordinates as ClipCoordinates[number]];
    if (g?.type === 'MultiPolygon') return g.coordinates as ClipCoordinates;
    return [];
  });
}

/**
 * Group the two agencies' loaded perimeters into fire areas. `run` is the
 * Worker job (groupPerimetersInWorker); it is called only when a candidate
 * exists. A thrown or refused job is `unavailable`, never "no overlap".
 */
export async function groupFireAreas(
  bcws: readonly Feature[],
  nifc: readonly Feature[],
  run: (sourceJson: string) => Promise<PerimeterJobResult>,
  now: () => number = Date.now
): Promise<FireAreaState> {
  const rows = crossBorderCandidates(bcws, nifc);
  if (rows.length === 0) return { ...NO_FIRE_AREAS, status: 'complete', computedAt: now() };
  const candidates = new Set(rows.flatMap((row) => fireRecordKey(row.issuer, row.feature.properties) ?? []));
  let result: PerimeterJobResult;
  try {
    result = await run(JSON.stringify(rows.map((row) => ({ issuer: row.issuer, geometry: row.feature.geometry, properties: row.feature.properties }))));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { ...NO_FIRE_AREAS, status: 'unavailable', computedAt: null, unresolved: candidates };
  }
  const recordOfVersion = new Map(result.graph.versions.map((version) => [version.versionKey, version.recordKey] as const));
  const rowsOfRecord = new Map<string, CandidateRow[]>();
  for (const source of result.sources) {
    const record = recordOfVersion.get(source.versionKey);
    if (record === undefined) continue;
    const list = rowsOfRecord.get(record) ?? [];
    for (const index of source.indices) if (rows[index]) list.push(rows[index]!);
    rowsOfRecord.set(record, list);
  }
  const outlines = new Map(result.footprints.map((footprint) => [footprint.key, footprint.coordinates] as const));
  const areaOf = new Map<string, string>();
  const areas: FireArea[] = [];
  for (const group of result.graph.groups) {
    if (group.members.length < 2) continue;
    const members = group.members.flatMap((record) => rowsOfRecord.get(record) ?? []);
    for (const record of group.members) areaOf.set(record, group.key);
    const outline = outlines.get(group.key) ?? null;
    areas.push({
      key: group.key,
      members: members.map((row) => ({
        issuer: row.issuer,
        properties: row.feature.properties,
        ...(row.feature.id === undefined ? {} : { featureId: row.feature.id })
      })),
      coordinates: outline ?? sideBySide(members),
      outlined: outline !== null
    });
  }
  // An unresolved pair (a refused clip) is not an answer about overlap: its
  // records count once per agency and say their grouping is unavailable.
  return { status: 'complete', computedAt: now(), areaOf, areas, unresolved: new Set(result.graph.unresolvedPairs.flat()) };
}

/** One counted perimeter: its dedupe identity and its kernel record key (null when unkeyed). */
export interface CountedPerimeter {
  readonly identity: string;
  readonly recordKey: string | null;
}

/**
 * Distinct fire areas among the counted perimeters: each record once, and
 * the records of one known fire area once together (the ratified count
 * rule). `merged` is how many areas joined two or more counted records,
 * which is when the count carries the ratified label.
 */
export function countFireAreas(
  rows: readonly CountedPerimeter[],
  areaOf: (recordKey: string) => string | null
): { readonly count: number; readonly merged: number } {
  const seen = new Set<string>();
  const joined = new Map<string, Set<string>>();
  for (const row of rows) {
    const area = row.recordKey === null ? null : areaOf(row.recordKey);
    seen.add(area === null ? `record:${row.identity}` : `area:${area}`);
    if (area !== null) {
      const set = joined.get(area) ?? new Set<string>();
      set.add(row.recordKey!);
      joined.set(area, set);
    }
  }
  return { count: seen.size, merged: [...joined.values()].filter((set) => set.size > 1).length };
}
