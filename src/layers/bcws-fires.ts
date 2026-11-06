/**
 * BC Wildfire Service "Fire Perimeters - Current - View" (the BC Data
 * Catalogue's "BC Wildfire Fire Perimeters - Current"), beside the NIFC
 * perimeters in the Wildfire mode.
 *
 * Source: services6.arcgis.com/ubm4tcTYICKBpist, BCWS_FirePerimeters_PublicView
 * FeatureServer layer 0, no key, `Access-Control-Allow-Origin: *` (verified
 * 2026-11-06 with the deploy Origin; errors arrive as HTTP 200 envelopes).
 * The layer holds the whole fire season until April 1, active and Out alike,
 * British Columbia only; the issuer says it is "refreshed from operational
 * systems every 15 min". Licence: Open Government Licence - British Columbia
 * (the acknowledgements carry its attribution sentence).
 *
 * Viewport scope (DDM-P1-T06, nifc-fires.ts's pattern): each read asks for
 * the overscanned envelope of the view, cut to the Province's box; an
 * ordinary pan inside the answered envelope reuses it with no request for
 * five minutes; a `moveend` that leaves it re-queries after a 400 ms
 * debounce; a re-query that fails keeps the last answer's status while that
 * answer still covers the view, else reads unavailable. Every read is the
 * bounded, reload-bracketed read of src/util/bcws-perimeter-read.ts: one
 * page (a view that needs a second reads live (partial)), never complete
 * when a reload overlapped it. A failed read is unavailable, never zero.
 *
 * Where a BC and a NIFC perimeter overlap they are one fire area
 * (src/layers/fire-areas.ts): drawn once, as the union outline over both,
 * and answered by one popup listing each agency's own record.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

import type { LayerStatus } from '../types/layer';
import { URLS } from '../config/urls';
import {
  BCWS_STAGE_CLASS_PROPERTY,
  BCWS_STATUS_PRESENTATION,
  FIRE_FOOTPRINT_PRESENTATION,
  bcwsStatusClass,
  buildBcwsFillPaint,
  buildBcwsLinePaint
} from '../config/wildfire-presentation';
import { registerClickTarget } from '../map/interaction-coordinator';
import { assembleSections } from '../map/response-sections';
import { getPerimeterSnapshot, onPerimeterSnapshotChange } from '../state/fire-perimeter-snapshot';
import { registry } from '../state/registry';
import { hideLegend, LEGEND_ORDER, renderSwatchLegend, showLegend } from '../ui/legend-registry';
import type { GroupInput } from '../ui/popup-frame';
import { buildQueryEnvelope, envelopeCovers, toCoverageEnvelope } from '../util/bbox';
import { BCWS_COVERAGE, BCWS_READ_LIMITS, readBcwsPerimeters, type BcwsReadOptions } from '../util/bcws-perimeter-read';
import { groupPerimetersInWorker } from '../util/perimeter-job-client';
import {
  FIRE_AREA_JOB_DEADLINE_MS,
  FIRE_AREA_JOB_LIMITS,
  NO_FIRE_AREAS,
  fireRecordKey,
  groupFireAreas,
  type FireAreaState
} from './fire-areas';
import { buildBcwsPopupModel, buildFireAreaGroupInput } from './fire-records';

type Envelope = readonly [number, number, number, number];
type Limits = Omit<BcwsReadOptions, 'endpoint' | 'bounds' | 'signal' | 'where'>;
type SettledStatus = Extract<LayerStatus, 'ready' | 'degraded' | 'error' | 'no-data'>;
export interface BcwsCallerOptions {
  readonly endpoint: string;
  readonly limits: Limits;
  readonly coverage: Envelope;
  readonly fillPaint: NonNullable<maplibregl.FillLayerSpecification['paint']>;
  readonly linePaint: NonNullable<maplibregl.LineLayerSpecification['paint']>;
  readonly beforeId?: string;
  /** Debounce for the while-active viewport refresh (nifc-fires.ts REFRESH_DEBOUNCE_MS). */
  readonly refreshDebounceMs?: number;
  /** How long a covering answer is reused without a request (nifc-fires.ts CURRENT_CHECK_WINDOW_MS). */
  readonly reuseMs?: number;
  /** Told after every publish, so the module can draw what follows from it. */
  readonly onPublish?: (map: maplibregl.Map, snapshot: BcwsSourceSnapshot) => void;
}
export interface BcwsSourceSnapshot {
  readonly collection: FeatureCollection<Polygon | MultiPolygon>;
  readonly complete: boolean;
  readonly status: SettledStatus;
  readonly reason: 'answered' | 'off-coverage' | 'incomplete';
  readonly retrievedAt: number | null;
  /** The bounds the service was asked for (the envelope cut to the coverage), or null when nothing was asked. */
  readonly bounds: Envelope | null;
  /** The view envelope this answer covers (its query envelope shrunk one quantum), or null for a failed read. */
  readonly coverage: Envelope | null;
}
const KEY = 'bcws-fires';
const FILL = 'bcws-fires-fill';
const LINE = 'bcws-fires-line';

