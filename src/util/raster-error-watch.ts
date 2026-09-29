/**
 * The no-deadline raster tile watch: the debounced tile-error honesty policy
 * (designed 2026-07-02), alone.
 *
 * It follows one source's `error` and `sourcedata` events and keeps a
 * status honest both ways:
 *
 * - Degrade on evidence, not on a blip. Tile errors accumulate in a rolling
 *   window; only when ERROR_THRESHOLD errors land inside WINDOW_MS with no
 *   successful tile load in between does the watch report `error`. A single
 *   transient tile failure (one dropped request on a working service) never
 *   flips a working source to "unavailable".
 * - Self-heal on a successful tile event. Any tile that loads clears the
 *   error window, and if the watch had degraded it reports `ready` again. A
 *   tile MapLibre restores from its cache fires no event, so a return to a
 *   view already seen heals only once some tile of it loads afresh.
 *
 * This is the one copy of the policy. raster-status.ts has no no-deadline
 * mode and does not import this module, so no raster-status closure (the
 * heatrisk-days row among them) carries it. The Fire 3D terrain watch
 * (src/map/fire3d.ts) imports it from here directly, so the
 * Fire 3D activation closure (DR-085; the fire3d-mode row of
 * scripts/check-activation-budget.mjs) carries none of raster-status.ts's
 * completeness mode (DR-142). Keep it that way: this module imports
 * raster-status.ts for a type only, which the build erases
 * (tests/raster-readiness-contract.test.mjs holds the line).
 */

import type * as maplibregl from 'maplibre-gl';

import { isObject } from './guards';
import type { RasterTileWatch } from './raster-status';

/** Tile errors older than this rolling window no longer count. */
const WINDOW_MS = 10_000;

/**
 * Errors inside the window required before the watch degrades. A viewport
 * at the zooms this module serves loads roughly six to twelve tiles, so a
 * real outage crosses three failures within a second or two, while a single
 * dropped request stays safely under the threshold.
 */
const ERROR_THRESHOLD = 3;

export interface RasterErrorWatchOptions {
  /**
   * Report the first successful tile (and the first after each `reset`).
   * Omitted, the watch keeps the original heal-after-error behavior.
   */
  readonly reportInitialSuccess?: boolean;
}

type RasterTileEvent = {
  readonly sourceId?: string;
  readonly dataType?: string;
  readonly tile?: unknown;
};

/**
 * Read the source id off an error event. MapLibre attaches the failing
 * source's id through the style's evented-parent data, but the v6
 * `ErrorEvent` type declares only `error`, so the id is read through a
 * guard rather than an assertion. A generic map error carries no id and is
 * ignored.
 */
function errorSourceId(e: maplibregl.ErrorEvent): string | null {
  return isObject(e) && typeof e.sourceId === 'string' ? e.sourceId : null;
}

/**
 * Watch one raster source's tile loads with no completeness deadline.
 * `report` receives `error` when the degrade threshold is crossed and
 * `ready` when a later successful tile load heals it (or, with
 * `reportInitialSuccess`, when the first tile loads). It is never called
 * after `detach()`.
 */
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report: (state: 'ready' | 'error') => void,
  options: RasterErrorWatchOptions = {}
): RasterTileWatch {
  let errorTimes: number[] = [];
  let degraded = false;
  let initialSuccessReported = options.reportInitialSuccess !== true;

  const onError = (e: maplibregl.ErrorEvent): void => {
    if (errorSourceId(e) !== sourceId) return;
    const now = Date.now();
    errorTimes = errorTimes.filter((t) => now - t < WINDOW_MS);
    errorTimes.push(now);
    if (!degraded && errorTimes.length >= ERROR_THRESHOLD) {
      degraded = true;
      console.warn(`[${sourceId}] repeated tile-load failures; reporting unavailable.`, e.error);
      report('error');
    }
  };

  const onSourceData = (e: RasterTileEvent): void => {
    if (e.sourceId !== sourceId || e.dataType !== 'source' || !e.tile) return;
    errorTimes = [];
    if (degraded || !initialSuccessReported) {
      degraded = false;
      initialSuccessReported = true;
      report('ready');
    }
  };

  map.on('error', onError);
  map.on('sourcedata', onSourceData);

  return {
    detach(): void {
      map.off('error', onError);
      map.off('sourcedata', onSourceData);
      errorTimes = [];
      degraded = false;
    },
    reset(): void {
      errorTimes = [];
      degraded = false;
      initialSuccessReported = options.reportInitialSuccess !== true;
    }
  };
}
