/**
 * Shared tile-load watcher for raster layers: the debounced tile-error
 * honesty policy (designed 2026-07-02).
 *
 * The gap it closes: a raster layer registers its XYZ or WMS tile template
 * and reports `ready`, but MapLibre fetches tiles lazily, so a tile-load
 * failure after activation surfaced as blank tiles under a stale "live"
 * pill. The watcher listens to the map's `error` and `sourcedata` events
 * for one source and keeps the status pill honest both ways:
 *
 * - Degrade on evidence, not on a blip. Tile errors accumulate in a rolling
 *   window; only when ERROR_THRESHOLD errors land inside WINDOW_MS with no
 *   successful tile load in between does the layer report `error`. A single
 *   transient tile failure (one dropped request on a working service) never
 *   flips a working layer to "unavailable".
 * - Self-heal on evidence. Any successfully loaded tile clears the error
 *   window, and if the layer had degraded it reports `ready` again. Panning
 *   or zooming naturally issues fresh tile requests, so recovery follows the
 *   same pan-to-retry behavior the hydrography layer set as precedent.
 *
 * Known tradeoff, documented rather than hidden: a viewport entirely outside
 * a service's tile coverage (for example a fully off-coverage pan under the
 * national framing) can 404 every request and read as "unavailable" even
 * though the service is healthy elsewhere. The self-heal restores the pill
 * as soon as the viewport returns to coverage; distinguishing "service down"
 * from "no tiles here" would need per-status-code policy and is deferred
 * until a real case shows up.
 */

import type * as maplibregl from 'maplibre-gl';

import { isObject } from './guards';

/** Tile errors older than this rolling window no longer count. */
const WINDOW_MS = 10_000;

/**
 * Errors inside the window required before the layer degrades. A viewport
 * at the zooms this module serves loads roughly six to twelve tiles, so a
 * real outage crosses three failures within a second or two, while a single
 * dropped request stays safely under the threshold.
 */
const ERROR_THRESHOLD = 3;

/**
 * The completeness deadline every tile-proven raster row shares
 * (DDM-P14-T04: sst-anomaly, gridded-index, hillshade). It sits strictly
 * below the 10 s boot-idle budget (src/state/boot-idle.ts), so a row that
 * never proves a tile still reaches a terminal state inside a settled boot.
 * tests/raster-readiness-contract.test.mjs reads it from here.
 */
export const RASTER_PROOF_DEADLINE_MS = 8_000;

export interface RasterTileWatch {
  /** Detach both listeners and forget all evidence. Call from deactivate. */
  detach(): void;
  /** Forget accumulated evidence (call after a product swap re-adds the source). */
  reset(): void;
}

export interface RasterTileWatchOptions {
  /**
   * Report the first successful tile. Existing consumers omit this and keep
   * the original heal-after-error behavior.
   */
  readonly reportInitialSuccess?: boolean;
  /**
   * Opt in to selected-frame request accounting. The deadline starts with
   * the watcher, so even a source that emits no tile events reaches a
   * terminal state.
   */
  readonly requestCompletenessDeadlineMs?: number;
  /**
   * Outcome for an idle cycle with no selected-frame tile evidence. The
   * default remains `ready` for existing bounded-coverage consumers. Shared
   * ground, gridded-index and the SST anomaly set `error` because they must
   * prove at least one visible tile (DR-050 a names those two). `no-data` is
   * hillshade's and does not come from DR-050: a view outside a bounded
   * archive's own declared extent requests no tile at all, a verified
   * absence. Only for `no-data` does the deadline read an empty cycle the
   * same way, and only once the source has loaded (a map that never idles
   * still ends the cycle; a stalled or failed archive read has not loaded,
   * and stays `error`).
   */
  readonly emptyIdleOutcome?: 'ready' | 'error' | 'no-data';
}

export type RasterTileOutcome = 'ready' | 'degraded' | 'error';
type BasicRasterTileOutcome = Exclude<RasterTileOutcome, 'degraded'>;
type CompletenessOptions = RasterTileWatchOptions & {
  readonly requestCompletenessDeadlineMs: number;
};

type RasterTileEvent = {
  readonly sourceId?: string;
  readonly dataType?: string;
  readonly isSourceLoaded?: boolean;
  readonly tile?: unknown;
};

/**
 * Read the source id off an error event. MapLibre attaches the failing
 * source's id through the style's evented-parent data, but the v6
 * `ErrorEvent` type declares only `error`, so the id is read through a
 * guard rather than an assertion. A generic map error carries no id and is
 * ignored, exactly as before.
 */
