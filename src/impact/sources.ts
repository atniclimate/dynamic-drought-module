/**
 * Live source fetchers for the impact briefing.
 *
 * Each function fetches one verified, Cross-Origin Resource Sharing (CORS)
 * open source for a boundary selection and returns a `SourceResult`: the
 * claims it produced and whether the fetch succeeded. The orchestrator
 * (`hydrate.ts`) assembles these into the three temporal horizons.
 *
 * Honesty contract (CLAUDE.md section 6 invariant 6; ddm-drought-impact-
 * modeling): observations are stated plainly with their source; outlooks are
 * stated as probabilities or tendencies. A fetch that fails returns `ok:false`
 * so the horizon can say so honestly rather than inventing a value. A fetch
 * that succeeds but finds nothing (no active alerts, no fires) returns
 * `ok:true` with an informative observation. JSON fetches keep the briefing's
 * master abort signal and per-call timeout active through body consumption,
 * so a hung host never blocks the panel (invariant 5).
 *
 * Verified sources (see docs/KERNEL_INTEGRATION_CONTINUATION.md section 3 and
 * src/config/urls.ts): USDM FeatureServer (CORS *), NIFC perimeters
 * FeatureServer (CORS *), NWS api.weather.gov alerts and point forecast
 * (CORS *).
 */

import { URLS } from '../config/urls';
import { HEATRISK_CATEGORIES } from '../config/palette';
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

/** The `features` array of a GeoJSON-shaped payload, or `[]` when absent. */
function featuresOf(json: unknown): unknown[] {
  return isObject(json) && Array.isArray(json.features) ? json.features : [];
}

// ---------------------------------------------------------------------------
// Current: issuer-published HeatRisk class at the selected frame and point
// ---------------------------------------------------------------------------

function heatRiskIsoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

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
    const { identifySelectedHeatRisk } = await import(
      '../ui/heatrisk-sequence'
    );
    const identified = await identifySelectedHeatRisk(
      context.lngLat.lng,
      context.lngLat.lat,
      signal
    );
    if (signal.aborted) return { claims: [], ok: false };
    // HeatRisk is contextual to its active displayed frame. An inactive layer
    // adds no source slot and does not make an otherwise complete horizon
    // partial.
    if (!identified) return { claims: [], ok: true };

    const validity =
      `${heatRiskMoment(identified.frame.validTime)} to ` +
      heatRiskMoment(identified.validThrough);
    const source = 'National Weather Service HeatRisk (Experimental)';
    const sourceUrl = `${URLS.nwsHeatRisk}/info/iteminfo`;
    const shared = {
      source,
      sourceUrl,
      evidence: 'classified',
      dates: {
        valid: heatRiskIsoDay(identified.frame.validTime),
        retrieved: todayIso()
      },
      support: {
        native: 'National Weather Service HeatRisk raster cell',
        reporting: 'the cell at the selected point'
      },
      uncertainty: {
        kind: 'categorical',
        text: 'an issuer-published 0-4 classification; no DDM category is calculated'
      }
    } as const;

    if (identified.value === null) {
      const text =
        `HeatRisk (Experimental): no data at the selected point for ${context.title} for the selected frame. ` +
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
          label: 'NWS HeatRisk selected frame',
          text
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
        label: 'NWS HeatRisk selected frame',
        text
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
 * Query the United States Drought Monitor FeatureServer for the polygons that
 * contain the clicked point and translate the worst (highest) category present
 * into observation claims: the drought state, then the wildfire implication,
 * then the extreme-heat implication. If no polygon contains the point, the
 * location is better than D0 this week, which is itself a plain observation.
 */
export async function fetchUsdmClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const url = `${URLS.usdmFeatureServer}/query?${esriPointQuery(lng, lat, 'DM').toString()}`;
  const source = 'U.S. Drought Monitor (NDMC / NOAA / USDA)';
  const sourceUrl = 'https://droughtmonitor.unl.edu/';
  // The USDM is an expert-analyzed weekly product: evidence 'analyzed'. The
  // point query returns only the DM category (no map date), so the date shown
  // is the retrieval date; the prose already frames the read as "this week's".
  const usdmShared = {
    source,
    sourceUrl,
    evidence: 'analyzed',
    dates: { retrieved: todayIso() },
    support: { reporting: 'the USDM polygon at the clicked point' }
  } as const;

  try {
    const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
    if (signal.aborted) return { claims: [], ok: false };

    const features = featuresOf(json);
    let worst = -1;
    for (const f of features) {
      if (!isObject(f) || !isObject(f.properties)) continue;
      const dm = Number(f.properties.DM);
      if (Number.isInteger(dm) && dm > worst) worst = dm;
    }

    if (worst < 0) {
      return {
        ok: true,
        claims: [
          makeClaim({
            text: 'No drought category is mapped at this location in this week\'s U.S. Drought Monitor (conditions are better than D0, Abnormally Dry).',
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
            text: `This location is in a mapped U.S. Drought Monitor category (DM ${worst}) this week.`,
            ...usdmShared
          })
        ]
      };
    }

    return {
      ok: true,
      claims: [
        makeClaim({
          text: `This location is in ${impact.code} ${impact.label} as of this week's U.S. Drought Monitor. ${impact.summary}`,
          ...usdmShared
        }),
        // The wildfire companion translates the analyzed category through the
        // documented USDM impact profiles: a DDM-derived read, labeled so.
        // The former extreme-heat companion was removed by ruling
        // (D-0.8.0-047); do not reintroduce a heat claim inferred from the
        // USDM category.
        makeClaim({
          text: `Wildfire: ${impact.wildfire} Drought raises the odds and the potential intensity of wildfire by drying and curing fuels; it does not by itself start fires.`,
          ...usdmShared,
          evidence: 'derived',
          lineage: ['USDM category at the clicked point', 'documented USDM impact profiles and the ddm-drought-impact-modeling causal-chain reads'],
          uncertainty: { kind: 'typical', text: 'an elevated-risk tendency at this category, not a certainty' }
        })
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] USDM point query failed.', err);
    return { claims: [], ok: false, note: 'The U.S. Drought Monitor did not respond.' };
  }
}

// ---------------------------------------------------------------------------
// Current: statewide drought-severity trend (DSCI) with a trend chart
// ---------------------------------------------------------------------------

function fmtUsdmDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

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

function calendarToProse(c: CalendarDay): string {
  return `${c.m}/${c.d}/${c.y}`;
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
  const sourceUrl = 'https://droughtmonitor.unl.edu/DmData/DataDownload.aspx';

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
    // Trend direction over the last ~12 weeks.
    const prior = points[Math.max(0, points.length - 12)]!.v;
    const delta = lastPoint.v - prior;
    const trendWord = Math.abs(delta) < 15 ? 'about steady' : delta > 0 ? 'rising' : 'easing';
    // The latest map date, read once as a calendar value: the prose and the
    // claim's `dates.valid` MUST agree (they are the same day, shown twice).
    const lastCal = calendarDayOf(rawByT.get(lastPoint.t) ?? '');
    if (!lastCal) {
      return { claims: [], ok: false, note: 'The USDM Data Services drought-severity series was unavailable.' };
    }
    const asOf = calendarToProse(lastCal);

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
          text: `As of the ${asOf} map, statewide drought severity for ${stateName} (Drought Severity and Coverage Index, 0 to 500) is ${Math.round(lastPoint.v)} and has been ${trendWord} over recent weeks.`,
          source,
          sourceUrl,
          evidence: 'analyzed',
          dates: { valid: calendarToIso(lastCal), retrieved: todayIso() },
          support: { reporting: `statewide (${stateName})` },
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
// Current: active NIFC wildfire perimeters near the selection
// ---------------------------------------------------------------------------

/**
 * Query the National Interagency Fire Center (NIFC) current-perimeters
 * FeatureServer for active fires intersecting the selection's bounding box (or
 * a small box around the click when no geometry bbox is available). Reports the
 * count as an observation; zero active perimeters is also a plain observation.
 */
export async function fetchNifcClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const source = 'NIFC active fire perimeters (WFIGS)';
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
      note: 'The NIFC active-fire service could not query the complete selection envelope.'
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
          'attr_UniqueFireIdentifier,attr_IncidentName',
          50
        );
        return fetchJson(
          `${URLS.nifcFires}/query?${query.toString()}`,
          GEOJSON_ACCEPT,
          siblingSignal
        );
      }
    );
    if (signal.aborted) return { claims: [], ok: false };

    const features = mergeByStableIdentifier(
      payloads.map(featuresOf),
      (feature) => {
        if (!isObject(feature) || !isObject(feature.properties)) return null;
        const id = feature.properties.attr_UniqueFireIdentifier;
        return typeof id === 'string' || typeof id === 'number' ? id : null;
      }
    );
    const count = features.length;
    const text =
      count === 0
        ? 'No active NIFC wildfire perimeters intersect this area right now.'
        : `${count} active wildfire ${count === 1 ? 'perimeter' : 'perimeters'} (NIFC) ${count === 1 ? 'intersects' : 'intersect'} this area right now.`;
    // Mapped incident perimeters and their count: directly observed.
    return {
      ok: true,
      claims: [
        makeClaim({ text, source, sourceUrl, evidence: 'observed', dates: { retrieved: todayIso() } })
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NIFC query failed.', err);
    return { claims: [], ok: false, note: 'The NIFC active-fire service did not respond.' };
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
    const alertShared = { source, sourceUrl, evidence: 'observed', dates: { retrieved: todayIso() } } as const;
    const claims: SourcedClaim[] = [];
    if (fire.length > 0) {
      claims.push(
        makeClaim({
          // vocab-allow: reports the NWS alert products in effect, upstream data
          text: `A fire-weather alert is in effect here: ${fire.join(', ')}. This signals imminent fire-weather conditions (low humidity, wind, dry fuels).`,
          ...alertShared
        })
      );
    }
    if (heat.length > 0) {
      claims.push(
        makeClaim({
          // vocab-allow: reports the NWS alert products in effect, upstream data
          text: `An extreme-heat alert is in effect here: ${heat.join(', ')}. Heat raises drinking-water demand and human-health stress, and drought-dried soils amplify it.`,
          ...alertShared
        })
      );
    }
    if (claims.length === 0) {
      claims.push(
        makeClaim({
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
        text: heatText
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
}

/** Query one CPC outlook layer (0 = temperature, 1 = precipitation) at a point. */
async function fetchCpcLayer(
  base: string,
  layer: 0 | 1,
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<OutlookValue | null> {
  const url = `${base}/${layer}/query?${esriPointQuery(lng, lat, 'cat,prob').toString()}`;
  const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
  const f = featuresOf(json)[0] ?? null;
  if (!isObject(f) || !isObject(f.properties)) return null;
  const cat = f.properties.cat;
  const prob = f.properties.prob;
  if (typeof cat !== 'string') return null;
  return { cat, prob: typeof prob === 'number' ? prob : NaN };
}

/** Render a category and probability into a lean phrase for one variable. */
function leanPhrase(v: OutlookValue | null, variable: string): string | null {
  if (!v) return null;
  const odds = Number.isFinite(v.prob) ? ` (${v.prob}% odds)` : '';
  if (v.cat === 'Above') return `above-normal ${variable}${odds}`;
  if (v.cat === 'Below') return `below-normal ${variable}${odds}`;
  return `near-normal ${variable}`;
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
 * outlook rule). A window whose fetches fail is skipped; the result is ok when
 * at least one window resolved.
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
  await Promise.all(
    windows.map(async ({ label, base }, ordinal) => {
      try {
        // Fetch temperature and precipitation independently so one variable's
        // HTTP failure does not discard the other; a window still emits the
        // variable that succeeded (graceful degradation, honest-feedback rule).
        const [temp, precip] = await Promise.all([
          fetchCpcLayer(base, 0, lng, lat, signal).catch(() => null),
          fetchCpcLayer(base, 1, lng, lat, signal).catch(() => null)
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
        // Foreground the temperature tercile bar (the heat-relevant variable).
        const chartSvg = temp
          ? cpcOutlookBarsSvg({ variable: 'temperature', cat: temp.cat, prob: temp.prob, window: label })
          : undefined;
        settled.push({
          ordinal,
          claim: makeClaim({
            text: `CPC ${label} outlook: ${parts.join(', ')}.${interp ? ' ' + interp : ''}`,
            source,
            sourceUrl,
            evidence: 'outlook',
            dates: { retrieved: todayIso() },
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
    return { claims: [], ok: false, note: 'The CPC extended-range outlooks did not respond.' };
  }
  return { claims, ok: true, ...(anyFailed ? { note: 'One CPC outlook window did not respond.' } : {}) };
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
        text: `${name}: ${short || 'forecast available'}, near ${tempStr}.`
      }
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NWS forecast query failed.', err);
    // vocab-allow: names the NWS point forecast, upstream product
    return { claims: [], ok: false, note: 'The NWS point forecast did not respond.' };
  }
}
