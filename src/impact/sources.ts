/**
 * Live source fetchers for the impact briefing.
 *
 * Each function fetches one verified, Cross-Origin Resource Sharing (CORS)
 * open source for a boundary selection and returns a `SourceResult`: the
 * claims it produced and whether the fetch succeeded. The orchestrator
 * (`hydrate.ts`) assembles these into the three temporal horizons.
 *
 * Honesty contract (a core project invariant; the ddm-drought-impact-
 * modeling doctrine): observations are stated plainly with their source; outlooks are
 * stated as probabilities or tendencies. A fetch that fails returns `ok:false`
 * so the horizon can say so honestly rather than inventing a value. A fetch
 * that succeeds but finds nothing (no active alerts, no fires) returns
 * `ok:true` with an informative observation. An ArcGIS host that answers
 * HTTP 200 with an error envelope is neither: `featuresOf` throws, so the
 * fetcher reports `unavailable` rather than reading an outage as an absence
 * of drought or fire. JSON fetches keep the briefing's
 * master abort signal and per-call timeout active through body consumption,
 * so a hung host never blocks the panel (invariant 5).
 *
 * Verified sources (see src/config/urls.ts): USDM FeatureServer (CORS *), NIFC perimeters
 * FeatureServer (CORS *), NWS api.weather.gov alerts and point forecast
 * (CORS *).
 */

import { URLS } from '../config/urls';
import { HEATRISK_CATEGORIES, SPC_FIREWX_CATEGORIES } from '../config/palette';
import {
  NIFC_AREA_QUERY_RECORD_CAP,
  buildNifcAreaPerimeterClaim
} from '../config/wildfire-presentation';
import {
  loadServiceEnvelopePieces,
  mergeByStableIdentifier
} from '../util/bbox';
import { naiveBboxSuggestsAntimeridianCrossing } from '../util/antimeridian';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { cpcOutlookBarsSvg, trendLineSvg, type TrendPoint } from '../ui/charts';
import { categoryImpact } from './category-impacts';
import { makeClaim, todayIso } from './evidence';
import { contextStateFips, contextStateName } from './resources';
import {
  NWS_CACHE_TTL,
  createNwsRequestSession,
  fetchNwsPointMetadata,
  nwsCoordinate,
  type NwsRequestSession
} from './nws-point';
import type {
  BoundarySelectionContext,
  HeatSourceRead,
  SourcedClaim
} from './types';

/** The outcome of one source fetch. */
export interface SourceResult {
  readonly claims: SourcedClaim[];
  /** True if the fetch completed (even if it found nothing); false on error. */
  readonly ok: boolean;
  /** Optional honest note shown when `ok` is false. */
  readonly note?: string;
  /** Optional typed heat read used by the cross-source comparison. */
  readonly heatRead?: HeatSourceRead;
}

const TIMEOUT_MS = 10_000;
const GEOJSON_ACCEPT = { Accept: 'application/geo+json, application/json' };

/** Round a coordinate to 4 decimals; the NWS API rejects more precision. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Build an Environmental Systems Research Institute (ESRI) FeatureServer
 * point-intersect query. The shared keys (where, inSR, spatialRel,
 * returnGeometry, f) are baked in; the caller supplies the `outFields`.
 */
