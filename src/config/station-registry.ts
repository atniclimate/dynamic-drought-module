import { TELEMETRY_STATIONS } from './telemetry';
import { URLS } from './urls';
import type { StationValue, TelemetryFreshness, TelemetryStation } from '../types/station';
import type {
  PrimaryParameterCategory,
  StationDiscoveryRecord,
  StationNetwork,
  StationNetworkAdapter,
  StationNetworkHandles,
  StationNetworkKey,
  StationRegistryEntry,
  StationViewportDiscoveryResult,
  StationViewportDiscoveryRequest,
  ViewportBounds
} from '../types/station-network';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const PROXIMITY_MERGE_METERS = 100;
const EARTH_RADIUS_METERS = 6_371_000;
const USGS_DISCOVERY_TIMEOUT_MS = 8_000;
const AWDB_DISCOVERY_TIMEOUT_MS = 12_000;
const RAWS_DISCOVERY_TIMEOUT_MS = 10_000;
const COOPS_DISCOVERY_TIMEOUT_MS = 12_000;
const USGS_BBOX_AREA_CAP = 25;
const USGS_EXTREME_AREA_FACTOR = 64;
const USGS_DISCOVERY_PARAMETER_CODES = '00060,00065';
const AWDB_DISCOVERY_NETWORKS = ['SNTL', 'SCAN'] as const;
const AGRIMET_DISCOVERY_TIMEOUT_MS = 12_000;
const COCORAHS_DISCOVERY_TIMEOUT_MS = 15_000;
// CoCoRaHS round-one scope is the Pacific Northwest core; the IEM mirror has
// no combined-region call, so we fan out one state per fetch and merge.
const COCORAHS_DISCOVERY_STATES = ['WA', 'OR', 'ID'] as const;

type AwdbDiscoveryNetwork = (typeof AWDB_DISCOVERY_NETWORKS)[number];
type CocorahsDiscoveryState = (typeof COCORAHS_DISCOVERY_STATES)[number];

type MutableStationNetworkHandles = {
  -readonly [K in keyof StationNetworkHandles]?: StationNetworkHandles[K];
};

interface AwdbStationMetadata {
  readonly stationTriplet: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly network: AwdbDiscoveryNetwork;
}

interface AwdbStationCacheInflight {
  readonly controller: AbortController;
  readonly promise: Promise<readonly AwdbStationMetadata[]>;
  readonly waiters: Set<AbortSignal>;
  hasEverHadWaiter: boolean;
}

let awdbStationCache: readonly AwdbStationMetadata[] | null = null;
let awdbStationCacheInflight: AwdbStationCacheInflight | null = null;

interface CoopsStationMetadata {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly state: string | null;
  readonly productsSelf: string | null;
}

interface CoopsStationCacheInflight {
  readonly controller: AbortController;
  readonly promise: Promise<readonly CoopsStationMetadata[]>;
  readonly waiters: Set<AbortSignal>;
  hasEverHadWaiter: boolean;
}

let coopsStationCache: readonly CoopsStationMetadata[] | null = null;
let coopsStationCacheInflight: CoopsStationCacheInflight | null = null;

interface AgrimetStationMetadata {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly state: string | null;
  readonly webpage: string | null;
}

interface CocorahsStationMetadata {
  readonly sid: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly state: string | null;
}

const DISCOVERY_NOT_WIRED_ADAPTER = {
  toDiscoveryRecord: (_rawRecord: unknown): StationDiscoveryRecord | null => null
};

const RAWS_STATION_ADAPTER = {
  toDiscoveryRecord: rawsDiscoveryRecord
} satisfies StationNetworkAdapter<unknown>;

const COOPS_STATION_ADAPTER = {
  toDiscoveryRecord: coopsDiscoveryRecordFromUnknown
} satisfies StationNetworkAdapter<unknown>;

const AGRIMET_STATION_ADAPTER = {
  toDiscoveryRecord: agrimetDiscoveryRecordFromUnknown
} satisfies StationNetworkAdapter<unknown>;

const COCORAHS_STATION_ADAPTER = {
  toDiscoveryRecord: cocorahsDiscoveryRecordFromUnknown
} satisfies StationNetworkAdapter<unknown>;

export const STATION_NETWORKS = [
  {
    key: 'usgs-iv',
    label: 'USGS Instantaneous Values',
    refreshWindowMs: 6 * HOUR_MS,
    cadence: 'about every 15 to 60 minutes',
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'nrcs-awdb',
    label: 'NRCS AWDB SNOTEL and SCAN',
    refreshWindowMs: 2 * DAY_MS,
    cadence: 'about daily',
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'usace-cwms',
    label: 'USACE Corps Water Management System',
    refreshWindowMs: 6 * HOUR_MS,
    cadence: 'about hourly',
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'usbr-hydromet',
    label: 'USBR Hydromet',
    refreshWindowMs: 2 * DAY_MS,
    cadence: 'about daily',
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'raws',
    label: 'NIFC Remote Automated Weather Stations',
    refreshWindowMs: 3 * HOUR_MS,
    cadence: 'about hourly',
    adapter: RAWS_STATION_ADAPTER
  },
  {
    key: 'noaa-coops',
    label: 'NOAA Tides and Currents',
    refreshWindowMs: 6 * HOUR_MS,
    cadence: 'about every 6 minutes',
    adapter: COOPS_STATION_ADAPTER
  },
  {
    key: 'usbr-agrimet',
    label: 'USBR AgriMet',
    refreshWindowMs: 2 * DAY_MS,
    cadence: 'about daily',
    adapter: AGRIMET_STATION_ADAPTER
  },
  {
    key: 'cocorahs',
    label: 'CoCoRaHS (via Iowa Environmental Mesonet)',
    refreshWindowMs: 2 * DAY_MS,
    cadence: 'daily (volunteer reports)',
    adapter: COCORAHS_STATION_ADAPTER
  },
  {
    key: 'nwrfc',
    label: 'Northwest River Forecast Center',
    refreshWindowMs: DAY_MS,
    cadence: 'seasonal updates',
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  }
] as const satisfies readonly StationNetwork[];

export const STATIC_TELEMETRY_STATION_REGISTRY = mergeTelemetryStations(
  TELEMETRY_STATIONS,
  []
);

export function mergeTelemetryStations(
  seeds: readonly TelemetryStation[],
  discovered: readonly StationDiscoveryRecord[]
): readonly StationRegistryEntry[] {
  const entries: StationRegistryEntry[] = seeds.map((station) => seedEntry(station));

  for (const record of discovered) {
    const matchIndex = findMergeTarget(entries, record);
    if (matchIndex === -1) {
      entries.push(discoveredEntry(record));
      continue;
    }

    const current = entries[matchIndex];
    if (!current) continue;
    entries[matchIndex] = mergeEntry(current, record);
  }

  return entries;
}

export function freshnessForNetwork(
  network: StationNetworkKey,
  timestampIso: string,
  nowMs = Date.now()
): TelemetryFreshness {
  const timestampMs = Date.parse(timestampIso);
  if (Number.isNaN(timestampMs)) return 'stale';
  return nowMs - timestampMs <= stationNetworkByKey(network).refreshWindowMs
    ? 'fresh'
    : 'stale';
}

