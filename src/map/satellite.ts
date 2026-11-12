import { addProtocol } from 'maplibre-gl';
import type * as maplibregl from 'maplibre-gl';

import { CHIP_STATE_WORDS, imageryFailureState } from '../config/chip-state';
import { URLS } from '../config/urls';
import { revertBasemapForFailure } from '../state/basemap-store';
import { showToast } from '../ui/overlay';
import { fetchBufferedWithBudget, fetchJsonWithBudget, sleepUnlessAborted } from '../util/fetch';
import { isObject } from '../util/guards';
import {
  watchRasterTiles,
  type RasterTileWatch
} from '../util/raster-status';
import { firstLayerIdAbove } from './layer-order';
import {
  decodeImage,
  isPlaceholderImage,
  isSupportedRaster,
  MAX_SATELLITE_IMAGE_BYTES,
  SATELLITE_TILE_SCHEME,
  satelliteTileAction
} from './satellite-guard';

/**
 * Opt-in recent satellite context from NOAA NESDIS.
 *
 * The service is a rolling 24-hour merged GOES East and West GeoColor image
 * catalog. Activation queries a bounded set of recent catalog items, rejects
 * stale or future-dated records, and probes them newest to oldest before it
 * pins every exportImage tile to the selected object id and observation time.
 * The probe and every drawn tile pass the placeholder guard
 * (./satellite-guard.ts): the service can answer a valid request with a
 * black and white placeholder image, which is never drawn as imagery. A
 * frame that serves it at tile time is skipped for the rest of the session
 * and the selection walks back to an older frame.
 * The last frame whose tiles loaded is held: turning imagery back on puts it
 * on the map at once while it is still recent, and the refresh looks for a
 * newer one; a catalog query that fails is asked once more before imagery
 * reads unavailable.
 * That pin is load-bearing: the image endpoint advertises a 12-hour cache, and
 * an unpinned "latest" request could mix scans across one viewport.
 *
 * OpenStreetMap stays visible underneath. GOES coverage stops near 76 degrees
 * latitude, and transparent or missing imagery must reveal the default map,
 * never a blank surface. The chip keeps the observation time separate from
 * the hazard layers above it; the imagery's caveats read in the Impact
 * Briefing's Technical information (src/ui/map-technical-information.ts).
 */

const SOURCE_ID = 'basemap-satellite';
const LAYER_ID = 'basemap-satellite';
const METADATA_TIMEOUT_MS = 10_000;
/** The pause before a failed catalog query is asked once more; both fit the selection budget. */
const CATALOG_RETRY_DELAY_MS = 1_000;
const TILE_COMPLETENESS_DEADLINE_MS = 30_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 35_000;
const FRAME_SELECTION_TIMEOUT_MS = 55_000;
const REFRESH_INTERVAL_MS = 10 * 60_000;
const FAILED_LOOKUP_RETRY_MS = 10 * 60_000;
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
// A revert toasts only for a SAT press; a mode's default, the boot and URL
// restore path stay silent.
let announceRevert = false;
// When imagery last failed: automatic requests do not look again for
// FAILED_LOOKUP_RETRY_MS.
let lastFailureAt = Number.NEGATIVE_INFINITY;
let currentFrame: SatelliteFrame | null = null;
type FrameStatus = 'live' | 'live-partial';
let frameStatus: FrameStatus | null = null;
// Drops the installed frame the way a failed tile load does (rollback, or
// the plain map); set while a frame's tiles are watched.
let failInstalledFrame: ((reason: string) => void) | null = null;
// Placeholder tiles answered transparent since the page loaded.
let placeholderTiles = 0;
// Frames that served a placeholder at tile time; never selected again this session.
const placeholderFrameIds = new Set<number>();
// The last frame whose tiles loaded: reinstalled at once on the next activation while recent.
let heldFrame: SatelliteFrame | null = null;
let protocolRegistered = false;

/**
 * What the Impact Briefing says about the imagery: 'on' while a frame is
 * drawn, 'unavailable' while the plain map stands in for failed imagery,
 * null while the plain map is a choice. Sent as an event (mirrored literals
 * of src/ui/map-technical-information.ts, which owns the words) so the
 * briefing module stays out of this lazy chunk.
 */
