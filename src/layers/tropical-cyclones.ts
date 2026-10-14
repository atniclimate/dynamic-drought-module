/**
 * Active tropical cyclones (ENSO block B3; the owner's F2): the NOAA National
 * Hurricane Center and Central Pacific Hurricane Center forecast advisories
 * for the Atlantic, Eastern North Pacific and Central North Pacific, drawn in
 * the issuer's geometry and the issuer renderer's colours (DR-101).
 *
 * What it draws, bottom to top: the Forecast Cone as a light fill with the
 * renderer's red outline, the Forecast Track line, the Watch-Warning coast
 * lines in the renderer's four classes (an unrecognised code is neutral and
 * thin, never drawn as a warning), and the Forecast Points. The points
 * renderer draws picture icons rather than colours, so each point is a
 * neutral circle sized by its renderer class: the advisory's current position
 * (tau 0) filled, forecast positions hollow. Wind radii and the past track
 * are not drawn (a later block).
 *
 * The read and its six states are src/layers/tropical-read.ts. This module
 * owns the master controller (superseded on each activate, aborted on
 * deactivate and, while the first sweep is in flight, by the controller's
 * `LayerActivation.signal`), the generation check that keeps a late sweep off
 * the map, a re-read every 30 minutes while on (the issuer updates every 6
 * hours, every 3 hours near the coast), and the snapshot the map key reads.
 */

import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import type { LayerActivation } from '../config/layers';
import { URLS } from '../config/urls';
import {
  TROPICAL_CONE,
  TROPICAL_POINT_CLASSES,
  TROPICAL_POINT_INK,
  TROPICAL_POINT_PAPER,
  TROPICAL_POINT_UNKNOWN_RADIUS,
  TROPICAL_TRACK,
  TROPICAL_WW_CLASSES,
  TROPICAL_WW_UNKNOWN
} from '../config/tropical-presentation';
import { matchExpression } from '../config/style-expressions';
import { registerClickTarget } from '../map/interaction-coordinator';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import { registry } from '../state/registry';
import type { LayerStatus } from '../types/layer';
import { buildTropicalAreaPopupModel, buildTropicalPointPopupModel } from '../ui/tropical-popup';
import { linkAbort } from '../util/fetch';
import { readTropicalSweep, type TropicalState, type TropicalStorm, type TropicalSweep } from './tropical-read';

const LAYER_KEY = 'tropical-cyclones';
const SOURCE_ID = 'tropical-cyclones';
const CONE_FILL_ID = 'tropical-cyclones-cone-fill';
const CONE_LINE_ID = 'tropical-cyclones-cone-line';
const TRACK_ID = 'tropical-cyclones-track';
const WW_ID = 'tropical-cyclones-ww';
const POINTS_ID = 'tropical-cyclones-points';
const SNAPSHOT_EVENT = 'ddm:tropical-snapshot';
const SNAPSHOT_REQUEST_EVENT = 'ddm:tropical-snapshot-request';
const REFRESH_MS = 30 * 60 * 1000;
const SWEEP_REUSE_MS = 5 * 60 * 1000;

/** Fade targets for the sidebar's toggle transitions, in drawing order. */
export const fadeLayerIds = [CONE_FILL_ID, CONE_LINE_ID, TRACK_ID, WW_ID, POINTS_ID] as const;

const REGISTRY_STATUS: Readonly<Record<TropicalState, LayerStatus>> = {
  live: 'ready',
  'live (partial)': 'degraded',
  unavailable: 'error',
  'no data': 'no-data'
};

/** What the map key reads (src/ui/map-key.ts mirrors this shape). */
export interface TropicalSnapshot {
  readonly status: 'inactive' | 'loading' | TropicalState;
  readonly storms: readonly TropicalStorm[];
}

let master: AbortController | null = null;
let activeMap: maplibregl.Map | null = null;
let generation = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: TropicalSnapshot = { status: 'inactive', storms: [] };
let lastSweep: { readonly at: number; readonly result: TropicalSweep } | null = null;

function emit(next: TropicalSnapshot): void {
  snapshot = next;
  window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail: next }));
}

/** The key may load after this layer did: answer its request with the current state. */
function replaySnapshot(): void {
  window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail: snapshot }));
}

/** Whether a re-read is scheduled (tests: zero pending work after deactivate). */
export function pendingRefresh(): boolean {
  return refreshTimer !== null;
}

function clearRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

const part = (name: string): maplibregl.FilterSpecification => ['==', ['get', 'ddmPart'], name];

