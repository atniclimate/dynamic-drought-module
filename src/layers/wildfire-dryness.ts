/**
 * The Wildfire 3D dryness ground (DDM-P9-T13; DR-105): a greyscale NOAA STAR
 * weekly Vegetation Health Index under the hillshade and the white WHP drape,
 * USGS Relative Greenness as the automatic fallback. A lazy chunk the 3D scene
 * imports on entry (src/map/fire3d.ts); nothing here runs outside Wildfire 3D.
 *
 * Revised data (owner direction 2026-10-09): NOAA rewrites back-weeks after
 * publishing, so nothing here keeps a tile, a frame or a listing past one
 * activation, and no fetch forces the browser cache. The next entry reads the
 * week again and draws whatever STAR serves then.
 */

import { addProtocol, type Map as MapLibreMap } from 'maplibre-gl';

import { DRYNESS_NOT_ASSESSED_COLOR, RG_DRYNESS_CLASSES, STAR_DRYNESS_CLASSES } from '../config/dryness-ground';
import { URLS } from '../config/urls';
import { BOTTOM_STACK_IDS, firstLayerIdAbove } from '../map/layer-order';
import { createDrynessGround, type DrynessFrame, type DrynessSnapshot } from './dryness-ground';

/** Mirrored in src/map/layer-order.ts BOTTOM_STACK_IDS. */
const LAYER_ID = 'wildfire-dryness-ground';
const PROTOCOL = 'dryness-ground';
export const DRYNESS_GROUND_EVENT = 'ddm:dryness-ground';
/** The map key asks for the last state when it loads after the ground. */
export const DRYNESS_GROUND_REQUEST_EVENT = 'ddm:dryness-ground-request';
const RG_BOUNDS = [-128.54, 22.47, -65.37, 51.78] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * DRAFT key strings (release 0.7.3 step 2), every one in this one place: step
 * 3 (ddm-cite) owns the final wording and replaces these. None is cited yet,
 * except `starFailure`, which is DDM-P9-T13's own sentence.
 */
export const DRYNESS_KEY_DRAFT = {
  starTitle: 'Vegetation health (NOAA STAR VHI), darker is drier',
  rgTitle: 'Relative Greenness (USGS), darker is less green',
  starRows: ['0 to 6', '6 to 12', '12 to 24', '24 to 36', '36 to 48', '48 to 60', '60 to 72', '72 to 84', '84 to 100'],
  rgRows: ['1 to 10%', '11 to 20%', '21 to 30%', '31 to 40%', '41 to 50%', '51 to 60%', '61 to 70%', '71 to 80%', '81 to 90%', '91 to 100%'],
  notMeasured: 'Not measured (water, cloud or no data)',
  starWeek: (week: number, first: string, last: string): string => `NOAA STAR week ${week}: ${first} to ${last}`,
  rgWeek: (first: string, last: string): string => `USGS week of ${first} to ${last}`,
  starRevision: 'Recent weeks may be revised by NOAA.',
  starCoverage: 'Coverage: global land.',
  rgCoverage: 'Coverage: contiguous United States and southern British Columbia to 51.78 N; Alaska and the rest of Canada are not covered.',
  starQualification: 'Experimental NOAA STAR product, not an official NOAA operational product.',
  rgQualification: 'Low values can be normal seasonal curing.',
  // The exact failure sentence of DDM-P9-T13; the others are drafts.
  starFailure: 'NOAA STAR vegetation health unavailable; showing USGS Relative Greenness',
  unavailable: 'Dryness ground unavailable: NOAA STAR and USGS did not answer.'
} as const;

const day = (date: Date, withYear: boolean): string =>
  `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${withYear ? `, ${date.getUTCFullYear()}` : ''}`;
const range = (first: Date, last: Date): [string, string] =>
  [day(first, first.getUTCFullYear() !== last.getUTCFullYear()), day(last, true)];