/**
 * The DDM-P1-T06 query envelope for the view, cut to the static coverage
 * box: `query` is what the service is asked for (null when the envelope
 * misses the coverage), `coverage` what the answer then covers. Only the
 * coverage box is applied, not a Province outline.
 */
function queryEnvelope(map: maplibregl.Map, coverage: Envelope): { query: Envelope | null; coverage: Envelope } {
  const view = map.getBounds();
  const viewWest = view.getWest();
  // An encoded crossing (east below west) is unwrapped before the overscan, which assumes east >= west.
  const viewEast = view.getEast() < viewWest ? view.getEast() + 360 : view.getEast();
  const envelope = buildQueryEnvelope({
    getWest: () => viewWest,
    getSouth: () => view.getSouth(),
    getEast: () => viewEast,
    getNorth: () => view.getNorth()
  });
  const [west, , east] = envelope;
  const south = Math.max(envelope[1], coverage[1]);
  const north = Math.min(envelope[3], coverage[3]);
  if (![west, east, south, north].every(Number.isFinite)) throw new RangeError('Invalid BCWS view bounds.');
  const covered = toCoverageEnvelope(envelope);
  if (south > north) return { query: null, coverage: covered };
  let width = east - west;
  if (width < 0) width += 360;
  if (width >= 360) return { query: [coverage[0], south, coverage[2], north], coverage: covered };
  if (width < 0) throw new RangeError('Invalid BCWS view width.');
  const start = ((west + 180) % 360 + 360) % 360 - 180;
  const end = start + width;
  const pieces = end <= 180 ? [[start, end]] : [[start, 180], [-180, end - 360]];
  for (const piece of pieces) {
    const left = Math.max(piece[0]!, coverage[0]);
    const right = Math.min(piece[1]!, coverage[2]);
    if (left <= right) return { query: [left, south, right, north], coverage: covered };
  }
  return { query: null, coverage: covered };
}

/** The map source's copy: each feature carries its stage class beside the raw record. */
function withStageClass(collection: FeatureCollection<Polygon | MultiPolygon>): FeatureCollection<Polygon | MultiPolygon> {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, [BCWS_STAGE_CLASS_PROPERTY]: bcwsStatusClass(feature.properties?.['FIRE_STATUS']) }
    }))
  };
}

/**
 * The BC source caller: one owner per map, its own cancellation, the
 * envelope cache and the debounced refresh. Raw source dates remain the
 * issuer's own fields, never observation or discovery dates.
 */