export async function discoverStationsForViewport(
  request: StationViewportDiscoveryRequest
): Promise<StationViewportDiscoveryResult> {
  const queryBounds = clampUsgsDiscoveryBounds(request.bounds, request.center);
  const [usgsRecords, awdbRecords, rawsRecords, coopsRecords, agrimetRecords, cocorahsRecords] =
    await Promise.all([
      queryBounds
        ? discoveryRecordsOrEmpty(
            'USGS IV station discovery',
            discoverUsgsStations(queryBounds, request.signal),
            request.signal
          )
        : Promise.resolve([]),
      discoverAwdbStations(request),
      discoveryRecordsOrEmpty(
        'NIFC RAWS station discovery',
        discoverRawsStations(request.bounds, request.signal),
        request.signal
      ),
      discoverCoopsStations(request),
      discoverAgrimetStations(request),
      discoverCocorahsStations(request)
    ]);

  const records = [
    ...usgsRecords,
    ...awdbRecords,
    ...rawsRecords,
    ...coopsRecords,
    ...agrimetRecords,
    ...cocorahsRecords
  ];
  if (!queryBounds) return { status: 'zoom-in', records };

  return {
    status: 'ok',
    records,
    queriedBounds: queryBounds
  };
}

async function discoverUsgsStations(
  queryBounds: StationViewportDiscoveryRequest['bounds'],
  signal: AbortSignal | null
): Promise<readonly StationDiscoveryRecord[]> {
  const params = new URLSearchParams({
    format: 'json',
    bBox: [
      queryBounds.west,
      queryBounds.south,
      queryBounds.east,
      queryBounds.north
    ].map(formatBboxNumber).join(','),
    parameterCd: USGS_DISCOVERY_PARAMETER_CODES,
    siteStatus: 'active'
  });

  const response = await fetchWithBudget(
    `${URLS.usgsIV}?${params.toString()}`,
    {},
    signal,
    USGS_DISCOVERY_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`USGS IV discovery HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return usgsDiscoveryRecordsFromPayload(payload);
}

async function discoveryRecordsOrEmpty(
  label: string,
  promise: Promise<readonly StationDiscoveryRecord[]>,
  signal: AbortSignal | null
): Promise<readonly StationDiscoveryRecord[]> {
  try {
    return await promise;
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    console.warn(`[telemetry] ${label} failed.`, err);
    return [];
  }
}

export function stationNetworkByKey(key: StationNetworkKey): StationNetwork {
  const network = STATION_NETWORKS.find((candidate) => candidate.key === key);
  if (!network) {
    throw new Error(`Unknown station network: ${key}`);
  }
  return network;
}

function seedEntry(station: TelemetryStation): StationRegistryEntry {
  return {
    station,
    values: [],
    primaryParameterCategory: primaryCategoryForStation(station),
    handles: handlesForStation(station),
    networks: networksForStation(station),
    isCuratedSeed: true
  };
}

function discoveredEntry(record: StationDiscoveryRecord): StationRegistryEntry {
  const handles = mergeHandles(handlesForStation(record.station), record.handles);
  return {
    station: mergeStationHandles(record.station, handles),
    values: [record.value],
    primaryParameterCategory: record.primaryParameterCategory,
    handles,
    networks: uniqueNetworks([record.network, ...networksForStation(record.station)]),
    isCuratedSeed: false
  };
}

function mergeEntry(
  current: StationRegistryEntry,
  record: StationDiscoveryRecord
): StationRegistryEntry {
  const handles = mergeHandles(
    mergeHandles(current.handles, handlesForStation(record.station)),
    record.handles
  );
  // current.station is preserved as the base (its name, description, and
  // color win), which keeps the curated seed's metadata on a seed merge;
  // only handles and network-specific sources are folded in from the
  // discovered record.
  const station = mergeStationHandles(current.station, handles, record.station);

  return {
    station,
    values: mergeValues(current.values, record.value, station.id),
    primaryParameterCategory:
      current.primaryParameterCategory === 'unknown'
        ? record.primaryParameterCategory
        : current.primaryParameterCategory,
    handles,
    networks: uniqueNetworks([record.network, ...current.networks, ...networksForStation(station)]),
    isCuratedSeed: current.isCuratedSeed
  };
}

function findMergeTarget(
  entries: readonly StationRegistryEntry[],
  record: StationDiscoveryRecord
): number {
  const recordHandles = mergeHandles(handlesForStation(record.station), record.handles);
  const handleIndex = entries.findIndex((entry) => hasMatchingHandle(entry.handles, recordHandles));
  if (handleIndex !== -1) return handleIndex;

  // Proximity fallback is for cross-network co-location (one physical
  // place observed by two networks), NOT for two distinct stations of the
  // same network that happen to be within the merge radius. If the record
  // and a candidate carry conflicting handles of the same network (two
  // different USGS site codes, say), they are distinct stations and must
  // not collapse into one marker (adversarial-review finding, 2026-07-06).
  return entries.findIndex(
    (entry) =>
      entry.primaryParameterCategory === record.primaryParameterCategory &&
      distanceMeters(entry.station.coords, record.station.coords) <= PROXIMITY_MERGE_METERS &&
      !handlesConflict(entry.handles, recordHandles)
  );
}

/**
 * True when two handle bags name the same network with different values
 * (for example two different `usgsSite` codes). Such stations are distinct
 * and must never merge by proximity.
 */
function handlesConflict(a: StationNetworkHandles, b: StationNetworkHandles): boolean {
  return (
    conflicts(a.usgsSite, b.usgsSite) ||
    conflicts(a.awdbStation, b.awdbStation) ||
    conflicts(a.cwmsTsId, b.cwmsTsId) ||
    conflicts(a.hydrometSite, b.hydrometSite) ||
    conflicts(a.rawsStationId, b.rawsStationId) ||
    conflicts(a.noaaCoopsId, b.noaaCoopsId) ||
    conflicts(a.agrimetSite, b.agrimetSite) ||
    conflicts(a.cocorahsSid, b.cocorahsSid) ||
    conflicts(a.nwrfcId, b.nwrfcId)
  );
}

function conflicts(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

function handlesForStation(station: TelemetryStation): StationNetworkHandles {
  const handles: MutableStationNetworkHandles = {};
  if (station.usgsSite) handles.usgsSite = station.usgsSite;
  if (station.awdbStation) handles.awdbStation = station.awdbStation;
  if (station.cwms) {
    handles.cwmsOffice = station.cwms.office;
    handles.cwmsTsId = station.cwms.tsId;
  }
  const hydrometSite = hydrometSiteForStation(station);
  if (hydrometSite) handles.hydrometSite = hydrometSite;
  if (station.rawsStationId) handles.rawsStationId = station.rawsStationId;
  if (station.noaaCoopsId) handles.noaaCoopsId = station.noaaCoopsId;
  if (station.agrimetSite) handles.agrimetSite = station.agrimetSite;
  if (station.cocorahsSid) handles.cocorahsSid = station.cocorahsSid;
  const nwrfcId = nwrfcIdForStation(station);
  if (nwrfcId) handles.nwrfcId = nwrfcId;
  return handles;
}

function mergeStationHandles(
  station: TelemetryStation,
  handles: StationNetworkHandles,
  sourceStation?: TelemetryStation
): TelemetryStation {
  return {
    ...station,
    ...(handles.usgsSite ? { usgsSite: handles.usgsSite } : {}),
    ...(handles.awdbStation ? { awdbStation: handles.awdbStation } : {}),
    ...(sourceStation?.cwms ? { cwms: sourceStation.cwms } : {}),
    ...(sourceStation?.hydrometParams
      ? { hydrometParams: sourceStation.hydrometParams }
      : handles.hydrometSite && !station.hydrometParams
        ? { hydrometParams: [handles.hydrometSite] }
        : {}),
    ...(handles.rawsStationId ? { rawsStationId: handles.rawsStationId } : {}),
    ...(handles.noaaCoopsId ? { noaaCoopsId: handles.noaaCoopsId } : {}),
    ...(handles.agrimetSite ? { agrimetSite: handles.agrimetSite } : {}),
    ...(handles.cocorahsSid ? { cocorahsSid: handles.cocorahsSid } : {})
  };
}

function mergeHandles(
  left: StationNetworkHandles,
  right: StationNetworkHandles
): StationNetworkHandles {
  const merged: MutableStationNetworkHandles = { ...left };
  if (right.usgsSite) merged.usgsSite = right.usgsSite;
  if (right.awdbStation) merged.awdbStation = right.awdbStation;
  if (right.cwmsOffice) merged.cwmsOffice = right.cwmsOffice;
  if (right.cwmsTsId) merged.cwmsTsId = right.cwmsTsId;
  if (right.hydrometSite) merged.hydrometSite = right.hydrometSite;
  if (right.rawsStationId) merged.rawsStationId = right.rawsStationId;
  if (right.noaaCoopsId) merged.noaaCoopsId = right.noaaCoopsId;
  if (right.agrimetSite) merged.agrimetSite = right.agrimetSite;
  if (right.cocorahsSid) merged.cocorahsSid = right.cocorahsSid;
  if (right.nwrfcId) merged.nwrfcId = right.nwrfcId;
  return merged;
}

function hasMatchingHandle(left: StationNetworkHandles, right: StationNetworkHandles): boolean {
  return (
    matches(left.usgsSite, right.usgsSite) ||
    matches(left.awdbStation, right.awdbStation) ||
    matches(left.cwmsTsId, right.cwmsTsId) ||
    matches(left.hydrometSite, right.hydrometSite) ||
    matches(left.rawsStationId, right.rawsStationId) ||
    matches(left.noaaCoopsId, right.noaaCoopsId) ||
    matches(left.agrimetSite, right.agrimetSite) ||
    matches(left.cocorahsSid, right.cocorahsSid) ||
    matches(left.nwrfcId, right.nwrfcId)
  );
}

function matches(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
}

function mergeValues(
  values: readonly StationValue[],
  nextValue: StationValue,
  stationId: string
): readonly StationValue[] {
  const normalizedValue = { ...nextValue, stationId };
  const next = values.filter(
    (value) =>
      value.source !== normalizedValue.source || value.parameter !== normalizedValue.parameter
  );
  next.push(normalizedValue);
  return next;
}

function networksForStation(station: TelemetryStation): readonly StationNetworkKey[] {
  const networks: StationNetworkKey[] = [];
  if (station.usgsSite) networks.push('usgs-iv');
  if (station.awdbStation) networks.push('nrcs-awdb');
  if (station.cwms) networks.push('usace-cwms');
  if (station.hydrometParams) networks.push('usbr-hydromet');
  if (station.rawsStationId) networks.push('raws');
  if (station.noaaCoopsId) networks.push('noaa-coops');
  if (station.agrimetSite) networks.push('usbr-agrimet');
  if (station.cocorahsSid) networks.push('cocorahs');
  if (nwrfcIdForStation(station)) networks.push('nwrfc');
  return uniqueNetworks(networks);
}

/**
 * The custody read for a station's popup: its primary network's label and
 * honest update cadence. Used for discovered stations that carry no in-browser
 * hydration path (RAWS, NOAA CO-OPS, AgriMet, CoCoRaHS), so the popup can state
 * the cadence and point to the source link instead of faking a live value.
 * Returns null for a station with no network handle at all.
 */
export function stationCustody(
  station: TelemetryStation
): { readonly networkLabel: string; readonly cadence: string } | null {
  const key = networksForStation(station)[0];
  if (!key) return null;
  const network = stationNetworkByKey(key);
  return { networkLabel: network.label, cadence: network.cadence };
}

function uniqueNetworks(networks: readonly StationNetworkKey[]): readonly StationNetworkKey[] {
  return Array.from(new Set(networks));
}

function primaryCategoryForStation(station: TelemetryStation): PrimaryParameterCategory {
  if (station.awdbStation) return station.awdbStation.includes(':SCAN') ? 'soil-climate' : 'snowpack';
  if (station.hydrometParams && station.hydrometParams.length > 0) {
    const primary = station.hydrometParams[0];
    if (primary?.endsWith(' AF')) return 'reservoir-storage';
    if (primary?.endsWith(' ET')) return 'evapotranspiration';
    if (primary?.endsWith(' MM') || primary?.endsWith(' MX') || primary?.endsWith(' MN')) {
      return 'temperature';
    }
  }
  if (station.cwms) return station.cwms.tsId.toLowerCase().includes('elev') ? 'stage' : 'streamflow';
  if (station.rawsStationId) return 'fire-weather';
  if (station.noaaCoopsId) return 'stage';
  if (station.agrimetSite) return 'evapotranspiration';
  if (station.cocorahsSid) return 'precipitation';
  if (station.usgsSite) return 'streamflow';
  if (nwrfcIdForStation(station)) return 'forecast';
  return 'unknown';
}

function hydrometSiteForStation(station: TelemetryStation): string | null {
  const primary = station.hydrometParams?.[0];
  if (!primary) return null;
  const site = primary.trim().split(/\s+/)[0];
  return site && site.length > 0 ? site : null;
}

function nwrfcIdForStation(station: TelemetryStation): string | null {
  for (const link of station.links) {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    if (!url.hostname.endsWith('nwrfc.noaa.gov')) continue;
    const id = url.searchParams.get('id');
    if (id) return id;
  }
  return null;
}

/** Great-circle distance in meters between two [lat, lon] points. */
export function distanceMeters(
  a: readonly [number, number],
  b: readonly [number, number]
): number {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const rLat1 = radians(lat1);
  const rLat2 = radians(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function clampUsgsDiscoveryBounds(
  bounds: StationViewportDiscoveryRequest['bounds'],
  center: StationViewportDiscoveryRequest['center']
): StationViewportDiscoveryRequest['bounds'] | null {
  const centerLat = clamp(center[0], -89.5, 89.5);
  const centerLon = clamp(center[1], -180, 180);
  const south = clamp(Math.min(bounds.south, bounds.north), -90, 90);
  const north = clamp(Math.max(bounds.south, bounds.north), -90, 90);
  // Known limitation (adversarial-review finding, 2026-07-06, deferred): a
  // viewport crossing the anti-meridian (west 170, east -170) collapses to
  // a 340-degree-wide box here and falls back to "zoom in to load". The
  // bundled framings avoid the anti-meridian (the Alaska bounds stop short
  // of the Aleutian crossing), and USGS Instantaneous Values coverage there
  // is sparse, so splitting the query across the seam is not worth its cost
  // yet.
  const west = clamp(Math.min(bounds.west, bounds.east), -180, 180);
  const east = clamp(Math.max(bounds.west, bounds.east), -180, 180);
  const width = Math.max(0, east - west);
  const height = Math.max(0, north - south);
  const latitudeFactor = Math.max(0.05, Math.abs(Math.cos(radians(centerLat))));
  const area = width * latitudeFactor * height;

  if (width <= 0 || height <= 0) return null;
  if (area > USGS_BBOX_AREA_CAP * USGS_EXTREME_AREA_FACTOR) return null;
  if (area <= USGS_BBOX_AREA_CAP) {
    return { west, south, east, north };
  }

  const scale = Math.sqrt(USGS_BBOX_AREA_CAP / area);
  const clampedWidth = width * scale;
  const clampedHeight = height * scale;
  return boundsFromCenter(centerLat, centerLon, clampedWidth, clampedHeight);
}

function boundsFromCenter(
  centerLat: number,
  centerLon: number,
  width: number,
  height: number
): StationViewportDiscoveryRequest['bounds'] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return {
    west: clamp(centerLon - halfWidth, -180, 180),
    south: clamp(centerLat - halfHeight, -90, 90),
    east: clamp(centerLon + halfWidth, -180, 180),
    north: clamp(centerLat + halfHeight, -90, 90)
  };
}

function usgsDiscoveryRecordsFromPayload(payload: unknown): readonly StationDiscoveryRecord[] {
  const bySite = new Map<string, UsgsDiscoverySite>();
  for (const series of readUsgsTimeSeries(payload)) {
    const siteCode = readUsgsSiteCode(series);
    const siteName = readUsgsSiteName(series);
    const coords = readUsgsCoords(series);
    const value = readUsgsStationValue(siteCode, series);
    if (!siteCode || !siteName || !coords || !value) continue;

    const current = bySite.get(siteCode);
    if (!current) {
      bySite.set(siteCode, { siteCode, siteName, coords, values: [value] });
      continue;
    }
    current.values.push(value);
  }

  const records: StationDiscoveryRecord[] = [];
  for (const site of bySite.values()) {
    const value = preferredUsgsValue(site.values);
    if (!value) continue;
    records.push({
      network: 'usgs-iv',
      station: {
        id: `usgs-${site.siteCode}`,
        name: site.siteName,
        coords: site.coords,
        region: 'discovered',
        type: 'gage',
        agency: 'USGS',
        color: '#06b6d4',
        description: 'USGS Instantaneous Values station discovered in the current viewport.',
        usgsSite: site.siteCode,
        links: [
          {
            label: 'USGS streamgage',
            url: `https://waterdata.usgs.gov/monitoring-location/${site.siteCode}`
          }
        ]
      },
      value,
      primaryParameterCategory: value.parameter === 'gage_height_ft' ? 'stage' : 'streamflow',
      handles: { usgsSite: site.siteCode }
    });
  }
  return records;
}

