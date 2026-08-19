import type maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import { setBasemapMode } from '../state/basemap-store';
import { showToast } from '../ui/overlay';
import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import {
  watchRasterTiles,
  type RasterTileWatch
} from '../util/raster-status';
import { firstLayerIdAbove } from './layer-order';

/**
 * Opt-in recent satellite context from NOAA NESDIS.
 *
 * The service is a rolling 24-hour merged GOES East and West GeoColor image
 * catalog. Activation queries a bounded set of recent catalog items, rejects
 * stale or future-dated records, and probes them newest to oldest before it
 * pins every exportImage tile to the selected object id and observation time.
 * That pin is load-bearing: the image endpoint advertises a 12-hour cache, and
 * an unpinned "latest" request could mix scans across one viewport.
 *
 * OpenStreetMap stays visible underneath. GOES coverage stops near 76 degrees
 * latitude, and transparent or missing imagery must reveal the default map,
 * never a blank surface. The chip keeps observation time and interpretation
 * caveats separate from the hazard layers above it.
 */

const SOURCE_ID = 'basemap-satellite';
const LAYER_ID = 'basemap-satellite';
const METADATA_TIMEOUT_MS = 10_000;
const TILE_COMPLETENESS_DEADLINE_MS = 30_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 35_000;
const FRAME_SELECTION_TIMEOUT_MS = 55_000;
const REFRESH_INTERVAL_MS = 10 * 60_000;
const RECENT_FRAME_MS = 45 * 60_000;
const MAX_FRAME_AGE_MS = 26 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 15 * 60_000;
const MAX_CANDIDATE_FRAMES = 4;

/**
 * A z4 known-data control over the central United States and southern Canada.
 * The fixed control avoids treating an Arctic or off-coverage viewport as a
 * failed frame, while still exercising the exact pinned ImageServer export
 * path that MapLibre uses.
 */
export const SATELLITE_PROBE_BBOX =
  '-12523442.7142433,5009377.08569731,-10018754.1713946,7514065.62854597';

const ATTRIBUTION =
  '<a href="https://www.nesdis.noaa.gov/imagery/satellite-maps" ' +
  'target="_blank" rel="noopener">NOAA NESDIS GOES GeoColor</a>';

export interface SatelliteFrame {
  readonly objectId: number;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
}

let activeMap: maplibregl.Map | null = null;
let metadataController: AbortController | null = null;
let tileWatch: RasterTileWatch | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let activationEpoch = 0;
let currentFrame: SatelliteFrame | null = null;
type FrameStatus = 'live' | 'live-partial';
let frameStatus: FrameStatus | null = null;

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFrameFeature(value: unknown): SatelliteFrame | null {
  if (!isObject(value) || !isObject(value.attributes)) return null;
  const attributes = value.attributes;
  const objectId = finiteNumber(
    attributes.objectid ?? attributes.OBJECTID ?? attributes.ObjectId
  );
  const startTime = finiteNumber(
    attributes.start_time ?? attributes.START_TIME ?? attributes.Start_Time
  );
  const endTime = finiteNumber(
    attributes.end_time ?? attributes.END_TIME ?? attributes.End_Time
  );
  const name = String(attributes.name ?? attributes.NAME ?? '').trim();

  if (
    objectId === null ||
    !Number.isInteger(objectId) ||
    objectId <= 0 ||
    startTime === null ||
    endTime === null ||
    startTime <= 0 ||
    endTime < startTime ||
    endTime - startTime > 30 * 60_000 ||
    name.length === 0
  ) {
    return null;
  }
  return { objectId, name, startTime, endTime };
}

export function isSatelliteFrameRecent(
  frame: SatelliteFrame,
  now = Date.now()
): boolean {
  const age = now - frame.endTime;
  return age >= -MAX_FUTURE_SKEW_MS && age <= MAX_FRAME_AGE_MS;
}

/**
 * Validate and sort the bounded ArcGIS candidate response. A malformed,
 * stale, or future-dated newest feature does not hide a usable earlier frame.
 */