function ensureLayers(map: maplibregl.Map, data: FeatureCollection): void {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  } else {
    map.addSource(SOURCE_ID, { type: 'geojson', data, attribution: 'NOAA NHC and CPHC' });
  }
  const pointClass: maplibregl.ExpressionSpecification = ['concat', ['get', 'dvlbl'], ',', ['get', 'stormsrc']];
  const radius = matchExpression(pointClass, TROPICAL_POINT_CLASSES.map((c) => [c.key, c.radius] as const), TROPICAL_POINT_UNKNOWN_RADIUS);
  const wwColor = matchExpression(['get', 'tcww'], TROPICAL_WW_CLASSES.map((c) => [c.code, c.color] as const), TROPICAL_WW_UNKNOWN.color);
  const wwWidth = matchExpression(['get', 'tcww'], TROPICAL_WW_CLASSES.map((c) => [c.code, c.width] as const), TROPICAL_WW_UNKNOWN.width);
  const isNow: maplibregl.ExpressionSpecification = ['==', ['to-number', ['get', 'tau'], -1], 0];
  const specs: maplibregl.LayerSpecification[] = [
    { id: CONE_FILL_ID, type: 'fill', source: SOURCE_ID, filter: part('cone'), paint: { 'fill-color': TROPICAL_CONE.fill, 'fill-opacity': TROPICAL_CONE.fillOpacity } },
    { id: CONE_LINE_ID, type: 'line', source: SOURCE_ID, filter: part('cone'), paint: { 'line-color': TROPICAL_CONE.outline, 'line-width': TROPICAL_CONE.outlineWidth } },
    { id: TRACK_ID, type: 'line', source: SOURCE_ID, filter: part('track'), paint: { 'line-color': TROPICAL_TRACK.color, 'line-width': TROPICAL_TRACK.width } },
    { id: WW_ID, type: 'line', source: SOURCE_ID, filter: part('ww'), layout: { 'line-cap': 'round' }, paint: { 'line-color': wwColor, 'line-width': wwWidth } },
    {
      id: POINTS_ID,
      type: 'circle',
      source: SOURCE_ID,
      filter: part('points'),
      paint: {
        'circle-radius': radius,
        // Later positions are hollow: a white fill read as solid over the SST raster.
        'circle-color': ['case', isNow, TROPICAL_POINT_INK, 'rgba(255,255,255,0)'],
        'circle-stroke-color': ['case', isNow, TROPICAL_POINT_PAPER, TROPICAL_POINT_INK],
        'circle-stroke-width': 1.5
      }
    }
  ];
  const missing = specs.filter((spec) => !map.getLayer(spec.id));
  for (const spec of missing) map.addLayer(spec);
  // A storm found by a later re-read adds layers outside the controller's
  // activation, so seat them in the ruled chain here (EVENT_OVERLAY_IDS).
  if (missing.length > 0) {
    reassertThematicOrder(map);
    reassertLabelOrder(map);
  }
}

function clearDrawn(map: maplibregl.Map): void {
  (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
}

async function sweep(map: maplibregl.Map, signal: AbortSignal, first: boolean): Promise<void> {
  const mine = ++generation;
  // Flipping modes re-enters within minutes; the issuer updates every 3 to 6 hours, so a young sweep is drawn again as it was read.
  const reused = first && lastSweep !== null && Date.now() - lastSweep.at < SWEEP_REUSE_MS ? lastSweep.result : null;
  if (first && reused === null) {
    registry.setStatus(LAYER_KEY, 'loading');
    emit({ status: 'loading', storms: [] });
  }
  const result = reused ?? (await readTropicalSweep(URLS.nhcTropicalMapServer, signal));
  // A late answer: superseded, deactivated, or the map changed under it.
  if (result === null || signal.aborted || mine !== generation || activeMap !== map) return;
  // Only a complete answer is reused; a partial one is read again on re-entry.
  if (reused === null) lastSweep = result.state === 'live' || result.state === 'no data' ? { at: Date.now(), result } : null;
  if (result.problems.length > 0) console.warn('[tropical-cyclones] read problems:', result.problems);
  if (result.features.length > 0) ensureLayers(map, { type: 'FeatureCollection', features: [...result.features] });
  else clearDrawn(map);
  // The key reads the storms from the snapshot and the state from the registry: snapshot first.
  emit({ status: result.state, storms: result.storms });
  registry.setStatus(LAYER_KEY, REGISTRY_STATUS[result.state]);
  clearRefresh();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (!signal.aborted && activeMap === map) void sweep(map, signal, false);
  }, REFRESH_MS);
}

export async function activate(map: maplibregl.Map, activation?: LayerActivation): Promise<void> {
  if (activeMap === map && master && !master.signal.aborted) return;
  master?.abort();
  master = new AbortController();
  const signal = master.signal;
  // The controller's off intent aborts the first sweep at that moment (plan rule 5).
  const unlink = linkAbort(master, activation?.signal ?? null);
  activeMap = map;
  clearRefresh();
  window.removeEventListener(SNAPSHOT_REQUEST_EVENT, replaySnapshot);
  window.addEventListener(SNAPSHOT_REQUEST_EVENT, replaySnapshot);
  try {
    await sweep(map, signal, true);
  } finally {
    unlink();
  }
}

export function deactivate(map: maplibregl.Map): void {
  master?.abort();
  master = null;
  generation += 1;
  clearRefresh();
  for (const id of [...fadeLayerIds].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  window.removeEventListener(SNAPSHOT_REQUEST_EVENT, replaySnapshot);
  activeMap = null;
  emit({ status: 'inactive', storms: [] });
}

export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'point-event',
    layerIds: [POINTS_ID, WW_ID, CONE_FILL_ID],
    label: (feature) => {
      // The popup's title (the points layer's classification and name) names the target too.
      const name = feature.properties?.['ddmTitle'] ?? feature.properties?.['stormname'];
      return typeof name === 'string' && name.trim() !== '' ? name : 'Tropical cyclone';
    },
    respond: (feature) => ({
      model:
        feature.layer.id === POINTS_ID
          ? buildTropicalPointPopupModel(feature.properties ?? null)
          : buildTropicalAreaPopupModel(feature.properties ?? null)
    })
  });
  for (const id of [POINTS_ID, WW_ID, CONE_FILL_ID]) {
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}
