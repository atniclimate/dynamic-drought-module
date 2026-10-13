/**
 * The NHC and CPHC Tropical Weather MapServer fixtures (ENSO block B3), the
 * only route home for
 * mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather
 * (admission planning/2026-09-25-desktop-pass/admissions/noaa-tropical-cyclones.md,
 * line 9).
 *
 * Seeded from the live answers saved by the 2026-10-13 scout probe (public
 * data): Hurricane Simon in slot EP5, advisory 24, the only occupied slot that
 * day, and the empty answer every other slot gave. Sanitised: the properties
 * the layer reads are kept, coordinates are rounded to four decimals, and the
 * cone keeps every sixteenth of its 1,049 vertices (67), so the fixture is a
 * small faithful copy of the issuer shape, not the full ring.
 *
 * One answer function (`tropicalAnswer`) serves both the browser-free reader
 * test (tests/tropical-read.test.mjs, through a stubbed fetch) and the
 * suite-wide browser stub below, so the two can never disagree about an arm.
 * The harness arms (a held request, a body that stalls, a late answer) are
 * timing behaviours, not bodies; the reader test drives them with its own
 * fetch stub over these same bodies.
 */

import type { BrowserContext, Page } from '@playwright/test';

/** The service path, matched alone (the host is shared with other NOAA MapServers). */
export const TROPICAL_SERVICE_PATH = '/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

export function isTropicalRequestUrl(url: URL): boolean {
  return url.pathname.includes(TROPICAL_SERVICE_PATH);
}

interface Collection {
  readonly type: 'FeatureCollection';
  readonly features: readonly Record<string, unknown>[];
  readonly exceededTransferLimit?: boolean;
}

export const TROPICAL_EMPTY: Collection = {"type":"FeatureCollection","features":[]};

/** EP5, Hurricane Simon, advisory 24: Forecast Points (layer 240), nine positions, tau 0 to 120. */
export const EP5_POINTS: Collection = {"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[-107.2,20.6]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":100,"maxwind":80,"mslp":977,"ssnum":1,"datelbl":"2:00 AM Tue","tcdvlp":"Hurricane","tcdir":315,"tcspd":3,"fldatelbl":"2026-10-12 11:00 PM Mon MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":0,"timezone":"MST","validtime":"13/0600","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-107.4,20.7]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":90,"maxwind":75,"mslp":9999,"ssnum":1,"datelbl":"11:00 AM Tue","tcdvlp":"Hurricane","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-13 11:00 AM Tue MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":12,"timezone":"MST","validtime":"13/1800","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-107.7,20.9]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":90,"maxwind":75,"mslp":9999,"ssnum":1,"datelbl":"11:00 PM Tue","tcdvlp":"Hurricane","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-13 11:00 PM Tue MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":24,"timezone":"MST","validtime":"14/0600","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-107.8,21.0]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":90,"maxwind":75,"mslp":9999,"ssnum":1,"datelbl":"11:00 AM Wed","tcdvlp":"Hurricane","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-14 11:00 AM Wed MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":36,"timezone":"MST","validtime":"14/1800","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-107.9,21.2]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":90,"maxwind":75,"mslp":9999,"ssnum":1,"datelbl":"11:00 PM Wed","tcdvlp":"Hurricane","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-14 11:00 PM Wed MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":48,"timezone":"MST","validtime":"15/0600","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-108.0,21.8]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":85,"maxwind":70,"mslp":9999,"ssnum":1,"datelbl":"11:00 AM Thu","tcdvlp":"Hurricane","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-15 11:00 AM Thu MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":60,"timezone":"MST","validtime":"15/1800","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-108.1,23.0]},"properties":{"stormname":"Hurricane Simon","stormtype":"HU","dvlbl":"H","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":80,"maxwind":65,"mslp":9999,"ssnum":1,"datelbl":"11:00 PM Thu","tcdvlp":"Hurricane","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-15 11:00 PM Thu MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":72,"timezone":"MST","validtime":"16/0600","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-108.1,24.2]},"properties":{"stormname":"Hurricane Simon","stormtype":"TS","dvlbl":"S","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":65,"maxwind":55,"mslp":9999,"ssnum":0,"datelbl":"11:00 PM Fri","tcdvlp":"Tropical Storm","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-16 11:00 PM Fri MST","stormnum":20,"stormsrc":"Tropical Cyclone","tau":96,"timezone":"MST","validtime":"17/0600","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-108.2,25.4]},"properties":{"stormname":"Hurricane Simon","stormtype":"STD","dvlbl":"D","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"gust":40,"maxwind":30,"mslp":9999,"ssnum":0,"datelbl":"11:00 PM Sat","tcdvlp":"Subtropical Depression","tcdir":9999,"tcspd":9999,"fldatelbl":"2026-10-17 11:00 PM Sat MST","stormnum":20,"stormsrc":"Post-Tropical Cyclone","tau":120,"timezone":"MST","validtime":"18/0600","idp_source":"ep202026-024_5day_pts","binnumber":"EP5"}}]};

