import { isObject } from '../util/guards';
import {
  NWS_CACHE_TTL,
  fetchNwsPointMetadata,
  type NwsPointMetadata,
  type NwsRequestSession
} from './nws-point';
import type {
  BoundarySelectionContext,
  PointHeatBriefing,
  PointHeatGridGuidance,
  PointHeatMetricKey,
  PointHeatMetricSeries,
  PointHeatObservation,
  PointHeatValue
} from './types';

const GRID_METRICS: ReadonlyArray<{
  readonly key: PointHeatMetricKey;
  readonly label: string;
}> = [
  { key: 'temperature', label: 'Temperature' },
  { key: 'maxTemperature', label: 'Maximum temperature' },
  { key: 'minTemperature', label: 'Minimum temperature' },
  { key: 'apparentTemperature', label: 'Apparent temperature' },
  { key: 'heatIndex', label: 'Heat index' },
  { key: 'wetBulbGlobeTemperature', label: 'Wet Bulb Globe Temperature' },
  { key: 'relativeHumidity', label: 'Relative humidity' }
];

const OBSERVATION_METRICS: ReadonlyArray<{
  readonly key: PointHeatMetricKey;
  readonly label: string;
}> = [
  { key: 'temperature', label: 'Temperature' },
  { key: 'relativeHumidity', label: 'Relative humidity' },
  { key: 'heatIndex', label: 'Heat index' }
];

