import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { LayerStatus } from '../types/layer';
import { registry } from '../state/registry';
import { readBcwsPerimeters, type BcwsReadOptions } from '../util/bcws-perimeter-read';

type Envelope = readonly [number, number, number, number];
type Limits = Omit<BcwsReadOptions, 'endpoint' | 'bounds' | 'signal'>;
type SettledStatus = Extract<LayerStatus, 'ready' | 'degraded' | 'error' | 'no-data'>;
export interface BcwsCallerOptions {
  readonly endpoint: string;
  readonly limits: Limits;
  readonly coverage: Envelope;
  readonly fillPaint: NonNullable<maplibregl.FillLayerSpecification['paint']>;
  readonly linePaint: NonNullable<maplibregl.LineLayerSpecification['paint']>;
  readonly beforeId?: string;
}
export interface BcwsSourceSnapshot {
  readonly collection: FeatureCollection<Polygon | MultiPolygon>;
  readonly complete: boolean;
  readonly status: SettledStatus;
  readonly reason: 'answered' | 'off-coverage' | 'incomplete';
  readonly retrievedAt: number | null;
  readonly bounds: Envelope | null;
}
const KEY = 'bcws-fires';
const FILL = 'bcws-fires-fill';
const LINE = 'bcws-fires-line';

/** Static coverage exclusion only; not the dynamic K anchor or a Province mask. */
function queryBounds(map: maplibregl.Map, coverage: Envelope): Envelope | null {
  const view = map.getBounds();
  const west = view.getWest(); const east = view.getEast();
  const south = Math.max(view.getSouth(), coverage[1]);
  const north = Math.min(view.getNorth(), coverage[3]);
  if (![west, east, south, north].every(Number.isFinite)) throw new RangeError('Invalid BCWS view bounds.');
  if (south > north) return null;
  let width = east - west;
  if (width < 0) width += 360;
  if (width >= 360) return [coverage[0], south, coverage[2], north];
  if (width < 0) throw new RangeError('Invalid BCWS view width.');
  const start = ((west + 180) % 360 + 360) % 360 - 180;
  const end = start + width;
  const pieces = end <= 180 ? [[start, end]] : [[start, 180], [-180, end - 360]];
  for (const piece of pieces) {
    const left = Math.max(piece[0]!, coverage[0]);
    const right = Math.min(piece[1]!, coverage[2]);
    if (left <= right) return [left, south, right, north];
  }
  return null;
}

/**
 * Unregistered source caller. A future admitted declaration must supply limits
 * and presentation; this module chooses no resource budget or issuer palette.
 * Raw source dates remain initial-event fields, never observation/discovery dates.
 */
export function createBcwsCaller(options: BcwsCallerOptions): {
  activate(map: maplibregl.Map): Promise<void>;
  refresh(): Promise<void>;
  cancelActivation(): void;
  deactivate(): void;
  getSnapshot(): BcwsSourceSnapshot | null;
} {
  if (!options.coverage.every(Number.isFinite) || options.coverage[0] < -180 ||
      options.coverage[2] > 180 || options.coverage[0] > options.coverage[2] ||
      options.coverage[1] < -90 || options.coverage[3] > 90 ||
      options.coverage[1] > options.coverage[3]) throw new RangeError('Invalid BCWS coverage envelope.');
  let activeMap: maplibregl.Map | null = null;
  let controller: AbortController | null = null;
  let sequence = 0;
  let pending: Promise<void> | null = null;
  let snapshot: BcwsSourceSnapshot | null = null;
  const empty = (): FeatureCollection<Polygon | MultiPolygon> => ({ type: 'FeatureCollection', features: [] });
  function clearMap(map: maplibregl.Map): void {
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(KEY)) map.removeSource(KEY);
  }
  function cancelActivation(): void {
    sequence++;
    controller?.abort(); controller = null;
    pending = null;
  }
  function deactivate(): void {
    const map = activeMap;
    activeMap = null;
    cancelActivation();
    if (map) { map.off('moveend', onMove); clearMap(map); }
    snapshot = null;
    // The layer controller owns registry active membership, as for NIFC.
  }
  function publish(map: maplibregl.Map, value: BcwsSourceSnapshot): void {
    const source = map.getSource(KEY) as maplibregl.GeoJSONSource | undefined;
    if (value.collection.features.length === 0) clearMap(map);
    else {
      if (source) source.setData(value.collection);
      else map.addSource(KEY, { type: 'geojson', data: value.collection });
      const before = options.beforeId && map.getLayer(options.beforeId) ? options.beforeId : undefined;
      if (!map.getLayer(FILL)) map.addLayer({ id: FILL, type: 'fill', source: KEY, paint: options.fillPaint }, before);
      if (!map.getLayer(LINE)) map.addLayer({ id: LINE, type: 'line', source: KEY, paint: options.linePaint }, before);
    }
    snapshot = value;
    registry.setStatus(KEY, value.status);
  }
  async function read(map: maplibregl.Map, request: number, owner: AbortController): Promise<void> {
    const owns = (): boolean => activeMap === map && request === sequence && !owner.signal.aborted;
    let bounds: Envelope | null = null;
    try {
      bounds = queryBounds(map, options.coverage);
      if (!bounds) {
        if (owns()) publish(map, { collection: empty(), complete: true, status: 'no-data',
          reason: 'off-coverage', retrievedAt: null, bounds: null });
        return;
      }
      const result = await readBcwsPerimeters({ ...options.limits, endpoint: options.endpoint, bounds, signal: owner.signal });
      if (!owns()) return;
      // Missing source status is a schema failure; explicit null remains unknown.
      if (result.collection.features.some(feature => !feature.properties || !Object.hasOwn(feature.properties, 'FIRE_STATUS'))) {
        throw new Error('BCWS response missing FIRE_STATUS.');
      }
      const length = result.collection.features.length;
      const status: SettledStatus = result.complete ? length ? 'ready' : 'no-data' : length ? 'degraded' : 'error';
      publish(map, { collection: result.collection, complete: result.complete, status,
        reason: result.complete ? 'answered' : 'incomplete', retrievedAt: result.complete || length > 0 ? Date.now() : null, bounds });
    } catch {
      if (owns()) publish(map, { collection: empty(), complete: false, status: 'error',
        reason: 'incomplete', retrievedAt: null, bounds });
    } finally {
      if (activeMap === map && request === sequence) { controller = null; pending = null; }
    }
  }
  function refresh(): Promise<void> {
    const map = activeMap;
    if (!map) return Promise.resolve();
    cancelActivation();
    const owner = new AbortController(); controller = owner;
    const request = sequence;
    registry.setStatus(KEY, 'loading');
    const task = read(map, request, owner);
    pending = task;
    return task;
  }
  function onMove(): void { void refresh(); }
  function activate(map: maplibregl.Map): Promise<void> {
    if (activeMap === map) {
      if (controller && pending) return pending;
      if (snapshot?.complete && (snapshot.collection.features.length === 0 ||
          (map.getSource(KEY) && map.getLayer(FILL) && map.getLayer(LINE)))) {
        const current = queryBounds(map, options.coverage);
        if (JSON.stringify(current) === JSON.stringify(snapshot.bounds)) {
          registry.setStatus(KEY, snapshot.status); return Promise.resolve();
        }
      }
    } else {
      if (activeMap) deactivate();
      activeMap = map; map.on('moveend', onMove);
    }
    return refresh();
  }
  return { activate, refresh, cancelActivation, deactivate, getSnapshot: () => snapshot };
}