/** EP5 Forecast Track (layer 241). */
export const EP5_TRACK: Collection = {"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-107.2,20.6],[-107.4,20.7],[-107.7,20.9],[-107.8,21.0],[-107.9,21.2],[-108.0,21.8],[-108.1,23.0],[-108.1,24.2],[-108.2,25.4]]},"properties":{"stormname":"Simon","stormtype":"HU","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"stormnum":20,"idp_source":"ep202026-024_5day_lin","binnumber":"EP5"}}]};

/** EP5 Forecast Cone (layer 242), decimated as the header says. */
export const EP5_CONE: Collection = {"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-107.9982,20.2132],[-107.639,20.2165],[-107.3243,20.2851],[-107.0377,20.3819],[-106.9293,20.6704],[-106.9279,20.9676],[-106.873,21.2844],[-106.8282,21.6354],[-106.7922,21.9832],[-106.7582,22.321],[-106.7174,22.676],[-106.6024,22.9326],[-106.477,23.1908],[-106.3497,23.4472],[-106.2294,23.7105],[-106.1091,23.9738],[-105.9855,24.2459],[-105.8662,24.5101],[-105.7565,24.7841],[-105.6853,25.0846],[-105.6546,25.4498],[-105.6892,25.787],[-105.7714,26.0885],[-105.8862,26.3574],[-106.0282,26.6109],[-106.1944,26.8282],[-106.3851,27.0211],[-106.6059,27.1957],[-106.8383,27.3468],[-107.095,27.4735],[-107.3853,27.5785],[-107.6872,27.6479],[-108.0258,27.6926],[-108.4077,27.6918],[-108.7521,27.6409],[-109.0644,27.5579],[-109.3428,27.4529],[-109.5901,27.3288],[-109.8285,27.1718],[-110.034,27.0057],[-110.2235,26.7998],[-110.3917,26.5725],[-110.5299,26.339],[-110.6421,26.0556],[-110.7138,25.7556],[-110.7318,25.3898],[-110.7031,25.0227],[-110.6245,24.7296],[-110.5043,24.4542],[-110.363,24.2119],[-110.2049,23.9744],[-110.0517,23.7561],[-109.8936,23.5186],[-109.7499,23.2547],[-109.638,23.0069],[-109.5144,22.7349],[-109.4122,22.4534],[-109.3317,22.1503],[-109.2495,21.8488],[-109.1572,21.5574],[-109.0554,21.2755],[-108.9388,21.0085],[-108.7872,20.7645],[-108.6184,20.5498],[-108.4088,20.3759],[-108.1482,20.2531],[-107.9982,20.2132]]]},"properties":{"stormname":"Simon","stormtype":"HU","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"stormnum":20,"idp_source":"ep202026-024_5day_pgn","binnumber":"EP5"}}]};