function readUsgsTimeSeries(payload: unknown): readonly Record<string, unknown>[] {
  if (!isObject(payload) || !isObject(payload.value)) return [];
  const timeSeries = payload.value.timeSeries;
  if (!Array.isArray(timeSeries)) return [];
  return timeSeries.filter(isObject);
}

function readUsgsSiteCode(series: Record<string, unknown>): string | null {
  const sourceInfo = series.sourceInfo;
  if (!isObject(sourceInfo)) return null;
  const siteCode = sourceInfo.siteCode;
  if (!Array.isArray(siteCode) || siteCode.length === 0) return null;
  const first = siteCode[0];
  if (!isObject(first)) return null;
  return typeof first.value === 'string' ? first.value : null;
}

function readUsgsSiteName(series: Record<string, unknown>): string | null {
  const sourceInfo = series.sourceInfo;
  if (!isObject(sourceInfo)) return null;
  return typeof sourceInfo.siteName === 'string' ? sourceInfo.siteName : null;
}

function readUsgsCoords(series: Record<string, unknown>): readonly [number, number] | null {
  const sourceInfo = series.sourceInfo;
  if (!isObject(sourceInfo) || !isObject(sourceInfo.geoLocation)) return null;
  const geogLocation = sourceInfo.geoLocation.geogLocation;
  if (!isObject(geogLocation)) return null;
  const latitude = geogLocation.latitude;
  const longitude = geogLocation.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  return [latitude, longitude];
}

