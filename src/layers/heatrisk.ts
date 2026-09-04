/**
 * National Weather Service (NWS) HeatRisk layer (experimental product; E2).
 *
 * The Environmental Systems Research Institute (ESRI) ImageServer publishes
 * a time-aware mosaic of colorized HeatRisk classes. The service metadata
 * exposes only a time range, so this module reads the mosaic catalog's
 * `idp_validtime` field at every activation and offers exactly those
 * advertised granules. It never invents an intermediate date and never
 * omits the `time` parameter.
 *
 * Each selected frame is rendered through its own MapLibre source instance.
 * Replacing a selection first aborts the superseded controller, detaches its
 * honesty watcher, and removes its source. A late tile from the removed
 * source therefore has nowhere to render.
 *
 * SURFACE CONTINUITY ACROSS A DAY CHANGE (DDM-P8-T05). That teardown is
 * what keeps a superseded frame from painting, and it is deliberately kept:
 * holding the previous day's raster up while the new day's tiles arrive
 * would present a stale product under the new day's valid date, which is a
 * worse claim than an empty one. The cost is that the map carries no
 * surface for the length of the exportImage round trip, so the transition
 * must SAY so for exactly that long. Two statements cover it, and both are
 * released the moment the frame reaches a terminal verdict:
 *
 *   - the on-map loading indicator, held from the teardown until the tile
 *     watcher reports (`beginFrameLoad` / `endFrameLoad` below);
 *   - the frame event, which now announces `loading` at render time instead
 *     of `ready`, so the on-map key qualifies the scale it is showing
 *     rather than claiming a surface that has not painted.
 *
 * The watcher's request-completeness deadline bounds the loading state: it
 * always reports `ready`, `degraded` or `error` within
 * TILE_SUCCESS_DEADLINE_MS, so neither statement can outlive its fetch.
 */

import type * as maplibregl from 'maplibre-gl';

import { pointHasHeatRiskCoverage } from './heatrisk-coverage';
import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import {
  parseHeatRiskDayParam,
  syncHeatRiskDayParam
} from '../state/url';
import { hideLegend, LEGEND_ORDER, showLegend } from '../ui/legend-registry';
import { hideLoading, showLoading } from '../ui/overlay';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import {
  watchRasterTiles,
  type RasterTileWatch
} from '../util/raster-status';

const LAYER_KEY = 'heatrisk';
const SOURCE_ID_PREFIX = 'heatrisk-frame';
const LAYER_ID = 'heatrisk';

const FRAMES_EVENT = 'ddm:heatrisk-frames';
const DAY_SELECT_EVENT = 'ddm:heatrisk-day-select';

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

/** Per-call network budget for service metadata and catalog enumeration. */
const FETCH_TIMEOUT_MS = 10_000;
/** Maximum wait for a selected frame to produce positive tile evidence. */
const TILE_SUCCESS_DEADLINE_MS = 10_000;
/** The issuer contract is seven distinct daily periods. */
const DAILY_FRAME_MS = 24 * 60 * 60 * 1000;
const REQUIRED_FRAME_COUNT = 7;

type Status = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data';
type FrameEventStatus = Status | 'inactive';

interface HeatRiskFrame {
  readonly day: number;
  readonly validTime: number;
  readonly name: string;
}

interface FrameEventDetail {
  readonly status: FrameEventStatus;
  readonly frames: readonly HeatRiskFrame[];
  readonly selectedDay: number | null;
  readonly hasCoverage: boolean | null;
}

let masterController: AbortController | null = null;
let tileWatch: RasterTileWatch | null = null;
let activeMap: maplibregl.Map | null = null;
let activeSourceId: string | null = null;
let sourceGeneration = 0;
let frames: readonly HeatRiskFrame[] = [];
let selectedDay: number | null = null;
let currentHasCoverage: boolean | null = null;
let listeningForDaySelection = false;
let coverageMoveMap: maplibregl.Map | null = null;
/** The on-map loading-indicator token held across a frame render, or null
 * when no frame is in flight (DDM-P8-T05). */