const MAX_SERIES_VALUES = 24;

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function durationMilliseconds(duration: string): number | null {
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      duration
    );
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const milliseconds =
    (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function parseNwsValidTime(
  validTime: string
): { startTime: string; endTime?: string } | null {
  const [startTime, duration] = validTime.split('/');
  if (!startTime || !duration || !Number.isFinite(Date.parse(startTime))) {
    return null;
  }
  const length = durationMilliseconds(duration);
  if (length === null) return { startTime };
  return {
    startTime,
    endTime: new Date(Date.parse(startTime) + length).toISOString()
  };
}

function currentOrFuture(
  value: PointHeatValue,
  now: number
): boolean {
  const end = value.endTime ? Date.parse(value.endTime) : NaN;
  const start = Date.parse(value.startTime);
  return Number.isFinite(end)
    ? end > now
    : Number.isFinite(start) && start >= now;
}

function gridMetricSeries(
  payload: Readonly<Record<string, unknown>>,
  key: PointHeatMetricKey,
  label: string,
  now: number
): PointHeatMetricSeries | null {
  const property = payload[key];
  if (!isObject(property) || typeof property.uom !== 'string') return null;
  const rawValues = Array.isArray(property.values) ? property.values : [];
  const populated: PointHeatValue[] = [];
  for (const row of rawValues) {
    if (!isObject(row) || typeof row.validTime !== 'string') continue;
    const value = numeric(row.value);
    const interval = parseNwsValidTime(row.validTime);
    if (value === null || !interval) continue;
    const point: PointHeatValue = {
      value,
      unitCode: property.uom,
      validTime: row.validTime,
      ...interval
    };
    if (currentOrFuture(point, now)) populated.push(point);
  }
  populated.sort(
    (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)
  );
  if (populated.length === 0) return null;
  return {
    key,
    label,
    unitCode: property.uom,
    values: populated.slice(0, MAX_SERIES_VALUES),
    availableValueCount: populated.length
  };
}

function parseGridGuidance(
  payload: unknown,
  metadata: NwsPointMetadata,
  now: number
): PointHeatGridGuidance {
  if (!isObject(payload) || !isObject(payload.properties)) {
    throw new Error('invalid NWS grid payload');
  }
  const properties = payload.properties;
  const metrics = GRID_METRICS.map(({ key, label }) =>
    gridMetricSeries(properties, key, label, now)
  ).filter((metric): metric is PointHeatMetricSeries => metric !== null);
  const generatedAt =
    typeof properties.updateTime === 'string'
      ? properties.updateTime
      : typeof properties.generatedAt === 'string'
        ? properties.generatedAt
        : undefined;
  if (metrics.length === 0) {
    return {
      status: 'no-data',
      note:
        'NWS returned grid guidance, but none of the heat fields had a populated current or future interval.',
      ...(metadata.office ? { office: metadata.office } : {}),
      ...(metadata.gridId ? { gridId: metadata.gridId } : {}),
      ...(generatedAt ? { generatedAt } : {}),
      metrics: []
    };
  }
  return {
    status: 'ready',
    ...(metadata.office ? { office: metadata.office } : {}),
    ...(metadata.gridId ? { gridId: metadata.gridId } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    metrics
  };
}

function featureArray(payload: unknown): readonly unknown[] {
  return isObject(payload) && Array.isArray(payload.features)
    ? payload.features
    : [];
}

interface StationCandidate {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly lng: number;
  readonly lat: number;
  readonly distanceKm: number;
}

function haversineKm(
  from: { readonly lng: number; readonly lat: number },
  to: { readonly lng: number; readonly lat: number }
): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const fromLat = radians(from.lat);
  const toLat = radians(to.lat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestStation(
  payload: unknown,
  point: { readonly lng: number; readonly lat: number }
): StationCandidate | null {
  const candidates: StationCandidate[] = [];
  for (const feature of featureArray(payload)) {
    if (
      !isObject(feature) ||
      !isObject(feature.geometry) ||
      !Array.isArray(feature.geometry.coordinates) ||
      !isObject(feature.properties)
    ) {
      continue;
    }
    const lng = numeric(feature.geometry.coordinates[0]);
    const lat = numeric(feature.geometry.coordinates[1]);
    const id =
      typeof feature.properties.stationIdentifier === 'string'
        ? feature.properties.stationIdentifier
        : null;
    const url =
      typeof feature.properties['@id'] === 'string'
        ? feature.properties['@id']
        : null;
    if (lng === null || lat === null || !id || !url) continue;
    candidates.push({
      id,
      name:
        typeof feature.properties.name === 'string'
          ? feature.properties.name
          : id,
      url,
      lng,
      lat,
      distanceKm: haversineKm(point, { lng, lat })
    });
  }
  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates[0] ?? null;
}

function observationMetric(
  properties: Readonly<Record<string, unknown>>,
  key: PointHeatMetricKey,
  label: string,
  timestamp: string
): PointHeatMetricSeries | null {
  const property = properties[key];
  if (
    !isObject(property) ||
    typeof property.unitCode !== 'string'
  ) {
    return null;
  }
  const value = numeric(property.value);
  if (value === null) return null;
  return {
    key,
    label,
    unitCode: property.unitCode,
    values: [
      {
        value,
        unitCode: property.unitCode,
        validTime: timestamp,
        startTime: timestamp
      }
    ],
    availableValueCount: 1
  };
}

function parseObservation(
  payload: unknown,
  station: StationCandidate
): PointHeatObservation {
  if (!isObject(payload) || !isObject(payload.properties)) {
    throw new Error('invalid NWS observation payload');
  }
  const properties = payload.properties;
  const timestamp =
    typeof properties.timestamp === 'string'
      ? properties.timestamp
      : null;
  if (!timestamp) {
    return {
      status: 'no-data',
      note: 'The nearest NWS station returned no timestamped observation.',
      stationId: station.id,
      stationName: station.name,
      stationUrl: station.url,
      distanceKm: station.distanceKm,
      metrics: []
    };
  }
  const metrics = OBSERVATION_METRICS.map(({ key, label }) =>
    observationMetric(properties, key, label, timestamp)
  ).filter((metric): metric is PointHeatMetricSeries => metric !== null);
  if (metrics.length === 0) {
    return {
      status: 'no-data',
      note:
        'The nearest NWS station returned an observation, but the heat fields were empty.',
      stationId: station.id,
      stationName: station.name,
      stationUrl: station.url,
      distanceKm: station.distanceKm,
      timestamp,
      metrics: []
    };
  }
  return {
    status: 'ready',
    stationId: station.id,
    stationName: station.name,
    stationUrl: station.url,
    distanceKm: station.distanceKm,
    timestamp,
    metrics
  };
}

async function fetchGrid(
  metadata: NwsPointMetadata,
  session: NwsRequestSession,
  now: number
): Promise<PointHeatGridGuidance> {
  if (!metadata.forecastGridDataUrl) {
    return {
      status: 'no-data',
      note: 'NWS point discovery returned no grid-guidance link.',
      metrics: []
    };
  }
  try {
    const payload = await session.fetchJson(
      metadata.forecastGridDataUrl,
      NWS_CACHE_TTL.grid
    );
    return parseGridGuidance(payload, metadata, now);
  } catch (err) {
    if (session.signal.aborted) throw err;
    console.warn('[point-heat] NWS grid guidance failed.', err);
    return {
      status: 'error',
      note: 'The NWS grid-guidance source did not respond.',
      metrics: []
    };
  }
}

async function fetchObservation(
  metadata: NwsPointMetadata,
  point: { readonly lng: number; readonly lat: number },
  session: NwsRequestSession
): Promise<PointHeatObservation> {
  if (!metadata.observationStationsUrl) {
    return {
      status: 'no-data',
      note: 'NWS point discovery returned no observation-station link.',
      metrics: []
    };
  }
  try {
    const stations = await session.fetchJson(
      metadata.observationStationsUrl,
      NWS_CACHE_TTL.stations
    );
    const nearest = nearestStation(stations, point);
    if (!nearest) {
      return {
        status: 'no-data',
        note: 'NWS returned no usable observation station for this point.',
        metrics: []
      };
    }
    const latestUrl = `${nearest.url.replace(/\/$/, '')}/observations/latest`;
    const latest = await session.fetchJson(
      latestUrl,
      NWS_CACHE_TTL.observation
    );
    return parseObservation(latest, nearest);
  } catch (err) {
    if (session.signal.aborted) throw err;
    console.warn('[point-heat] NWS nearby observation failed.', err);
    return {
      status: 'error',
      note: 'The NWS nearby-observation source did not respond.',
      metrics: []
    };
  }
}

function overallStatus(
  observation: PointHeatObservation,
  grid: PointHeatGridGuidance
): PointHeatBriefing['status'] {
  const statuses = [observation.status, grid.status];
  const readyCount = statuses.filter((status) => status === 'ready').length;
  if (readyCount === 2) return 'ready';
  if (readyCount === 1) return 'degraded';
  if (statuses.every((status) => status === 'no-data')) return 'no-data';
  return 'error';
}

function overallNote(
  observation: PointHeatObservation,
  grid: PointHeatGridGuidance
): string | undefined {
  const notes = [observation.note, grid.note].filter(
    (note): note is string => typeof note === 'string' && note !== ''
  );
  return notes.length > 0 ? notes.join(' ') : undefined;
}

export async function fetchPointHeat(
  context: BoundarySelectionContext,
  session: NwsRequestSession,
  now: number = Date.now()
): Promise<PointHeatBriefing> {
  const point = { ...context.lngLat };
  try {
    const metadata = await fetchNwsPointMetadata(
      point.lng,
      point.lat,
      session
    );
    if (session.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const [observation, grid] = await Promise.all([
      fetchObservation(metadata, point, session),
      fetchGrid(metadata, session, now)
    ]);
    const note = overallNote(observation, grid);
    return {
      status: overallStatus(observation, grid),
      ...(note ? { note } : {}),
      point,
      observation,
      grid
    };
  } catch (err) {
    if (session.signal.aborted) throw err;
    console.warn('[point-heat] NWS point discovery failed.', err);
    const note = 'The NWS point source did not respond.';
    return {
      status: 'error',
      note,
      point,
      observation: { status: 'error', note, metrics: [] },
      grid: { status: 'error', note, metrics: [] }
    };
  }
}
