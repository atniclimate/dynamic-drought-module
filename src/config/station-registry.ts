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
import { fetchBufferedWithBudget, fetchWithBudget } from '../util/fetch';
import { quantizeBbox } from '../util/bbox';
import { isObject } from '../util/guards';
import { ExpiringLruCache } from '../util/bounded-cache';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const PROXIMITY_MERGE_METERS = 100;
// Spatial-hash cell size for the proximity-merge fallback (#1). Chosen so one
// cell is at least PROXIMITY_MERGE_METERS (100 m) wide in BOTH latitude and
// longitude everywhere in the served domain (up to Alaska's ~71.5 deg N, where
// 0.004 deg of longitude is about 141 m), so the 3x3 cell neighborhood around a
// record always contains every entry within the 100 m merge radius. Cells are
// deliberately over-inclusive at lower latitudes; the exact haversine filter
// still runs, so over-inclusion costs a few extra checks, never correctness.
const PROXIMITY_GRID_CELL_DEG = 0.004;
const EARTH_RADIUS_METERS = 6_371_000;

/**
 * The handle fields that identify the same physical station across networks: a
 * discovered record and an entry are the same station when they share any one
 * of these values (note `cwmsOffice` is NOT here, since a shared office does not
 * identify a station, only a shared `cwmsTsId` does). The merge handle index
 * keys on exactly these fields (#1). Declared here, above
 * STATIC_TELEMETRY_STATION_REGISTRY, because that module-level merge call reads
 * it at load: a later `const` would sit in the temporal dead zone and crash boot.
 */
const HANDLE_MATCH_FIELDS: readonly (keyof StationNetworkHandles)[] = [
  'usgsSite',
  'awdbStation',
  'cwmsTsId',
  'hydrometSite',
  'rawsStationId',
  'noaaCoopsId',
  'agrimetSite',
  'cocorahsSid',
  'nwrfcId'
];
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
// Per-viewport discovery cache + RAWS zoom gate (#3). Quantizing the query
// bounds (same 0.25-degree step hydrography's HYDRO_CACHE uses) coalesces nearby
// pans onto one key, so USGS Instantaneous Values and NIFC RAWS are fetched once
// per quantized viewport instead of on every settled pan; the caches live for
// the session like HYDRO_CACHE (station existence is stable within a session;
// popup hydration still re-fetches live values on click). RAWS additionally
// skips entirely above the area cap, so a national or multi-state framing does
// not fire a NIFC envelope query for a layer that only reads at regional zoom.
const DISCOVERY_BBOX_QUANT = 0.25;
const RAWS_DISCOVERY_AREA_CAP = 100;
// The whole-layer discovery gate (0.7.0 H4; D-0.7.0-007). The binding
// physical limit is the USGS Instantaneous Values bBox rule: the RAW degree
// product (width times height, NO latitude weighting) may not exceed 25
// square degrees. Rather than clamping the query to a centered sub-window
// (which silently drops edge stations; the exact sin the 2026-07-09
// assessment caught), discovery is GATED: a viewport wider than this cap
// fires no discovery queries at all and the layer reads "zoom in to load"
// (the hydrography precedent). This also retires the cap note at region
// zoom, per the ruling.
const TELEMETRY_DISCOVERY_AREA_CAP_RAW_DEG = 25;

/** Marker dot colors by discovered network (0.7.0 H4: no on-canvas color
 * goes unlabeled; src/layers/telemetry.ts renders the legend key from
 * STATION_MARKER_LEGEND so the colors and their labels live in one place).
 * Curated seed stations keep their own per-station colors from
 * src/config/telemetry.ts; the legend carries a note for those. */
const STATION_MARKER_COLORS = {
  usgsIv: '#06b6d4',
  snotel: '#38bdf8',
  scan: '#84cc16',
  raws: '#ef4444',
  noaaCoops: '#2563eb',
  agrimet: '#f59e0b',
  cocorahs: '#22d3ee'
} as const;

