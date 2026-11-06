import { readPolygonPages, type PolygonPageOptions, type PolygonPagesResult } from './polygon-pages';
import { fetchJsonWithBudget } from './fetch';

export interface BcwsReadOptions extends Omit<PolygonPageOptions, 'urlForPage' | 'sourceLabel'> {
  readonly endpoint: string;
  readonly bounds?: readonly [west: number, south: number, east: number, north: number];
  /** An ArcGIS where clause; the default `1=1` reads every perimeter in `bounds`. */
  readonly where?: string;
}

/**
 * The fields DDM reads, checked against the layer schema by
 * scripts/check-upstream-drift.mjs (a wrong name is an HTTP 200 error
 * envelope). OBJECTID keys de-duplication inside one answer only; the
 * service renumbers it at every reload, so nothing keys on it across reads.
 */
export const BCWS_OUT_FIELDS = [
  'FIRE_NUMBER',
  'FIRE_YEAR',
  'VERSION_NUMBER',
  'FIRE_SIZE_HECTARES',
  'TRACK_DATE',
  'LOAD_DATE',
  'FIRE_STATUS',
  'FIRE_URL',
  'OBJECTID'
] as const;

/** British Columbia's own extent (48.3 N to 60 N, 139.06 W to 114.03 W), rounded outward: BC perimeters exist only here. */
export const BCWS_COVERAGE = [-139.5, 48, -113.5, 60] as const;

/**
 * The read's allowances, for the layer, the minimap and the briefing alike.
 * One page of the service's 1,000-record cap (the province held 319 on
 * 2026-11-06, past seasons 321 to 680), so a read never spans the reload
 * renumbering and a view that needs a second page reads partial; NIFC's own
 * 15 s budget and 8 MiB decoded cap (the province measured 368,353 bytes
 * decoded with these fields); 250,000 vertices against the province's 11,444.
 */
export const BCWS_READ_LIMITS = {
  pageSize: 1000,
  pageLimit: 1,
  pageTimeoutMs: 15_000,
  totalTimeoutMs: 15_000,
  maxPageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxVertices: 250_000
} as const;

/** The issuer's stages of control that are active (DR-134; owner ruling 2026-09-26), verbatim. */
export const BCWS_ACTIVE_STAGES = ['Out of Control', 'Being Held', 'Under Control'] as const;

/** The same whitelist as a where clause, for reads that count active perimeters only. */
export const BCWS_ACTIVE_WHERE = `FIRE_STATUS IN (${BCWS_ACTIVE_STAGES.map((stage) => `'${stage}'`).join(',')})`;

// The stage whitelist lives beside the stage names (one definition for the map, the counts and the popup).
export { bcwsStatusClass } from '../config/wildfire-presentation';

/** The layer's whole-table record count, or null when the answer is not a count. */
async function tableCount(endpoint: string, options: BcwsReadOptions): Promise<number | null> {
  const url = new URL(endpoint);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('returnCountOnly', 'true');
  url.searchParams.set('f', 'json');
  try {
    const value = await fetchJsonWithBudget(url.toString(), null, options.signal, options.pageTimeoutMs, 4096);
    const count = (value as { count?: unknown } | null)?.count;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch (error) {
    if (options.signal.aborted) throw error;
    return null;
  }
}

/**
 * One bounded read of the BC Wildfire Service current perimeters.
 *
 * The service reloads about every 15 minutes by emptying the layer and
 * refilling it, renumbering every OBJECTID from 1 (measured 2026-11-06 UTC:
 * an answer at 06:26:39 held no features, one at 06:26:58 held all 319). An
 * answer taken inside that window looks complete and is not, so the read is
 * bracketed by two whole-table counts and is complete only when they agree:
 * a reload in progress between them changes the count. A disagreement or a
 * failed count makes the read `changed-record`, never complete.
 * Current-product membership is never filtered by year.
 */
export async function readBcwsPerimeters(options: BcwsReadOptions): Promise<PolygonPagesResult> {
  if (options.bounds && (!options.bounds.every(Number.isFinite) ||
      options.bounds[0] > options.bounds[2] || options.bounds[1] > options.bounds[3])) {
    throw new RangeError('Invalid BCWS query bounds.');
  }
  const before = await tableCount(options.endpoint, options);
  const result = await readPolygonPages({
    ...options,
    sourceLabel: 'BC Wildfire Service',
    urlForPage: (offset, count) => {
      const url = new URL(options.endpoint);
      const params = {
        f: 'geojson', where: options.where ?? '1=1', outFields: BCWS_OUT_FIELDS.join(','), outSR: '4326',
        returnGeometry: 'true', orderByFields: 'OBJECTID ASC',
        resultOffset: String(offset), resultRecordCount: String(count),
        maxAllowableOffset: '0.0005', geometryPrecision: '5'
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (options.bounds) {
        url.searchParams.set('geometry', options.bounds.join(','));
        url.searchParams.set('geometryType', 'esriGeometryEnvelope');
        url.searchParams.set('inSR', '4326');
        url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
      }
      return url.toString();
    }
  });
  if (!result.complete) return result;
  const after = await tableCount(options.endpoint, options);
  return before !== null && before === after ? result : { ...result, complete: false, reason: 'changed-record' };
}
