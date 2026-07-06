import { TELEMETRY_STATIONS } from './telemetry';
import type { StationValue, TelemetryFreshness, TelemetryStation } from '../types/station';
import type {
  PrimaryParameterCategory,
  StationDiscoveryRecord,
  StationNetwork,
  StationNetworkHandles,
  StationNetworkKey,
  StationRegistryEntry,
  StationViewportDiscoveryRequest
} from '../types/station-network';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const PROXIMITY_MERGE_METERS = 100;
const EARTH_RADIUS_METERS = 6_371_000;

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
  _request: StationViewportDiscoveryRequest
): Promise<readonly StationDiscoveryRecord[]> {
  return [];
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