export const STATION_MARKER_LEGEND: readonly {
  readonly color: string;
  readonly label: string;
}[] = [
  { color: STATION_MARKER_COLORS.usgsIv, label: 'USGS streamgage' },
  { color: STATION_MARKER_COLORS.snotel, label: 'NRCS SNOTEL snowpack' },
  { color: STATION_MARKER_COLORS.scan, label: 'NRCS SCAN soil climate' },
  { color: STATION_MARKER_COLORS.raws, label: 'NIFC RAWS fire weather' },
  { color: STATION_MARKER_COLORS.noaaCoops, label: 'NOAA tides and currents' },
  { color: STATION_MARKER_COLORS.agrimet, label: 'USBR AgriMet agriculture' },
  { color: STATION_MARKER_COLORS.cocorahs, label: 'CoCoRaHS precipitation' }
];
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
    label: 'Northwest River Forecast Center', // vocab-allow: verbatim agency name
    refreshWindowMs: DAY_MS,
    cadence: 'seasonal updates',
    adapter: DISCOVERY_NOT_WIRED_ADAPTER
  }
] as const satisfies readonly StationNetwork[];

export const STATIC_TELEMETRY_STATION_REGISTRY = mergeTelemetryStations(
  TELEMETRY_STATIONS,
  []
);

/** The `field:value` keys a handle bag contributes to the merge handle index. */
function handleMatchKeys(handles: StationNetworkHandles): string[] {
  const keys: string[] = [];
  for (const field of HANDLE_MATCH_FIELDS) {
    const value = handles[field];
    if (value !== undefined) keys.push(`${field}:${value}`);
  }
  return keys;
}