let frameLoadToken: number | null = null;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Say on the map that a selected frame is loading, from the instant the
 * previous frame's source is torn down. Replaces any statement a
 * superseded frame was still making, so a rapid run through the day
 * selector leaves exactly one.
 */
function beginFrameLoad(): void {
  endFrameLoad();
  frameLoadToken = showLoading('Loading HeatRisk...');
}

/** Withdraw the loading statement. Idempotent; safe on every exit. */
function endFrameLoad(): void {
  hideLoading(frameLoadToken);
  frameLoadToken = null;
}

function emitFrames(status: FrameEventStatus): void {
  window.dispatchEvent(
    new CustomEvent<FrameEventDetail>(FRAMES_EVENT, {
      detail: { status, frames, selectedDay, hasCoverage: currentHasCoverage }
    })
  );
}

function replaceMasterController(): AbortSignal {
  masterController?.abort();
  masterController = new AbortController();
  return masterController.signal;
}

function mapCenterHasCoverage(map: maplibregl.Map): boolean {
  const center = map.getCenter();
  return pointHasHeatRiskCoverage(center.lng, center.lat);
}

function showCoverageNote(hasCoverage: boolean): void {
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) => {
      const title = document.createElement('h3');
      title.className = 'legend-section-title';
      title.textContent = 'HeatRisk coverage';
      const note = document.createElement('p');
      note.className = 'legend-note';
      note.textContent = hasCoverage
        ? 'National Weather Service HeatRisk covers the contiguous United States only.'
        : 'No HeatRisk data at the map center. National Weather Service HeatRisk covers the contiguous United States only.';
      body.append(title, note);
    }
  });
}

/** Read the complete advertised time range from the service metadata. */
function extractTimeExtent(json: unknown): readonly [number, number] | null {
  if (!isObject(json) || !isObject(json.timeInfo)) return null;
  const extent = json.timeInfo.timeExtent;
  if (!Array.isArray(extent) || extent.length !== 2) return null;
  const [start, end] = extent;
  if (
    typeof start !== 'number' ||
    !Number.isFinite(start) ||
    typeof end !== 'number' ||
    !Number.isFinite(end) ||
    start > end
  ) {
    return null;
  }
  return [start, end];
}

/**
 * Parse every distinct primary catalog granule. The returned day position
 * comes only from chronological order in this response.
 */
function extractFrames(
  json: unknown,
  extent: readonly [number, number]
): readonly HeatRiskFrame[] | null {
  if (
    !isObject(json) ||
    json.exceededTransferLimit === true ||
    !Array.isArray(json.features)
  ) {
    return null;
  }

  const byTime = new Map<number, string>();
  for (const feature of json.features) {
    if (!isObject(feature) || !isObject(feature.attributes)) return null;
    const validTime = feature.attributes.idp_validtime;
    const name = feature.attributes.name;
    if (
      typeof validTime !== 'number' ||
      !Number.isFinite(validTime) ||
      !Number.isSafeInteger(validTime) ||
      typeof name !== 'string' ||
      name.length === 0
    ) {
      return null;
    }
    if (byTime.has(validTime)) return null;
    byTime.set(validTime, name);
  }

  const advertised = Array.from(byTime, ([validTime, name]) => ({
    validTime,
    name
  })).sort((a, b) => a.validTime - b.validTime);

  if (
    advertised.length !== REQUIRED_FRAME_COUNT ||
    advertised[0]?.validTime !== extent[0] ||
    advertised.at(-1)?.validTime !== extent[1] ||
    advertised.some(
      (frame, index) =>
        index > 0 &&
        frame.validTime - advertised[index - 1]!.validTime !== DAILY_FRAME_MS
    )
  ) {
    return null;
  }

  return advertised.map((frame, index) => ({
    day: index + 1,
    validTime: frame.validTime,
    name: frame.name
  }));
}