export function createBcwsCaller(options: BcwsCallerOptions): {
  activate(map: maplibregl.Map): Promise<void>;
  refresh(): Promise<void>;
  cancelActivation(): void;
  deactivate(): void;
  getSnapshot(): BcwsSourceSnapshot | null;
  getMap(): maplibregl.Map | null;
} {
  if (!options.coverage.every(Number.isFinite) || options.coverage[0] < -180 ||
      options.coverage[2] > 180 || options.coverage[0] > options.coverage[2] ||
      options.coverage[1] < -90 || options.coverage[3] > 90 ||
      options.coverage[1] > options.coverage[3]) throw new RangeError('Invalid BCWS coverage envelope.');
  const debounceMs = options.refreshDebounceMs ?? 400;
  const reuseMs = options.reuseMs ?? 5 * 60_000;
  let activeMap: maplibregl.Map | null = null;
  let controller: AbortController | null = null;
  let sequence = 0;
  let pending: Promise<void> | null = null;
  let snapshot: BcwsSourceSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const empty = (): FeatureCollection<Polygon | MultiPolygon> => ({ type: 'FeatureCollection', features: [] });
  function clearMap(map: maplibregl.Map): void {
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(KEY)) map.removeSource(KEY);
  }
  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function cancelActivation(): void {
    sequence++;
    controller?.abort(); controller = null;
    pending = null;
    clearTimer();
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
      const data = withStageClass(value.collection);
      if (source) source.setData(data);
      else map.addSource(KEY, { type: 'geojson', data, attribution: 'BC Wildfire Service' });
      const before = options.beforeId && map.getLayer(options.beforeId) ? options.beforeId : undefined;
      if (!map.getLayer(FILL)) map.addLayer({ id: FILL, type: 'fill', source: KEY, paint: options.fillPaint }, before);
      if (!map.getLayer(LINE)) map.addLayer({ id: LINE, type: 'line', source: KEY, paint: options.linePaint }, before);
    }
    snapshot = value;
    registry.setStatus(KEY, value.status);
    options.onPublish?.(map, value);
  }
  /** Whether the held answer still covers the view and is fresh enough to stand without a request. */
  function reusable(map: maplibregl.Map): boolean {
    return (
      snapshot !== null && snapshot.complete && snapshot.coverage !== null &&
      envelopeCovers(snapshot.coverage, map.getBounds()) &&
      (snapshot.retrievedAt === null || Date.now() - snapshot.retrievedAt < reuseMs) &&
      (snapshot.collection.features.length === 0 || Boolean(map.getSource(KEY) && map.getLayer(FILL) && map.getLayer(LINE)))
    );
  }
  async function read(map: maplibregl.Map, request: number, owner: AbortController): Promise<void> {
    const owns = (): boolean => activeMap === map && request === sequence && !owner.signal.aborted;
    const previous = snapshot;
    let envelope: { query: Envelope | null; coverage: Envelope } | null = null;
    try {
      envelope = queryEnvelope(map, options.coverage);
      if (!envelope.query) {
        if (owns()) publish(map, { collection: empty(), complete: true, status: 'no-data',
          reason: 'off-coverage', retrievedAt: null, bounds: null, coverage: envelope.coverage });
        return;
      }
      const bounds = envelope.query;
      const result = await readBcwsPerimeters({ ...options.limits, endpoint: options.endpoint, bounds, signal: owner.signal });
      if (!owns()) return;
      // Missing source status is a schema failure; explicit null remains unknown.
      if (result.collection.features.some(feature => !feature.properties || !Object.hasOwn(feature.properties, 'FIRE_STATUS'))) {
        throw new Error('BCWS response missing FIRE_STATUS.');
      }
      const length = result.collection.features.length;
      // An incomplete read with nothing in hand is a failed read, never "no perimeters".
      if (!result.complete && length === 0) throw new Error('BCWS read did not complete.');
      const status: SettledStatus = result.complete ? length ? 'ready' : 'no-data' : 'degraded';
      publish(map, { collection: result.collection, complete: result.complete, status,
        reason: result.complete ? 'answered' : 'incomplete', retrievedAt: Date.now(),
        bounds, coverage: result.complete ? envelope.coverage : null });
    } catch {
      if (!owns()) return;
      // DDM-P1-T06 clause 4: an answer that still covers the view keeps its honest status.
      if (previous?.complete && previous.coverage && envelopeCovers(previous.coverage, map.getBounds()) &&
          (previous.collection.features.length === 0 || map.getSource(KEY))) {
        snapshot = previous;
        registry.setStatus(KEY, previous.status);
        return;
      }
      publish(map, { collection: empty(), complete: false, status: 'error',
        reason: 'incomplete', retrievedAt: null, bounds: envelope?.query ?? null, coverage: null });
    } finally {
      if (activeMap === map && request === sequence) { controller = null; pending = null; }
    }
  }
  function refresh(): Promise<void> {
    const map = activeMap;
    if (!map) return Promise.resolve();
    cancelActivation();
    if (reusable(map)) {
      registry.setStatus(KEY, snapshot!.status);
      return Promise.resolve();
    }
    const owner = new AbortController(); controller = owner;
    const request = sequence;
    registry.setStatus(KEY, 'loading');
    const task = read(map, request, owner);
    pending = task;
    return task;
  }
  function onMove(): void {
    clearTimer();
    timer = setTimeout(() => { timer = null; void refresh(); }, debounceMs);
  }
  function activate(map: maplibregl.Map): Promise<void> {
    if (activeMap === map) {
      if (controller && pending) return pending;
    } else {
      if (activeMap) deactivate();
      activeMap = map; map.on('moveend', onMove);
    }
    return refresh();
  }
  return { activate, refresh, cancelActivation, deactivate, getSnapshot: () => snapshot, getMap: () => activeMap };
}

// ---------------------------------------------------------------------------
// The registered layer (LayerModule contract, src/config/layers.ts)
// ---------------------------------------------------------------------------

const FOOTPRINT_SOURCE = 'fire-footprints';
const FOOTPRINT_FILL = 'fire-footprints-fill';
const FOOTPRINT_LINE = 'fire-footprints-line';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [FILL, LINE] as const;