export function parseSatelliteFrames(
  value: unknown,
  now = Date.now()
): readonly SatelliteFrame[] {
  if (!isObject(value)) throw new Error('Satellite metadata is not an object.');
  if (isObject(value.error)) {
    throw new Error('Satellite metadata service returned an ArcGIS error.');
  }
  const features = value.features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('Satellite metadata has no recent frame.');
  }

  const seen = new Set<number>();
  const frames = features
    .map(parseFrameFeature)
    .filter((frame): frame is SatelliteFrame => frame !== null)
    .filter((frame) => isSatelliteFrameRecent(frame, now))
    .sort((a, b) => b.endTime - a.endTime)
    .filter((frame) => {
      if (seen.has(frame.objectId)) return false;
      seen.add(frame.objectId);
      return true;
    });

  if (frames.length === 0) {
    throw new Error('Satellite metadata has no valid recent frame.');
  }
  return frames;
}

/** Retained as the small single-frame parser contract used by older tests. */
export function parseLatestSatelliteFrame(
  value: unknown,
  now = Date.now()
): SatelliteFrame {
  return parseSatelliteFrames(value, now)[0];
}

function latestFrameQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'objectid,name,start_time,end_time',
    returnGeometry: 'false',
    orderByFields: 'end_time DESC',
    resultRecordCount: String(MAX_CANDIDATE_FRAMES),
    f: 'json'
  });
  return `${URLS.noaaMergedGeoColorImageServer}/query?${params.toString()}`;
}

/** Build a MapLibre WMS-style tile template pinned to exactly one frame. */
export function satelliteTileTemplate(frame: SatelliteFrame): string {
  const mosaicRule = encodeURIComponent(
    JSON.stringify({
      mosaicMethod: 'esriMosaicLockRaster',
      lockRasterIds: [String(frame.objectId)]
    })
  );
  return (
    `${URLS.noaaMergedGeoColorImageServer}/exportImage?` +
    'bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&' +
    `format=jpgpng&transparent=true&time=${frame.startTime}&` +
    `mosaicRule=${mosaicRule}&f=image`
  );
}