function readUsgsStationValue(
  siteCode: string | null,
  series: Record<string, unknown>
): StationValue | null {
  if (!siteCode) return null;
  const code = readUsgsVariableCode(series);
  const latest = readLatestUsgsReading(series);
  if (!latest) return null;
  const value = Number(latest.value);
  if (!Number.isFinite(value)) return null;

  const timestamp = latest.dateTime;
  const freshness = usgsDiscoveryFreshness(timestamp);
  return {
    stationId: `usgs-${siteCode}`,
    parameter: code === '00065' ? 'gage_height_ft' : 'discharge_cfs',
    label: code === '00065' ? 'Gage height' : 'Discharge',
    value: Math.round(value * 100) / 100,
    unit: readUsgsUnitCode(series) ?? '',
    timestamp,
    freshness,
    source: 'usgs-iv'
  };
}

function readLatestUsgsReading(
  series: Record<string, unknown>
): { readonly value: string; readonly dateTime: string } | null {
  const values = series.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const first = values[0];
  if (!isObject(first) || !Array.isArray(first.value)) return null;

  for (let i = first.value.length - 1; i >= 0; i--) {
    const reading = first.value[i];
    if (!isObject(reading)) continue;
    if (reading.value === '-999999') continue;
    if (typeof reading.value !== 'string' || typeof reading.dateTime !== 'string') continue;
    return { value: reading.value, dateTime: reading.dateTime };
  }
  return null;
}

function readUsgsVariableCode(series: Record<string, unknown>): string | null {
  const variable = series.variable;
  if (!isObject(variable) || !Array.isArray(variable.variableCode)) return null;
  const first = variable.variableCode[0];
  if (!isObject(first)) return null;
  return typeof first.value === 'string' ? first.value : null;
}

function readUsgsUnitCode(series: Record<string, unknown>): string | null {
  const variable = series.variable;
  if (!isObject(variable) || !isObject(variable.unit)) return null;
  return typeof variable.unit.unitCode === 'string' ? variable.unit.unitCode : null;
}

function preferredUsgsValue(values: readonly StationValue[]): StationValue | null {
  return (
    values.find((value) => value.parameter === 'discharge_cfs') ??
    values.find((value) => value.parameter === 'gage_height_ft') ??
    values[0] ??
    null
  );
}

