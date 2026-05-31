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
 * `ok:true` with an informative observation. Every fetch goes through
 * `fetchWithBudget` with the briefing's master abort signal and a per-call
 * timeout, so a hung host never blocks the panel (invariant 5).
 *
 * Verified sources (see docs/KERNEL_INTEGRATION_CONTINUATION.md section 3 and
 * src/config/urls.ts): USDM FeatureServer (CORS *), NIFC perimeters
 * FeatureServer (CORS *), NWS api.weather.gov alerts and point forecast
 * (CORS *).
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { cpcOutlookBarsSvg, trendLineSvg, type TrendPoint } from '../ui/charts';
import { categoryImpact } from './category-impacts';
import { regionStateFips, regionStateName } from './resources';
import type { BoundarySelectionContext, SourcedClaim } from './types';

/** The outcome of one source fetch. */
export interface SourceResult {
  readonly claims: SourcedClaim[];
  /** True if the fetch completed (even if it found nothing); false on error. */
  readonly ok: boolean;
  /** Optional honest note shown when `ok` is false. */
  readonly note?: string;
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
 * `fetchWithBudget` plus the ok-check and JSON parse shared by every fetcher.
 * Throws `HTTP <status>` on a non-OK response. Callers keep their own
 * `signal.aborted` re-check immediately after, before touching the panel.
 */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs = TIMEOUT_MS
): Promise<unknown> {
  const resp = await fetchWithBudget(url, { headers }, signal, timeoutMs);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** The `features` array of a GeoJSON-shaped payload, or `[]` when absent. */
function featuresOf(json: unknown): unknown[] {
  return isObject(json) && Array.isArray(json.features) ? json.features : [];
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
          {
            text: 'No drought category is mapped at this location in this week\'s U.S. Drought Monitor (conditions are better than D0, Abnormally Dry).',
            source,
            sourceUrl,
            kind: 'observation'
          }
        ]
      };
    }

    const impact = categoryImpact(worst);
    if (!impact) {
      return {
        ok: true,
        claims: [
          {
            text: `This location is in a mapped U.S. Drought Monitor category (DM ${worst}) this week.`,
            source,
            sourceUrl,
            kind: 'observation'
          }
        ]
      };
    }

    return {
      ok: true,
      claims: [
        {
          text: `This location is in ${impact.code} ${impact.label} as of this week's U.S. Drought Monitor. ${impact.summary}`,
          source,
          sourceUrl,
          kind: 'observation'
        },
        {
          text: `Wildfire: ${impact.wildfire} Drought raises the odds and the potential intensity of wildfire by drying and curing fuels; it does not by itself start fires.`,
          source,
          sourceUrl,
          kind: 'observation'
        },
        {
          text: `Extreme heat: ${impact.heat}`,
          source,
          sourceUrl,
          kind: 'observation'
        }
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
  const fips = regionStateFips(context.regionKey);
  const stateName = regionStateName(context.regionKey);
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 14);
  const params = new URLSearchParams({
    aoi: String(fips),
    startdate: fmtUsdmDate(start),
    enddate: fmtUsdmDate(end),
    statisticsType: '1'
  });
  const url = `${URLS.usdmDataServices}/StateStatistics/GetDSCI?${params.toString()}`;
  const source = 'USDM Data Services (NDMC)';
  const sourceUrl = 'https://droughtmonitor.unl.edu/DmData/DataDownload.aspx';

  try {
    const json: unknown = await fetchJson(url, { Accept: 'application/json' }, signal);
    if (signal.aborted) return { claims: [], ok: false };

    const rows = Array.isArray(json) ? json : [];
    const points: TrendPoint[] = [];
    for (const r of rows) {
      if (!isObject(r)) continue;
      const t = typeof r.mapDate === 'string' ? Date.parse(r.mapDate) : NaN;
      const v = typeof r.dsci === 'number' ? r.dsci : Number(r.dsci);
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
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
    // Carry the latest map date so the reading is dated, not asserted as "now"
    // (the USGS popup and USDM point claim use the same dated framing).
    const asOf = fmtUsdmDate(new Date(lastPoint.t));

    const chartSvg = trendLineSvg(points, {
      title: `${stateName} drought severity (DSCI, 0 to 500) over the past year`,
      yMax: 500,
      yLabel: 'DSCI',
      source: 'USDM Data Services'
    });

    return {
      ok: true,
      claims: [
        {
          text: `As of the ${asOf} map, statewide drought severity for ${stateName} (Drought Severity and Coverage Index, 0 to 500) is ${Math.round(lastPoint.v)} and has been ${trendWord} over recent weeks.`,
          source,
          sourceUrl,
          kind: 'observation',
          ...(chartSvg ? { chartSvg } : {})
        }
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
  const bbox = context.bbox ?? ([lng - 0.5, lat - 0.5, lng + 0.5, lat + 0.5] as const);
  const envelope = bbox.map((n) => round4(n)).join(',');
  const url = `${URLS.nifcFires}/query?${esriEnvelopeQuery(envelope, 'attr_IncidentName', 50).toString()}`;
  const source = 'NIFC active fire perimeters (WFIGS)';
  const sourceUrl = 'https://data-nifc.opendata.arcgis.com/';

  try {
    const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
    if (signal.aborted) return { claims: [], ok: false };

    const count = featuresOf(json).length;
    const text =
      count === 0
        ? 'No active NIFC wildfire perimeters intersect this area right now.'
        : `${count} active wildfire ${count === 1 ? 'perimeter' : 'perimeters'} (NIFC) ${count === 1 ? 'intersects' : 'intersect'} this area right now.`;
    return { ok: true, claims: [{ text, source, sourceUrl, kind: 'observation' }] };
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
const FIRE_EVENTS = ['Red Flag Warning', 'Fire Weather Watch'];
const HEAT_EVENTS = ['Excessive Heat Warning', 'Excessive Heat Watch', 'Heat Advisory', 'Extreme Heat Warning', 'Extreme Heat Watch'];

/**
 * Query the National Weather Service active alerts at the clicked point and
 * surface any fire-weather or extreme-heat alerts as observations. When none
 * are active, that is reported plainly (a meaningful all-clear for the
 * foregrounded hazards).
 */
export async function fetchNwsAlertClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const url = `${URLS.nwsApi}/alerts/active?point=${round4(lat)},${round4(lng)}`;
  const source = 'NWS active alerts';
  const sourceUrl = 'https://www.weather.gov/';

  try {
    const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
    if (signal.aborted) return { claims: [], ok: false };

    const features = featuresOf(json);
    const events = new Set<string>();
    for (const f of features) {
      if (!isObject(f) || !isObject(f.properties)) continue;
      const event = f.properties.event;
      if (typeof event === 'string') events.add(event);
    }

    const fire = [...events].filter((e) => FIRE_EVENTS.includes(e));
    const heat = [...events].filter((e) => HEAT_EVENTS.includes(e));
    const claims: SourcedClaim[] = [];
    if (fire.length > 0) {
      claims.push({
        text: `A fire-weather alert is in effect here: ${fire.join(', ')}. This signals imminent fire-weather conditions (low humidity, wind, dry fuels).`,
        source,
        sourceUrl,
        kind: 'observation'
      });
    }
    if (heat.length > 0) {
      claims.push({
        text: `An extreme-heat alert is in effect here: ${heat.join(', ')}. Heat raises drinking-water demand and human-health stress, and drought-dried soils amplify it.`,
        source,
        sourceUrl,
        kind: 'observation'
      });
    }
    if (claims.length === 0) {
      claims.push({
        text: 'No active red-flag fire-weather or extreme-heat alerts at this location right now (NWS).',
        source,
        sourceUrl,
        kind: 'observation'
      });
    }
    return { ok: true, claims };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NWS alerts query failed.', err);
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

  const claims: SourcedClaim[] = [];
  let anyFailed = false;
  await Promise.all(
    windows.map(async ({ label, base }) => {
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
        claims.push({
          text: `CPC ${label} outlook: ${parts.join(', ')}.${interp ? ' ' + interp : ''}`,
          source,
          sourceUrl,
          kind: 'outlook',
          ...(chartSvg ? { chartSvg } : {})
        });
      } catch (err) {
        if (!signal.aborted) console.warn(`[impact] CPC ${label} outlook failed.`, err);
        anyFailed = true;
      }
    })
  );

  if (signal.aborted) return { claims: [], ok: false };
  // Keep windows in chronological order (6-10 then 8-14) regardless of which
  // promise settled first.
  claims.sort((a, b) => a.text.localeCompare(b.text));
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
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const pointsUrl = `${URLS.nwsApi}/points/${round4(lat)},${round4(lng)}`;
  const source = 'NWS forecast';
  const sourceUrl = 'https://www.weather.gov/';

  try {
    const pResp = await fetchWithBudget(pointsUrl, { headers: GEOJSON_ACCEPT }, signal, TIMEOUT_MS);
    if (!pResp.ok) throw new Error(`points HTTP ${pResp.status}`);
    const pJson: unknown = await pResp.json();
    if (signal.aborted) return { claims: [], ok: false };

    const forecastUrl =
      isObject(pJson) && isObject(pJson.properties) && typeof pJson.properties.forecast === 'string'
        ? pJson.properties.forecast
        : null;
    if (!forecastUrl) throw new Error('no forecast URL in points response');

    const fResp = await fetchWithBudget(forecastUrl, { headers: GEOJSON_ACCEPT }, signal, TIMEOUT_MS);
    if (!fResp.ok) throw new Error(`forecast HTTP ${fResp.status}`);
    const fJson: unknown = await fResp.json();
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

    return {
      ok: true,
      claims: [
        {
          text: `${name}: ${short || 'forecast available'}, near ${tempStr}. Watch this against the heat outlook; hot, dry spells deepen near-term dryness and fire danger.`,
          source,
          sourceUrl,
          kind: 'outlook'
        }
      ]
    };
  } catch (err) {
    if (signal.aborted) return { claims: [], ok: false };
    console.warn('[impact] NWS forecast query failed.', err);
    return { claims: [], ok: false, note: 'The NWS point forecast did not respond.' };
  }
}