let areas: FireAreaState = NO_FIRE_AREAS;
let groupingController: AbortController | null = null;
let groupingGeneration = 0;
let unsubscribeNifc: (() => void) | null = null;

const caller = createBcwsCaller({
  endpoint: `${URLS.bcwsFirePerimeters}/query`,
  limits: BCWS_READ_LIMITS,
  coverage: BCWS_COVERAGE,
  fillPaint: buildBcwsFillPaint(),
  linePaint: buildBcwsLinePaint(),
  beforeId: 'first-symbol',
  onPublish(map, snapshot) {
    if (snapshot.collection.features.length > 0) {
      showBcwsLegend();
      // A refresh after an empty answer adds the layers again; seat them in the chain.
      reorder(map);
    } else hideLegend(KEY);
    scheduleGrouping(map);
  }
});

function showBcwsLegend(): void {
  showLegend(KEY, {
    order: LEGEND_ORDER.event + 2,
    render: (body) =>
      renderSwatchLegend(
        body,
        // DRAFT wording (DR-177)
        'BC Wildfire Service current perimeters',
        (['active', 'inactive', 'unknown'] as const).map((cls) => ({
          color: BCWS_STATUS_PRESENTATION[cls].lineColor,
          label: BCWS_STATUS_PRESENTATION[cls].legendLabel
        }))
      )
  });
}

function clearFootprints(map: maplibregl.Map | null): void {
  if (!map) return;
  if (map.getLayer(FOOTPRINT_LINE)) map.removeLayer(FOOTPRINT_LINE);
  if (map.getLayer(FOOTPRINT_FILL)) map.removeLayer(FOOTPRINT_FILL);
  if (map.getSource(FOOTPRINT_SOURCE)) map.removeSource(FOOTPRINT_SOURCE);
}