function usgsDiscoveryFreshness(timestampIso: string): TelemetryFreshness {
  const timestampMs = Date.parse(timestampIso);
  if (Number.isNaN(timestampMs)) return 'stale';
  if (Date.now() - timestampMs > DAY_MS) return 'stale';
  return freshnessForNetwork('usgs-iv', timestampIso);
}

function formatBboxNumber(value: number): string {
  return value.toFixed(5).replace(/\.?0+$/, '');
}

async function discoverAwdbStations(
  request: StationViewportDiscoveryRequest
): Promise<readonly StationDiscoveryRecord[]> {
  try {
    const stations = await getAwdbStationCache(request.signal);
    if (request.signal?.aborted) return [];
    return stations
      .filter((station) => isCoordinateInBounds(station.latitude, station.longitude, request.bounds))
      .map(awdbDiscoveryRecord);
  } catch (err) {
    if (isAbortError(err) || request.signal?.aborted) throw err;
    console.warn('[telemetry] NRCS AWDB station discovery failed.', err);
    return [];
  }
}

async function getAwdbStationCache(
  signal: AbortSignal | null
): Promise<readonly AwdbStationMetadata[]> {
  if (awdbStationCache) return awdbStationCache;
  const inflight =
    awdbStationCacheInflight && !awdbStationCacheInflight.controller.signal.aborted
      ? awdbStationCacheInflight
      : startAwdbStationCacheFetch();
  if (signal) addAwdbCacheWaiter(inflight, signal);

  try {
    if (!signal) return await inflight.promise;
    return await Promise.race([inflight.promise, abortPromise(signal)]);
  } finally {
    if (signal) removeAwdbCacheWaiter(inflight, signal);
  }
}

function startAwdbStationCacheFetch(): AwdbStationCacheInflight {
  const controller = new AbortController();
  const waiters = new Set<AbortSignal>();
  const promise = fetchAwdbStationLists(controller.signal)
    .then((stations) => {
      awdbStationCache = stations;
      return stations;
    })
    .finally(() => {
      awdbStationCacheInflight = null;
    });
  const inflight = { controller, promise, waiters, hasEverHadWaiter: false };
  awdbStationCacheInflight = inflight;
  return inflight;
}

function addAwdbCacheWaiter(inflight: AwdbStationCacheInflight, signal: AbortSignal): void {
  if (signal.aborted) {
    maybeAbortAwdbCacheFetch(inflight);
    return;
  }
  inflight.hasEverHadWaiter = true;
  inflight.waiters.add(signal);
  signal.addEventListener('abort', () => removeAwdbCacheWaiter(inflight, signal), { once: true });
}

function removeAwdbCacheWaiter(inflight: AwdbStationCacheInflight, signal: AbortSignal): void {
  inflight.waiters.delete(signal);
  maybeAbortAwdbCacheFetch(inflight);
}

function maybeAbortAwdbCacheFetch(inflight: AwdbStationCacheInflight): void {
  if (awdbStationCacheInflight !== inflight) return;
  if (
    inflight.hasEverHadWaiter &&
    inflight.waiters.size === 0 &&
    !inflight.controller.signal.aborted
  ) {
    inflight.controller.abort();
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true }
    );
  });
}

interface StationListCache<T> {
  get(signal: AbortSignal | null): Promise<readonly T[]>;
}

// Reference-counted, single-flight cache for a national or multi-state station
// list. It generalizes the hand-rolled AWDB and CO-OPS caches above: at most
// one fetch is in flight; concurrent callers share it; and if every waiter
// aborts before it resolves, the shared fetch is aborted too. The AWDB and
// CO-OPS caches predate this helper and are left in place; the newer AgriMet
// and CoCoRaHS lists share it so the waiter bookkeeping lives in one spot.
function createStationListCache<T>(
  fetcher: (signal: AbortSignal) => Promise<readonly T[]>
): StationListCache<T> {
  interface Inflight {
    readonly controller: AbortController;
    readonly promise: Promise<readonly T[]>;
    readonly waiters: Set<AbortSignal>;
    hasEverHadWaiter: boolean;
  }

  let cache: readonly T[] | null = null;
  let inflight: Inflight | null = null;

  function maybeAbort(target: Inflight): void {
    if (inflight !== target) return;
    if (
      target.hasEverHadWaiter &&
      target.waiters.size === 0 &&
      !target.controller.signal.aborted
    ) {
      target.controller.abort();
    }
  }

  function removeWaiter(target: Inflight, signal: AbortSignal): void {
    target.waiters.delete(signal);
    maybeAbort(target);
  }

  function addWaiter(target: Inflight, signal: AbortSignal): void {
    if (signal.aborted) {
      maybeAbort(target);
      return;
    }
    target.hasEverHadWaiter = true;
    target.waiters.add(signal);
    signal.addEventListener('abort', () => removeWaiter(target, signal), { once: true });
  }

  function start(): Inflight {
    const controller = new AbortController();
    const created: Inflight = {
      controller,
      waiters: new Set<AbortSignal>(),
      hasEverHadWaiter: false,
      promise: fetcher(controller.signal)
        .then((list) => {
          cache = list;
          return list;
        })
        .finally(() => {
          if (inflight === created) inflight = null;
        })
    };
    inflight = created;
    return created;
  }

  return {
    async get(signal: AbortSignal | null): Promise<readonly T[]> {
      if (cache) return cache;
      const target = inflight && !inflight.controller.signal.aborted ? inflight : start();
      if (signal) addWaiter(target, signal);
      try {
        if (!signal) return await target.promise;
        return await Promise.race([target.promise, abortPromise(signal)]);
      } finally {
        if (signal) removeWaiter(target, signal);
      }
    }
  };
}

async function fetchAwdbStationLists(
  signal: AbortSignal
): Promise<readonly AwdbStationMetadata[]> {
  const settled = await Promise.allSettled(
    AWDB_DISCOVERY_NETWORKS.map((network) => fetchAwdbStationsForNetwork(network, signal))
  );
  const stations: AwdbStationMetadata[] = [];
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      stations.push(...result.value);
    } else {
      failures.push(result.reason);
    }
  }
  const abortFailure = failures.find(isAbortError);
  if (abortFailure || signal.aborted) {
    throw abortFailure ?? new DOMException('Aborted', 'AbortError');
  }
  if (failures.length === AWDB_DISCOVERY_NETWORKS.length) {
    throw new Error('NRCS AWDB station discovery failed for all requested networks');
  }
  if (failures.length > 0) {
    console.warn('[telemetry] partial NRCS AWDB station discovery failed.', failures);
  }
  return stations;
}