type ImageryBriefing = 'on' | 'unavailable' | null;
let imageryBriefing: ImageryBriefing = null;

function publishImageryBriefing(state: ImageryBriefing): void {
  imageryBriefing = state;
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('ddm:satellite-imagery', { detail: { state } }));
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('ddm:satellite-imagery-request', () => publishImageryBriefing(imageryBriefing));
}

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

/** The service answered and holds no recent frame: a verified absence. */
class NoRecentFrameError extends Error {}

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
    throw new NoRecentFrameError('Satellite metadata has no recent frame.');
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
    throw new NoRecentFrameError('Satellite metadata has no valid recent frame.');
  }
  return frames;
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

/**
 * Decode the control image at full size and reject blank, off-coverage,
 * wrong-size and placeholder responses, so a frame that serves the
 * service's placeholder image is never installed and the next older
 * candidate is tried.
 */
async function validateProbeImage(
  bytes: ArrayBuffer,
  contentType: string,
  signal: AbortSignal
): Promise<void> {
  if (!isSupportedRaster(contentType, new Uint8Array(bytes))) {
    throw new Error('Satellite probe did not return a supported raster image.');
  }
  signal.throwIfAborted();
  let image: Awaited<ReturnType<typeof decodeImage>>;
  try {
    image = await decodeImage(bytes, contentType, signal);
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw new Error(`Satellite probe image could not be decoded (${String(error)}).`);
  }
  if (image.width !== 256 || image.height !== 256) {
    throw new Error('Satellite probe image dimensions are not 256 by 256.');
  }
  const pixels = image.data;
  let opaquePixels = 0;
  let minimum = 255;
  let maximum = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue;
    opaquePixels++;
    const luminance =
      pixels[index]! * 0.2126 +
      pixels[index + 1]! * 0.7152 +
      pixels[index + 2]! * 0.0722;
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
  }
  if (opaquePixels < 4 || maximum - minimum < 2) {
    throw new Error('Satellite probe image is blank or uniform.');
  }
  if (isPlaceholderImage(image)) {
    throw new Error('Satellite probe returned the service placeholder image, not imagery.');
  }
}

