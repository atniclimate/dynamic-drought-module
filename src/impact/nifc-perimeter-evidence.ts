/**
 * Selected-place NIFC mapped-perimeter evidence.
 *
 * One geometry-exact spatial question, answered honestly: how many current
 * mapped WFIGS fire perimeters intersect the selection's OWN boundary shape?
 * The boundary polygon is POSTed to the National Interagency Fire Center
 * (NIFC) current-perimeters FeatureServer as an `esriGeometryPolygon`
 * intersects query (the same live POST pattern src/state/minimap-wildfire.ts
 * already runs in production against the same host), so the server's spatial
 * index performs the polygon-polygon intersection and only attributes come
 * back.
 *
 * Honesty contract:
 *   - a completed empty result is a VERIFIED ZERO for mapped perimeters,
 *     never an all-clear (unmapped incidents do not appear);
 *   - a failed or unrunnable query is UNKNOWN, never zero;
 *   - a transfer-limited result is a verified LOWER BOUND, reported as
 *     `degraded` ("live (partial)");
 *   - the claim's dates stay day-granular per the claim contract; the exact
 *     query instant is carried separately as `queriedAtUtc`.
 *
 * Fail-closed guards: no areal geometry on the selection, or antimeridian-
 * crossing evidence (`context.bboxCrossesAntimeridian`; a polygon cannot be
 * split at 180 degrees with existing tooling), both return an honest error
 * section instead of querying a shape that does not represent the selection.
 *
 * This section never feeds and is never fed by the regional minimap count
 * (src/state/minimap-wildfire.ts) or the envelope-based Current-horizon
 * claim (`fetchNifcClaims` in src/impact/sources.ts).
 */

import type { Geometry, MultiPolygon, Polygon } from 'geojson';

import { URLS } from '../config/urls';
import { classifyNifcIncidentType } from '../config/wildfire-presentation';
import { geoJsonPolygonToEsriRings } from '../util/esri-geometry';
import { fetchJsonWithBudget } from '../util/fetch';
import { makeClaim, todayIso } from './evidence';
import type { BoundarySelectionContext, PerimeterEvidenceSection } from './types';

/** Matches the minimap's POST timeout; heavier payload than a point query. */
const FETCH_TIMEOUT_MS = 15_000;

/** The service's per-query record ceiling; reaching it means `degraded`. */
export const PERIMETER_RESULT_RECORD_COUNT = 2000;

const SOURCE = 'NIFC current mapped fire perimeters (WFIGS)';
const SOURCE_URL = 'https://data-nifc.opendata.arcgis.com/';

/** Per-category counts over the received records. */
export interface PerimeterBreakdown {
  readonly wildfire: number;
  readonly prescribed: number;
  readonly other: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The selection geometry when it is areal, else null (fail closed). */
export function arealGeometry(
  geometry: Geometry | undefined
): Polygon | MultiPolygon | null {
  if (!geometry) return null;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return geometry;
  }
  return null;
}

/**
 * Build the form-encoded ArcGIS polygon-intersects query body. Attributes
 * only (`returnGeometry=false`): the server answers the spatial question;
 * no perimeter polygons transfer.
 */
export function buildPerimeterQueryBody(
  geometry: Polygon | MultiPolygon
): URLSearchParams {
  return new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({
      rings: geoJsonPolygonToEsriRings(geometry),
      spatialReference: { wkid: 4326 }
    }),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'attr_IncidentTypeCategory',
    returnGeometry: 'false',
    resultRecordCount: String(PERIMETER_RESULT_RECORD_COUNT),
    f: 'geojson'
  });
}

/**
 * Attributes-only parse of the ArcGIS `f=geojson` response. Deliberately
 * NOT `parseArcGisPolygonFeatureCollection` (that validator requires real
 * polygon geometry per feature; this query intentionally omits geometry).
 * An HTTP 200 ArcGIS error envelope and a malformed collection are
 * failures, never clean zeros. `exceededTransferLimit` absent means the
 * result is complete (the verified service contract).
 */
export function parsePerimeterFeatureCollection(value: unknown): {
  readonly types: readonly unknown[];
  readonly truncated: boolean;
} {
  if (isRecord(value) && Object.hasOwn(value, 'error')) {
    const error = isRecord(value['error']) ? value['error'] : null;
    const code = error?.['code'];
    const message = error?.['message'];
    throw new Error(
      `NIFC perimeter-evidence ArcGIS error ${
        typeof code === 'number' || typeof code === 'string'
          ? String(code)
          : '(unknown code)'
      }: ${typeof message === 'string' ? message : 'unknown error'}`
    );
  }
  if (
    !isRecord(value) ||
    value['type'] !== 'FeatureCollection' ||
    !Array.isArray(value['features']) ||
    (value['exceededTransferLimit'] !== undefined &&
      typeof value['exceededTransferLimit'] !== 'boolean')
  ) {
    throw new Error(
      'NIFC perimeter-evidence response was not a valid FeatureCollection.'
    );
  }
  const types: unknown[] = [];
  for (const feature of value['features']) {
    if (
      !isRecord(feature) ||
      feature['type'] !== 'Feature' ||
      !(feature['properties'] === null || isRecord(feature['properties']))
    ) {
      throw new Error(
        'NIFC perimeter-evidence response contained an invalid feature.'
      );
    }
    const properties = feature['properties'];
    types.push(
      isRecord(properties) ? properties['attr_IncidentTypeCategory'] : undefined
    );
  }
  return { types, truncated: value['exceededTransferLimit'] === true };
}