async function fetchAwdbStationsForNetwork(
  network: AwdbDiscoveryNetwork,
  signal: AbortSignal
): Promise<readonly AwdbStationMetadata[]> {
  const params = new URLSearchParams({
    stationTriplets: `*:*:${network}`,
    activeOnly: 'true',
    returnStationElements: 'false'
  });
  const response = await fetchWithBudget(
    `${URLS.nrcsAwdbStations}?${params.toString()}`,
    {},
    signal,
    AWDB_DISCOVERY_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`NRCS AWDB station discovery HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return readAwdbStationList(payload, network);
}

function readAwdbStationList(
  payload: unknown,
  network: AwdbDiscoveryNetwork
): readonly AwdbStationMetadata[] {
  if (!Array.isArray(payload)) return [];
  const stations: AwdbStationMetadata[] = [];
  for (const raw of payload) {
    if (!isObject(raw)) continue;
    const stationTriplet = readNonEmptyString(raw.stationTriplet);
    const name = readNonEmptyString(raw.name);
    const latitude = readFiniteNumber(raw.latitude);
    const longitude = readFiniteNumber(raw.longitude);
    if (!stationTriplet || !name || latitude === null || longitude === null) continue;
    stations.push({ stationTriplet, name, latitude, longitude, network });
  }
  return stations;
}

function awdbDiscoveryRecord(station: AwdbStationMetadata): StationDiscoveryRecord {
  const stationIdPrefix = station.network === 'SNTL' ? 'snotel' : 'scan';
  const parameter =
    station.network === 'SNTL' ? 'snow_water_equivalent_in' : 'soil_moisture_pct';
  const label = station.network === 'SNTL' ? 'Snow water equivalent' : 'Soil moisture';
  const primaryParameterCategory: PrimaryParameterCategory =
    station.network === 'SNTL' ? 'snowpack' : 'soil-climate';
  const id = `${stationIdPrefix}-${station.stationTriplet.toLowerCase()}`;

  return {
    network: 'nrcs-awdb',
    station: {
      id,
      name: station.name,
      coords: [station.latitude, station.longitude],
      region: 'discovered',
      type: station.network === 'SNTL' ? 'snotel' : 'scan',
      agency: 'NRCS',
      color: station.network === 'SNTL' ? '#38bdf8' : '#84cc16',
      description:
        station.network === 'SNTL'
          ? 'NRCS SNOTEL station discovered in the current viewport.'
          : 'NRCS SCAN station discovered in the current viewport.',
      awdbStation: station.stationTriplet,
      links: []
    },
    value: {
      stationId: id,
      parameter,
      label,
      value: null,
      unit: station.network === 'SNTL' ? 'in' : '%',
      timestamp: '',
      freshness: 'unknown',
      source: 'nrcs-awdb'
    },
    primaryParameterCategory,
    handles: { awdbStation: station.stationTriplet }
  };
}

async function discoverRawsStations(
  bounds: ViewportBounds,
  signal: AbortSignal | null
): Promise<readonly StationDiscoveryRecord[]> {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: [bounds.west, bounds.south, bounds.east, bounds.north]
      .map(formatBboxNumber)
      .join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields:
      'StationName,StationID,MesoWestStationID,Latitude,Longitude,State,Agency,Status,ObservedDate',
    f: 'geojson'
  });

  const response = await fetchWithBudget(
    `${URLS.nifcRawsFeatureServer}/query?${params.toString()}`,
    {},
    signal,
    RAWS_DISCOVERY_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`NIFC RAWS station discovery HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return readRawsFeatures(payload)
    .map((feature) => RAWS_STATION_ADAPTER.toDiscoveryRecord(feature))
    .filter(isDiscoveryRecord);
}

function readRawsFeatures(payload: unknown): readonly Record<string, unknown>[] {
  if (!isObject(payload) || !Array.isArray(payload.features)) return [];
  return payload.features.filter(isObject);
}

function rawsDiscoveryRecord(feature: unknown): StationDiscoveryRecord | null {
  if (!isObject(feature)) return null;
  const coords = readGeoJsonCoords(feature);
  const properties = feature.properties;
  if (!coords || !isObject(properties)) return null;
  if (properties.Status !== 'A') return null;

  const stationId = readIdentifier(properties.StationID);
  const stationName = readNonEmptyString(properties.StationName);
  if (!stationId || !stationName) return null;

  const mesowestStationId = readIdentifier(properties.MesoWestStationID);
  const id = `raws-${stationId}`;
  return {
    network: 'raws',
    station: {
      id,
      name: stationName,
      coords,
      region: readNonEmptyString(properties.State) ?? 'discovered',
      type: 'fire-weather',
      agency: readNonEmptyString(properties.Agency) ?? 'NIFC RAWS',
      color: '#ef4444',
      description: 'NIFC RAWS station discovered in the current viewport.',
      rawsStationId: stationId,
      links: [
        mesowestStationId
          ? {
              label: 'MesoWest station page',
              url: `https://mesowest.utah.edu/cgi-bin/droman/meso_base_dyn.cgi?stn=${encodeURIComponent(
                mesowestStationId
              )}`
            }
          : {
              label: 'NIFC RAWS open data',
              url: 'https://data-nifc.opendata.arcgis.com/'
            }
      ]
    },
    value: {
      stationId: id,
      parameter: 'fire_weather_conditions',
      label: 'Fire weather conditions',
      value: null,
      unit: '',
      timestamp: '',
      freshness: 'unknown',
      source: 'raws'
    },
    primaryParameterCategory: 'fire-weather',
    handles: { rawsStationId: stationId }
  };
}

async function discoverCoopsStations(
  request: StationViewportDiscoveryRequest
): Promise<readonly StationDiscoveryRecord[]> {
  try {
    const stations = await getCoopsStationCache(request.signal);
    if (request.signal?.aborted) return [];
    return stations
      .filter((station) => isCoordinateInBounds(station.latitude, station.longitude, request.bounds))
      .map((station) => COOPS_STATION_ADAPTER.toDiscoveryRecord(station))
      .filter(isDiscoveryRecord);
  } catch (err) {
    if (isAbortError(err) || request.signal?.aborted) throw err;
    console.warn('[telemetry] NOAA CO-OPS station discovery failed.', err);
    return [];
  }
}

async function getCoopsStationCache(
  signal: AbortSignal | null
): Promise<readonly CoopsStationMetadata[]> {
  if (coopsStationCache) return coopsStationCache;
  const inflight =
    coopsStationCacheInflight && !coopsStationCacheInflight.controller.signal.aborted
      ? coopsStationCacheInflight
      : startCoopsStationCacheFetch();
  if (signal) addCoopsCacheWaiter(inflight, signal);

  try {
    if (!signal) return await inflight.promise;
    return await Promise.race([inflight.promise, abortPromise(signal)]);
  } finally {
    if (signal) removeCoopsCacheWaiter(inflight, signal);
  }
}

function startCoopsStationCacheFetch(): CoopsStationCacheInflight {
  const controller = new AbortController();
  const waiters = new Set<AbortSignal>();
  const promise = fetchCoopsStationList(controller.signal)
    .then((stations) => {
      coopsStationCache = stations;
      return stations;
    })
    .finally(() => {
      coopsStationCacheInflight = null;
    });
  const inflight = { controller, promise, waiters, hasEverHadWaiter: false };
  coopsStationCacheInflight = inflight;
  return inflight;
}

function addCoopsCacheWaiter(inflight: CoopsStationCacheInflight, signal: AbortSignal): void {
  if (signal.aborted) {
    maybeAbortCoopsCacheFetch(inflight);
    return;
  }
  inflight.hasEverHadWaiter = true;
  inflight.waiters.add(signal);
  signal.addEventListener('abort', () => removeCoopsCacheWaiter(inflight, signal), { once: true });
}

function removeCoopsCacheWaiter(inflight: CoopsStationCacheInflight, signal: AbortSignal): void {
  inflight.waiters.delete(signal);
  maybeAbortCoopsCacheFetch(inflight);
}

function maybeAbortCoopsCacheFetch(inflight: CoopsStationCacheInflight): void {
  if (coopsStationCacheInflight !== inflight) return;
  if (
    inflight.hasEverHadWaiter &&
    inflight.waiters.size === 0 &&
    !inflight.controller.signal.aborted
  ) {
    inflight.controller.abort();
  }
}

async function fetchCoopsStationList(signal: AbortSignal): Promise<readonly CoopsStationMetadata[]> {
  const params = new URLSearchParams({ type: 'waterlevels' });
  const response = await fetchWithBudget(
    `${URLS.noaaCoopsStations}?${params.toString()}`,
    {},
    signal,
    COOPS_DISCOVERY_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`NOAA CO-OPS station discovery HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return readCoopsStationList(payload);
}

function readCoopsStationList(payload: unknown): readonly CoopsStationMetadata[] {
  if (!isObject(payload) || !Array.isArray(payload.stations)) return [];
  const stations: CoopsStationMetadata[] = [];
  for (const raw of payload.stations) {
    if (!isObject(raw)) continue;
    const id = readIdentifier(raw.id);
    const name = readNonEmptyString(raw.name);
    const latitude = readFiniteNumber(raw.lat);
    const longitude = readFiniteNumber(raw.lng);
    if (!id || !name || latitude === null || longitude === null) continue;
    stations.push({
      id,
      name,
      latitude,
      longitude,
      state: readNonEmptyString(raw.state),
      productsSelf: readCoopsProductsSelf(raw)
    });
  }
  return stations;
}

function readCoopsProductsSelf(raw: Record<string, unknown>): string | null {
  const products = raw.products;
  if (!isObject(products)) return null;
  return readNonEmptyString(products.self);
}

function coopsDiscoveryRecordFromUnknown(rawRecord: unknown): StationDiscoveryRecord | null {
  if (!isCoopsStationMetadata(rawRecord)) return null;
  return coopsDiscoveryRecord(rawRecord);
}

function isCoopsStationMetadata(value: unknown): value is CoopsStationMetadata {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number' &&
    (typeof value.state === 'string' || value.state === null) &&
    (typeof value.productsSelf === 'string' || value.productsSelf === null)
  );
}

function coopsDiscoveryRecord(station: CoopsStationMetadata): StationDiscoveryRecord | null {
  const id = `coops-${station.id}`;
  return {
    network: 'noaa-coops',
    station: {
      id,
      name: station.name,
      coords: [station.latitude, station.longitude],
      region: station.state ?? 'discovered',
      type: 'tide-gage',
      agency: 'NOAA CO-OPS',
      color: '#2563eb',
      description: 'NOAA CO-OPS water level station discovered in the current viewport.',
      noaaCoopsId: station.id,
      links: [
        {
          label: 'NOAA Tides and Currents station',
          url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${encodeURIComponent(
            station.id
          )}`
        }
      ]
    },
    value: {
      stationId: id,
      parameter: 'water_level',
      label: 'Water level',
      value: null,
      unit: '',
      timestamp: '',
      freshness: 'unknown',
      source: 'noaa-coops'
    },
    primaryParameterCategory: 'stage',
    handles: { noaaCoopsId: station.id }
  };
}

