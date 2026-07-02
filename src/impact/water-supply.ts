/**
 * NWRFC seasonal water-supply claims for the impact briefing's long-range
 * horizon (Tier 2 telemetry T2; the projection partner to the NRCS
 * snowpack observations per the ddm-agency-data pairing doctrine).
 *
 * Source: the NWRFC Water Supply Forecast Report bulk CSV
 * (`URLS.nwrfcWsReportCsv`; scout-proposed and verifier-confirmed
 * 2026-07-01). Load-bearing caveats from verification, all handled here:
 *   - No CORS at all, so the route is Worker-proxy ONLY. An empty
 *     `workerProxy` returns an honest failure note, never a blind fetch.
 *   - The body is CSV wrapped in a bare HTML shell (<title>, <body>,
 *     <pre> ... </pre>, </body>); markup lines are stripped before parse.
 *   - `Source=<id>` does NOT filter server-side; the full table (~123
 *     stations) is fetched and filtered client-side by station ID.
 *   - `FcstDate` echoes the requested `WyrDate`; the consumer passes
 *     today's date, there is no "latest" default.
 *
 * Coverage honesty: NWRFC forecasts the Columbia Basin and PNW coastal
 * rivers. Claims are produced only for selections that resolve to
 * Washington, Oregon, or Idaho, and every claim NAMES its forecast point
 * (a basin-scale read at a named dam or gauge, not a pretense of
 * site-specific data). Out-of-domain selections return ok with no claims
 * (not applicable is not a failure).
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { resolveStateCode } from './resources';
import type { BoundarySelectionContext, SourcedClaim } from './types';
import type { SourceResult } from './sources';

// The proxied round trip to the NWRFC CGI measured 11.6 to 12.8 seconds
// live (2026-07-01, four runs); the Worker's own upstream budget is 12
// seconds. 20 seconds covers the observed worst case plus the Worker's
// timeout window without racing it. The horizons render progressively, so
// the wait costs only the long-range section, which shows its loading
// state honestly meanwhile.
const TIMEOUT_MS = 20_000;

/** The forecast period the briefing keys on (the standard summer-supply window). */
const FCST_PERIOD = 'APR-SEP';

/**
 * Basin-representative forecast points, curated. Region framing wins over
 * the state fallback; every entry was confirmed present in the live file
 * on 2026-07-01. BONO3 (Columbia at Bonneville) is the basin-integrating
 * outlet used for state-level fallbacks.
 */
const REGION_POINTS: Readonly<Record<string, string>> = {
  central_oregon: 'MODO3',
  south_puget_sound: 'CONW1',
  cascades: 'CONW1',
  columbia_snake_basin: 'BONO3',
  washington_state: 'BONO3',
  southwest_washington: 'BONO3'
};

const STATE_POINTS: Readonly<Record<string, string>> = {
  WA: 'BONO3',
  OR: 'MODO3',
  ID: 'BONO3'
};

/** Water year of a date: October through December belong to the next year. */
function waterYearOf(d: Date): number {
  return d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface WsRow {
  readonly id: string;
  readonly location: string;
  readonly fcstPeriod: string;
  readonly pctOfNormal: number | null;
  readonly runoffToDatePct: number | null;
  readonly fcstDate: string;
}

/**
 * Parse the HTML-wrapped CSV: drop markup and blank lines, read the header
 * to find column indices by name (defensive against column drift), and
 * return the data rows.
 */
function parseWsReport(text: string): WsRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('<'));
  const headerIdx = lines.findIndex((l) => l.startsWith('ID,'));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx];
  if (!header) return [];
  const cols = header.split(',');
  const iId = cols.indexOf('ID');
  const iLoc = cols.indexOf('Location');
  const iPeriod = cols.indexOf('FcstPeriod');
  const iPct = cols.indexOf('50PerAvg');
  const iCur = cols.indexOf('CurPerAvg');
  const iDate = cols.indexOf('FcstDate');
  if ([iId, iLoc, iPeriod, iPct, iCur, iDate].some((i) => i < 0)) return [];

  const rows: WsRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const f = line.split(',');
    const id = f[iId];
    const location = f[iLoc];
    const fcstPeriod = f[iPeriod];
    const fcstDate = f[iDate];
    if (!id || !location || !fcstPeriod || !fcstDate) continue;
    const pct = Number(f[iPct]);
    const cur = Number(f[iCur]);
    rows.push({
      id,
      location,
      fcstPeriod,
      pctOfNormal: Number.isFinite(pct) ? pct : null,
      runoffToDatePct: Number.isFinite(cur) ? cur : null,
      fcstDate
    });
  }
  return rows;
}

