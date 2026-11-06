import { readPolygonPages, type PolygonPageOptions, type PolygonPagesResult } from './polygon-pages';
import { fetchJsonWithBudget, sleepUnlessAborted } from './fetch';

export interface BcwsReadOptions extends Omit<PolygonPageOptions, 'urlForPage' | 'sourceLabel'> {
  readonly endpoint: string;
  readonly bounds?: readonly [west: number, south: number, east: number, north: number];
  /** An ArcGIS where clause; the default `1=1` reads every perimeter in `bounds`. */
  readonly where?: string;
  /** How long an unfinished-looking layer must hold still to count as settled; `BCWS_RELOAD_SETTLE_MS` unless a test sets it. */
  readonly reloadSettleMs?: number;
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

/**
 * How long a reload can stand between its schema step and its data step:
 * measured 6.5 to 7.2 s at 319 records (five reloads, 2026-11-06); past
 * seasons held up to 680.
 * shortcut: a refill slower than this, read between its steps, would pass as
 * a layer that held still; widen it if a season's reload is measured slower.
 */
export const BCWS_RELOAD_SETTLE_MS = 30_000;

/**
 * The least gap from schema step to data step that reads as a finished
 * reload. Finished gaps measured 6.5 to 7.2 s (five reloads, 2026-11-06). The
 * emptying step landed within about 1.7 s of the schema step (the 06:26:39
 * empty answer was stamped 06:26:38; its data step came at 06:26:44), and
 * whether it also moves the data stamp could not be caught live, so a smaller
 * gap is never taken as finished: it waits for the settle time instead.
 */
export const BCWS_RELOAD_FINISHED_GAP_MS = 3_000;

/** The layer's own edit stamps (ArcGIS `editingInfo`, epoch ms). */
interface EditStamps {
  readonly schema: number;
  readonly data: number;
}
let stampRequests = 0;

/**
 * Read the layer's edit stamps fresh; null when the answer carries none. The
 * layer description is served `public, s-maxage=300`, and the CDN answered it
 * from a copy that predated the latest reload (2026-11-06 07:41:28 UTC, two
 * cache hits); a value no earlier request used makes it ask the service
 * (`X-Cache: TCP_MISS`, 07:42:54 UTC), and no-store keeps the browser out.
 */
async function editStamps(layerUrl: string, options: BcwsReadOptions): Promise<EditStamps | null> {
  const url = new URL(layerUrl);
  url.searchParams.set('f', 'json');
  url.searchParams.set('_', `${Date.now()}-${++stampRequests}`);
  try {
    // The layer description is about 11 kB; a larger answer is not the one measured.
    const value = await fetchJsonWithBudget(url.toString(), { cache: 'no-store' }, options.signal, options.pageTimeoutMs, 64 * 1024);
    const info = (value as { editingInfo?: { schemaLastEditDate?: unknown; dataLastEditDate?: unknown } } | null)?.editingInfo;
    const schema = info?.schemaLastEditDate;
    const data = info?.dataLastEditDate;
    return typeof schema === 'number' && Number.isSafeInteger(schema) && typeof data === 'number' && Number.isSafeInteger(data)
      ? { schema, data }
      : null;
  } catch (error) {
    if (options.signal.aborted) throw error;
    return null;
  }
}

/**
 * One bounded read of the BC Wildfire Service current perimeters.
 *
 * The service reloads about every 15 minutes: it steps the layer's schema
 * stamp, empties the table, refills it (renumbering every OBJECTID from 1)
 * and steps its data stamp 6.5 to 7.2 s after the schema stamp (measured
 * 2026-11-06 UTC: 04:41:26.179 then 04:41:32.833, 07:41:36.367 then
 * 07:41:43.439; an answer at 06:26:39 held no features, one at 06:26:58 held
 * all 319). An answer taken between the
 * two steps looks complete and is not. So the read is bracketed by the
 * layer's own edit stamps, read past the CDN and browser caches (the
 * whole-table count this replaced is served `public, s-maxage=300` too, so
 * two counts could be one cached copy), with the page past the browser cache;
 * it is complete only when the stamps did not move during it and the last
 * reload had finished (data stamp `BCWS_RELOAD_FINISHED_GAP_MS` or more after
 * the schema stamp). Stamps that may show a reload begun and not finished count only once they have held still for
 * `BCWS_RELOAD_SETTLE_MS`: a reload's data step lands well inside that, so a
 * layer that holds still that long is one whose last reload wrote no data
 * (an emptied table after the April 1 rollover reads as zero). Anything else
 * is `changed-record`, never complete. Current-product membership is never
 * filtered by year.
 */
export async function readBcwsPerimeters(options: BcwsReadOptions): Promise<PolygonPagesResult> {
  if (options.bounds && (!options.bounds.every(Number.isFinite) ||
      options.bounds[0] > options.bounds[2] || options.bounds[1] > options.bounds[3])) {
    throw new RangeError('Invalid BCWS query bounds.');
  }
  const layerUrl = options.endpoint.replace(/\/query$/, '');
  const before = await editStamps(layerUrl, options);
  const started = performance.now();
  const result = await readPolygonPages({
    ...options,
    requestInit: { cache: 'no-store' },
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
  const finished = before !== null && before.data - before.schema >= BCWS_RELOAD_FINISHED_GAP_MS;
  if (before !== null && !finished) {
    await sleepUnlessAborted((options.reloadSettleMs ?? BCWS_RELOAD_SETTLE_MS) - (performance.now() - started), options.signal);
  }
  const after = await editStamps(layerUrl, options);
  const held = before !== null && after !== null && after.schema === before.schema && after.data === before.data;
  return held ? result : { ...result, complete: false, reason: 'changed-record' };
}