const agrimetStationListCache = createStationListCache(fetchAgrimetStationList);

async function discoverAgrimetStations(
  request: StationViewportDiscoveryRequest
): Promise<readonly StationDiscoveryRecord[]> {
  try {
    const stations = await agrimetStationListCache.get(request.signal);
    if (request.signal?.aborted) return [];
    return stations
      .filter((station) =>
        isCoordinateInBounds(station.latitude, station.longitude, request.bounds)
      )
      .map((station) => AGRIMET_STATION_ADAPTER.toDiscoveryRecord(station))
      .filter(isDiscoveryRecord);
  } catch (err) {
    if (isAbortError(err) || request.signal?.aborted) throw err;
    console.warn('[telemetry] USBR AgriMet station discovery failed.', err);
    return [];
  }
}

async function fetchAgrimetStationList(
  signal: AbortSignal
): Promise<readonly AgrimetStationMetadata[]> {
  // The AgriMet origin sends no CORS header, so the request must go through the
  // Worker proxy (www.usbr.gov is already on the allow-list). The response is a
  // JavaScript data file (application/x-javascript), not JSON; read it as text
  // and extract the single-quoted string assigned to `agrimet_sites`.
  const proxied = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(URLS.usbrAgrimetSitesJs)}`;
  const response = await fetchWithBudget(proxied, {}, signal, AGRIMET_DISCOVERY_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`USBR AgriMet station discovery HTTP ${response.status}`);
  }
  const text = await response.text();
  return readAgrimetStationList(text);
}

function readAgrimetStationList(text: string): readonly AgrimetStationMetadata[] {
  const match = /agrimet_sites\s*=\s*'([\s\S]*?)'\s*;/.exec(text);
  if (!match || !match[1]) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return [];
  }
  if (!isObject(payload) || !Array.isArray(payload.features)) return [];
  const stations: AgrimetStationMetadata[] = [];
  for (const raw of payload.features) {
    if (!isObject(raw)) continue;
    const coords = readGeoJsonCoords(raw);
    const properties = raw.properties;
    if (!coords || !isObject(properties)) continue;
    const id = readIdentifier(properties.StationID);
    const name = readNonEmptyString(properties.StationName);
    if (!id || !name) continue;
    stations.push({
      id,
      name,
      latitude: coords[0],
      longitude: coords[1],
      state: readNonEmptyString(properties.StationState),
      webpage: readAbsoluteHttpUrl(properties.webpage)
    });
  }
  return stations;
}

function agrimetDiscoveryRecordFromUnknown(rawRecord: unknown): StationDiscoveryRecord | null {
  if (!isAgrimetStationMetadata(rawRecord)) return null;
  return agrimetDiscoveryRecord(rawRecord);
}

function isAgrimetStationMetadata(value: unknown): value is AgrimetStationMetadata {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number' &&
    (typeof value.state === 'string' || value.state === null) &&
    (typeof value.webpage === 'string' || value.webpage === null)
  );
}

function agrimetDiscoveryRecord(station: AgrimetStationMetadata): StationDiscoveryRecord {
  const id = `agrimet-${station.id}`;
  return {
    network: 'usbr-agrimet',
    station: {
      id,
      name: station.name,
      coords: [station.latitude, station.longitude],
      region: station.state ?? 'discovered',
      type: 'agrimet',
      agency: 'USBR AgriMet',
      color: '#f59e0b',
      description: 'USBR AgriMet agricultural weather station discovered in the current viewport.',
      agrimetSite: station.id,
      links: [
        station.webpage
          ? { label: 'AgriMet station page', url: station.webpage }
          : { label: 'USBR AgriMet', url: 'https://www.usbr.gov/pn/agrimet/' }
      ]
    },
    value: {
      stationId: id,
      parameter: 'reference_evapotranspiration',
      label: 'Reference evapotranspiration',
      value: null,
      unit: '',
      timestamp: '',
      freshness: 'unknown',
      source: 'usbr-agrimet'
    },
    primaryParameterCategory: 'evapotranspiration',
    handles: { agrimetSite: station.id }
  };
}

const cocorahsStationListCache = createStationListCache(fetchCocorahsStationLists);

async function discoverCocorahsStations(
  request: StationViewportDiscoveryRequest
): Promise<readonly StationDiscoveryRecord[]> {
  try {
    const stations = await cocorahsStationListCache.get(request.signal);
    if (request.signal?.aborted) return [];
    return stations
      .filter((station) =>
        isCoordinateInBounds(station.latitude, station.longitude, request.bounds)
      )
      .map((station) => COCORAHS_STATION_ADAPTER.toDiscoveryRecord(station))
      .filter(isDiscoveryRecord);
  } catch (err) {
    if (isAbortError(err) || request.signal?.aborted) throw err;
    console.warn('[telemetry] CoCoRaHS station discovery failed.', err);
    return [];
  }
}

async function fetchCocorahsStationLists(
  signal: AbortSignal
): Promise<readonly CocorahsStationMetadata[]> {
  // The IEM mirror has no combined-region endpoint, so fetch each state and
  // merge; a per-state failure is contained the same way the AWDB per-network
  // fan-out is (partial results survive, a total failure throws).
  const settled = await Promise.allSettled(
    COCORAHS_DISCOVERY_STATES.map((state) => fetchCocorahsStationsForState(state, signal))
  );
  const stations: CocorahsStationMetadata[] = [];
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      stations.push(...result.value);
    } else {
      failures.push(result.reason);
    }
  }
  const abortFailure = failures.find(isAbortError);
  if (abortFailure || signal.aborted) {
    throw abortFailure ?? new DOMException('Aborted', 'AbortError');
  }
  if (failures.length === COCORAHS_DISCOVERY_STATES.length) {
    throw new Error('CoCoRaHS station discovery failed for all requested states');
  }
  if (failures.length > 0) {
    console.warn('[telemetry] partial CoCoRaHS station discovery failed.', failures);
  }
  return stations;
}

async function fetchCocorahsStationsForState(
  state: CocorahsDiscoveryState,
  signal: AbortSignal
): Promise<readonly CocorahsStationMetadata[]> {
  const params = new URLSearchParams({ network: `${state}_COCORAHS` });
  const response = await fetchWithBudget(
    `${URLS.iemCocorahsNetwork}?${params.toString()}`,
    {},
    signal,
    COCORAHS_DISCOVERY_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`CoCoRaHS station discovery HTTP ${response.status} (${state})`);
  }
  const payload: unknown = await response.json();
  return readCocorahsStationList(payload);
}

function readCocorahsStationList(payload: unknown): readonly CocorahsStationMetadata[] {
  if (!isObject(payload) || !Array.isArray(payload.features)) return [];
  const stations: CocorahsStationMetadata[] = [];
  for (const raw of payload.features) {
    if (!isObject(raw)) continue;
    const coords = readGeoJsonCoords(raw);
    const properties = raw.properties;
    if (!coords || !isObject(properties)) continue;
    // The mirror returns the full historical roster; only stations currently
    // reporting (online === true) are surfaced, or dead sites would show.
    if (properties.online !== true) continue;
    const sid = readNonEmptyString(properties.sid);
    const name = readNonEmptyString(properties.sname);
    if (!sid || !name) continue;
    stations.push({
      sid,
      name,
      latitude: coords[0],
      longitude: coords[1],
      state: readNonEmptyString(properties.state)
    });
  }
  return stations;
}

function cocorahsDiscoveryRecordFromUnknown(rawRecord: unknown): StationDiscoveryRecord | null {
  if (!isCocorahsStationMetadata(rawRecord)) return null;
  return cocorahsDiscoveryRecord(rawRecord);
}

function isCocorahsStationMetadata(value: unknown): value is CocorahsStationMetadata {
  return (
    isObject(value) &&
    typeof value.sid === 'string' &&
    typeof value.name === 'string' &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number' &&
    (typeof value.state === 'string' || value.state === null)
  );
}

function cocorahsDiscoveryRecord(station: CocorahsStationMetadata): StationDiscoveryRecord {
  const id = `cocorahs-${station.sid}`;
  return {
    network: 'cocorahs',
    station: {
      id,
      name: station.name,
      coords: [station.latitude, station.longitude],
      region: station.state ?? 'discovered',
      type: 'cocorahs',
      agency: 'CoCoRaHS (via Iowa Environmental Mesonet)',
      color: '#22d3ee',
      description:
        'CoCoRaHS precipitation station discovered in the current viewport (round-one scope: Washington, Oregon, Idaho).',
      cocorahsSid: station.sid,
      links: [
        {
          label: 'CoCoRaHS',
          url: 'https://www.cocorahs.org/'
        }
      ]
    },
    value: {
      stationId: id,
      parameter: 'daily_precipitation',
      label: 'Daily precipitation',
      value: null,
      unit: '',
      timestamp: '',
      freshness: 'unknown',
      source: 'cocorahs'
    },
    primaryParameterCategory: 'precipitation',
    handles: { cocorahsSid: station.sid }
  };
}

function readAbsoluteHttpUrl(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  return /^https?:\/\//i.test(raw.trim()) ? raw.trim() : null;
}

function readGeoJsonCoords(feature: Record<string, unknown>): readonly [number, number] | null {
  const geometry = feature.geometry;
  if (!isObject(geometry) || !Array.isArray(geometry.coordinates)) return null;
  const [lon, lat] = geometry.coordinates;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}

function readIdentifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readNonEmptyString(value);
}

function isDiscoveryRecord(value: StationDiscoveryRecord | null): value is StationDiscoveryRecord {
  return value !== null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCoordinateInBounds(lat: number, lon: number, bounds: ViewportBounds): boolean {
  const south = Math.min(bounds.south, bounds.north);
  const north = Math.max(bounds.south, bounds.north);
  if (lat < south || lat > north) return false;

  const west = normalizeLongitude(bounds.west);
  const east = normalizeLongitude(bounds.east);
  const normalizedLon = normalizeLongitude(lon);
  return west <= east
    ? normalizedLon >= west && normalizedLon <= east
    : normalizedLon >= west || normalizedLon <= east;
}

function normalizeLongitude(value: number): number {
  if (value < -180 || value > 180) {
    return ((((value + 180) % 360) + 360) % 360) - 180;
  }
  return value;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface UsgsDiscoverySite {
  readonly siteCode: string;
  readonly siteName: string;
  readonly coords: readonly [number, number];
  readonly values: StationValue[];
}