/** Draw each fire area once: a clear fill that answers the click, and the union outline over both agencies' lines. */
function drawFootprints(map: maplibregl.Map, state: FireAreaState): void {
  if (state.areas.length === 0) {
    clearFootprints(map);
    return;
  }
  const data: FeatureCollection<MultiPolygon> = {
    type: 'FeatureCollection',
    features: state.areas.map((area): Feature<MultiPolygon> => ({
      type: 'Feature',
      // `members` (record keys, comma-joined) lets the conditions strip count the area once from what is rendered.
      properties: {
        footprint: area.key,
        outlined: area.outlined,
        members: [...new Set(area.members.flatMap((m) => fireRecordKey(m.issuer, m.properties) ?? []))].join(',')
      },
      geometry: { type: 'MultiPolygon', coordinates: area.coordinates }
    }))
  };
  const source = map.getSource(FOOTPRINT_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(FOOTPRINT_SOURCE, { type: 'geojson', data });
  const before = map.getLayer('first-symbol') ? 'first-symbol' : undefined;
  if (!map.getLayer(FOOTPRINT_FILL)) {
    map.addLayer({ id: FOOTPRINT_FILL, type: 'fill', source: FOOTPRINT_SOURCE, paint: { 'fill-color': FIRE_FOOTPRINT_PRESENTATION.lineColor, 'fill-opacity': 0 } }, before);
  }
  if (!map.getLayer(FOOTPRINT_LINE)) {
    map.addLayer({
      id: FOOTPRINT_LINE,
      type: 'line',
      source: FOOTPRINT_SOURCE,
      filter: ['==', ['get', 'outlined'], true],
      paint: {
        'line-color': FIRE_FOOTPRINT_PRESENTATION.lineColor,
        'line-opacity': FIRE_FOOTPRINT_PRESENTATION.lineOpacity,
        'line-width': FIRE_FOOTPRINT_PRESENTATION.lineWidth
      }
    }, before);
  }
}

/** Regroup after either agency's loaded perimeters change; a newer request supersedes an older one. */
function scheduleGrouping(map: maplibregl.Map): void {
  groupingController?.abort();
  groupingController = null;
  const generation = ++groupingGeneration;
  const bc = caller.getSnapshot()?.collection.features ?? [];
  const nifc = getPerimeterSnapshot().collection?.features ?? [];
  if (bc.length === 0 || nifc.length === 0) {
    areas = NO_FIRE_AREAS;
    clearFootprints(map);
    return;
  }
  const owner = new AbortController();
  groupingController = owner;
  // The drawn areas keep answering (by their stable record keys) until the new grouping lands.
  areas = { ...areas, status: 'pending' };
  void groupFireAreas(bc, nifc, (sourceJson) =>
    groupPerimetersInWorker(sourceJson, { signal: owner.signal, generation, deadlineMs: FIRE_AREA_JOB_DEADLINE_MS, limits: FIRE_AREA_JOB_LIMITS })
  ).then(
    (state) => {
      if (generation !== groupingGeneration || caller.getMap() !== map) return;
      groupingController = null;
      areas = state;
      drawFootprints(map, state);
      reorder(map);
    },
    () => {
      if (generation !== groupingGeneration) return;
      groupingController = null;
      areas = { ...NO_FIRE_AREAS, status: 'unavailable' };
      clearFootprints(map);
    }
  );
}

/** Re-seat the thematic chain once the footprint layers join it (src/map/layer-order.ts). */
function reorder(map: maplibregl.Map): void {
  if (typeof map.getStyle !== 'function') return;
  void import('../map/layer-order').then(({ reassertThematicOrder }) => {
    if (caller.getMap() === map) reassertThematicOrder(map);
  });
}

export async function activate(map: maplibregl.Map): Promise<void> {
  unsubscribeNifc ??= onPerimeterSnapshotChange(() => {
    const active = caller.getMap();
    if (active) scheduleGrouping(active);
  });
  await caller.activate(map);
}

export function cancelActivation(): void {
  caller.cancelActivation();
  groupingController?.abort();
  groupingController = null;
  groupingGeneration++;
}

export function deactivate(map: maplibregl.Map): void {
  unsubscribeNifc?.();
  unsubscribeNifc = null;
  cancelActivation();
  caller.deactivate();
  areas = NO_FIRE_AREAS;
  clearFootprints(map);
  hideLegend(KEY);
}

/**
 * The layer's most recent answer, read-only, for the minimap and the
 * briefing (nifc-fires.ts `loadedNifcCollection`'s counterpart). `coverage`
 * is the view envelope a complete answer covers; null means it covers none.
 */
export function loadedBcwsCollection(): {
  readonly collection: FeatureCollection<Polygon | MultiPolygon>;
  readonly coverage: Envelope | null;
  readonly fetchedAt: number | null;
  readonly complete: boolean;
} | null {
  const snapshot = caller.getSnapshot();
  return snapshot
    ? { collection: snapshot.collection, coverage: snapshot.coverage, fetchedAt: snapshot.retrievedAt, complete: snapshot.complete }
    : null;
}

/** The current fire areas, read-only (the minimap, the briefing). */
export function fireAreas(): FireAreaState {
  return areas;
}

function areaInput(key: string): GroupInput | null {
  const area = areas.areas.find((candidate) => candidate.key === key);
  if (!area || areas.computedAt === null) return null;
  return buildFireAreaGroupInput(key, area.members, areas.computedAt, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', {
    nifc: null,
    bcws: caller.getSnapshot()?.retrievedAt ?? null
  });
}

const footprintKeyOf = (feature: maplibregl.MapGeoJSONFeature): string | null => {
  const key = feature.properties?.['footprint'];
  return typeof key === 'string' && key !== '' ? key : null;
};

export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [FILL],
    label: (feature) => `Fire Number ${String(feature.properties?.['FIRE_NUMBER'] ?? 'not stated')}`,
    respond: (feature) => {
      const recordKey = fireRecordKey('bcws', feature.properties ?? {});
      const unresolved = recordKey !== null && areas.unresolved.has(recordKey);
      return {
        model: buildBcwsPopupModel(feature.properties ?? {}, caller.getSnapshot()?.retrievedAt ?? null, feature.id,
          unresolved ? ['grouping-unavailable'] : [])
      };
    }
  });
  // One fire area under the click is one group; two or more are one collection in the same frame.
  registerClickTarget({
    kind: 'point-event',
    layerIds: [FOOTPRINT_FILL],
    // DRAFT wording (DR-177): the frame's group title without its count.
    label: (feature) => (footprintKeyOf(feature) === null ? null : 'Overlapping agency fire perimeters'),
    respond: (feature) => {
      const key = footprintKeyOf(feature);
      const group = key === null ? null : areaInput(key);
      return group ? { model: { kind: 'group', group } } : null;
    },
    group: {
      respond: (features) => {
        const sections = assembleSections(features, footprintKeyOf).flatMap((section) => areaInput(section.key) ?? []);
        const [first, second, ...rest] = sections;
        if (!first) return null;
        return second ? { model: { kind: 'collection', sections: [first, second, ...rest] } } : { model: { kind: 'group', group: first } };
      }
    }
  });
  for (const id of [FILL, FOOTPRINT_FILL]) {
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}