/** Classify every received incident-type value into the shared categories. */
export function summarizePerimeterTypes(
  types: readonly unknown[]
): PerimeterBreakdown {
  const counts = { wildfire: 0, prescribed: 0, other: 0 };
  for (const value of types) {
    counts[classifyNifcIncidentType(value)] += 1;
  }
  return counts;
}

/**
 * The claim sentence for one completed query. Verified zero is stated as a
 * verified zero, never an all-clear; a truncated result is stated as an
 * at-least lower bound with the record limit named.
 */
export function buildPerimeterEvidenceClaim(input: {
  readonly title: string;
  readonly count: number;
  readonly truncated: boolean;
  readonly breakdown: PerimeterBreakdown;
}): string {
  const { title, count, truncated, breakdown } = input;
  if (truncated) {
    return `At least ${count.toLocaleString('en-US')} current mapped NIFC fire ${
      count === 1 ? 'perimeter intersects' : 'perimeters intersect'
    } ${title} right now (the query reached the service's ${PERIMETER_RESULT_RECORD_COUNT.toLocaleString(
      'en-US'
    )}-record result limit, so the true count may be higher).`;
  }
  if (count === 0) {
    return `No current mapped NIFC fire perimeters intersect ${title} right now. This is a verified zero for mapped perimeters, not an all-clear: an active incident without a mapped perimeter yet would not appear in this count.`;
  }
  const parts: { readonly count: number; readonly label: string }[] = [];
  if (breakdown.wildfire > 0) {
    parts.push({ count: breakdown.wildfire, label: 'wildfire' });
  }
  if (breakdown.prescribed > 0) {
    parts.push({ count: breakdown.prescribed, label: 'Prescribed fire' });
  }
  if (breakdown.other > 0) {
    parts.push({ count: breakdown.other, label: 'other or unclassified fire' });
  }
  const bodies = parts.map((part) => `${part.count} ${part.label}`);
  const list =
    bodies.length === 1
      ? bodies[0]
      : `${bodies.slice(0, -1).join(', ')} and ${bodies.at(-1)}`;
  const lastCount = parts.at(-1)?.count ?? count;
  const noun = lastCount === 1 ? 'perimeter' : 'perimeters';
  return `${count} current mapped NIFC fire ${
    count === 1 ? 'perimeter intersects' : 'perimeters intersect'
  } ${title} right now: ${list} ${noun}.`;
}

function errorSection(note: string): PerimeterEvidenceSection {
  return {
    status: 'error',
    note,
    count: null,
    truncated: false,
    breakdown: null,
    queriedAtUtc: null,
    claim: null
  };
}

/**
 * Fetch the perimeter-evidence section for one selection. Returns the
 * finished section (the hydrator assigns it directly, like `fetchPointHeat`).
 * Runs under the briefing's master abort signal with its own timeout; on
 * abort the error is rethrown so the caller's cancellation guard handles it.
 */
export async function fetchPerimeterEvidence(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<PerimeterEvidenceSection> {
  const geometry = arealGeometry(context.geometry);
  if (!geometry) {
    return errorSection(
      `No boundary geometry is available for this selection, so the geometry-exact NIFC perimeter query did not run. Whether a mapped perimeter intersects ${context.title} is unknown right now.`
    );
  }
  if (context.bboxCrossesAntimeridian === true) {
    return errorSection(
      `The NIFC current-perimeters service could not query the complete selection geometry across the antimeridian. Whether a mapped perimeter intersects ${context.title} is unknown right now.`
    );
  }

  try {
    const payload = await fetchJsonWithBudget(
      `${URLS.nifcFires}/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: buildPerimeterQueryBody(geometry),
        cache: 'no-store'
      },
      signal,
      FETCH_TIMEOUT_MS
    );
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const { types, truncated } = parsePerimeterFeatureCollection(payload);
    const breakdown = summarizePerimeterTypes(types);
    const count = types.length;
    const claim = makeClaim({
      text: buildPerimeterEvidenceClaim({
        title: context.title,
        count,
        truncated,
        breakdown
      }),
      source: SOURCE,
      sourceUrl: SOURCE_URL,
      evidence: 'observed',
      dates: { retrieved: todayIso() }
    });
    return {
      status: truncated ? 'degraded' : 'ready',
      count,
      truncated,
      breakdown,
      queriedAtUtc: new Date().toISOString(),
      claim
    };
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn('[impact] NIFC perimeter-evidence query failed.', err);
    return errorSection(
      `The NIFC current-perimeters service did not respond to the query against ${context.title}'s boundary. Whether a mapped perimeter intersects this place is unknown right now.`
    );
  }
}