/** Spatial-hash cell key for a coordinate pair `[lng, lat]`. */
function proximityCellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / PROXIMITY_GRID_CELL_DEG)},${Math.floor(lng / PROXIMITY_GRID_CELL_DEG)}`;
}

/**
 * Merge curated seed stations with discovered records into one registry.
 *
 * Same result as a naive per-record double scan, but O(D) rather than O(D*N):
 * a handle index (`field:value` -> lowest entry index) replaces the handle
 * findIndex, and a spatial grid (cell -> entry indices) bounds the proximity
 * fallback to a 3x3 cell neighborhood (#1). The matching RULES are unchanged:
 * a shared handle wins over proximity; proximity requires the same parameter
 * category, a distance within PROXIMITY_MERGE_METERS, and no conflicting handle
 * of the same network; and ties resolve to the lowest entry index, exactly as
 * the previous `findIndex` did.
 */
export function mergeTelemetryStations(
  seeds: readonly TelemetryStation[],
  discovered: readonly StationDiscoveryRecord[]
): readonly StationRegistryEntry[] {
  const entries: StationRegistryEntry[] = [];
  // `field:value` -> lowest entry index carrying it (lowest preserves the old
  // findIndex-first semantics; never overwrite a lower index).
  const handleIndex = new Map<string, number>();
  // cell -> entry indices whose coords fall in that cell.
  const grid = new Map<string, number[]>();

  const indexHandles = (i: number, handles: StationNetworkHandles): void => {
    for (const key of handleMatchKeys(handles)) {
      if (!handleIndex.has(key)) handleIndex.set(key, i);
    }
  };
  const pushEntry = (entry: StationRegistryEntry): void => {
    const i = entries.length;
    entries.push(entry);
    indexHandles(i, entry.handles);
    // `TelemetryStation.coords` is [latitude, longitude] (see
    // src/config/telemetry.ts and `distanceMeters` below). FIRE-19: these
    // names were reversed here and in `findMergeTarget`. Both sites were
    // reversed identically, so the produced and consumed cell keys agreed and
    // no behavior changes with the rename; only the reader is no longer misled.
    const [lat, lng] = entry.station.coords;
    const cell = proximityCellKey(lat, lng);
    const bucket = grid.get(cell);
    if (bucket) bucket.push(i);
    else grid.set(cell, [i]);
  };

  for (const station of seeds) pushEntry(seedEntry(station));

  for (const record of discovered) {
    const matchIndex = findMergeTarget(entries, record, handleIndex, grid);
    if (matchIndex === -1) {
      pushEntry(discoveredEntry(record));
      continue;
    }

    const current = entries[matchIndex];
    if (!current) continue;
    const merged = mergeEntry(current, record);
    entries[matchIndex] = merged;
    // A merge can grow the entry's handle set; index the new keys. The coords
    // are taken from `current` (the base) and never change, so the grid bucket
    // stays valid without an update.
    indexHandles(matchIndex, merged.handles);
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

// Session caches keyed by quantized viewport (#3); see DISCOVERY_BBOX_QUANT.
//
// Bounded rather than plain Maps (ARCH-06). Each entry is a list of station
// metadata records for one quantized viewport, so entries are far smaller than
// the hydrography geometry cache and a wider pan history is cheap to keep:
// thirty-two quantized viewports. The time-to-live is shorter than the
// geometry cache's because station discovery decides which gauges exist for a
// viewport, and a gauge that comes online or goes offline mid-session should
// not stay hidden for hours.
const DISCOVERY_CACHE_MAX_ENTRIES = 32;
const DISCOVERY_CACHE_TTL_MS = 15 * MINUTE_MS;

const USGS_DISCOVERY_CACHE = new ExpiringLruCache<
  string,
  readonly StationDiscoveryRecord[]
>(DISCOVERY_CACHE_MAX_ENTRIES);
const RAWS_DISCOVERY_CACHE = new ExpiringLruCache<
  string,
  readonly StationDiscoveryRecord[]
>(DISCOVERY_CACHE_MAX_ENTRIES);

/** Quantized cache key for a viewport bbox (mirrors hydrography's HYDRO_CACHE). */
function discoveryCacheKey(bounds: ViewportBounds): string {
  return quantizeBbox(
    [bounds.south, bounds.west, bounds.north, bounds.east],
    DISCOVERY_BBOX_QUANT
  ).join(',');
}

/** Latitude-adjusted viewport area in square degrees (same math as the USGS gate). */
function viewportAreaDeg(
  bounds: ViewportBounds,
  center: StationViewportDiscoveryRequest['center']
): number {
  const width = Math.abs(bounds.east - bounds.west);
  const height = Math.abs(bounds.north - bounds.south);
  const latitudeFactor = Math.max(0.05, Math.abs(Math.cos(radians(center[0]))));
  return width * latitudeFactor * height;
}

/** USGS Instantaneous Values discovery, served from the per-viewport cache. */
async function discoverUsgsStationsCached(
  queryBounds: StationViewportDiscoveryRequest['bounds'],
  signal: AbortSignal | null
): Promise<readonly StationDiscoveryRecord[]> {
  const key = discoveryCacheKey(queryBounds);
  const cached = USGS_DISCOVERY_CACHE.get(key);
  if (cached) return cached;
  const records = await discoverUsgsStations(queryBounds, signal);
  USGS_DISCOVERY_CACHE.set(key, records, DISCOVERY_CACHE_TTL_MS);
  return records;
}

/** NIFC RAWS discovery, served from the per-viewport cache. */
async function discoverRawsStationsCached(
  bounds: StationViewportDiscoveryRequest['bounds'],
  signal: AbortSignal | null
): Promise<readonly StationDiscoveryRecord[]> {
  const key = discoveryCacheKey(bounds);
  const cached = RAWS_DISCOVERY_CACHE.get(key);
  if (cached) return cached;
  const records = await discoverRawsStations(bounds, signal);
  RAWS_DISCOVERY_CACHE.set(key, records, DISCOVERY_CACHE_TTL_MS);
  return records;
}

export async function discoverStationsForViewport(
  request: StationViewportDiscoveryRequest
): Promise<StationViewportDiscoveryResult> {
  // The whole-layer gate (0.7.0 H4; D-0.7.0-007): above the raw-degree area
  // cap no discovery source fires at all. The caller renders the curated
  // seeds and reports "zoom in to load"; there is nothing partial to hide.
  const rawWidth = Math.abs(request.bounds.east - request.bounds.west);
  const rawHeight = Math.abs(request.bounds.north - request.bounds.south);
  if (rawWidth * rawHeight > TELEMETRY_DISCOVERY_AREA_CAP_RAW_DEG) {
    return { status: 'zoom-in', records: [] };
  }

  const queryBounds = clampUsgsDiscoveryBounds(request.bounds, request.center);
  // RAWS reads only at regional zoom; skip its NIFC envelope query on a
  // national or multi-state framing rather than firing it every pan (#3).
  // (Below the 25-square-degree gate this always allows; kept as a belt.)
  const rawsAllowed =
    viewportAreaDeg(request.bounds, request.center) <= RAWS_DISCOVERY_AREA_CAP;

  // Every source runs through the same settle wrapper so a non-abort
  // failure is RECORDED, not swallowed (0.7.0 H4: the pill must say
  // "live (partial)" instead of an unqualified "live" when a source died).
  const sources: readonly {
    readonly label: string;
    readonly run: () => Promise<readonly StationDiscoveryRecord[]>;
  }[] = [
    ...(queryBounds
      ? [
          {
            label: 'USGS IV station discovery',
            run: () => discoverUsgsStationsCached(queryBounds, request.signal)
          }
        ]
      : []),
    { label: 'NRCS AWDB station discovery', run: () => discoverAwdbStations(request) },
    ...(rawsAllowed
      ? [
          {
            label: 'NIFC RAWS station discovery',
            run: () => discoverRawsStationsCached(request.bounds, request.signal)
          }
        ]
      : []),
    { label: 'NOAA CO-OPS station discovery', run: () => discoverCoopsStations(request) },
    { label: 'USBR AgriMet station discovery', run: () => discoverAgrimetStations(request) },
    { label: 'CoCoRaHS station discovery', run: () => discoverCocorahsStations(request) }
  ];

  const outcomes = await Promise.all(
    sources.map((source) =>
      settleDiscoverySource(source.label, source.run(), request.signal)
    )
  );

  const records = outcomes.flatMap((outcome) => outcome.records);
  const failedSources = outcomes
    .filter((outcome) => outcome.failed)
    .map((outcome) => outcome.label);
  // queryBounds is never null below the area gate; the belt remains for the
  // day the gate constant and the clamp constant drift apart.
  if (!queryBounds) return { status: 'zoom-in', records };

  return {
    status: 'ok',
    records,
    queriedBounds: queryBounds,
    failedSources
  };
}

interface DiscoverySourceOutcome {
  readonly label: string;
  readonly records: readonly StationDiscoveryRecord[];
  readonly failed: boolean;
}

/**
 * Await one discovery source, converting a non-abort failure into a
 * recorded outcome (warn once, keep the label) instead of a swallowed
 * empty array. Aborts still throw so a superseded viewport never renders.
 */
async function settleDiscoverySource(
  label: string,
  promise: Promise<readonly StationDiscoveryRecord[]>,
  signal: AbortSignal | null
): Promise<DiscoverySourceOutcome> {
  try {
    return { label, records: await promise, failed: false };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    console.warn(`[telemetry] ${label} failed.`, err);
    return { label, records: [], failed: true };
  }
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
  record: StationDiscoveryRecord,
  handleIndex: ReadonlyMap<string, number>,
  grid: ReadonlyMap<string, number[]>
): number {
  const recordHandles = mergeHandles(handlesForStation(record.station), record.handles);

  // Handle match: the lowest-index entry that shares any handle value with the
  // record (the handle index stores the lowest index per key, so the minimum
  // across the record's keys is the same entry `findIndex` would have found).
  let handleMatch = -1;
  for (const key of handleMatchKeys(recordHandles)) {
    const idx = handleIndex.get(key);
    if (idx !== undefined && (handleMatch === -1 || idx < handleMatch)) handleMatch = idx;
  }
  if (handleMatch !== -1) return handleMatch;

  // Proximity fallback is for cross-network co-location (one physical place
  // observed by two networks), NOT for two distinct stations of the same
  // network that happen to be within the merge radius. If the record and a
  // candidate carry conflicting handles of the same network (two different USGS
  // site codes, say), they are distinct stations and must not collapse into one
  // marker (adversarial-review finding, 2026-07-06).
  //
  // Only entries in the record's 3x3 cell neighborhood can be within the merge
  // radius (see PROXIMITY_GRID_CELL_DEG), so the grid bounds the scan. The
  // lowest passing index is returned, matching the old findIndex-first result.
  // [latitude, longitude], matching `pushEntry`'s cell key (FIRE-19).
  const [lat, lng] = record.station.coords;
  const baseLatCell = Math.floor(lat / PROXIMITY_GRID_CELL_DEG);
  const baseLngCell = Math.floor(lng / PROXIMITY_GRID_CELL_DEG);
  let proxMatch = -1;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const bucket = grid.get(`${baseLatCell + dLat},${baseLngCell + dLng}`);
      if (!bucket) continue;
      for (const i of bucket) {
        // Already have a lower-index match; a higher index cannot improve it.
        if (proxMatch !== -1 && i >= proxMatch) continue;
        const entry = entries[i];
        if (!entry) continue;
        if (
          entry.primaryParameterCategory === record.primaryParameterCategory &&
          distanceMeters(entry.station.coords, record.station.coords) <= PROXIMITY_MERGE_METERS &&
          !handlesConflict(entry.handles, recordHandles)
        ) {
          proxMatch = i;
        }
      }
    }
  }
  return proxMatch;
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
  // RAW degree product, no latitude weighting. The USGS limit is "the
  // product of the differences may not exceed 25 degrees" in raw degrees;
  // the earlier cosine-weighted area here was the H4 400's root cause (the
  // ~37-raw-square-degree Washington default view weighted to exactly 25.0
  // at latitude 47 and sailed through unclamped). The whole-layer area gate
  // in discoverStationsForViewport now stops wide viewports first; this
  // clamp remains as the belt behind it.
  const area = width * height;

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
        color: STATION_MARKER_COLORS.usgsIv,
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

// The four cache-backed source functions below no longer carry their own
// catch blocks: settleDiscoverySource records a non-abort failure at the
// orchestration level (0.7.0 H4), where it feeds the degraded pill instead
// of vanishing into a silent empty array.
async function discoverAwdbStations(
  request: StationViewportDiscoveryRequest
): Promise<readonly StationDiscoveryRecord[]> {
  const stations = await getAwdbStationCache(request.signal);
  if (request.signal?.aborted) return [];
  return stations
    .filter((station) => isCoordinateInBounds(station.latitude, station.longitude, request.bounds))
    .map(awdbDiscoveryRecord);
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
      color: station.network === 'SNTL' ? STATION_MARKER_COLORS.snotel : STATION_MARKER_COLORS.scan,
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
      color: STATION_MARKER_COLORS.raws,
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
  const stations = await getCoopsStationCache(request.signal);
  if (request.signal?.aborted) return [];
  return stations
    .filter((station) => isCoordinateInBounds(station.latitude, station.longitude, request.bounds))
    .map((station) => COOPS_STATION_ADAPTER.toDiscoveryRecord(station))
    .filter(isDiscoveryRecord);
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
      color: STATION_MARKER_COLORS.noaaCoops,
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
  const stations = await agrimetStationListCache.get(request.signal);
  if (request.signal?.aborted) return [];
  return stations
    .filter((station) =>
      isCoordinateInBounds(station.latitude, station.longitude, request.bounds)
    )
    .map((station) => AGRIMET_STATION_ADAPTER.toDiscoveryRecord(station))
    .filter(isDiscoveryRecord);
}

async function fetchAgrimetStationList(
  signal: AbortSignal
): Promise<readonly AgrimetStationMetadata[]> {
  // On an empty-proxy fork (a deployer who has not stood up the Worker),
  // building `${workerProxy}/proxy?...` would blind-fetch a relative `/proxy?`
  // that 404s. Match the guard in hydromet.ts and awdb.ts and report no
  // stations honestly instead (#17).
  if (URLS.workerProxy === '') return [];
  // The AgriMet origin sends no CORS header, so the request must go through the
  // Worker proxy (this exact AgriMet path is in the route table). The response is a
  // JavaScript data file (application/x-javascript), not JSON; read it as text
  // and extract the single-quoted string assigned to `agrimet_sites`.
  const proxied = `${URLS.workerProxy}/proxy?url=${encodeURIComponent(URLS.usbrAgrimetSitesJs)}`;
  const response = await fetchBufferedWithBudget(
    proxied,
    {},
    signal,
    AGRIMET_DISCOVERY_TIMEOUT_MS
  );
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
      color: STATION_MARKER_COLORS.agrimet,
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
  const stations = await cocorahsStationListCache.get(request.signal);
  if (request.signal?.aborted) return [];
  return stations
    .filter((station) =>
      isCoordinateInBounds(station.latitude, station.longitude, request.bounds)
    )
    .map((station) => COCORAHS_STATION_ADAPTER.toDiscoveryRecord(station))
    .filter(isDiscoveryRecord);
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
      color: STATION_MARKER_COLORS.cocorahs,
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
