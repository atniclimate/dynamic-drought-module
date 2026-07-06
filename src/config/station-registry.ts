import { TELEMETRY_STATIONS } from './telemetry';
import { URLS } from './urls';
import type { StationValue, TelemetryFreshness, TelemetryStation } from '../types/station';
import type {
  PrimaryParameterCategory,
  StationDiscoveryRecord,
  StationNetwork,
  StationNetworkHandles,
  StationNetworkKey,
  StationRegistryEntry,
  StationViewportDiscoveryResult,
  StationViewportDiscoveryRequest
} from '../types/station-network';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const PROXIMITY_MERGE_METERS = 100;
const EARTH_RADIUS_METERS = 6_371_000;
const USGS_DISCOVERY_TIMEOUT_MS = 8_000;
const USGS_BBOX_AREA_CAP = 25;
const USGS_EXTREME_AREA_FACTOR = 64;
const USGS_DISCOVERY_PARAMETER_CODES = '00060,00065';

type MutableStationNetworkHandles = {
  -readonly [K in keyof StationNetworkHandles]?: StationNetworkHandles[K];
};

const DISCOVERY_NOT_WIRED_ADAPTER = {
  toDiscoveryRecord: (_rawRecord: unknown): StationDiscoveryRecord | null => null
};

export const STATION_NETWORKS = [
  {
    key: 'usgs-iv',
    label: 'USGS Instantaneous Values',
    refreshWindowMs: 6 * HOUR_MS,
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'nrcs-awdb',
    label: 'NRCS AWDB SNOTEL and SCAN',
    refreshWindowMs: 2 * DAY_MS,
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'usace-cwms',
    label: 'USACE Corps Water Management System',
    refreshWindowMs: 6 * HOUR_MS,
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'usbr-hydromet',
    label: 'USBR Hydromet',
    refreshWindowMs: 2 * DAY_MS,
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  },
  {
    key: 'nwrfc',
    label: 'Northwest River Forecast Center',
    refreshWindowMs: DAY_MS,
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
  if (!queryBounds) return { status: 'zoom-in', records: [] };

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
    request.signal,
    USGS_DISCOVERY_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`USGS IV discovery HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return {
    status: 'ok',
    records: usgsDiscoveryRecordsFromPayload(payload),
    queriedBounds: queryBounds
  };
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

  return entries.findIndex(
    (entry) =>
      entry.primaryParameterCategory === record.primaryParameterCategory &&
      distanceMeters(entry.station.coords, record.station.coords) <= PROXIMITY_MERGE_METERS
  );
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
        : {})
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
  if (right.nwrfcId) merged.nwrfcId = right.nwrfcId;
  return merged;
}

function hasMatchingHandle(left: StationNetworkHandles, right: StationNetworkHandles): boolean {
  return (
    matches(left.usgsSite, right.usgsSite) ||
    matches(left.awdbStation, right.awdbStation) ||
    matches(left.cwmsTsId, right.cwmsTsId) ||
    matches(left.hydrometSite, right.hydrometSite) ||
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
  if (nwrfcIdForStation(station)) networks.push('nwrfc');
  return uniqueNetworks(networks);
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

function distanceMeters(
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface UsgsDiscoverySite {
  readonly siteCode: string;
  readonly siteName: string;
  readonly coords: readonly [number, number];
  readonly values: StationValue[];
}