export function satelliteProbeUrl(frame: SatelliteFrame): string {
  return satelliteTileTemplate(frame).replace(
    '{bbox-epsg-3857}',
    SATELLITE_PROBE_BBOX
  );
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isSupportedRaster(contentType: string, bytes: Uint8Array): boolean {
  if (contentType.startsWith('image/png')) {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  }
  if (contentType.startsWith('image/jpeg')) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

/** Decode the control image and reject blank, off-coverage, or wrong-size responses. */
async function validateProbeImage(
  bytes: Uint8Array,
  contentType: string,
  signal: AbortSignal
): Promise<void> {
  if (!isSupportedRaster(contentType, bytes)) {
    throw new Error('Satellite probe did not return a supported raster image.');
  }
  if (signal.aborted) throw abortError();

  const imageBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(imageBuffer).set(bytes);
  const objectUrl = URL.createObjectURL(
    new Blob([imageBuffer], { type: contentType })
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => {
        image.src = '';
        finish(abortError());
      };

      image.onload = () => {
        try {
          if (image.naturalWidth !== 256 || image.naturalHeight !== 256) {
            throw new Error('Satellite probe image dimensions are not 256 by 256.');
          }
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('Satellite probe image could not be inspected.');
          context.drawImage(image, 0, 0, 16, 16);
          const pixels = context.getImageData(0, 0, 16, 16).data;
          let opaquePixels = 0;
          let minimum = 255;
          let maximum = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index + 3] === 0) continue;
            opaquePixels++;
            const luminance =
              pixels[index] * 0.2126 +
              pixels[index + 1] * 0.7152 +
              pixels[index + 2] * 0.0722;
            minimum = Math.min(minimum, luminance);
            maximum = Math.max(maximum, luminance);
          }
          if (opaquePixels < 4 || maximum - minimum < 2) {
            throw new Error('Satellite probe image is blank or uniform.');
          }
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      image.onerror = () => finish(new Error('Satellite probe image could not be decoded.'));
      signal.addEventListener('abort', onAbort, { once: true });
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function proveFrameAvailable(
  frame: SatelliteFrame,
  masterSignal: AbortSignal
): Promise<void> {
  if (masterSignal.aborted) throw abortError();
  const controller = new AbortController();
  const onMasterAbort = (): void => controller.abort();
  masterSignal.addEventListener('abort', onMasterAbort);
  const timer = setTimeout(() => controller.abort(), CANDIDATE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(satelliteProbeUrl(frame), {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Satellite probe returned HTTP ${response.status}.`);
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (controller.signal.aborted) throw abortError();
    await validateProbeImage(bytes, contentType, controller.signal);
  } finally {
    clearTimeout(timer);
    masterSignal.removeEventListener('abort', onMasterAbort);
  }
}

function ensureImageryChip(): HTMLElement | null {
  const existing = document.getElementById('basemap-vintage');
  if (existing) {
    existing.classList.add('sr-only');
    existing.setAttribute('role', 'status');
    existing.setAttribute('aria-live', 'polite');
    existing.setAttribute('aria-atomic', 'true');
    return existing;
  }
  const dock = document.getElementById('map-bottom-dock');
  const foot = dock?.querySelector('.map-dock-foot');
  if (!dock || !foot) return null;
  const chip = document.createElement('div');
  // Preserve the established id because embeds and downstream CSS may use it.
  chip.id = 'basemap-vintage';
  chip.className = 'basemap-imagery-chip sr-only';
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  chip.setAttribute('aria-atomic', 'true');
  chip.hidden = true;
  dock.insertBefore(chip, foot);
  return chip;
}

function formatUtc(milliseconds: number, includeDate: boolean): string {
  return new Intl.DateTimeFormat('en-US', {
    ...(includeDate
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC'
  }).format(new Date(milliseconds));
}

function observationRange(frame: SatelliteFrame): string {
  const start = new Date(frame.startTime);
  const end = new Date(frame.endTime);
  const sameDay =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCDate() === end.getUTCDate();
  return sameDay
    ? `${formatUtc(frame.startTime, true)} to ${formatUtc(frame.endTime, false)} UTC`
    : `${formatUtc(frame.startTime, true)} to ${formatUtc(frame.endTime, true)} UTC`;
}

type ImageryStatus = 'loading' | 'live' | 'live-partial';

/**
 * What this imagery covers, and what its edges are.
 *
 * The product is a merged mosaic of the GOES East and West full disks, so
 * its geometry is two circles, not a rectangle: coverage ends near 76
 * degrees north and south AND runs out on the far side of both disks
 * (roughly between the eastern Atlantic and the western Pacific), where the
 * service returns fully transparent pixels and the subdued base map shows
 * through. Probed live 2026-08-19: `exportImage` over central Africa and
 * south Asia returned a 334-byte fully transparent PNG at every sample,
 * while the service's own declared extent claims the whole globe. The
 * declared extent is what the raster source's `bounds` follow, because a
 * single rectangle cannot describe a footprint that wraps the
 * antimeridian; the honest move is to say what the edges mean rather than
 * to cull tiles that might carry data.
 *
 * The daylight boundary is likewise inherent: GeoColor renders the lit and
 * unlit halves differently, so a visible seam crosses the mosaic wherever
 * the terminator falls. Neither edge is a fault to hide.
 */
export const SATELLITE_COVERAGE_NOTE =
  'Coverage is the GOES East and West disks: it ends near 76 degrees north and south, and the base map shows through beyond the disks. The daylight boundary crosses the mosaic as a visible seam.';

function showChip(
  status: ImageryStatus,
  frame: SatelliteFrame | null,
  refreshDelayed = false
): void {
  const chip = ensureImageryChip();
  if (!chip) return;
  chip.hidden = false;
  chip.dataset.status = status;
  if (status === 'loading' || frame === null) {
    chip.textContent = 'Recent NOAA satellite imagery · loading';
    return;
  }
  const state = status === 'live-partial' ? 'live (partial)' : 'live';
  const age = Date.now() - frame.endTime;
  const freshness = age >= 0 && age <= RECENT_FRAME_MS
    ? 'near-real-time'
    : 'latest available';
  const delayed = refreshDelayed ? ' · refresh delayed' : '';
  chip.textContent =
    `NOAA GOES GeoColor · ${state} · observed ${observationRange(frame)} · ` +
    `${freshness}${delayed}. Context only; daytime approximate true color, nighttime ` +
    'infrared with static lights; clouds can obscure land and smoke. ' +
    `${SATELLITE_COVERAGE_NOTE}`;
}

function clearRefreshTimer(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

function removeSatelliteArtifacts(map: maplibregl.Map): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

function removeSatelliteSource(map: maplibregl.Map): void {
  tileWatch?.detach();
  tileWatch = null;
  removeSatelliteArtifacts(map);
}

function deactivate(map: maplibregl.Map): void {
  activationEpoch++;
  metadataController?.abort();
  metadataController = null;
  clearRefreshTimer();
  removeSatelliteSource(map);
  const chip = ensureImageryChip();
  if (chip) chip.hidden = true;
  activeMap = null;
  currentFrame = null;
  frameStatus = null;
}

function revertToDefault(map: maplibregl.Map, reason: string): void {
  if (activeMap !== map) return;
  console.warn(`[basemap] recent satellite imagery reverted: ${reason}`);
  deactivate(map);
  setBasemapMode('default');
  showToast('Recent satellite imagery is unavailable. Default map restored.');
}

interface InstalledFrame {
  readonly frame: SatelliteFrame;
  readonly status: FrameStatus | null;
}

function sameFrame(a: SatelliteFrame, b: SatelliteFrame): boolean {
  return (
    a.objectId === b.objectId &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime
  );
}

function watchFrameTiles(
  map: maplibregl.Map,
  frame: SatelliteFrame,
  epoch: number,
  previous: InstalledFrame | null,
  refreshDelayed: boolean
): void {
  let rollback = previous;
  tileWatch?.detach();
  tileWatch = watchRasterTiles(
    map,
    SOURCE_ID,
    (status) => {
      if (
        epoch !== activationEpoch ||
        activeMap !== map ||
        currentFrame === null ||
        !sameFrame(currentFrame, frame)
      ) {
        return;
      }
      if (status === 'error') {
        const fallback = rollback;
        rollback = null;
        if (fallback && isSatelliteFrameRecent(fallback.frame)) {
          console.warn(
            '[basemap] selected satellite refresh frame failed; restoring the previous frame.'
          );
          removeSatelliteSource(map);
          try {
            installFrame(
              map,
              fallback.frame,
              epoch,
              null,
              fallback.status,
              true
            );
          } catch (error) {
            revertToDefault(map, `previous frame could not be restored (${String(error)})`);
          }
          return;
        }
        revertToDefault(map, 'selected-frame tiles did not load');
        return;
      }
      rollback = null;
      frameStatus = status === 'degraded' ? 'live-partial' : 'live';
      showChip(frameStatus, currentFrame, refreshDelayed);
    },
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: TILE_COMPLETENESS_DEADLINE_MS
    }
  );
}

function installFrame(
  map: maplibregl.Map,
  frame: SatelliteFrame,
  epoch: number,
  previous: InstalledFrame | null,
  initialStatus: FrameStatus | null = null,
  refreshDelayed = false
): void {
  const tiles = [satelliteTileTemplate(frame)];
  currentFrame = frame;
  frameStatus = initialStatus;
  showChip(initialStatus ?? 'loading', frame, refreshDelayed);

  try {
    watchFrameTiles(map, frame, epoch, previous, refreshDelayed);
    map.addSource(SOURCE_ID, {
      type: 'raster',
      tiles,
      tileSize: 256,
      attribution: ATTRIBUTION,
      minzoom: 0,
      maxzoom: 7,
      bounds: [-180, -76.49019873, 180, 76.45880127]
    });
    map.addLayer(
      {
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          'raster-opacity': 0.92,
          'raster-saturation': -0.12,
          'raster-contrast': 0.04
        }
      },
      firstLayerIdAbove(map, ['background', 'basemap'])
    );
  } catch (error) {
    removeSatelliteSource(map);
    if (currentFrame !== null && sameFrame(currentFrame, frame)) {
      currentFrame = null;
      frameStatus = null;
    }
    throw error;
  }
}

function replaceFrame(
  map: maplibregl.Map,
  frame: SatelliteFrame,
  epoch: number
): void {
  const previous = currentFrame === null
    ? null
    : { frame: currentFrame, status: frameStatus };
  removeSatelliteSource(map);
  try {
    installFrame(map, frame, epoch, previous);
  } catch (error) {
    if (previous) {
      try {
        installFrame(
          map,
          previous.frame,
          epoch,
          null,
          previous.status,
          true
        );
      } catch (restoreError) {
        throw new Error(
          `Satellite frame swap and rollback failed (${String(error)}; ${String(restoreError)}).`
        );
      }
    }
    throw error;
  }
}

async function fetchCandidateFrames(
  signal: AbortSignal
): Promise<readonly SatelliteFrame[]> {
  const value = await fetchJsonWithBudget(
    latestFrameQueryUrl(),
    { cache: 'no-store', credentials: 'omit' },
    signal,
    METADATA_TIMEOUT_MS
  );
  return parseSatelliteFrames(value);
}

interface CandidateSelection {
  readonly frame: SatelliteFrame | null;
  readonly attempted: boolean;
}

async function selectUsableFrame(
  frames: readonly SatelliteFrame[],
  installed: SatelliteFrame | null,
  signal: AbortSignal
): Promise<CandidateSelection> {
  let attempted = false;
  for (const frame of frames) {
    if (installed) {
      if (sameFrame(frame, installed)) continue;
      if (frame.endTime < installed.endTime) continue;
    }
    attempted = true;
    try {
      await proveFrameAvailable(frame, signal);
      return { frame, attempted };
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(
        `[basemap] satellite frame ${frame.objectId} failed its known-data probe.`,
        error
      );
    }
  }
  return { frame: null, attempted };
}

async function refreshFrame(
  map: maplibregl.Map,
  epoch: number,
  initial: boolean
): Promise<void> {
  metadataController?.abort();
  const controller = new AbortController();
  metadataController = controller;
  let selectionTimedOut = false;
  const selectionTimer = setTimeout(() => {
    selectionTimedOut = true;
    controller.abort();
  }, FRAME_SELECTION_TIMEOUT_MS);
  try {
    const frames = await fetchCandidateFrames(controller.signal);
    if (
      controller.signal.aborted ||
      epoch !== activationEpoch ||
      activeMap !== map
    ) {
      return;
    }

    if (
      !initial &&
      currentFrame !== null &&
      frames.length > 0 &&
      sameFrame(frames[0], currentFrame)
    ) {
      showChip(frameStatus ?? 'loading', currentFrame);
      return;
    }

    const installed = currentFrame;
    const selection = await selectUsableFrame(
      frames,
      initial ? null : installed,
      controller.signal
    );
    if (
      controller.signal.aborted ||
      epoch !== activationEpoch ||
      activeMap !== map
    ) {
      return;
    }

    if (selection.frame === null) {
      if (
        !initial &&
        installed !== null &&
        isSatelliteFrameRecent(installed) &&
        map.getSource(SOURCE_ID)
      ) {
        showChip(frameStatus ?? 'loading', installed, selection.attempted);
        return;
      }
      throw new Error('No recent satellite candidate passed its image probe.');
    }

    replaceFrame(map, selection.frame, epoch);
  } catch (error) {
    if (
      (controller.signal.aborted && !selectionTimedOut) ||
      epoch !== activationEpoch ||
      activeMap !== map
    ) {
      return;
    }
    if (
      !initial &&
      currentFrame !== null &&
      isSatelliteFrameRecent(currentFrame) &&
      map.getSource(SOURCE_ID)
    ) {
      console.warn('[basemap] satellite frame refresh delayed.', error);
      showChip(frameStatus ?? 'loading', currentFrame, true);
      return;
    }
    // A recent installed frame returned above. Any remaining case is either
    // an initial failure, a missing source, or an installed frame that has
    // aged beyond the rolling-catalog policy. Do not leave stale imagery
    // mounted merely because its MapLibre source still exists.
    revertToDefault(map, `frame lookup failed (${String(error)})`);
  } finally {
    clearTimeout(selectionTimer);
    if (metadataController === controller) metadataController = null;
  }
}

function scheduleRefresh(map: maplibregl.Map, epoch: number): void {
  clearRefreshTimer();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (epoch !== activationEpoch || activeMap !== map) return;
    void refreshFrame(map, epoch, false).finally(() => {
      if (epoch === activationEpoch && activeMap === map) {
        scheduleRefresh(map, epoch);
      }
    });
  }, REFRESH_INTERVAL_MS);
}

/**
 * Show or hide recent satellite imagery. Metadata and tile requests are
 * bounded or cancelled when the user switches off, and activation is
 * transactional so a failed frame cannot leave the URL claiming imagery.
 */
export async function setSatelliteActive(
  map: maplibregl.Map,
  active: boolean
): Promise<void> {
  if (!active) {
    if (activeMap === map) {
      deactivate(map);
    } else {
      // Do not abort or detach another map's active source during teardown.
      removeSatelliteArtifacts(map);
    }
    return;
  }

  if (activeMap === map) return;
  if (activeMap && activeMap !== map) deactivate(activeMap);

  activationEpoch++;
  const epoch = activationEpoch;
  activeMap = map;
  showChip('loading', null);
  await refreshFrame(map, epoch, true);
  if (epoch === activationEpoch && activeMap === map) {
    scheduleRefresh(map, epoch);
  }
}
