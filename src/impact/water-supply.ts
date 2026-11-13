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
 *
 * Which point: a Tribal land area or a watershed reads the point on its own
 * river, found by its USGS Watershed Boundary Dataset code (`BASIN_POINTS`),
 * and reads none when its basin has no point. A state, an ecoregion and a
 * Treaty area span many basins and read the state-level point
 * (`resolveWaterSupplyPoint`).
 */

import type { RegionKey } from '../config/regions';
import { URLS } from '../config/urls';
import { ExpiringLruCache } from '../util/bounded-cache';
import { assertCompleteFeatureCollection } from '../util/arcgis-features';
import { fetchBufferedWithBudget, fetchJsonWithBudget } from '../util/fetch';
import { isoDayLocal } from '../util/iso-day';
import { makeClaim, todayIso } from './evidence';
import { resolveStateCode } from './resources';
import type { StateCode } from './resources';
import type { BoundaryKind, BoundarySelectionContext, SourcedClaim } from './types';
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
 * Basin-representative forecast points, curated; every entry was confirmed
 * present in the live file on 2026-07-01. The place's own resolved state
 * wins over the camera region whenever it is known (see
 * `fetchWaterSupplyClaims` below); `REGION_POINTS` is consulted only when
 * the place's own state cannot be resolved from the place itself. BONO3
 * (Columbia at Bonneville) is the basin-integrating outlet used for
 * state-level points.
 *
 * Keyed by `RegionKey` (partial: only the regions inside the NWRFC domain
 * appear) so a region rename fails at compile time instead of silently
 * dropping this lookup to the state fallback (IB-18).
 */