async function proveFrameAvailable(
  frame: SatelliteFrame,
  masterSignal: AbortSignal
): Promise<void> {
  if (masterSignal.aborted) throw abortError();
  const response = await fetchBufferedWithBudget(
    satelliteProbeUrl(frame),
    { cache: 'no-store', credentials: 'omit' },
    masterSignal,
    CANDIDATE_PROBE_TIMEOUT_MS,
    MAX_SATELLITE_IMAGE_BYTES
  );
  if (!response.ok) {
    throw new Error(`Satellite probe returned HTTP ${response.status}.`);
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const bytes = await response.arrayBuffer();
  if (masterSignal.aborted) throw abortError();
  await validateProbeImage(bytes, contentType, masterSignal);
}

/**
 * Every satellite tile is read through the placeholder guard. A placeholder
 * from the installed frame drops that frame and marks it for the session:
 * the last good frame comes back if a refresh brought it, otherwise the
 * selection walks back to an older frame, and the plain map and the
 * unavailable state come only when none is left. One placeholder is enough
 * because the service serves it for whole requests, not for single cells of
 * a real frame.
 */
function onSatelliteTile(url: string, placeholder: boolean): void {
  if (!placeholder) return;
  placeholderTiles++;
  const frame = currentFrame;
  if (frame === null || !url.endsWith(satelliteTileTemplate(frame).split('{bbox-epsg-3857}')[1]!)) {
    return;
  }
  placeholderFrameIds.add(frame.objectId);
  failInstalledFrame?.(
    `the service answered with a placeholder image (${placeholderTiles} placeholder tiles this page)`
  );
}

function registerSatelliteProtocol(): void {
  if (protocolRegistered) return;
  addProtocol(SATELLITE_TILE_SCHEME, satelliteTileAction(onSatelliteTile));
  protocolRegistered = true;
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

type ImageryStatus = 'loading' | 'live' | 'live-partial' | 'no-data' | 'unavailable';

// The imagery's caveats and coverage note read in the Impact Briefing (SATELLITE_CAVEAT_NOTE and
// SATELLITE_COVERAGE_NOTE in src/ui/map-technical-information.ts); the chip carries state and time.
function showChip(
  status: ImageryStatus,
  frame: SatelliteFrame | null,
  refreshDelayed = false
): void {
  const chip = ensureImageryChip();
  if (!chip) return;
  chip.hidden = false;
  chip.dataset.status = status;
  if (status === 'no-data' || status === 'unavailable') {
    chip.textContent = `Recent NOAA satellite imagery · ${CHIP_STATE_WORDS[status]}`;
    return;
  }
  if (status === 'loading' || frame === null) {
    chip.textContent = 'Recent NOAA satellite imagery · loading';
    return;
  }
  const state = status === 'live-partial' ? 'live (partial)' : 'live';
  const age = Date.now() - frame.endTime;
  const freshness = age >= 0 && age <= RECENT_FRAME_MS
    ? 'near-real-time'
    : 'latest available';
  // The freshness words are tied to "UTC" with U+00A0 and their hyphens held by U+2060 (Lexend has
  // no U+2011), so they never stand alone on the panel's last line (text registration T1).
  const tie = ' ';
  const tail = freshness.replace(/-/g, '⁠-⁠').replace(/ /g, tie);
  const delayed = refreshDelayed ? `${tie}·${tie}refresh delayed` : '';
  chip.textContent =
    `NOAA GOES GeoColor · ${state} · observed ${observationRange(frame)}${tie}·${tie}` +
    `${tail}${delayed}.`;
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
  failInstalledFrame = null;
  removeSatelliteArtifacts(map);
  stampFrame(null);
}

/** Production-observable stamp of the frame the map holds (the src/map/fire3d.ts pattern). */
function stampFrame(frame: SatelliteFrame | null): void {
  const root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement;
  if (!root) return;
  if (frame) root.dataset.ddmSatellite = String(frame.objectId);
  else delete root.dataset.ddmSatellite;
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

function revertToDefault(
  map: maplibregl.Map,
  reason: string,
  state: 'no-data' | 'unavailable' = 'unavailable'
): void {
  if (activeMap !== map) return;
  lastFailureAt = Date.now();
  console.warn(`[basemap] recent satellite imagery reverted: ${reason}`);
  // Write the terminal state first: the hidden chip is the SAT button's
  // accessible description and must not keep reading "loading".
  showChip(state, null);
  deactivate(map);
  publishImageryBriefing('unavailable');
  revertBasemapForFailure();
  if (!announceRevert) return;
  showToast(
    state === 'no-data'
      ? 'No recent satellite imagery is available. Default map restored.'
      : 'Recent satellite imagery is unavailable. Default map restored.'
  );
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
  refreshDelayed: boolean,
  reused: boolean
): void {
  let rollback = previous;
  const stillInstalled = (): boolean =>
    epoch === activationEpoch &&
    activeMap === map &&
    currentFrame !== null &&
    sameFrame(currentFrame, frame);
  const fail = (reason: string): void => {
    if (!stillInstalled()) return;
    const fallback = rollback;
    rollback = null;
    if (heldFrame !== null && sameFrame(heldFrame, frame)) heldFrame = null;
    if (
      fallback &&
      isSatelliteFrameRecent(fallback.frame) &&
      !placeholderFrameIds.has(fallback.frame.objectId)
    ) {
      console.warn(
        `[basemap] selected satellite refresh frame failed (${reason}); restoring the previous frame.`
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
    // A held frame that fails may have left NOAA's catalog: ask it, as a press without a held frame does.
    if (reused || placeholderFrameIds.has(frame.objectId)) {
      // Walk back: choose again among the frames not yet marked; the plain map comes when none passes.
      console.warn(
        `[basemap] satellite frame ${frame.objectId} failed at tile time (${reason}); choosing a frame again.`
      );
      removeSatelliteSource(map);
      currentFrame = null;
      frameStatus = null;
      showChip('loading', null);
      void refreshFrame(map, epoch, true);
      return;
    }
    revertToDefault(map, reason);
  };
  failInstalledFrame = fail;
  tileWatch?.detach();
  tileWatch = watchRasterTiles(
    map,
    SOURCE_ID,
    (status) => {
      if (!stillInstalled()) return;
      if (status === 'error') {
        fail('selected-frame tiles did not load');
        return;
      }
      rollback = null;
      heldFrame = frame;
      frameStatus = status === 'degraded' ? 'live-partial' : 'live';
      showChip(frameStatus, currentFrame, refreshDelayed);
      publishImageryBriefing('on');
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
  refreshDelayed = false,
  reused = false
): void {
  registerSatelliteProtocol();
  const tiles = [`${SATELLITE_TILE_SCHEME}://${satelliteTileTemplate(frame)}`];
  currentFrame = frame;
  frameStatus = initialStatus;
  showChip(initialStatus ?? 'loading', frame, refreshDelayed);

  try {
    watchFrameTiles(map, frame, epoch, previous, refreshDelayed, reused);
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
    stampFrame(frame);
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

async function queryCandidateFrames(
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

/**
 * The catalog query, asked once more after a short pause when it fails (an
 * HTTP error, an error envelope, a corrupt body or its own timeout): the
 * service failed 2 of about 9 queries in one session (2026-11-11) while the
 * next one answered.
 * A verified absence and a cancellation are answers and are not repeated.
 */
async function fetchCandidateFrames(
  signal: AbortSignal
): Promise<readonly SatelliteFrame[]> {
  try {
    return await queryCandidateFrames(signal);
  } catch (error) {
    if (signal.aborted || error instanceof NoRecentFrameError) throw error;
    console.warn('[basemap] satellite frame lookup failed; asking once more.', error);
    await sleepUnlessAborted(CATALOG_RETRY_DELAY_MS, signal);
    if (signal.aborted) throw abortError();
    return queryCandidateFrames(signal);
  }
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
    if (placeholderFrameIds.has(frame.objectId)) continue;
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
    // A success clears the hold, so a working feed is never skipped.
    lastFailureAt = Number.NEGATIVE_INFINITY;
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
    revertToDefault(
      map,
      `frame lookup failed (${String(error)})`,
      imageryFailureState(error instanceof NoRecentFrameError)
    );
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
  active: boolean,
  announce = false
): Promise<void> {
  if (active && announce) announceRevert = true;
  if (!active) {
    if (activeMap === map) {
      deactivate(map);
    } else {
      // Do not abort or detach another map's active source during teardown.
      removeSatelliteArtifacts(map);
    }
    if (activeMap === null) publishImageryBriefing(null);
    return;
  }

  if (activeMap === map) return;
  // A failed lookup is not repeated automatically for ten minutes; a SAT
  // press looks again.
  if (!announce && Date.now() - lastFailureAt < FAILED_LOOKUP_RETRY_MS) {
    revertBasemapForFailure();
    publishImageryBriefing('unavailable');
    return;
  }
  if (activeMap && activeMap !== map) deactivate(activeMap);

  activationEpoch++;
  const epoch = activationEpoch;
  activeMap = map;
  announceRevert = announce;
  showChip('loading', null);
  // The held frame goes back on the map at once; the refresh then only looks
  // for a newer one, and a failed look keeps it (the refresh path).
  const held = heldFrame;
  let reused = false;
  if (held && isSatelliteFrameRecent(held) && !placeholderFrameIds.has(held.objectId)) {
    try {
      installFrame(map, held, epoch, null, null, false, true);
      reused = true;
    } catch (error) {
      console.warn('[basemap] the held satellite frame could not be reinstalled.', error);
    }
  }
  await refreshFrame(map, epoch, !reused);
  if (epoch === activationEpoch && activeMap === map) {
    scheduleRefresh(map, epoch);
  }
}
