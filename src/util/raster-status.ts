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

import type maplibregl from 'maplibre-gl';

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
   * ground sets `error` because it must prove at least one visible tile.
   */
  readonly emptyIdleOutcome?: 'ready' | 'error';
}

type RasterTileOutcome = 'ready' | 'degraded' | 'error';
type BasicRasterTileOutcome = Exclude<RasterTileOutcome, 'degraded'>;

type RasterTileEvent = {
  readonly sourceId?: string;
  readonly dataType?: string;
  readonly isSourceLoaded?: boolean;
  readonly tile?: unknown;
};

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
  report: (state: RasterTileOutcome) => void,
  options: RasterTileWatchOptions & {
    readonly requestCompletenessDeadlineMs: number;
  }
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
    | ((state: RasterTileOutcome) => void)
    | ((state: BasicRasterTileOutcome) => void),
  options: RasterTileWatchOptions = {}
): RasterTileWatch {
  const reportOutcome = report as (state: RasterTileOutcome) => void;
  let errorTimes: number[] = [];
  let degraded = false;
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
  let lastCompletenessOutcome: RasterTileOutcome | null = null;

  const clearDeadline = (): void => {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };

  const reportCompleteness = (
    emptyCycleOutcome: RasterTileOutcome = 'error'
  ): void => {
    const outcome: RasterTileOutcome =
      requestedTiles.size === 0
        ? emptyCycleOutcome
        : successfulTiles.size === 0
          ? 'error'
          : successfulTiles.size < requestedTiles.size
            ? 'degraded'
            : 'ready';
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
      reportCompleteness();
    }, deadlineMs);
  };

  const beginRequestCycle = (): void => {
    if (requestCycleActive) return;
    requestCycleActive = true;
    requestedTiles = new Set();
    successfulTiles = new Set();
    lastCompletenessOutcome = null;
    scheduleDeadline();
  };

  const finishRequestCycle = (
    emptyCycleOutcome: RasterTileOutcome = 'error'
  ): void => {
    clearDeadline();
    reportCompleteness(emptyCycleOutcome);
    requestCycleActive = false;
  };

  const onError = (e: { error?: Error; sourceId?: string }): void => {
    if (e.sourceId !== sourceId) return;
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
  if (requestCycleActive) scheduleDeadline();

  return {
    detach(): void {
      map.off('error', onError);
      map.off('sourcedataloading', onSourceLoading);
      map.off('sourcedata', onSourceData);
      map.off('sourcedataabort', onSourceAbort);
      map.off('idle', onIdle);
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
      initialSuccessReported = options.reportInitialSuccess !== true;
      requestedTiles = new Set();
      successfulTiles = new Set();
      lastCompletenessOutcome = null;
      requestCycleActive = deadlineMs !== null;
      if (requestCycleActive) scheduleDeadline();
    }
  };
}