const REGION_POINTS: Readonly<Partial<Record<RegionKey, string>>> = {
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

/**
 * Places read by their own river basin: one Tribal land area or one
 * watershed. A state, an ecoregion and a Treaty area span many basins and
 * keep the state-level point above.
 */
const BASIN_KINDS: ReadonlySet<BoundaryKind> = new Set(['tribal', 'aiannh', 'bia-reservation', 'watershed']);

/**
 * Forecast point by river basin: each point, then the USGS Watershed Boundary
 * Dataset code prefixes (HUC4, HUC6 or HUC8) of the basin it is read for.
 * One row per river the NWRFC report names inside Washington, Oregon and
 * Idaho: the most downstream point the report publishes on that river, keyed
 * to the WBD units that carry the river's name. The longest matching prefix
 * wins, so a tributary's own point beats its parent river's, and the last row
 * (the Columbia above Bonneville Dam, HUC4 1701 to 1707) is the containing
 * mainstem for a basin with no river-level point. No prefix appears twice. A basin that matches no row
 * (Puget Sound outside the Skagit, the coast, the Columbia below Bonneville)
 * has no forecast point and the place reads none: another river's forecast is
 * never presented as the place's own. Keyed by code, never by name: HUC8
 * 17110016 is Washington's Deschutes, not Oregon's.
 *
 * Every point id and river name was read from the live NWRFC report, and
 * every code and basin name from the live WBD HUC8 layer, on 2026-11-12.
 * Not rows: 17110020 Dungeness-Elwha (one unit, two rivers, a Dungeness point
 * only) and the Powder, whose only point is on Eagle Creek.
 * shortcut: a whole-HUC4 row (the Yakima, the Willamette) and the Bonneville
 * row stand for every unit beneath them, so the Yamhill and the Tualatin,
 * which join below Salem, read the Willamette at Salem, and Snake mainstem
 * units read Bonneville although the report publishes Snake points; upgrade
 * with a row per river when the owner picks the points.
 */
const BASIN_POINTS: ReadonlyArray<readonly [point: string, ...prefixes: string[]]> = [
  ['BFEI1', '17010104'], // Kootenai at Bonners Ferry
  ['EASI1', '17010105'], // Moyie at Eastport
  ['CABI1', '17010213'], // Clark Fork, Cabinet Gorge Dam
  ['ALFW1', '17010214', '17010216'], // Pend Oreille, Albeni Falls Dam
  ['PRTI1', '17010215'], // Priest near Priest River
  ['LLKW1', '170103'], // Spokane at Long Lake
  ['COEI1', '17010303'], // Coeur d'Alene Lake
  ['CLDI1', '17010304'], // St. Joe at Calder
  ['LAUW1', '17020002'], // Kettle at Laurier
  ['TONW1', '17020006'], // Okanogan near Tonasket
  ['NITW1', '17020007'], // Similkameen near Nighthawk
  ['PATW1', '17020008'], // Methow near Pateros
  ['CHDW1', '17020009'], // Chelan, Lake Chelan Dam
  ['PESW1', '17020011'], // Wenatchee at Peshastin
  ['KIOW1', '1703'], // Yakima at Kiona
  ['NACW1', '17030002'], // Naches near Naches
  ['REXI1', '17040202', '17040203'], // Henrys Fork at Rexburg
  ['TEAI1', '17040204'], // Teton near St. Anthony
  ['RIRI1', '17040205'], // Willow Creek near Ririe
  ['TOPI1', '17040208'], // Portneuf at Topaz
  ['SFLN2', '17040213'], // Salmon Falls Creek near San Jacinto
  ['MACI1', '17040218'], // Big Lost, Mackay Reservoir
  ['MAGI1', '17040219'], // Big Wood, Magic Dam
  ['WODI1', '17040221'], // Little Wood near Carey
  ['HOTI1', '17050102'], // Bruneau near Hot Springs
  ['OWYO3', '17050104', '17050105', '17050106', '17050107', '17050108', '17050109', '17050110'], // Owyhee Dam
  ['PARI1', '17050111', '17050112', '17050113', '17050114'], // Boise near Parma
  ['MADO3', '17050116'], // Malheur near Drewsey
  ['EMMI1', '17050120', '17050121', '17050122', '17050123'], // Payette near Emmett
  ['WSRI1', '17050124'], // Weiser near Weiser
  ['UNYO3', '17050202'], // Burnt, Unity Dam
  ['IMNO3', '17060102'], // Imnaha at Imnaha
  ['TRYO3', '17060104', '17060105', '17060106'], // Grande Ronde at Troy
  ['WHBI1', '170602'], // Salmon at Whitebird
  ['SPDI1', '170603'], // Clearwater at Spalding
  ['PDTO3', '17070103'], // Umatilla at Pendleton
  ['SERO3', '170702'], // John Day at Service Creek
  ['MODO3', '170703'], // Deschutes at Moody
  ['MEWW1', '17080002'], // Lewis, Merwin Dam
  ['CASW1', '17080004', '17080005'], // Cowlitz at Castle Rock
  ['SLMO3', '1709'], // Willamette at Salem
  ['VIDO3', '17090004'], // McKenzie near Vida
  ['MEHO3', '17090005'], // North Santiam at Mehama
  ['WTLO3', '17090006'], // South Santiam at Waterloo
  ['ESTO3', '17090011'], // Clackamas at Estacada
  ['RYGO3', '17100307', '17100308'], // Rogue at Raygold
  ['CONW1', '17110005', '17110006', '17110007'], // Skagit near Concrete
  ['BUSO3', '17120002'], // Silvies near Burns
  ['DONO3', '17120003'], // Donner und Blitzen near Frenchglen
  ['BONO3', '1701', '1702', '1704', '1705', '1706', '1707'] // Columbia, Bonneville Dam (1703 is the Yakima row)
];

/**
 * The forecast point for a WBD code (a place's HUC8, or a watershed place's
 * own HUC4 or HUC2): the row whose prefix contains the code, longest prefix
 * first. Undefined when the basin has no forecast point.
 */
export function waterSupplyPointForBasin(code: string): string | undefined {
  let best: string | undefined;
  let bestLength = 0;
  for (const [point, ...prefixes] of BASIN_POINTS) {
    for (const prefix of prefixes) {
      if (prefix.length > bestLength && code.startsWith(prefix)) {
        best = point;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

// The WBD point read answered in 0.3 seconds live (2026-11-12); same budget as
// the Place studio's watershed reads (src/state/watershed-geometry.ts).
const BASIN_TIMEOUT_MS = 8_000;

/**
 * The HUC8 that contains a point, from the USGS WBD service (layer 4,
 * attributes only). Null when no hydrologic unit is there (a verified
 * absence); throws on a failed, partial, error-envelope or unreadable answer.
 * shortcut: one point stands for the whole place, so a reservation spanning
 * two rivers reads the one under its point; upgrade to a bbox overlap read
 * if a reader reports a wrong river.
 */
async function fetchBasinCodeAt(
  lngLat: { readonly lng: number; readonly lat: number },
  signal: AbortSignal
): Promise<string | null> {
  const params = new URLSearchParams({
    geometry: `${lngLat.lng},${lngLat.lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    // `name` is not read here: the upstream-drift field probe refuses a
    // one-field list, and this keeps the layer's `huc8` field watched.
    outFields: 'huc8,name',
    returnGeometry: 'false',
    f: 'geojson'
  });
  const raw = await fetchJsonWithBudget(
    `${URLS.wbdMapServer}/4/query?${params.toString()}`,
    { cache: 'no-store' },
    signal,
    BASIN_TIMEOUT_MS
  );
  const feature = assertCompleteFeatureCollection(raw).features[0];
  if (!feature) return null;
  const code: unknown = feature.properties?.huc8;
  if (typeof code !== 'string' || !/^\d{8}$/.test(code)) throw new Error('no HUC8 code in the WBD answer');
  return code;
}

/** A watershed place's own code, HUC4 else HUC2, padded as the studio catalog pads it. */
function watershedCode(context: BoundarySelectionContext): string | null {
  for (const [key, digits] of [['huc4', 4], ['huc2', 2]] as const) {
    const value = context.properties?.[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim().padStart(digits, '0');
  }
  return null;
}

/** Water year of a date: October through December belong to the next year. */
function waterYearOf(d: Date): number {
  return d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}

// The NWRFC report is daily; repeat briefings reuse the parsed rows instead of
// downloading the whole file again. Keyed on the final request URL.
const WS_CACHE_TTL_MS = 30 * 60_000;
const WS_ROWS_CACHE = new ExpiringLruCache<string, WsRow[]>(4);

/** Test-only hook for deterministic cache assertions (as clearDsciResponseCache). */
export function clearWaterSupplyRowsCache(): void {
  WS_ROWS_CACHE.clear();
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
 * return the data rows: possibly none (a header-only report is an answer),
 * or null when the header or a column is missing (not a report at all).
 */
function parseWsReport(text: string): WsRow[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('<'));
  const headerIdx = lines.findIndex((l) => l.startsWith('ID,'));
  if (headerIdx < 0) return null;
  const header = lines[headerIdx];
  if (!header) return null;
  const cols = header.split(',');
  const iId = cols.indexOf('ID');
  const iLoc = cols.indexOf('Location');
  const iPeriod = cols.indexOf('FcstPeriod');
  const iPct = cols.indexOf('50PerAvg');
  const iCur = cols.indexOf('CurPerAvg');
  const iDate = cols.indexOf('FcstDate');
  if ([iId, iLoc, iPeriod, iPct, iCur, iDate].some((i) => i < 0)) return null;

  const rows: WsRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const f = line.split(',');
    const id = f[iId];
    const location = f[iLoc];
    const fcstPeriod = f[iPeriod];
    const fcstDate = f[iDate];
    if (!id || !location || !fcstPeriod || !fcstDate) continue;
    const pct = f[iPct]?.trim() ? Number(f[iPct]) : NaN;
    const cur = f[iCur]?.trim() ? Number(f[iCur]) : NaN;
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

/**
 * The state-level point, for the kinds outside `BASIN_KINDS` only.
 * The place's own state wins whenever it is known: `context.containing.basis`
 * is 'none' only when the place's own state could not be resolved from the
 * place itself (the `ContainingPlaces` invariant, src/impact/types.ts), so
 * `STATE_POINTS[state]` is the honest point for every boundary kind that
 * carries a known state, not only a state boundary itself. The
 * camera-region fallback below fires ONLY in that one basis: 'none' case,
 * where `resolveStateCode` itself already fell back to the region's
 * primary state; consulting `REGION_POINTS` there still gives the click
 * the basin's own outlook rather than nothing, on the same region the
 * state guess itself already depended on. Exercised by
 * tests/camera-region-fallbacks.spec.ts.
 */
export function resolveWaterSupplyPoint(
  context: BoundarySelectionContext,
  state: StateCode
): string | undefined {
  return context.containing.basis !== 'none'
    ? STATE_POINTS[state]
    : ((context.regionKey !== null ? REGION_POINTS[context.regionKey] : undefined) ??
      STATE_POINTS[state]);
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
  // In order: `resolveStateCode` first prefers the place's own containing
  // state (src/impact/resources.ts) and falls back to the camera region's
  // primary state only when the place's own state is unknown. That resolved
  // state gates the domain: outside Washington, Oregon, and Idaho the
  // source is not applicable, which is not a failure. Within the domain, a
  // Tribal land area or a watershed reads the point on its own river
  // (`BASIN_POINTS`); for the other kinds the point selection applies the
  // same place-first order: the place's own state wins whenever it is known,
  // and the camera region is consulted only in the one case where it is not
  // (see `resolveWaterSupplyPoint` above).
  const state = resolveStateCode(context);
  if (state === null || STATE_POINTS[state] === undefined) {
    return { claims: [], ok: true };
  }

  let point: string | undefined;
  if (BASIN_KINDS.has(context.kind)) {
    let basin: string | null;
    try {
      basin =
        context.kind === 'watershed' ? watershedCode(context) : await fetchBasinCodeAt(context.lngLat, signal);
    } catch {
      // A failed basin read is unavailable: without the place's basin no
      // point is chosen, and the state's point is never substituted. No note:
      // the sentence for this case is the owner's to give.
      return { claims: [], ok: false };
    }
    if (signal.aborted) return { claims: [], ok: false };
    point = basin === null ? undefined : waterSupplyPointForBasin(basin);
  } else {
    point = resolveWaterSupplyPoint(context, state);
  }
  // No forecast point for this place is not a failure: the read is left out.
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
  // Named in the claim: from October the report forecasts the coming
  // April-September, which a reader would otherwise take for the one just ended.
  const wy = waterYearOf(today);
  const upstream =
    `${URLS.nwrfcWsReportCsv}?Type=ALL&Source=ALL` +
    `&Wyr=${wy}&WyrDate=${isoDayLocal(today)}&Flavor=ESP10`;
  const proxied = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(upstream)}`;

  let rows = WS_ROWS_CACHE.get(proxied);
  if (!rows) {
    try {
      const resp = await fetchBufferedWithBudget(proxied, {}, signal, TIMEOUT_MS);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const parsed = parseWsReport(await resp.text());
      if (parsed === null) throw new Error('no NWRFC report header');
      rows = parsed;
      // A header with no rows is the report's answer (October until the
      // first new-year forecast), so it is cached like any other.
      WS_ROWS_CACHE.set(proxied, rows, WS_CACHE_TTL_MS);
    } catch {
      if (signal.aborted) return { claims: [], ok: false };
      return {
        claims: [],
        ok: false,
        // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
        note: 'The NWRFC water-supply forecast source did not respond.'
      };
    }
  }

  const row = rows.find((r) => r.id === point && r.fcstPeriod === FCST_PERIOD);
  if (!row || row.pctOfNormal === null) {
    return {
      claims: [],
      ok: false,
      // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
      note: `The NWRFC report carried no ${FCST_PERIOD} forecast for the ${point} forecast point.`
    };
  }

  const location = titleCase(row.location);
  const stationUrl = `https://www.nwrfc.noaa.gov/water_supply/ws_forecasts.php?id=${encodeURIComponent(point)}`;
  // `FcstDate` echoes the requested date, so it is not an issue date: only
  // `retrieved` is stated.
  const wsShared = {
    source: 'NWRFC Water Supply Forecast', // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
    sourceUrl: stationUrl,
    product: 'waterSupply' as const,
    dates: { retrieved: todayIso() },
    // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
    support: { reporting: `the ${location} basin forecast point (${point})` },
    method: { baseline: '1991-2020 normal' }
  } as const;
  const claims: SourcedClaim[] = [];

  if (row.runoffToDatePct !== null) {
    claims.push(
      makeClaim({
        // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
        text: `Observed water-year runoff to date at the ${location} forecast point is ${row.runoffToDatePct} percent of the 1991-2020 normal.`,
        ...wsShared,
        evidence: 'observed'
      })
    );
  }

  // DR-046 a: the number and its uncertainty stand alone; NWRFC publishes no
  // percent-of-normal bands, so no DDM band sentence follows.
  claims.push(
    makeClaim({
      text: // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
        `The NWRFC April-September ${wy} water-supply forecast at ${location} is ${row.pctOfNormal} percent of the 1991-2020 normal ` + // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
        `(50 percent exceedance). This is a basin-scale read at a named forecast point, not a site-specific value.`,
      ...wsShared,
      evidence: 'outlook',
      // vocab-allow: names the NWRFC Water Supply Forecast and its forecast points, upstream product
      uncertainty: { kind: 'range', text: 'the 50 percent exceedance value of an ensemble forecast; actual volumes have even odds of falling either side of it' }
    })
  );

  return { claims, ok: true };
}