function esriPointQuery(lng: number, lat: number, outFields: string): URLSearchParams {
  return new URLSearchParams({
    where: '1=1',
    geometry: `${round4(lng)},${round4(lat)}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    f: 'geojson'
  });
}

/**
 * Build an ESRI FeatureServer envelope-intersect query. `recordCount`, when
 * given, caps the result set (exactOptionalPropertyTypes-safe: only set when
 * provided).
 */
function esriEnvelopeQuery(envelope: string, outFields: string, recordCount?: number): URLSearchParams {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    f: 'geojson'
  });
  if (recordCount !== undefined) params.set('resultRecordCount', String(recordCount));
  return params;
}

/**
 * Cancellable JSON fetch shared by every fetcher. The owning signal and
 * timeout remain active through response-body consumption. Callers keep their
 * own `signal.aborted` re-check immediately after, before touching the panel.
 */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs = TIMEOUT_MS
): Promise<unknown> {
  return fetchJsonWithBudget(url, { headers }, signal, timeoutMs);
}

/**
 * An upstream ArcGIS service that answered HTTP 200 with an error envelope
 * instead of data (FSPEC-01). `mapservices.weather.noaa.gov` does this when
 * one of its backends is out: HTTP 200, `text/plain`, body
 * `{"status":"error","messages":["Could not access any server machines. ..."]}`.
 * Thrown by `featuresOf` so every consumer that goes through the shared helper
 * lands in its own catch and reports `unavailable`, instead of reading the
 * envelope as an empty result and asserting `no data` (an outage must never
 * become a positive finding of absence).
 */
class EsriServiceError extends Error {
  /** The service's own message text, verbatim; logged with the failure. */
  readonly serviceMessage: string;

  constructor(serviceMessage: string) {
    super(`upstream service error: ${serviceMessage}`);
    this.name = 'EsriServiceError';
    this.serviceMessage = serviceMessage;
  }
}

/**
 * The service's own error text when a payload is an ArcGIS error envelope,
 * else null. Two shapes are published: the load-balancer envelope
 * (`status: 'error'` plus a `messages` array) and the ArcGIS REST envelope
 * (an `error` object with a `message`). Neither can occur on a real
 * FeatureCollection, so a match is unambiguous.
 */
function esriErrorMessage(json: unknown): string | null {
  if (!isObject(json)) return null;
  const unnamed = 'the service reported an error without a message';
  if (json.status === 'error' && Array.isArray(json.messages)) {
    const parts = json.messages
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    return parts.length > 0 ? parts.join(' ') : unnamed;
  }
  if (isObject(json.error)) {
    const message = typeof json.error.message === 'string' ? json.error.message.trim() : '';
    return message.length > 0 ? message : unnamed;
  }
  return null;
}

/**
 * The `features` array of a GeoJSON-shaped payload, or `[]` when absent.
 * Throws `EsriServiceError` on an HTTP 200 error envelope (see above); no
 * retry is attempted, so the existing per-call budget still bounds the work.
 */
function featuresOf(json: unknown): unknown[] {
  const serviceMessage = esriErrorMessage(json);
  if (serviceMessage !== null) throw new EsriServiceError(serviceMessage);
  return isObject(json) && Array.isArray(json.features) ? json.features : [];
}

/**
 * The honest note for a failed source fetch: a service that answered with an
 * error envelope is `unavailable` and said so, which is a different fact from
 * a service that never answered. `service` is the subject of the sentence,
 * for example "The U.S. Drought Monitor".
 */
function upstreamNote(err: unknown, service: string): string {
  return err instanceof EsriServiceError
    ? `${service} is unavailable: it answered with an error rather than data.`
    : `${service} did not respond.`;
}

/** An epoch-millisecond upstream Date field, or null when absent or unusable. */
function epochField(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** The UTC calendar day of an instant, ISO 8601, for a claim's `dates`. */
function isoDayUtc(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * "Aug 25, 2026" for prose. Upstream Date fields on these services are UTC
 * midnights, so the day is read in UTC; a local read would show the previous
 * day for every viewer west of Greenwich.
 */
function humanDayUtc(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(time));
}

/** "Aug 25", for the start of a span whose end carries the shared year. */
function humanDayUtcNoYear(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(time));
}

// ---------------------------------------------------------------------------
// Current: issuer-published HeatRisk class at the selected frame and point
// ---------------------------------------------------------------------------

function heatRiskMoment(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short'
  }).format(new Date(time));
}

/**
 * Read the selected HeatRisk frame at the selected point. The identify helper
 * sends that frame's exact epoch and verifies the returned catalog time before
 * a non-null class can become a claim.
 */
export async function fetchHeatRiskClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  try {
    const { identifyHeatRiskForBriefing, heatRiskClaimRegister, REQUIRED_FRAME_COUNT } =
      await import('../ui/heatrisk-sequence');
    // DR-014 a: this reads independently of the map layer's activation, so
    // the near-term heat claim states its evidence whether or not HeatRisk is
    // displayed. The briefing describes the place, not the map.
    const result = await identifyHeatRiskForBriefing(
      context.lngLat.lng,
      context.lngLat.lat,
      signal
    );
    if (signal.aborted) return { claims: [], ok: false };
    // DDM-P7-T05 F3: the three nulls the old signature collapsed into one
    // note are told apart here (see HeatRiskBriefingRead's own doc).
    if (result.kind === 'no-displayed-frame') {
      // HeatRisk is contextual to its active displayed frame. An inactive
      // layer adds no source slot and does not make an otherwise complete
      // horizon partial.
      return { claims: [], ok: true };
    }
    if (result.kind === 'catalog-failed') {
      return {
        claims: [],
        ok: false,
        note: 'The National Weather Service HeatRisk catalog did not respond.'
      };
    }
    if (result.kind === 'superseded') return { claims: [], ok: false };
    const identified = result.identify;
    const frameLabel =
      identified.frameSource === 'selected'
        ? 'the selected frame'
        : `day ${identified.frame.day} of ${REQUIRED_FRAME_COUNT} of the catalog`;

    const validity =
      `${heatRiskMoment(identified.frame.validTime)} to ` +
      heatRiskMoment(identified.validThrough);
    const source = 'National Weather Service HeatRisk (Experimental)';
    const sourceUrl = `${URLS.nwsHeatRisk}/info/iteminfo`;
    const shared = {
      source,
      sourceUrl,
      product: 'heatrisk',
      evidence: 'classified',
      // DR-070 amended 2026-09-08, DR-071: HeatRisk stays 'classified'
      // evidence (the badge stays Classified), but the issuer's own words
      // describe a forecast, "provides a forecast of the potential level of
      // risk for heat-related impacts to occur over a 24-hour period"
      // (HeatRisk v2.6 Overview). A claim whose 24-hour period is still IN
      // FORCE (has not ended) therefore overrides the classified ->
      // observed default and reads outlook; an ENDED period reads observed
      // (the spent claim the doctrine forbids as an outlook). This is the
      // same boundary the time bar draws for the same product
      // (src/layers/heatrisk.ts frameStamp/framePhase), read here through
      // the one shared helper (heatRiskClaimRegister) so the briefing and
      // the map can never disagree about when a HeatRisk claim is in force.
      register: heatRiskClaimRegister(identified.validThrough, Date.now()),
      dates: {
        valid: isoDayUtc(identified.frame.validTime),
        retrieved: todayIso()
      },
      support: {
        native: 'National Weather Service HeatRisk raster cell',
        reporting: 'the cell at the selected point',
        // DDM-P13-T02: `heatrisk` is the src/ui/legend-registry.ts key this
        // layer already builds its category legend under (src/layers/heatrisk.ts).
        legendKey: 'heatrisk'
      },
      // DDM-P13-T02: quoted, not authored here. The issuer's own definition
      // of the product this claim reads, already carried in prose at
      // src/layers/heatrisk.ts:200-204 (HeatRisk v2.6 Overview, read
      // 2026-09-08): a 24-hour-period forecast, not an instant reading.
      method: {
        // vocab-allow: verbatim quoted upstream product definition (HeatRisk v2.6 Overview), quotation marks and all; not DDM's own word for its own read
        basis: 'HeatRisk "provides a forecast of the potential level of risk for heat-related impacts to occur over a 24-hour period" and is calculated "from the current date through seven days in the future" (HeatRisk v2.6 Overview).'
      },
      uncertainty: {
        kind: 'categorical',
        text: 'an issuer-published 0-4 classification; no DDM category is calculated'
      }
    } as const;

    const heatReadLabel =
      identified.frameSource === 'selected'
        ? 'NWS HeatRisk selected frame'
        : `NWS HeatRisk day ${identified.frame.day} of ${REQUIRED_FRAME_COUNT}`;

    if (identified.value === null) {
      const text =
        `HeatRisk (Experimental): no data at the selected point for ${context.title} for ${frameLabel}. ` +
        `Valid ${validity}.`;
      return {
        ok: true,
        claims: [
          makeClaim({
            text,
            ...shared
          })
        ],
        heatRead: {
          key: 'heatRisk',
          label: heatReadLabel,
          text,
          sourceUrl
        }
      };
    }

    const category = HEATRISK_CATEGORIES[identified.value]!;
    const text =
      `HeatRisk (Experimental) value ${category.value}, ${category.label}, at the selected point for ${context.title}. ` +
      `Valid ${validity}. ${category.meaning}`;
    return {
      ok: true,
      claims: [
        makeClaim({
          text,
          ...shared
        })
      ],
      heatRead: {
        key: 'heatRisk',
        label: heatReadLabel,
        text,
        sourceUrl
      }
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] HeatRisk identify failed.', err);
    return {
      claims: [],
      ok: false,
      note: 'The National Weather Service HeatRisk classification did not respond.'
    };
  }
}

// ---------------------------------------------------------------------------
// Current: USDM category at the clicked point
// ---------------------------------------------------------------------------

/**
 * The whole published field list of `USDM_current` layer 0 (VERIFIED live
 * 2026-09-02, DWH-05): the category AND the issuer's own dates. `ValidStart`
 * and `ValidEnd` are requested with `MapDate` because they are the window the
 * map speaks for; the claim states the map date, and the window is available
 * to the same parse without a second round trip.
 */
const USDM_OUT_FIELDS = 'DM,MapDate,ValidStart,ValidEnd';

/**
 * DDM-P13-T02 F2: the U.S. Drought Monitor's own published percentile basis
 * for its D0 to D4 categories, quoted from the issuer (NDMC, "Drought
 * Classification",
 * https://droughtmonitor.unl.edu/About/AbouttheData/DroughtClassification.aspx),
 * not authored here. Every claim that names a D-category (the per-point USDM
 * claims below, and the statewide DSCI claim) carries this SAME string
 * character for character, so the method line reads identically wherever a
 * category appears.
 */
// vocab-allow: verbatim quoted upstream table heading ("example percentile range for most indicators"), quotation marks and all; not DDM's own word for its own read
const USDM_PERCENTILE_BASIS =
  'The U.S. Drought Monitor assigns D0 to D4 by percentile; the NDMC\'s "example percentile range for most indicators" is D0 20.01-30.00, D1 10.01-20.00, D2 5.01-10.00, D3 2.01-5.00, D4 0.00-2.00 (NDMC, Drought Classification).';

/**
 * Query the United States Drought Monitor FeatureServer for the polygons that
 * contain the clicked point and translate the worst (highest) category present
 * into claims: the analyzed drought state, then the derived wildfire
 * implication. (The former extreme-heat companion was removed by ruling
 * D-0.8.0-047 and is not rebuilt here.) If no polygon contains the point, the
 * location is better than D0 on that map, which is itself a plain reading.
 */
export async function fetchUsdmClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const url = `${URLS.usdmFeatureServer}/query?${esriPointQuery(lng, lat, USDM_OUT_FIELDS).toString()}`;
  const source = 'U.S. Drought Monitor (NDMC / NOAA / USDA)';
  const sourceUrl = 'https://droughtmonitor.unl.edu/';

  try {
    const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
    if (signal.aborted) return { claims: [], ok: false };

    const features = featuresOf(json);
    let worst = -1;
    let mapDate: number | null = null;
    for (const f of features) {
      if (!isObject(f) || !isObject(f.properties)) continue;
      const dm = Number(f.properties.DM);
      if (Number.isInteger(dm) && dm > worst) worst = dm;
      mapDate ??= epochField(f.properties.MapDate);
    }
    // The USDM is an expert-analyzed weekly product: evidence 'analyzed'. The
    // map date is the issuer's own, so the claim is dated by the map it reads
    // and not by the moment DDM fetched it (DWH-05); a payload that carries no
    // MapDate falls back to the retrieval date and to the weekly framing.
    const usdmShared = {
      source,
      sourceUrl,
      product: 'usdm' as const,
      evidence: 'analyzed' as const,
      dates:
        mapDate === null
          ? { retrieved: todayIso() }
          : { valid: isoDayUtc(mapDate), retrieved: todayIso() },
      support: { reporting: 'the USDM polygon at the clicked point' }
    };
    // "this week's map" is only true until Thursday's release: NDMC publishes
    // on Thursday using data through the previous Tuesday morning, so the map
    // date is named whenever the service returns it.
    const asOfMap =
      mapDate === null
        ? "this week's U.S. Drought Monitor"
        : `the U.S. Drought Monitor map dated ${humanDayUtc(mapDate)}`;

    if (worst < 0) {
      return {
        ok: true,
        claims: [
          makeClaim({
            text: `No drought category is mapped at this location in ${asOfMap} (conditions are better than D0, Abnormally Dry).`,
            ...usdmShared
          })
        ]
      };
    }

    const impact = categoryImpact(worst);
    if (!impact) {
      return {
        ok: true,
        claims: [
          makeClaim({
            text: `This location is in a mapped drought category (DM ${worst}) in ${asOfMap}.`,
            ...usdmShared,
            support: { ...usdmShared.support, legendKey: 'usdm' },
            method: { basis: USDM_PERCENTILE_BASIS }
          })
        ]
      };
    }

    return {
      ok: true,
      claims: [
        makeClaim({
          text: `This location is in ${impact.code} ${impact.label} as of ${asOfMap}. ${impact.summary}`,
          ...usdmShared,
          support: { ...usdmShared.support, legendKey: 'usdm' },
          method: { basis: USDM_PERCENTILE_BASIS }
        }),
        // The wildfire companion translates the analyzed category through the
        // documented USDM impact profiles: a DDM-derived read, labeled so.
        // The former extreme-heat companion was removed by ruling
        // (D-0.8.0-047); do not reintroduce a heat claim inferred from the
        // USDM category.
        //
        // It stays in the Drought row of the matrix deliberately. Its issuer
        // is the U.S. Drought Monitor and its clock is that map's date, so
        // filing it under Fire would give the Fire row a drought issuer and a
        // drought validity date, which is exactly what the matrix exists to
        // prevent. It is a drought-impact read that names wildfire, not a
        // fire product.
        makeClaim({
          text: `Wildfire: ${impact.wildfire} Drought raises the odds and the potential intensity of wildfire by drying and curing fuels; it does not by itself start fires.`,
          ...usdmShared,
          evidence: 'derived',
          // Plain language in the sentence, the doctrine id in the title
          // attribute (DR-058 a): "ddm-drought-impact-modeling causal-chain
          // reads" was internal vocabulary inside a public claim.
          lineage: [
            'USDM category at the clicked point',
            'the documented USDM impact profile for that category, read through the DDM drought-impact model'
          ],
          lineageRef: 'ddm-drought-impact-modeling',
          uncertainty: { kind: 'typical', text: 'an elevated-risk tendency at this category, not a certainty' }
        })
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] USDM point query failed.', err);
    return { claims: [], ok: false, note: upstreamNote(err, 'The U.S. Drought Monitor') };
  }
}

// ---------------------------------------------------------------------------
// Current: statewide drought-severity trend (DSCI) with a trend chart
// ---------------------------------------------------------------------------

function fmtUsdmDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/** One week in milliseconds; the DSCI series is weekly. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A calendar day, free of any timezone interpretation. */
interface CalendarDay {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

/**
 * Extract the calendar day of an upstream date string TEXTUALLY, without an
 * instant round trip: `Date.parse` treats a date-only ISO string as UTC
 * midnight while local getters read the viewer's zone, so mixing them can
 * shift the shown day by one either side of UTC (the DG-080-REVIEW T-P0-2
 * blocker: the prose and the Valid line could disagree on the same card).
 * ISO (`2026-07-14...`) and US (`7/14/2026...`) forms are read as written;
 * anything else falls back to the UTC calendar of the parsed instant so both
 * derived forms still agree with each other.
 */
function calendarDayOf(s: string): CalendarDay | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return { y: Number(us[3]), m: Number(us[1]), d: Number(us[2]) };
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * "Aug 25, 2026" from a calendar day. The instant is built from the calendar
 * triple and read back in UTC, so the round trip cannot shift the day; the
 * prose therefore always names the same day as the claim's ISO `valid` date.
 */
function calendarToProse(c: CalendarDay): string {
  return humanDayUtc(Date.UTC(c.y, c.m - 1, c.d));
}

function calendarToIso(c: CalendarDay): string {
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/**
 * Fetch the Drought Severity and Coverage Index (DSCI, 0 to 500) weekly series
 * for the region's primary state over roughly the past 14 months from the USDM
 * Data Services API and render it as an observed trend line. DSCI is a
 * statewide measure (not point-specific), so the claim is framed as statewide
 * context. The chart is solid throughout (all observation) with the current
 * value dotted and labeled.
 *
 * Trend wording: the NDMC publishes the DSCI definition, range and formula but
 * NO trend threshold, and calls the index experimental with "best practices
 * ... still evolving". The plus or minus 15 point band that turns the measured
 * change into a word is therefore DDM's own convention, and the rendered
 * sentence says so rather than letting the reader take it for the issuer's
 * (DWH-03). The change itself is measured and is stated in points.
 */
export async function fetchDsciTrendClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const fips = contextStateFips(context);
  const stateName = contextStateName(context);
  if (fips === null || stateName === null) {
    // The national explore framing has no primary state; the statewide DSCI
    // series is shown once a state can be identified for the selection.
    return {
      claims: [],
      ok: false,
      note: 'The statewide drought-severity trend is available for a state selection or a regional framing.'
    };
  }
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 14);
  const params = new URLSearchParams({
    aoi: String(fips),
    startdate: fmtUsdmDate(start),
    enddate: fmtUsdmDate(end),
    statisticsType: '1'
  });
  // Through the Worker proxy since 2026-07-14 (the 0.6.8 publish
  // verification): the upstream emitted Access-Control-Allow-Origin
  // through 2026-07-08 and has since stopped, so a direct browser fetch
  // dies on CORS. The hydromet pattern: no configured Worker (a fork
  // without one) falls back to the direct call, which degrades to the
  // honest unavailable note below rather than faking data.
  const upstream = `${URLS.usdmDataServices}/StateStatistics/GetDSCI?${params.toString()}`;
  const url =
    URLS.workerProxy === ''
      ? upstream
      : `${URLS.workerProxy}/proxy?url=${encodeURIComponent(upstream)}`;
  const source = 'USDM Data Services (NDMC)';
  // The NDMC's own DSCI page: it defines the index, its 0 to 500 range and its
  // formula, and it is where a reader can confirm that no trend threshold is
  // published (the band in the claim text is DDM's, and says so).
  const sourceUrl = 'https://droughtmonitor.unl.edu/About/AbouttheData/DSCI.aspx';

  try {
    const json: unknown = await fetchJson(url, { Accept: 'application/json' }, signal);
    if (signal.aborted) return { claims: [], ok: false };

    const rows = Array.isArray(json) ? json : [];
    const points: TrendPoint[] = [];
    // The raw upstream date string per instant, so the shown dates can be
    // derived from the source CALENDAR value rather than a timezone-sensitive
    // instant round trip (see calendarDayOf).
    const rawByT = new Map<number, string>();
    for (const r of rows) {
      if (!isObject(r) || typeof r.mapDate !== 'string') continue;
      const t = Date.parse(r.mapDate);
      const v = typeof r.dsci === 'number' ? r.dsci : Number(r.dsci);
      if (Number.isFinite(t) && Number.isFinite(v)) {
        points.push({ t, v });
        rawByT.set(t, r.mapDate);
      }
    }
    if (points.length < 2) {
      return { claims: [], ok: false, note: 'The USDM Data Services drought-severity series was unavailable.' };
    }

    points.sort((a, b) => a.t - b.t);
    const lastPoint = points[points.length - 1]!;
    // Trend direction over the last 12 weeks, measured on the DATES the series
    // carries. Stepping back 12 array positions assumed an unbroken weekly
    // series and silently shortened the comparison when a week was missing
    // (DWH-03); the comparison point is now the most recent map at or before
    // 12 weeks back, and the series may be shorter than that, in which case
    // the oldest map answers and the rendered span says so.
    const twelveWeeksBack = lastPoint.t - 12 * WEEK_MS;
    const priorPoint =
      [...points].reverse().find((p) => p.t <= twelveWeeksBack) ?? points[0]!;
    const delta = lastPoint.v - priorPoint.v;
    const trendWord = Math.abs(delta) < 15 ? 'about steady' : delta > 0 ? 'rising' : 'easing';
    // The latest map date, read once as a calendar value: the prose and the
    // claim's `dates.valid` MUST agree (they are the same day, shown twice).
    const lastCal = calendarDayOf(rawByT.get(lastPoint.t) ?? '');
    if (!lastCal) {
      return { claims: [], ok: false, note: 'The USDM Data Services drought-severity series was unavailable.' };
    }
    const asOf = calendarToProse(lastCal);
    // The comparison map's own date, read the same textual way, so the span
    // the sentence claims is the span the data actually covers.
    const priorCal = calendarDayOf(rawByT.get(priorPoint.t) ?? '');
    const spanWeeks = Math.max(1, Math.round((lastPoint.t - priorPoint.t) / WEEK_MS));
    const rounded = Math.round(delta);
    const changePhrase =
      rounded === 0
        ? 'unchanged'
        : `${rounded > 0 ? 'up' : 'down'} ${Math.abs(rounded)} points`;
    const sincePhrase = priorCal
      ? `over the ${spanWeeks} ${spanWeeks === 1 ? 'week' : 'weeks'} since the ${calendarToProse(priorCal)} map`
      : `over the ${spanWeeks} ${spanWeeks === 1 ? 'week' : 'weeks'} before it`;

    const chartSvg = trendLineSvg(points, {
      title: `${stateName} drought severity (DSCI, 0 to 500) over the past year`,
      yMax: 500,
      yLabel: 'DSCI',
      source: 'USDM Data Services'
    });

    // DSCI is computed by NDMC from the analyzed weekly USDM: 'analyzed'.
    // The latest map date is the value's valid date; retrieval is now.
    return {
      ok: true,
      claims: [
        makeClaim({
          text:
            `As of the ${asOf} map, statewide drought severity for ${stateName} ` +
            `(Drought Severity and Coverage Index, 0 to 500) is ${Math.round(lastPoint.v)}, ` +
            `${changePhrase} ${sincePhrase}, which DDM reads as ${trendWord}. ` +
            'The plus or minus 15 point band behind that word is a DDM convention: ' +
            'the NDMC publishes no DSCI trend threshold and calls the index itself experimental.',
          source,
          sourceUrl,
          product: 'dsci',
          evidence: 'analyzed',
          dates: { valid: calendarToIso(lastCal), retrieved: todayIso() },
          support: {
            reporting: `statewide (${stateName})`,
            // DDM-P13-T02: `usdm` is the src/ui/legend-registry.ts key the
            // U.S. Drought Monitor layer already builds its category legend
            // under (src/layers/usdm.ts showAbsoluteLegend).
            legendKey: 'usdm'
          },
          // DDM-P13-T02 correction: quoted from the issuer's own published
          // basis, held once as USDM_PERCENTILE_BASIS above and shared with
          // the per-point USDM category claims. The DSCI caveat stays in the
          // claim `text` above, unmoved; this is the USDM category's
          // percentile basis, a distinct fact from the DSCI caveat.
          method: {
            basis: USDM_PERCENTILE_BASIS
          },
          ...(chartSvg ? { chartSvg } : {})
        })
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] DSCI trend query failed.', err);
    return { claims: [], ok: false, note: 'The USDM drought-severity trend did not respond.' };
  }
}

// ---------------------------------------------------------------------------
// Current: mapped NIFC fire perimeters near the selection
// ---------------------------------------------------------------------------

/**
 * Query the National Interagency Fire Center (NIFC) current-perimeters
 * FeatureServer for current mapped fire perimeters intersecting the selection's
 * bounding box (or a small box around the click when no geometry bbox is
 * available). Wildfire, Prescribed fire, and unclassified records stay
 * distinct; zero mapped perimeters is also a plain observation.
 *
 * The sentence names the bounding box, not "this area" (DR-024 b): the box
 * is wider than the boundary, so a positive count is a count over the box,
 * and a page returned at the record cap is reported as a lower bound. The
 * polygon-exact query that would make the count a count over the place is
 * backed up on origin at feature/nifc-perimeter-evidence (905671d) and was
 * set aside by that ruling.
 */
export async function fetchNifcClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const source = 'NIFC current mapped fire perimeters (WFIGS)';
  const sourceUrl = 'https://data-nifc.opendata.arcgis.com/';
  const incompleteCrossingEnvelope =
    !context.serviceBbox &&
    (context.bboxCrossesAntimeridian === true ||
      (context.bbox !== undefined &&
        naiveBboxSuggestsAntimeridianCrossing(context.bbox)));
  if (incompleteCrossingEnvelope) {
    return {
      claims: [],
      ok: false,
      note: 'The NIFC current-perimeters service could not query the complete selection envelope.'
    };
  }
  const requestBbox =
    context.serviceBbox ??
    context.bbox ??
    ([lng - 0.5, lat - 0.5, lng + 0.5, lat + 0.5] as const);

  try {
    const payloads = await loadServiceEnvelopePieces(
      requestBbox,
      signal,
      async (piece, siblingSignal) => {
        const envelope = piece.map(round4).join(',');
        const query = esriEnvelopeQuery(
          envelope,
          'attr_UniqueFireIdentifier,attr_IncidentName,attr_IncidentTypeCategory',
          NIFC_AREA_QUERY_RECORD_CAP
        );
        return fetchJson(
          `${URLS.nifcFires}/query?${query.toString()}`,
          GEOJSON_ACCEPT,
          siblingSignal
        );
      }
    );
    if (signal.aborted) return { claims: [], ok: false };

    const pages = payloads.map(featuresOf);
    const features = mergeByStableIdentifier(
      pages,
      (feature) => {
        if (!isObject(feature) || !isObject(feature.properties)) return null;
        const id = feature.properties.attr_UniqueFireIdentifier;
        return typeof id === 'string' || typeof id === 'number' ? id : null;
      }
    );
    // A page that came back full may have been cut at the cap; the sentence
    // then reports the count as a lower bound rather than a total.
    const truncated = pages.some((page) => page.length >= NIFC_AREA_QUERY_RECORD_CAP);
    const text = buildNifcAreaPerimeterClaim(
      features.map((feature) =>
        isObject(feature) && isObject(feature.properties)
          ? feature.properties.attr_IncidentTypeCategory
          : undefined
      ),
      { truncated }
    );
    // Mapped incident perimeters and their count: directly observed.
    return {
      ok: true,
      claims: [
        makeClaim({ text, source, sourceUrl, product: 'nifc-fires', evidence: 'observed', dates: { retrieved: todayIso() } })
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NIFC query failed.', err);
    return {
      claims: [],
      ok: false,
      note: upstreamNote(err, 'The NIFC current-perimeters service')
    };
  }
}

// ---------------------------------------------------------------------------
// Current: active NWS alerts (red-flag fire weather, extreme heat)
// ---------------------------------------------------------------------------

/** NWS alert event names the briefing foregrounds (fire weather and heat). */
const FIRE_EVENTS = ['Red Flag Warning', 'Fire Weather Watch']; // vocab-allow: verbatim NWS product names, quoted source data
const HEAT_EVENTS = ['Excessive Heat Warning', 'Excessive Heat Watch', 'Heat Advisory', 'Extreme Heat Warning', 'Extreme Heat Watch']; // vocab-allow: verbatim NWS product names, quoted source data

/** Validate the active-products shape before absence can become an all-clear. */
function nwsActiveProductFeatures(json: unknown): unknown[] | null {
  if (
    !isObject(json) ||
    json.type !== 'FeatureCollection' ||
    !Array.isArray(json.features)
  ) {
    return null;
  }
  for (const feature of json.features) {
    if (
      !isObject(feature) ||
      feature.type !== 'Feature' ||
      !isObject(feature.properties) ||
      typeof feature.properties.event !== 'string'
    ) {
      return null;
    }
  }
  return json.features;
}

/**
 * Query the National Weather Service active alerts at the clicked point and
 * surface any fire-weather or extreme-heat alerts as observations. When none
 * are active, that is reported plainly (a meaningful all-clear for the
 * foregrounded hazards).
 */
export async function fetchNwsAlertClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal,
  session: NwsRequestSession = createNwsRequestSession(signal)
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const url =
    `${URLS.nwsApi}/alerts/active?point=` +
    `${nwsCoordinate(lat)},${nwsCoordinate(lng)}`;
  const source = 'NWS active alerts'; // vocab-allow: names the NWS alerts service, upstream product
  const sourceUrl = 'https://www.weather.gov/';

  try {
    const json: unknown = await session.fetchJson(url, NWS_CACHE_TTL.alerts);
    if (signal.aborted) return { claims: [], ok: false };

    const features = nwsActiveProductFeatures(json);
    if (features === null) {
      throw new Error('invalid NWS active-products payload');
    }
    const events = new Set<string>();
    for (const f of features) {
      if (!isObject(f) || !isObject(f.properties)) continue;
      const event = f.properties.event;
      if (typeof event === 'string') events.add(event);
    }

    const fire = [...events].filter((e) => FIRE_EVENTS.includes(e));
    const heat = [...events].filter((e) => HEAT_EVENTS.includes(e));
    const heatText =
      heat.length > 0
        // vocab-allow: reports upstream NWS alert products in effect
        ? `NWS active alerts at the selected point: ${heat.join(', ')}.`
        // vocab-allow: reports the absence of upstream NWS alert products
        : 'NWS reports no active extreme-heat alert at the selected point.';
    // Whether an NWS alert is in effect at the point is a directly observed
    // fact (the alert names quoted are verbatim upstream product names).
    const alertShared = { source, sourceUrl, product: 'nws-alerts', evidence: 'observed', dates: { retrieved: todayIso() } } as const;
    const claims: SourcedClaim[] = [];
    if (fire.length > 0) {
      claims.push(
        makeClaim({
          // vocab-allow: reports the NWS alert products in effect, upstream data
          text: `A fire-weather alert is in effect here: ${fire.join(', ')}. This signals imminent fire-weather conditions (low humidity, wind, dry fuels).`,
          ...alertShared,
          // One query answers for two hazard rows, so each statement names
          // the row it speaks for and neither row carries the other's.
          hazards: ['fire']
        })
      );
    }
    if (heat.length > 0) {
      claims.push(
        makeClaim({
          // The former tail, "and drought-dried soils amplify it", asserted a
          // drought-to-heat coupling: the class of claim ruling D-0.8.0-047
          // removed from the USDM category ladder. It is removed here too
          // (DWH-07); do not reintroduce a DDM-inferred drought-to-heat link.
          // vocab-allow: reports the NWS alert products in effect, upstream data
          text: `An extreme-heat alert is in effect here: ${heat.join(', ')}. Heat raises drinking-water demand and human-health stress.`,
          ...alertShared,
          hazards: ['heat']
        })
      );
    }
    if (claims.length === 0) {
      claims.push(
        makeClaim({
          // This one sentence reports both hazards, so it keeps the lane's own
          // pair and stands in the Fire row and the Heat row alike.
          // vocab-allow: reports the absence of NWS alert products, upstream data
          text: 'No active red-flag fire-weather or extreme-heat alerts at this location right now (NWS).',
          ...alertShared
        })
      );
    }
    return {
      ok: true,
      claims,
      heatRead: {
        key: 'nwsAlerts',
        // vocab-allow: names the upstream NWS active heat alerts product
        label: 'NWS active heat alerts',
        text: heatText,
        sourceUrl
      }
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NWS alerts query failed.', err);
    // vocab-allow: names the NWS alerts service, upstream product
    return { claims: [], ok: false, note: 'The NWS alerts service did not respond.' };
  }
}

// ---------------------------------------------------------------------------
// Near-term: CPC 6-10 day and 8-14 day outlooks (probability tilt)
// ---------------------------------------------------------------------------

interface OutlookValue {
  readonly cat: string;
  readonly prob: number;
  /** `fcst_date`: when CPC issued the outlook, epoch ms; null when absent. */
  readonly issued: number | null;
  /** `start_date`: first day of the valid window, epoch ms. */
  readonly validFrom: number | null;
  /** `end_date`: last day of the valid window, epoch ms (inclusive). */
  readonly validTo: number | null;
}

/**
 * The fields the extended-range outlook layers publish that the briefing can
 * state honestly: the tercile category and its probability, plus the issuance
 * and the valid window the service already sends with them (FSPEC-03). All
 * three date fields are epoch-millisecond UTC Date fields.
 */
const CPC_OUT_FIELDS = 'cat,prob,fcst_date,start_date,end_date';

/** Query one CPC outlook layer (0 = temperature, 1 = precipitation) at a point. */
async function fetchCpcLayer(
  base: string,
  layer: 0 | 1,
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<OutlookValue | null> {
  const url = `${base}/${layer}/query?${esriPointQuery(lng, lat, CPC_OUT_FIELDS).toString()}`;
  const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
  const f = featuresOf(json)[0] ?? null;
  if (!isObject(f) || !isObject(f.properties)) return null;
  const cat = f.properties.cat;
  const prob = f.properties.prob;
  if (typeof cat !== 'string') return null;
  return {
    cat,
    prob: typeof prob === 'number' ? prob : NaN,
    issued: epochField(f.properties.fcst_date),
    validFrom: epochField(f.properties.start_date),
    validTo: epochField(f.properties.end_date)
  };
}

/**
 * "Issued Sep 1, 2026; valid Sep 7 to Sep 11, 2026." from whichever of the
 * three date fields the service returned, and the empty string when it
 * returned none. An outlook must never state a window it was not given, so
 * each half is omitted independently rather than inferred from the other.
 */
function outlookValiditySentence(v: OutlookValue | null): string {
  if (!v) return '';
  const parts: string[] = [];
  if (v.issued !== null) parts.push(`Issued ${humanDayUtc(v.issued)}`);
  if (v.validFrom !== null && v.validTo !== null) {
    const sameYear =
      new Date(v.validFrom).getUTCFullYear() === new Date(v.validTo).getUTCFullYear();
    const from = sameYear ? humanDayUtcNoYear(v.validFrom) : humanDayUtc(v.validFrom);
    parts.push(`valid ${from} to ${humanDayUtc(v.validTo)}`);
  } else if (v.validFrom !== null) {
    parts.push(`valid from ${humanDayUtc(v.validFrom)}`);
  } else if (v.validTo !== null) {
    parts.push(`valid through ${humanDayUtc(v.validTo)}`);
  }
  return parts.length > 0 ? ` ${parts.join('; ')}.` : '';
}

/**
 * Render a category and probability into a lean phrase for one variable.
 * `EC` (Equal Chances) is CPC's own statement that no forecast tool favors
 * any tercile, which is a different claim from a near-normal tilt (the
 * issuer's own glossary: "areas where equal chances of experiencing
 * below-normal, normal, or above-normal conditions are possible";
 * ddm-science-verifier EC verdict, 2026-09-09). It is never folded into
 * `Normal`'s "near-normal" phrase. A category code that is none of the
 * four the issuer's service carries renders nothing rather than invent a
 * tilt: `leanPhrase` returning `null` here already leaves the claim to the
 * surviving variable, or drops the window if neither answers (see the
 * `parts.filter` call above this function's caller).
 */
function leanPhrase(v: OutlookValue | null, variable: string): string | null {
  if (!v) return null;
  const odds = Number.isFinite(v.prob) ? ` (${v.prob}% odds)` : '';
  if (v.cat === 'Above') return `above-normal ${variable}${odds}`;
  if (v.cat === 'Below') return `below-normal ${variable}${odds}`;
  if (v.cat === 'Normal') return `near-normal ${variable}`;
  if (v.cat === 'EC') {
    return `equal chances of above-, near-, or below-normal ${variable} (no CPC-favored category)`;
  }
  return null;
}

/** Drought-and-fire interpretation of a temperature and precipitation lean. */
function outlookInterpretation(temp: OutlookValue | null, precip: OutlookValue | null): string {
  if (temp?.cat === 'Above' && precip?.cat === 'Below') {
    return 'This hotter, drier tilt worsens near-term dryness and raises fire and heat risk.';
  }
  if (temp?.cat === 'Below' && precip?.cat === 'Above') {
    return 'This cooler, wetter tilt eases near-term dryness.';
  }
  return '';
}

/**
 * Query the CPC 6-10 day and 8-14 day temperature and precipitation outlooks at
 * the point and surface each window's probability tilt as an outlook claim. The
 * lean is stated as a probability, never a deterministic value (the honest
 * outlook rule), and each claim carries the issuance and the valid window the
 * service publishes alongside the category. A window whose fetches fail is
 * skipped; the result is ok when at least one window resolved.
 */
export async function fetchCpcOutlookClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const source = 'NOAA CPC extended-range outlooks';
  const sourceUrl = 'https://www.cpc.ncep.noaa.gov/';

  const windows: Array<{ label: string; base: string }> = [
    { label: '6-10 day', base: URLS.cpc610OutlookMapServer },
    { label: '8-14 day', base: URLS.cpc814OutlookMapServer }
  ];

  // Each settled claim carries its window's ordinal so chronological order
  // never depends on the display copy (a wording change must not reorder).
  const settled: Array<{ readonly ordinal: number; readonly claim: SourcedClaim }> = [];
  let anyFailed = false;
  // The first error-envelope answer seen across both windows, kept so a host
  // that answered with an error is not reported as one that never answered
  // (FSPEC-01). The per-variable catches below swallow the rejection to keep
  // the sibling variable, so the envelope has to be recorded on the way past.
  let serviceError: EsriServiceError | null = null;
  const keepServiceError = (err: unknown): null => {
    if (err instanceof EsriServiceError && serviceError === null) serviceError = err;
    return null;
  };
  await Promise.all(
    windows.map(async ({ label, base }, ordinal) => {
      try {
        // Fetch temperature and precipitation independently so one variable's
        // HTTP failure does not discard the other; a window still emits the
        // variable that succeeded (graceful degradation, honest-feedback rule).
        const [temp, precip] = await Promise.all([
          fetchCpcLayer(base, 0, lng, lat, signal).catch(keepServiceError),
          fetchCpcLayer(base, 1, lng, lat, signal).catch(keepServiceError)
        ]);
        if (signal.aborted) return;
        const parts = [leanPhrase(temp, 'temperature'), leanPhrase(precip, 'precipitation')].filter(
          (p): p is string => p !== null
        );
        if (parts.length === 0) {
          anyFailed = true;
          return;
        }
        if (!temp || !precip) anyFailed = true;
        const interp = outlookInterpretation(temp, precip);
        // The two variables are layers of ONE issuance, so they carry the same
        // fcst_date, start_date and end_date; whichever answered speaks for the
        // window. An outlook claim with no forecast period is the one kind that
        // must never lack one (DWH-06), so the dates are stated in the sentence
        // and the issuance also dates the claim.
        const dated = temp ?? precip;
        const validity = outlookValiditySentence(dated);
        const issued = dated?.issued ?? null;
        // Foreground the temperature tercile bar (the heat-relevant variable).
        const chartSvg = temp
          ? cpcOutlookBarsSvg({ variable: 'temperature', cat: temp.cat, prob: temp.prob, window: label })
          : undefined;
        settled.push({
          ordinal,
          claim: makeClaim({
            text: `CPC ${label} outlook: ${parts.join(', ')}.${interp ? ' ' + interp : ''}${validity}`,
            source,
            sourceUrl,
            product: 'cpcExtended',
            evidence: 'outlook',
            dates:
              issued === null
                ? { retrieved: todayIso() }
                : { issued: isoDayUtc(issued), retrieved: todayIso() },
            uncertainty: { kind: 'categorical', text: 'stated as tercile odds (above, near, or below normal), not a deterministic value' },
            ...(chartSvg ? { chartSvg } : {})
          })
        });
      } catch (err) {
        if (!signal.aborted) console.warn(`[impact] CPC ${label} outlook failed.`, err);
        anyFailed = true;
      }
    })
  );

  if (signal.aborted) return { claims: [], ok: false };
  // Keep windows in chronological order (6-10 then 8-14) regardless of which
  // promise settled first, by the declared window ordinal (never by text).
  const claims = settled.sort((a, b) => a.ordinal - b.ordinal).map((s) => s.claim);
  if (claims.length === 0) {
    return {
      claims: [],
      ok: false,
      note: upstreamNote(serviceError, 'The CPC extended-range outlooks')
    };
  }
  return { claims, ok: true, ...(anyFailed ? { note: 'One CPC outlook window did not respond.' } : {}) };
}

// ---------------------------------------------------------------------------
// Season-ahead: CPC seasonal temperature outlook (DDM-P7-T07, DR-075 a)
// ---------------------------------------------------------------------------

/**
 * The fields the CPC seasonal temperature outlook's Lead 1 layer (layer 0)
 * publishes that the briefing can state honestly: the tercile category, its
 * probability, the issuer's own season label, and the forecast issuance
 * date. Verified 2026-09-09 (STEP 0, ddm-forecast-wirer): neither `cat` nor
 * `valid_seas` carries a coded domain on the service; both are read as raw
 * codes and expanded through the issuer's own legend/page reading below
 * (ddm-science-verifier, 2026-09-09), never invented.
 */
const CPC_SEASONAL_TEMP_FIELDS = 'cat,prob,valid_seas,fcst_date';

/**
 * The issuer's own reading of its `cat` code, from the service's renderer
 * legend (STEP 0's `uniqueValueGroups`,
 * `I:\claude-temp\ddm-s18\DDM-P7-T07\layer0-description.json`): the raw
 * codes `Normal` and `EC` are never shown to the public by the issuer, which
 * labels them "Near Normal" and "Equal Chances"; this table carries the
 * sentence's own lowercase hyphenated reading of that legend directly
 * (`Above`/`Below` are already the issuer's words). `EC` renders its own
 * branch below rather than a table entry (its sentence carries no percent).
 * A code this table does not carry renders verbatim, never invented.
 */
const CPC_SEASONAL_CAT_LABEL: Readonly<Record<string, string>> = {
  Above: 'above-normal',
  Below: 'below-normal',
  Normal: 'near-normal'
};

/**
 * CPC's own "Mon-Mon-Mon YYYY" reading of its three-letter `valid_seas` code
 * (ddm-science-verifier, 2026-09-09: CPC's page writes "Sep-Oct-Nov 2026",
 * https://www.cpc.ncep.noaa.gov/products/predictions/long_range/seasonal_info.php).
 * A code outside this fixed 12-entry table, or a `valid_seas` value that does
 * not parse as `<code> <year>`, renders verbatim, never invented.
 */
const CPC_SEASON_CODE_EXPANSION: Readonly<Record<string, string>> = {
  JFM: 'Jan-Feb-Mar',
  FMA: 'Feb-Mar-Apr',
  MAM: 'Mar-Apr-May',
  AMJ: 'Apr-May-Jun',
  MJJ: 'May-Jun-Jul',
  JJA: 'Jun-Jul-Aug',
  JAS: 'Jul-Aug-Sep',
  ASO: 'Aug-Sep-Oct',
  SON: 'Sep-Oct-Nov',
  OND: 'Oct-Nov-Dec',
  NDJ: 'Nov-Dec-Jan',
  DJF: 'Dec-Jan-Feb'
};

function cpcSeasonalValidSeasLabel(validSeas: string): string {
  const match = /^([A-Za-z]{3})(?:\s+(\d{4}))?$/.exec(validSeas.trim());
  if (!match) return validSeas;
  const expansion = CPC_SEASON_CODE_EXPANSION[match[1]!.toUpperCase()];
  if (!expansion) return validSeas;
  return match[2] ? `${expansion} ${match[2]}` : expansion;
}

/**
 * Query the CPC seasonal temperature outlook (`cpcSeasonalTempOutlookMapServer`,
 * Lead 1 = layer 0) at the point and surface its category, probability and
 * the issuer's own season label as an outlook claim. This is a NOAA Climate
 * Prediction Center product, never presented as an ENSO forecast (DR-019).
 * The layer publishes no region-name attribute, so the claim states the
 * geography the query answered for as "at the selected point" (matching the
 * rest of this file's point-query claims). A failed fetch, an ArcGIS error
 * envelope, or a point the service returns no feature (or a malformed one)
 * for all report `ok: false` with a note naming the product, per the
 * honesty contract above; none of them renders a claim.
 */
export async function fetchCpcSeasonalTempClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const source = 'NOAA Climate Prediction Center seasonal temperature outlook';
  // The issuer's Seasonal Outlook landing page (ddm-science-verifier,
  // 2026-09-09: verified 200).
  const sourceUrl = 'https://www.cpc.ncep.noaa.gov/products/predictions/long_range/';
  const base = URLS.cpcSeasonalTempOutlookMapServer;
  const url = `${base}/0/query?${esriPointQuery(lng, lat, CPC_SEASONAL_TEMP_FIELDS).toString()}`;
  try {
    const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
    if (signal.aborted) return { claims: [], ok: false };
    const f = featuresOf(json)[0] ?? null;
    if (!isObject(f) || !isObject(f.properties)) {
      return {
        claims: [],
        ok: false,
        note: 'The NOAA CPC seasonal temperature outlook returned no reading for this point.'
      };
    }
    const cat = f.properties.cat;
    const validSeas = f.properties.valid_seas;
    const prob = f.properties.prob;
    if (
      typeof cat !== 'string' ||
      typeof validSeas !== 'string' ||
      typeof prob !== 'number' ||
      !Number.isFinite(prob)
    ) {
      return {
        claims: [],
        ok: false,
        note: 'The NOAA CPC seasonal temperature outlook returned no reading for this point.'
      };
    }
    // `fcst_date`'s field alias equals its field name on this service (STEP
    // 0): the issuer publishes no descriptive alias for it. "Issued" below
    // is this code's own inference from CPC's published near-mid-month
    // release cadence plus the sampled value, not a reading of an issuer
    // field description.
    const issued = epochField(f.properties.fcst_date);
    const issuedText = issued !== null ? ` Issued ${humanDayUtc(issued)}.` : '';
    const season = cpcSeasonalValidSeasLabel(validSeas);
    const text =
      cat === 'EC'
        ? `NOAA Climate Prediction Center seasonal temperature outlook for ${season}: Equal Chances (no favored tercile), at the selected point.${issuedText}`
        : `NOAA Climate Prediction Center seasonal temperature outlook for ${season}: ${prob}% chance of ${
            CPC_SEASONAL_CAT_LABEL[cat] ?? cat
          } temperature, at the selected point.${issuedText}`;
    return {
      claims: [
        makeClaim({
          text,
          source,
          sourceUrl,
          product: 'cpcSeasonalTemp',
          evidence: 'outlook',
          dates:
            issued === null
              ? { retrieved: todayIso() }
              : { issued: isoDayUtc(issued), retrieved: todayIso() },
          uncertainty: {
            kind: 'categorical',
            text: 'a tercile category and its stated probability, not a deterministic outcome'
          }
        })
      ],
      ok: true
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] CPC seasonal temperature outlook query failed.', err);
    return {
      claims: [],
      ok: false,
      note: upstreamNote(err, 'The NOAA CPC seasonal temperature outlook')
    };
  }
}

// ---------------------------------------------------------------------------
// Near-term: SPC Day 1-8 Fire Weather Outlook (DDM-P7-T03, DR-022 a)
// ---------------------------------------------------------------------------

/**
 * The SPC fire weather outlook layers this fetch reads at the selected
 * point (verified 2026-09-09, verify-spc-nifc.md, S20): layer 1 is Day 1 and
 * layer 4 is Day 2, both categorical on field `dn` (5 Elevated, 8 Critical,
 * 10 Extremely Critical, SPC's own public product word per the science
 * verdict; `SPC_FIREWX_CATEGORIES` carries the correction, so the map legend
 * and this text agree). Layers 8, 11, 14, 17, 20, 23 are the Days 3-8
 * probabilistic product on field `label` ("0.40", "0.70"), plus a live third
 * value with `dn` 0 and `label` "Probability Too Low" that the service's own
 * renderer does not document (stated honestly as a DDM-convention reading,
 * never as no data and never as an invented risk category). All six Days
 * 3-8 layers share one `issue` timestamp; every layer carries its own
 * `valid` and `expire` window as a `YYYYMMDDHHMM` UTC string, matching
 * `src/layers/spc-fire-weather.ts`'s own Day 1 field reading. NOAA's own
 * serviceDescription and about.html disagree on the Day 1 cadence (S20), so
 * no sentence here states a cadence: every window comes only from the
 * feature's own `valid` and `expire`, never invented from the calendar.
 */
// The `day` each layer answers (1, 2) is never read back from this table:
// `spcCategoricalClaim`'s two call sites below name their day literally, so
// only `layer` is carried here (F11, S20 fix round: an unused `day` field
// was deleted rather than kept dead).
const SPC_CATEGORICAL_DAYS: ReadonlyArray<{ readonly layer: number }> = [
  { layer: 1 },
  { layer: 4 }
];

/** Days 3-8, layer id order (S20: 8 Day 3, 11 Day 4, 14 Day 5, 17 Day 6, 20 Day 7, 23 Day 8). */
const SPC_PROBABILISTIC_DAYS: ReadonlyArray<{
  readonly day: 3 | 4 | 5 | 6 | 7 | 8;
  readonly layer: number;
}> = [
  { day: 3, layer: 8 },
  { day: 4, layer: 11 },
  { day: 5, layer: 14 },
  { day: 6, layer: 17 },
  { day: 7, layer: 20 },
  { day: 8, layer: 23 }
];

const SPC_CATEGORICAL_OUT_FIELDS = 'dn,valid,expire';
const SPC_PROBABILISTIC_OUT_FIELDS = 'dn,label,label2,valid,expire,issue';

/** The issuer's SPC fire weather definitions page (dn categories, product names). */
const SPC_ABOUT_URL = 'https://www.spc.noaa.gov/misc/about.html';
/** The issuer's Days 3-8 probability definition (verify-spc-nifc.md S20 quote). */
const SPC_PROBABILISTIC_INFO_URL = 'https://www.spc.noaa.gov/misc/SPC_Fire_Probabilistic_Information.pdf';

/** One SPC layer query's outcome: `ok: false` is a transport or envelope
 * failure (no claim is ever built from it); `ok: true, props: null` is a
 * legitimate empty result (the layer drew no area over the point). */
interface SpcLayerOutcome {
  readonly ok: boolean;
  readonly props: Record<string, unknown> | null;
  readonly err?: unknown;
}

/**
 * The field list threaded as an object property (`{ outFields }`) rather
 * than a bare positional string, so `scripts/check-upstream-drift.mjs`'s
 * static `outFields:` extraction can see each SPC layer's field list
 * (F6, S20 fix round: the SPC 6-day and 12-day column-family drift-contract
 * probe needs a real source-text anchor, not a positional argument).
 */
async function fetchSpcLayerOutcome(
  base: string,
  layer: number,
  query: { readonly outFields: string },
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<SpcLayerOutcome> {
  try {
    const url = `${base}/${layer}/query?${esriPointQuery(lng, lat, query.outFields).toString()}`;
    const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
    const f = featuresOf(json)[0] ?? null;
    return { ok: true, props: isObject(f) && isObject(f.properties) ? f.properties : null };
  } catch (err) {
    return { ok: false, props: null, err };
  }
}

/**
 * SPC's `YYYYMMDDHHMM` UTC field into epoch milliseconds, or null when the
 * field is missing or malformed. Mirrors `spcMomentUtc` in
 * `src/layers/spc-fire-weather.ts` (module-private there, and that file is a
 * different task's; kept as its own small parser here rather than imported).
 */
function parseSpcMoment(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) return null;
  const ms = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12))
  );
  return Number.isNaN(ms) ? null : ms;
}

/**
 * ", valid <from> to <until>." from whichever of `valid`/`expire` parsed.
 * Each half is stated only when the service gave it (the honest-outlook
 * rule: never invent a window edge), and a feature with neither closes the
 * sentence with a bare period. The moment grammar itself is `heatRiskMoment`
 * above (F11, S20 fix round: a byte-identical `spcMomentText` duplicated it;
 * deleted in favor of the one formatter), the same "Sep 8, 2026, 12:00 UTC"
 * grammar `src/layers/spc-fire-weather.ts:118` uses for the same SPC
 * valid/expire field (DR-037 i: one grammar per field, shared).
 */
function spcValidityClause(validMs: number | null, expireMs: number | null): string {
  if (validMs !== null && expireMs !== null) {
    return `, valid ${heatRiskMoment(validMs)} to ${heatRiskMoment(expireMs)}.`;
  }
  if (validMs !== null) return `, valid from ${heatRiskMoment(validMs)}.`;
  if (expireMs !== null) return `, valid through ${heatRiskMoment(expireMs)}.`;
  return '.';
}

/**
 * The issuer's own `dn` word (`SPC_FIREWX_CATEGORIES`, corrected to
 * "Extremely Critical" for `dn` 10), or `null` for a value the palette
 * table does not carry: the caller drops the read rather than inventing a
 * severity for an unrecognized code (F3, S20 fix round: a prior `Category
 * <n>` fallback fabricated a risk sentence for a malformed `dn`).
 */
function spcCategoryWord(dn: number): string | null {
  const entry = SPC_FIREWX_CATEGORIES.find((c) => c.dn === dn);
  return entry ? entry.label : null;
}

/**
 * One Day 1 or Day 2 categorical read, science verdict sentence shapes (a)
 * and (b) (section 4). `outcome.ok === false` (a failed query) yields no
 * claim at all here: the caller reports the day's absence from the cell
 * only through the lane's own failure note, never through this sentence
 * shape, so an outage can never read as an honest "no area is drawn".
 * `outcome.props === null` (the layer legitimately drew nothing here) is
 * the only path to the no-area sentence; a feature WITH an unrecognized or
 * malformed `dn` (F3: `null`, `''`, or any value not in
 * `SPC_FIREWX_CATEGORIES`) is dropped with a console warning instead,
 * never folded into "no area is drawn" (an area WAS returned) and never
 * printed as an invented "Category <n>" risk. One conflation remains and is
 * stated rather than hidden: `fetchSpcLayerOutcome` also folds a returned
 * feature whose `properties` is absent or not an object into `props: null`,
 * so such a feature would read as no area drawn; ArcGIS GeoJSON always
 * carries a properties object, so no live path reaches it.
 */
function spcCategoricalClaim(
  day: 1 | 2,
  outcome: SpcLayerOutcome,
  source: string
): SourcedClaim | null {
  if (!outcome.ok) return null;
  const product = `SPC Day ${day} Fire Weather Outlook`;
  const props = outcome.props;
  if (props === null) {
    return makeClaim({
      text: `${product}: no Elevated, Critical, or Extremely Critical area is drawn over this point for this day.`,
      source,
      sourceUrl: SPC_ABOUT_URL,
      product: 'spc-fire-weather',
      evidence: 'outlook',
      dates: { retrieved: todayIso() }
    });
  }
  const dn = typeof props.dn === 'number' ? props.dn : Number(props.dn);
  const categoryWord = Number.isFinite(dn) ? spcCategoryWord(dn) : null;
  if (categoryWord === null) {
    console.warn(
      `[impact] SPC Day ${day} outlook returned an unrecognized dn; dropped rather than invented.`,
      props.dn
    );
    return null;
  }
  const validMs = parseSpcMoment(props.valid);
  const expireMs = parseSpcMoment(props.expire);
  return makeClaim({
    text: `${product}: ${categoryWord} risk from wind and relative humidity at this point${spcValidityClause(validMs, expireMs)}`,
    source,
    sourceUrl: SPC_ABOUT_URL,
    product: 'spc-fire-weather',
    evidence: 'outlook',
    dates:
      validMs !== null
        ? { valid: isoDayUtc(validMs), retrieved: todayIso() }
        : { retrieved: todayIso() },
    uncertainty: {
      kind: 'categorical',
      text: 'a categorical fire-weather threat class, not a deterministic outcome'
    }
  });
}

/** "Day 5", "Days 5 and 6", or "Days 5, 6, and 7" (the serial comma, F11:
 * the verdict's own section 4(c) sentence uses one), for the compact fold. */
function joinDayList(days: readonly number[]): string {
  if (days.length === 1) return `Day ${days[0]}`;
  if (days.length === 2) return `Days ${days[0]} and ${days[1]}`;
  return `Days ${days.slice(0, -1).join(', ')}, and ${days[days.length - 1]}`;
}

/**
 * Query the SPC Day 1-8 Fire Weather Outlook (`spcFireWeatherOutlookMapServer`)
 * at the selected point and surface the near-term fire cell's claims: Day 1
 * and Day 2 first, then the Days 3-8 probabilistic reads in day order,
 * compactly (DDM-P7-T03, DR-022 a). Every sentence carries the issuer, the
 * product name, and the valid window the service gave it (never a cadence
 * claim, per the Day 1 cadence contradiction S20 found in NOAA's own
 * metadata); a day with no drawn area says so honestly (never no data,
 * never unavailable), and the live undocumented "Probability Too Low" value
 * is stated as a DDM-convention reading, never as no data and never as an
 * invented risk category. A day whose own query failed contributes no claim
 * (never a false "no area" reading of an outage); the whole lane reads
 * unavailable naming the product only when every one of the eight queries
 * failed. This never speaks for the 2023 Wildfire Hazard Potential raster,
 * which is not a forecast and is not read here.
 */
export async function fetchSpcFireOutlookClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const source = 'NOAA Storm Prediction Center';
  const base = URLS.spcFireWeatherOutlookMapServer;

  const [day1, day2, ...probOutcomes] = await Promise.all([
    fetchSpcLayerOutcome(base, SPC_CATEGORICAL_DAYS[0]!.layer, { outFields: SPC_CATEGORICAL_OUT_FIELDS }, lng, lat, signal),
    fetchSpcLayerOutcome(base, SPC_CATEGORICAL_DAYS[1]!.layer, { outFields: SPC_CATEGORICAL_OUT_FIELDS }, lng, lat, signal),
    ...SPC_PROBABILISTIC_DAYS.map(({ layer }) =>
      fetchSpcLayerOutcome(base, layer, { outFields: SPC_PROBABILISTIC_OUT_FIELDS }, lng, lat, signal)
    )
  ]);

  if (signal.aborted) return { claims: [], ok: false };

  const allOutcomes: readonly SpcLayerOutcome[] = [day1, day2, ...probOutcomes];
  const anySucceeded = allOutcomes.some((o) => o.ok);
  if (!anySucceeded) {
    const serviceError = allOutcomes.find((o) => o.err instanceof EsriServiceError)?.err;
    return {
      claims: [],
      ok: false,
      note: upstreamNote(serviceError, 'The NOAA Storm Prediction Center Day 1-8 Fire Weather Outlook')
    };
  }

  const claims: SourcedClaim[] = [];
  const day1Claim = spcCategoricalClaim(1, day1, source);
  if (day1Claim) claims.push(day1Claim);
  const day2Claim = spcCategoricalClaim(2, day2, source);
  if (day2Claim) claims.push(day2Claim);

  const noFeatureDays: number[] = [];
  for (let i = 0; i < SPC_PROBABILISTIC_DAYS.length; i += 1) {
    const { day } = SPC_PROBABILISTIC_DAYS[i]!;
    const outcome = probOutcomes[i]!;
    // A failed query contributes nothing, not even to the "no area" fold
    // (an outage is never a positive finding of absence, FSPEC-01).
    if (!outcome.ok) continue;
    const props = outcome.props;
    if (props === null) {
      noFeatureDays.push(day);
      continue;
    }
    const product = `SPC Day ${day} Fire Weather Outlook`;
    const label = typeof props.label === 'string' ? props.label.trim() : '';
    const issuedMs = parseSpcMoment(props.issue);
    const dates =
      issuedMs !== null
        ? { issued: isoDayUtc(issuedMs), retrieved: todayIso() }
        : { retrieved: todayIso() };
    if (label === '0.40' || label === '0.70') {
      const pct = label === '0.40' ? 40 : 70;
      const validMs = parseSpcMoment(props.valid);
      const expireMs = parseSpcMoment(props.expire);
      claims.push(
        makeClaim({
          text: `${product}: ${pct}% probability of critical fire weather and/or lightning-based ignition within 12 miles of this point${spcValidityClause(validMs, expireMs)}`,
          source,
          sourceUrl: SPC_PROBABILISTIC_INFO_URL,
          product: 'spc-fire-weather',
          evidence: 'outlook',
          dates,
          uncertainty: {
            kind: 'categorical',
            text: 'a probability of occurrence within 12 miles of the point during the outlook period, not a deterministic outcome'
          }
        })
      );
    } else if (label === 'Probability Too Low') {
      claims.push(
        makeClaim({
          text: `${product}: this point returns "Probability Too Low", a service value with no public SPC definition found; treated here as below the 10% threshold SPC does map, not as no-data.`,
          source,
          sourceUrl: SPC_PROBABILISTIC_INFO_URL,
          product: 'spc-fire-weather',
          evidence: 'outlook',
          dates,
          uncertainty: {
            kind: 'not-quantified',
            text: 'a live service value with no issuer-published definition found'
          }
        })
      );
    } else {
      // No verified sentence exists for any other label the service might
      // send; dropped rather than invented, and never folded into the
      // "no area" sentence below (an area WAS drawn here, just not one of
      // the three verified values).
      console.warn(
        `[impact] SPC Day ${day} outlook returned an unrecognized label; dropped rather than invented.`,
        label
      );
    }
  }

  if (noFeatureDays.length > 0) {
    claims.push(
      makeClaim({
        text: `SPC Day 3-8 Fire Weather Outlook: no area is drawn over this point for ${joinDayList(noFeatureDays)}.`,
        source,
        sourceUrl: SPC_ABOUT_URL,
        product: 'spc-fire-weather',
        evidence: 'outlook',
        dates: { retrieved: todayIso() }
      })
    );
  }

  if (claims.length === 0) {
    // Every query that answered found nothing claimable (for example every
    // probabilistic label was unrecognized while both categorical layers
    // also failed): report the same honest unavailable the total-failure
    // branch above uses, naming the product, rather than an empty cell with
    // no note.
    return {
      claims: [],
      ok: false,
      note: 'The NOAA Storm Prediction Center Day 1-8 Fire Weather Outlook returned no reading this briefing can state for this point.'
    };
  }

  // F5 (S20 fix round): a per-layer failure is NOT surfaced to the reader
  // here, on purpose for now. `fillCell` (src/impact/matrix.ts:262-310, not
  // granted to this lane) collects a lane's `note` only when the whole lane
  // answers `ok: false`; an `ok: true` lane's note is silently dropped, so a
  // note reporting a partial outage on this path would never reach the DOM
  // (the same gap exists for `fetchCpcOutlookClaims` above, which this
  // lane's round 1 copied without noticing). Handed off rather than fixed
  // here: see the report's Handoffs section.
  return { claims, ok: true };
}

// ---------------------------------------------------------------------------
// Near-term: NWS point forecast (temperature tendency)
// ---------------------------------------------------------------------------

/**
 * Resolve the NWS gridpoint forecast for the clicked point (two hops: the
 * `/points` metadata gives the forecast URL) and surface the next forecast
 * period as a near-term outlook. This is a point weather forecast, framed as
 * an outlook (a tendency, not a certainty), foregrounding temperature for the
 * heat horizon.
 */
export async function fetchNwsForecastClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal,
  session: NwsRequestSession = createNwsRequestSession(signal)
): Promise<SourceResult> {
  const source = 'NWS forecast'; // vocab-allow: names the NWS point forecast, upstream product
  const sourceUrl = 'https://www.weather.gov/';

  try {
    const point = await fetchNwsPointMetadata(
      context.lngLat.lng,
      context.lngLat.lat,
      session
    );
    if (signal.aborted) return { claims: [], ok: false };
    const forecastUrl = point.forecastUrl;
    if (!forecastUrl) throw new Error('no forecast URL in points response');

    const fJson: unknown = await session.fetchJson(
      forecastUrl,
      NWS_CACHE_TTL.forecast
    );
    if (signal.aborted) return { claims: [], ok: false };

    const periods =
      isObject(fJson) && isObject(fJson.properties) && Array.isArray(fJson.properties.periods)
        ? fJson.properties.periods
        : [];
    const first = periods.find(isObject);
    if (!first) throw new Error('no forecast periods');

    const name = typeof first.name === 'string' ? first.name : 'The coming period';
    const temp = typeof first.temperature === 'number' ? first.temperature : null;
    const unit = typeof first.temperatureUnit === 'string' ? first.temperatureUnit : 'F';
    const short = typeof first.shortForecast === 'string' ? first.shortForecast : '';
    const tempStr = temp !== null ? `${temp} degrees ${unit}` : 'an unspecified temperature';
    // vocab-allow: renders the upstream NWS point forecast product
    const text = `${name}: ${short || 'forecast available'}, near ${tempStr}. Watch this against the heat outlook; hot, dry spells deepen near-term dryness and fire danger.`;

    return {
      ok: true,
      claims: [
        makeClaim({
          // vocab-allow: names the NWS point forecast, upstream product
          text,
          source,
          sourceUrl,
          product: 'nwsForecast',
          evidence: 'outlook',
          dates: { retrieved: todayIso() },
          // vocab-allow: names the NWS point forecast, upstream product
          uncertainty: { kind: 'not-quantified', text: 'a point weather forecast stated as a tendency; the NWS product publishes no uncertainty band here' }
        })
      ],
      heatRead: {
        key: 'nwsForecast',
        // vocab-allow: names the upstream NWS point forecast product
        label: 'NWS point forecast',
        // vocab-allow: renders the upstream NWS point forecast product
        text: `${name}: ${short || 'forecast available'}, near ${tempStr}.`,
        sourceUrl
      }
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NWS forecast query failed.', err);
    // vocab-allow: names the NWS point forecast, upstream product
    return { claims: [], ok: false, note: 'The NWS point forecast did not respond.' };
  }
}