function buildCatalogUrl(): string {
  const params = new URLSearchParams({
    where: 'category=1',
    outFields: 'name,idp_validtime',
    returnGeometry: 'false',
    orderByFields: 'idp_validtime ASC',
    f: 'json'
  });
  return `${URLS.nwsHeatRisk}/query?${params.toString()}`;
}

/** Build a tile template containing one exact catalog-advertised time. */
function buildImageTileTemplate(timeMs: number): string {
  const params = [
    'bbox={bbox-epsg-3857}',
    'bboxSR=3857',
    'imageSR=3857',
    'size=256,256',
    'format=png32',
    'transparent=true',
    `time=${timeMs}`,
    'f=image'
  ].join('&');
  return `${URLS.nwsHeatRisk}/exportImage?${params}`;
}

function removeActiveRaster(map: maplibregl.Map): void {
  tileWatch?.detach();
  tileWatch = null;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (activeSourceId && map.getSource(activeSourceId)) {
    map.removeSource(activeSourceId);
  }
  activeSourceId = null;
}

/**
 * Replace the displayed source with one exact advertised frame. Source IDs
 * are never reused, so a late response owned by the superseded source is
 * dropped by MapLibre after that source is removed.
 */
function renderFrame(map: maplibregl.Map, day: number): void {
  const frame = frames[day - 1];
  if (!frame) return;

  replaceMasterController();
  // The statement is opened BEFORE the teardown, so there is no instant
  // between losing the old surface and the new frame's first tile at which
  // the map is both blank and silent (DDM-P8-T05).
  beginFrameLoad();
  removeActiveRaster(map);

  selectedDay = day;
  syncHeatRiskDayParam(day);

  const hasCoverage = mapCenterHasCoverage(map);
  currentHasCoverage = hasCoverage;
  showCoverageNote(hasCoverage);
  if (!hasCoverage) {
    // A verified absence, not a pending fetch: withdraw the loading
    // statement in the same turn so the two never both stand.
    endFrameLoad();
    reportStatus('no-data');
    emitFrames('no-data');
    return;
  }

  reportStatus('loading');
  sourceGeneration += 1;
  const sourceId = `${SOURCE_ID_PREFIX}-${sourceGeneration}`;
  activeSourceId = sourceId;
  map.addSource(sourceId, {
    type: 'raster',
    tiles: [buildImageTileTemplate(frame.validTime)],
    tileSize: 256,
    attribution: 'NOAA NWS HeatRisk (experimental)'
  });
  map.addLayer({
    id: LAYER_ID,
    type: 'raster',
    source: sourceId,
    paint: {
      'raster-opacity': 0.55
    }
  });

  tileWatch = watchRasterTiles(
    map,
    sourceId,
    (state) => {
      // Every path through the watcher is a terminal verdict on this
      // frame, so every path also ends the loading statement.
      endFrameLoad();
      if (!mapCenterHasCoverage(map)) {
        currentHasCoverage = false;
        reportStatus('no-data');
        emitFrames('no-data');
        return;
      }
      currentHasCoverage = true;
      reportStatus(state);
      emitFrames(state);
    },
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: TILE_SUCCESS_DEADLINE_MS
    }
  );
  // The source is on the map but nothing has painted from it yet. The
  // frame event carried `ready` here until DDM-P8-T05, which made the
  // on-map key present an unpainted frame as live for the whole fetch;
  // `loading` is what is true, and the watcher above replaces it with the
  // real verdict.
  emitFrames('loading');
}