/** EP5 Watch-Warning (layer 243): TWA, HWA, HWR. */
export const EP5_WW: Collection = {"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-106.0,22.82],[-105.69,22.39],[-105.27,21.52],[-105.51,20.77],[-105.68,20.42]]},"properties":{"stormname":"Simon","stormtype":"HU","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"stormnum":20,"idp_source":"ep202026-024_ww_wwlin","binnumber":"EP5","tcww":"TWA"}},{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-107.15,24.07],[-106.42,23.2],[-106.0,22.82]]},"properties":{"stormname":"Simon","stormtype":"HU","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"stormnum":20,"idp_source":"ep202026-024_ww_wwlin","binnumber":"EP5","tcww":"HWA"}},{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-106.21,21.28],[-106.48,21.51],[-106.59,21.63],[-106.71,21.8]]},"properties":{"stormname":"Simon","stormtype":"HU","basin":"EP","advdate":"200 AM MST Tue Oct 13 2026","advisnum":"24","fcstprd":120,"stormnum":20,"idp_source":"ep202026-024_ww_wwlin","binnumber":"EP5","tcww":"HWR"}}]};

/** The two error envelopes the service answered at HTTP 200 (a bad where, a bad layer id). */
export const TROPICAL_ERROR_BAD_WHERE = {"error":{"code":400,"message":"Failed to execute query.","details":[]}};
export const TROPICAL_ERROR_BAD_LAYER = {"error":{"code":400,"message":"Invalid or missing input parameters.","details":[]}};

/** The EP5 slot's index (AT1 = 0 ... CP5 = 14) and its four layer ids. */
export const EP5_SLOT = 9;
export const EP5_LAYERS = { points: 240, track: 241, cone: 242, ww: 243 } as const;

export type TropicalArm =
  | 'occupiedOne'
  | 'occupiedMixedAdvisory'
  | 'allEmpty'
  | 'emptyBody'
  | 'emptyObject'
  | 'noFeatures'
  | 'truncatedJson'
  | 'htmlAt200'
  | 'arcgisError'
  | 'lbEnvelope'
  | 'oneSublayer503'
  | 'badGeometry'
  | 'recordCapPage'
  | 'offCoverage';

/** Timing arms the reader test drives with its own fetch stub over the bodies above. */
export const TROPICAL_HARNESS_ARMS = ['holdFirst', 'hold', 'stalledBody', 'lateResponse'] as const;

export interface TropicalAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const GEOJSON = 'application/geo+json;charset=UTF-8';
const json = (value: unknown, status = 200): TropicalAnswer => ({ status, contentType: GEOJSON, body: JSON.stringify(value) });

function withProps(collection: Collection, patch: Record<string, unknown>): Collection {
  return {
    ...collection,
    features: collection.features.map((f) => ({ ...f, properties: { ...(f['properties'] as object), ...patch } }))
  };
}

/** The layer id a query URL names, or null. */
export function tropicalLayerId(url: string): number | null {
  const match = /\/MapServer\/(\d+)\/query$/.exec(new URL(url).pathname);
  return match ? Number(match[1]) : null;
}

/** What the service answers for one layer id under one arm. */
export function tropicalAnswer(arm: TropicalArm, layerId: number): TropicalAnswer {
  const isPoints = (layerId - 4) % 26 === 2;
  switch (arm) {
    case 'allEmpty':
      return json(TROPICAL_EMPTY);
    case 'emptyBody':
      return isPoints ? { status: 200, contentType: GEOJSON, body: '' } : json(TROPICAL_EMPTY);
    case 'emptyObject':
      return isPoints ? json({}) : json(TROPICAL_EMPTY);
    case 'noFeatures':
      return isPoints ? json({ type: 'FeatureCollection' }) : json(TROPICAL_EMPTY);
    case 'truncatedJson':
      return isPoints ? { status: 200, contentType: GEOJSON, body: '{"type":"FeatureCollection","features":[{"type":"Fea' } : json(TROPICAL_EMPTY);
    case 'htmlAt200':
      return isPoints ? { status: 200, contentType: 'text/html', body: '<html><body>Service temporarily unavailable</body></html>' } : json(TROPICAL_EMPTY);
    case 'arcgisError':
      return isPoints ? json(TROPICAL_ERROR_BAD_WHERE) : json(TROPICAL_EMPTY);
    case 'lbEnvelope':
      return isPoints ? json(TROPICAL_ERROR_BAD_LAYER) : json(TROPICAL_EMPTY);
    default:
      break;
  }
  // The occupied arms: EP5 holds Simon, every other slot is a valid empty collection.
  if (layerId === EP5_LAYERS.points) {
    if (arm === 'recordCapPage') {
      // Trimmed to the presence fields so 2000 records stay under the reader's 1 MiB body cap.
      const first = EP5_POINTS.features[0]! as { geometry: unknown; properties: Record<string, unknown> };
      const keep = ['stormname', 'basin', 'advdate', 'advisnum', 'binnumber', 'dvlbl', 'stormsrc', 'tau'];
      const one = { type: 'Feature', geometry: first.geometry, properties: Object.fromEntries(keep.map((k) => [k, first.properties[k]])) };
      return json({ type: 'FeatureCollection', features: Array.from({ length: 2000 }, () => one), exceededTransferLimit: true });
    }
    return json(arm === 'offCoverage' ? withProps(EP5_POINTS, { basin: 'WP' }) : EP5_POINTS);
  }
  if (layerId === EP5_LAYERS.track) return json(arm === 'offCoverage' ? withProps(EP5_TRACK, { basin: 'WP' }) : EP5_TRACK);
  if (layerId === EP5_LAYERS.cone) {
    if (arm === 'oneSublayer503') return { status: 503, contentType: 'text/html', body: '<html><body>503 Service Unavailable</body></html>' };
    if (arm === 'badGeometry') return json({ ...EP5_CONE, features: EP5_CONE.features.map((f) => ({ ...f, geometry: null })) });
    return json(arm === 'offCoverage' ? withProps(EP5_CONE, { basin: 'WP' }) : EP5_CONE);
  }
  if (layerId === EP5_LAYERS.ww) {
    if (arm === 'occupiedMixedAdvisory') return json(withProps(EP5_WW, { advisnum: '24A' }));
    return json(arm === 'offCoverage' ? withProps(EP5_WW, { basin: 'WP' }) : EP5_WW);
  }
  return json(TROPICAL_EMPTY);
}

// ---------------------------------------------------------------------------
// The suite-wide browser stub (the tests/nws-wwa-fixtures.ts pattern)
// ---------------------------------------------------------------------------

/** How a `gotoApp` boot answers the tropical MapServer: an arm, or `live` (pass through). */
export type TropicalStubMode = TropicalArm | 'live';

/** One request the default stub answered. */
export interface TropicalStubEntry {
  readonly method: string;
  readonly url: string;
  readonly layerId: number | null;
  readonly status: number;
}

interface TropicalStubState {
  mode: TropicalStubMode;
  readonly fulfilled: TropicalStubEntry[];
}

const tropicalStubStates = new WeakMap<BrowserContext, TropicalStubState>();

/**
 * Route the tropical MapServer on the browser CONTEXT, the default `gotoApp`
 * installs on every boot (ENSO boots turn the layer on). FAIL-CLOSED: a GET
 * `/MapServer/<id>/query?...f=geojson` is answered by `tropicalAnswer` under
 * the current arm; any other request to the service gets a 400 ArcGIS
 * envelope, never a live answer. `live` passes every request through. A
 * spec picks an arm through `gotoApp(page, query, { tropical: arm })`, never
 * its own `page.route` (tests/boundary-boot-inventory.test.mjs ROUTE_HOMES).
 * Idempotent per context: a second call only updates the arm.
 */
export async function installDefaultTropicalStub(page: Page, mode: TropicalStubMode): Promise<void> {
  const context = page.context();
  const existing = tropicalStubStates.get(context);
  if (existing) {
    existing.mode = mode;
    return;
  }
  const state: TropicalStubState = { mode, fulfilled: [] };
  tropicalStubStates.set(context, state);
  await context.route(
    (url) => isTropicalRequestUrl(url),
    async (route) => {
      if (state.mode === 'live') {
        await route.fallback();
        return;
      }
      const request = route.request();
      const url = new URL(request.url());
      const layerId = tropicalLayerId(request.url());
      const answer: TropicalAnswer =
        request.method() === 'GET' && layerId !== null && url.searchParams.get('f') === 'geojson'
          ? tropicalAnswer(state.mode, layerId)
          : json({ error: { code: 400, message: 'Unknown test tropical request', details: [] } });
      state.fulfilled.push({ method: request.method(), url: request.url(), layerId, status: answer.status });
      await route.fulfill({ status: answer.status, contentType: answer.contentType, body: answer.body });
    }
  );
}

/** Every request the suite-wide default answered in this page's context, in order (the route counter). */
export function tropicalStubLog(page: Page): readonly TropicalStubEntry[] {
  return tropicalStubStates.get(page.context())?.fulfilled ?? [];
}