/** STAR's own rule (vh1.js getLastWeek): the last complete 7-day week, 1 to 52; week 0 is the prior year's 52. UTC. */
export function starCurrentWeek(now: Date): string {
  const year = now.getUTCFullYear();
  const dayOfYear = Math.round((Date.UTC(year, now.getUTCMonth(), now.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const week = Math.floor((dayOfYear - 1) / 7);
  return week === 0 ? `${String(year - 1).padStart(4, '0')}052` : `${year}0${String(week).padStart(2, '0')}`;
}

/** The issuer's previous week: week 1 steps back to the prior year's 52 (no week 53 exists). */
export function starPreviousWeek(frame: string): string {
  const year = Number(frame.slice(0, 4)), week = Number(frame.slice(5));
  return week === 1 ? `${String(year - 1).padStart(4, '0')}052` : `${frame.slice(0, 4)}0${String(week - 1).padStart(2, '0')}`;
}

/** Week w is days 7w-6 to 7w of its year (week 52 ends Dec 30, Dec 29 in a leap year). */
export function starWeekLine(frame: string): string {
  const year = Number(frame.slice(0, 4)), week = Number(frame.slice(5));
  return DRYNESS_KEY_DRAFT.starWeek(week, ...range(new Date(Date.UTC(year, 0, 7 * week - 6)), new Date(Date.UTC(year, 0, 7 * week))));
}

/** RG's TIME labels the week's START Monday; the week runs to the Sunday after. */
export function rgWeekLine(time: string): string {
  const start = new Date(time);
  return DRYNESS_KEY_DRAFT.rgWeek(...range(start, new Date(start.getTime() + 6 * 86_400_000)));
}

const HALF = 20037508.342789244;
function mercatorBbox(z: number, x: number, y: number): string {
  const size = (2 * HALF) / 2 ** z, west = -HALF + x * size, north = HALF - y * size;
  return [west, north - size, west + size, north].join(',');
}

function starFrame(frame: string): DrynessFrame {
  return {
    productKey: 'star-vhi', frame, issuer: 'NOAA/NESDIS STAR', legendRows: DRYNESS_KEY_DRAFT.starRows,
    clockLabel: starWeekLine(frame), coverage: DRYNESS_KEY_DRAFT.starCoverage,
    qualification: DRYNESS_KEY_DRAFT.starQualification, creditKey: 'noaa-star',
    tileUrl: (z, x, y) => URLS.starVhiJ01TileTemplate.replace('{week}', frame)
      .replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
    // z8 answers 500: maxZoom 7 keeps every request at z7 or shallower.
    tileSize: 256, maxZoom: 7, bounds: [-180, -85, 180, 85]
  };
}

function rgFrame(time: string): DrynessFrame {
  return {
    productKey: 'usgs-relative-greenness', frame: time, issuer: 'USGS EROS', legendRows: DRYNESS_KEY_DRAFT.rgRows,
    clockLabel: rgWeekLine(time), coverage: DRYNESS_KEY_DRAFT.rgCoverage,
    qualification: DRYNESS_KEY_DRAFT.rgQualification, creditKey: 'usgs',
    tileUrl: (z, x, y) => `${URLS.usgsRgConusWeekWms}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
      '&LAYERS=rg_conus_week_data&STYLES=firedanger_weekly_rg_conus_raster&CRS=EPSG:3857' +
      `&BBOX=${mercatorBbox(z, x, y)}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&TIME=${encodeURIComponent(time)}`,
    tileSize: 256, maxZoom: 8, bounds: RG_BOUNDS
  };
}

function readyState(frame: DrynessFrame, map: MapLibreMap): 'live' | 'live (partial)' | 'no data' {
  if (frame.productKey === 'star-vhi') return 'live';
  const view = map.getBounds();
  const [west, south, east, north] = frame.bounds;
  if (view.getEast() <= west || view.getWest() >= east || view.getNorth() <= south || view.getSouth() >= north) return 'no data';
  return view.getWest() >= west && view.getEast() <= east && view.getSouth() >= south && view.getNorth() <= north
    ? 'live' : 'live (partial)';
}

/** What the map key renders; `productKey` is the product mounted on the map, read from the map. */
export interface DrynessGroundDetail {
  readonly state: DrynessSnapshot['state'];
  readonly productKey: DrynessFrame['productKey'] | 'none';
  readonly title: string | null;
  readonly rows: readonly { readonly grey: string; readonly label: string }[];
  readonly lines: readonly string[];
}

function describe(snapshot: DrynessSnapshot, map: MapLibreMap): DrynessGroundDetail {
  const layer = map.getLayer(LAYER_ID) as { source?: string } | undefined;
  const mounted = snapshot.selected && snapshot.sourceId && layer?.source === snapshot.sourceId &&
    map.getSource(snapshot.sourceId) ? snapshot.selected : null;
  const shown = snapshot.selected ?? snapshot.attempted;
  const star = shown?.productKey === 'star-vhi';
  const greys = star ? STAR_DRYNESS_CLASSES : RG_DRYNESS_CLASSES;
  const starFailed = snapshot.failures.some(row => row.productKey === 'star-vhi');
  const lines = [
    ...(shown ? [shown.clockLabel] : []),
    ...(mounted ? [mounted.coverage, ...(star ? [DRYNESS_KEY_DRAFT.starRevision] : []), mounted.qualification] : []),
    ...(snapshot.state === 'unavailable' ? [DRYNESS_KEY_DRAFT.unavailable]
      : starFailed && !star ? [DRYNESS_KEY_DRAFT.starFailure] : [])
  ];
  return {
    state: snapshot.state,
    productKey: mounted?.productKey ?? 'none',
    title: shown ? (star ? DRYNESS_KEY_DRAFT.starTitle : DRYNESS_KEY_DRAFT.rgTitle) : null,
    rows: mounted
      ? [...mounted.legendRows.map((label, index) => ({ grey: greys[index]!.grey, label })),
        { grey: DRYNESS_NOT_ASSESSED_COLOR, label: DRYNESS_KEY_DRAFT.notMeasured }]
      : [],
    lines
  };
}

let ground: ReturnType<typeof createDrynessGround> | null = null;
let protocolAdded = false;
let sourceId: string | null = null;
let lastDetail: DrynessGroundDetail | null = null;

function announce(detail: DrynessGroundDetail | null): void {
  lastDetail = detail;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (detail) {
      root.dataset['ddmDryness'] = detail.state;
      root.dataset['ddmDrynessProduct'] = detail.productKey;
    } else {
      delete root.dataset['ddmDryness'];
      delete root.dataset['ddmDrynessProduct'];
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(DRYNESS_GROUND_EVENT, { detail }));
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(DRYNESS_GROUND_REQUEST_EVENT, () => announce(lastDetail));
}

/** The ground's current source id, for the scene's transport reading; null when none is mounted. */
export function getDrynessSourceId(): string | null {
  return sourceId;
}

/**
 * Enter the ground for one Wildfire 3D activation. Aborting `signal` leaves:
 * every in-flight tile, probe and listing read is aborted and the layer and
 * source are removed. Resolves once the first frame is mounted or the ladder
 * has ended; it never rejects for a source failure (that is a state).
 */
export async function activateWildfireDryness(map: MapLibreMap, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (!protocolAdded) {
    addProtocol(PROTOCOL, (request, controller) =>
      ground ? ground.protocol(request, controller) : Promise.reject(new DOMException('Aborted', 'AbortError')));
    protocolAdded = true;
  }
  ground?.deactivate();
  const week = starCurrentWeek(new Date());
  const mine = createDrynessGround({
    protocolName: PROTOCOL,
    layerId: LAYER_ID,
    // Under the hillshade and every drape, above the basemaps (BOTTOM_STACK_IDS order).
    beforeId: target => firstLayerIdAbove(target, BOTTOM_STACK_IDS.slice(0, BOTTOM_STACK_IDS.indexOf(LAYER_ID))),
    allowedOrigins: [new URL(URLS.starVhiJ01TileTemplate).origin, new URL(URLS.usgsRgConusWeekWms).origin],
    star: [starFrame(week), starFrame(starPreviousWeek(week))],
    rg: {
      capabilitiesUrl: `${URLS.usgsRgConusWeekWms}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`,
      layerName: 'rg_conus_week_data',
      frame: rgFrame
    },
    // 52 KB is the largest STAR tile measured; RG tiles measured 33 KB.
    tileLimits: { timeoutMs: 15_000, maxDecodedBytes: 262_144, maxPixels: 65_536, maxOutputBytes: 524_288 },
    // The capabilities document measured 237,421 B decoded with 501 times (2026-10-09).
    metadataLimits: { timeoutMs: 15_000, maxDecodedBytes: 1_048_576, maxTimes: 2_000 },
    selectionDeadlineMs: 60_000,
    readyState,
    publish: snapshot => {
      sourceId = snapshot?.sourceId ?? null;
      announce(snapshot ? describe(snapshot, map) : null);
    }
  });
  ground = mine;
  signal.addEventListener('abort', () => { if (ground === mine) ground = null; }, { once: true });
  await mine.activate(map, signal);
}