function onCoverageMoveEnd(): void {
  if (!activeMap || selectedDay === null || frames.length === 0) return;
  const hasCoverage = mapCenterHasCoverage(activeMap);
  currentHasCoverage = hasCoverage;
  showCoverageNote(hasCoverage);
  if (!hasCoverage) {
    masterController?.abort();
    masterController = null;
    endFrameLoad();
    removeActiveRaster(activeMap);
    reportStatus('no-data');
    emitFrames('no-data');
    return;
  }
  if (!activeSourceId || !activeMap.getSource(activeSourceId)) {
    renderFrame(activeMap, selectedDay);
  }
}

function listenForCoverageMoves(map: maplibregl.Map): void {
  if (coverageMoveMap === map) return;
  coverageMoveMap?.off('moveend', onCoverageMoveEnd);
  coverageMoveMap = map;
  map.on('moveend', onCoverageMoveEnd);
}

function stopListeningForCoverageMoves(): void {
  coverageMoveMap?.off('moveend', onCoverageMoveEnd);
  coverageMoveMap = null;
}

function onDaySelection(event: Event): void {
  if (!activeMap || frames.length === 0) return;
  const detail = (event as CustomEvent<{ day?: unknown }>).detail;
  const day = detail?.day;
  if (
    typeof day !== 'number' ||
    !Number.isSafeInteger(day) ||
    day < 1 ||
    day > frames.length ||
    day === selectedDay
  ) {
    return;
  }
  renderFrame(activeMap, day);
}

function listenForDaySelection(): void {
  if (listeningForDaySelection) return;
  window.addEventListener(DAY_SELECT_EVENT, onDaySelection);
  listeningForDaySelection = true;
}

function stopListeningForDaySelection(): void {
  if (!listeningForDaySelection) return;
  window.removeEventListener(DAY_SELECT_EVENT, onDaySelection);
  listeningForDaySelection = false;
}

/**
 * Enumerate exact granule times, then add the first or URL-selected raster
 * frame. Missing or inconsistent metadata reports `error`; there is no
 * fallback that guesses a date.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (activeMap === map && frames.length > 0) return;

  const signal = replaceMasterController();
  // A re-activation supersedes any frame statement still standing; the
  // controller's own indicator covers the enumeration below, and
  // `renderFrame` opens a fresh one for the frame it draws.
  endFrameLoad();
  activeMap = map;
  activeSourceId = null;
  frames = [];
  selectedDay = null;
  currentHasCoverage = null;
  listenForDaySelection();
  listenForCoverageMoves(map);
  reportStatus('loading');
  emitFrames('loading');

  try {
    const metadataJson = await fetchJsonWithBudget(
      `${URLS.nwsHeatRisk}?f=json`,
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    const extent = extractTimeExtent(metadataJson);
    if (extent === null) {
      console.warn('[heatrisk] service metadata carried no usable time extent.');
      reportStatus('error');
      emitFrames('error');
      return;
    }

    const catalogJson = await fetchJsonWithBudget(
      buildCatalogUrl(),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    const advertised = extractFrames(catalogJson, extent);
    if (advertised === null) {
      console.warn('[heatrisk] catalog carried no consistent granule times.');
      reportStatus('error');
      emitFrames('error');
      return;
    }

    if (signal.aborted) return;
    frames = advertised;
    const requestedDay = parseHeatRiskDayParam();
    const initialDay =
      requestedDay !== null && requestedDay <= frames.length
        ? requestedDay
        : 1;
    renderFrame(map, initialDay);
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[heatrisk] source qualification fetch failed.', err);
    reportStatus('error');
    emitFrames('error');
  }
}

/**
 * Abort current work, detach the frame watcher, and remove the active source.
 * Toggling on again re-enumerates the publisher's current granules.
 */
export function deactivate(map: maplibregl.Map): void {
  masterController?.abort();
  masterController = null;
  endFrameLoad();
  removeActiveRaster(map);
  stopListeningForDaySelection();
  stopListeningForCoverageMoves();
  hideLegend(LAYER_KEY);
  activeMap = null;
  frames = [];
  selectedDay = null;
  currentHasCoverage = null;
  emitFrames('inactive');
}