function errorSourceId(e: maplibregl.ErrorEvent): string | null {
  return isObject(e) && typeof e.sourceId === 'string' ? e.sourceId : null;
}

function tileEventKey(event: RasterTileEvent): unknown | null {
  if (event.tile === undefined || event.tile === null) return null;
  if (isObject(event.tile) && isObject(event.tile.tileID)) {
    const key = event.tile.tileID.key;
    if (typeof key === 'string' || typeof key === 'number') return key;
  }
  return event.tile;
}

/**
 * Watch one raster source's tile loads and report honest status changes.
 * `report` receives `error` when the degrade threshold is crossed and
 * `ready` when a later successful tile load heals it; it is never called
 * after `detach()`.
 */
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report: (state: RasterTileOutcome | 'no-data') => void,
  options: CompletenessOptions & { readonly emptyIdleOutcome: 'no-data' }
): RasterTileWatch;
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report: (state: RasterTileOutcome) => void,
  options: CompletenessOptions & { readonly emptyIdleOutcome?: 'ready' | 'error' }
): RasterTileWatch;
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report: (state: BasicRasterTileOutcome) => void,
  options?: RasterTileWatchOptions
): RasterTileWatch;
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report:
    | ((state: RasterTileOutcome | 'no-data') => void)
    | ((state: RasterTileOutcome) => void)
    | ((state: BasicRasterTileOutcome) => void),
  options: RasterTileWatchOptions = {}
): RasterTileWatch {
  const reportOutcome = report as (state: RasterTileOutcome | 'no-data') => void;
  let errorTimes: number[] = [];
  let degraded = false;
  // found-042: a tile of this source has rendered since attach or reset.
  let rendered = false;
  let initialSuccessReported = options.reportInitialSuccess !== true;
  const deadlineMs =
    typeof options.requestCompletenessDeadlineMs === 'number' &&
    Number.isFinite(options.requestCompletenessDeadlineMs) &&
    options.requestCompletenessDeadlineMs > 0
      ? options.requestCompletenessDeadlineMs
      : null;
  let requestedTiles = new Set<unknown>();
  let successfulTiles = new Set<unknown>();
  let requestCycleActive = deadlineMs !== null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCompletenessOutcome: RasterTileOutcome | 'no-data' | null = null;

  const clearDeadline = (): void => {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };

  const reportCompleteness = (
    emptyCycleOutcome: RasterTileOutcome | 'no-data' = 'error',
    floorAtPartial = false
  ): void => {
    let outcome: RasterTileOutcome | 'no-data' =
      requestedTiles.size === 0
        ? emptyCycleOutcome
        : successfulTiles.size === 0
          ? 'error'
          : successfulTiles.size < requestedTiles.size
            ? 'degraded'
            : 'ready';
    // found-042: after a rendered frame, a later cycle's deadline alone never
    // reads below live (partial); only a finished cycle's evidence can. The
    // deadline passes `rendered` here; a finished cycle passes nothing.
    if (floorAtPartial && outcome === 'error') outcome = 'degraded';
    if (outcome === lastCompletenessOutcome) return;
    lastCompletenessOutcome = outcome;
    if (outcome === 'error') {
      console.warn(
        `[${sourceId}] no selected-frame tile succeeded before the load deadline; reporting unavailable.`
      );
    } else if (outcome === 'degraded') {
      console.warn(
        `[${sourceId}] selected-frame tile requests completed with known holes; reporting live (partial).`
      );
    }
    reportOutcome(outcome);
  };

  const scheduleDeadline = (): void => {
    clearDeadline();
    if (deadlineMs === null) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (!requestCycleActive) return;
      reportCompleteness(
        options.emptyIdleOutcome === 'no-data' && map.isSourceLoaded(sourceId)
          ? 'no-data'
          : 'error',
        rendered
      );
    }, deadlineMs);
  };

  // A cycle's verdict covers the view, not only the tiles it requested
  // (DDM-P14-T04). MapLibre fires nothing for a 404 tile while it stays on
  // the map, and may request its fallback parent a frame after the source
  // settled and the cycle closed. So a closed cycle with holes carries into
  // the next one: whole while the camera is still (every tile stays), holes
  // only after a move (`onMove`: a loaded tile leaves silently, cached; a
  // hole leaves with `sourcedataabort`). A cycle without holes starts fresh.
  const beginRequestCycle = (): void => {
    if (requestCycleActive) return;
    requestCycleActive = true;
    if (successfulTiles.size === requestedTiles.size) {
      requestedTiles = new Set();
      successfulTiles = new Set();
    }
    lastCompletenessOutcome = null;
    scheduleDeadline();
  };

  const finishRequestCycle = (
    emptyCycleOutcome: RasterTileOutcome | 'no-data' = 'error'
  ): void => {
    clearDeadline();
    reportCompleteness(emptyCycleOutcome);
    requestCycleActive = false;
  };

  const onMove = (): void => {
    if (requestCycleActive) return;
    for (const key of successfulTiles) requestedTiles.delete(key);
    successfulTiles.clear();
  };

  const onError = (e: maplibregl.ErrorEvent): void => {
    if (errorSourceId(e) !== sourceId) return;
    // Completeness-aware consumers need the whole request cycle before they
    // can distinguish total failure from usable partial coverage. The
    // sourcedataloading set already records each failed request, so idle or
    // the deadline will report `error` when none succeeded and `degraded`
    // when at least one did. Keep the three-error shortcut only for legacy
    // consumers that do not opt in to request accounting.
    if (deadlineMs !== null) return;
    const now = Date.now();
    errorTimes = errorTimes.filter((t) => now - t < WINDOW_MS);
    errorTimes.push(now);
    if (!degraded && errorTimes.length >= ERROR_THRESHOLD) {
      degraded = true;
      console.warn(`[${sourceId}] repeated tile-load failures; reporting unavailable.`, e.error);
      reportOutcome('error');
    }
  };

  const onSourceLoading = (e: RasterTileEvent): void => {
    if (e.sourceId !== sourceId || e.dataType !== 'source') return;
    const key = tileEventKey(e);
    if (key === null) return;
    beginRequestCycle();
    requestedTiles.add(key);
  };

  const onSourceData = (e: RasterTileEvent): void => {
    if (e.sourceId !== sourceId || e.dataType !== 'source') return;
    if (e.tile) {
      errorTimes = [];
      if (deadlineMs !== null) {
        const key = tileEventKey(e);
        if (key !== null) {
          beginRequestCycle();
          requestedTiles.add(key);
          successfulTiles.add(key);
          rendered = true;
        }
      } else if (degraded || !initialSuccessReported) {
        degraded = false;
        initialSuccessReported = true;
        reportOutcome('ready');
      }
    }
    // A source-loaded metadata event can precede viewport tile requests.
    // Require tile evidence before completing independently of map idle.
    if (
      deadlineMs !== null &&
      requestCycleActive &&
      requestedTiles.size > 0 &&
      e.isSourceLoaded === true
    ) {
      finishRequestCycle(options.emptyIdleOutcome ?? 'ready');
    }
  };

  const onSourceAbort = (e: RasterTileEvent): void => {
    if (e.sourceId !== sourceId || e.dataType !== 'source') return;
    const key = tileEventKey(e);
    if (key === null) return;
    requestedTiles.delete(key);
    successfulTiles.delete(key);
  };

  const onIdle = (): void => {
    if (deadlineMs === null || !requestCycleActive) return;
    finishRequestCycle(options.emptyIdleOutcome ?? 'ready');
  };

  map.on('error', onError);
  map.on('sourcedataloading', onSourceLoading);
  map.on('sourcedata', onSourceData);
  map.on('sourcedataabort', onSourceAbort);
  map.on('idle', onIdle);
  map.on('move', onMove);
  if (requestCycleActive) scheduleDeadline();

  return {
    detach(): void {
      map.off('error', onError);
      map.off('sourcedataloading', onSourceLoading);
      map.off('sourcedata', onSourceData);
      map.off('sourcedataabort', onSourceAbort);
      map.off('idle', onIdle);
      map.off('move', onMove);
      clearDeadline();
      errorTimes = [];
      degraded = false;
      requestCycleActive = false;
      requestedTiles.clear();
      successfulTiles.clear();
    },
    reset(): void {
      clearDeadline();
      errorTimes = [];
      degraded = false;
      rendered = false;
      initialSuccessReported = options.reportInitialSuccess !== true;
      requestedTiles = new Set();
      successfulTiles = new Set();
      lastCompletenessOutcome = null;
      requestCycleActive = deadlineMs !== null;
      if (requestCycleActive) scheduleDeadline();
    }
  };
}