/** Title-case an NWRFC LOCATION string ("COLUMBIA - BONNEVILLE DAM"). */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The honest supply-tilt sentence for a percent-of-normal forecast. */
function supplyTilt(pct: number): string {
  if (pct < 75) {
    return 'A well-below-normal supply outlook tightens late-season streamflow, irrigation deliveries, and fisheries flows, and extends the season when drought impacts compound.';
  }
  if (pct < 90) {
    return 'A below-normal supply outlook leans toward tighter late-season streamflow and earlier drawdown of stored water.';
  }
  if (pct <= 110) {
    return 'A near-normal supply outlook suggests typical late-season streamflow, with local basins still varying.';
  }
  return 'An above-normal supply outlook eases late-season streamflow pressure, though timing of the melt still shapes local conditions.';
}

/**
 * Fetch the water-supply outlook claims for a selection. Returns ok with
 * no claims for selections outside the NWRFC domain; ok:false with an
 * honest note when the source (or the required proxy) is unavailable.
 */
export async function fetchWaterSupplyClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  // Domain gate keyed to the SELECTION's state, never the ambient region:
  // the sidebar region is whatever framing the map opened with and can
  // disagree with a deep-linked or clicked boundary (verified live: a New
  // Mexico selection under the default washington_state framing must not
  // inherit a Columbia Basin forecast point). Outside the NWRFC domain the
  // source is not applicable, which is not a failure.
  const state = resolveStateCode(context);
  if (state === null || STATE_POINTS[state] === undefined) {
    return { claims: [], ok: true };
  }

  // Within the domain, a state-boundary selection uses its state's point
  // directly; other boundary kinds (an ecoregion or Tribal boundary clicked
  // inside a regional framing) let the region refine the basin point.
  const point =
    context.kind === 'state'
      ? STATE_POINTS[state]
      : ((context.regionKey !== null ? REGION_POINTS[context.regionKey] : undefined) ??
        STATE_POINTS[state]);
  if (!point) {
    return { claims: [], ok: true };
  }

  if (URLS.workerProxy === '') {
    return {
      claims: [],
      ok: false,
      note: 'The NWRFC water-supply outlook needs the Cloudflare Worker proxy, which this deployment has not configured.'
    };
  }

  const today = new Date();
  const upstream =
    `${URLS.nwrfcWsReportCsv}?Type=ALL&Source=ALL` +
    `&Wyr=${waterYearOf(today)}&WyrDate=${isoDay(today)}&Flavor=ESP10`;
  const proxied = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(upstream)}`;

  let rows: WsRow[];
  try {
    const resp = await fetchWithBudget(proxied, {}, signal, TIMEOUT_MS);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    rows = parseWsReport(await resp.text());
  } catch {
    if (signal.aborted) return { claims: [], ok: false };
    return {
      claims: [],
      ok: false,
      note: 'The NWRFC water-supply forecast source did not respond.'
    };
  }

  const row = rows.find((r) => r.id === point && r.fcstPeriod === FCST_PERIOD);
  if (!row || row.pctOfNormal === null) {
    return {
      claims: [],
      ok: false,
      note: `The NWRFC report carried no ${FCST_PERIOD} forecast for the ${point} forecast point.`
    };
  }

  const location = titleCase(row.location);
  const stationUrl = `https://www.nwrfc.noaa.gov/water_supply/ws_forecasts.php?id=${encodeURIComponent(point)}`;
  const claims: SourcedClaim[] = [];

  if (row.runoffToDatePct !== null) {
    claims.push({
      text: `Observed water-year runoff to date at the ${location} forecast point is ${row.runoffToDatePct} percent of the 1991-2020 normal.`,
      source: 'NWRFC Water Supply Forecast',
      sourceUrl: stationUrl,
      kind: 'observation'
    });
  }

  claims.push({
    text:
      `The NWRFC April-September water-supply forecast at ${location} is ${row.pctOfNormal} percent of the 1991-2020 normal ` +
      `(50 percent exceedance, issued ${row.fcstDate}). This is a basin-scale read at a named forecast point, not a site-specific value. ` +
      supplyTilt(row.pctOfNormal),
    source: 'NWRFC Water Supply Forecast',
    sourceUrl: stationUrl,
    kind: 'outlook'
  });

  return { claims, ok: true };
}
