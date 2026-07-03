/**
 * Shared tile-load watcher for raster layers: the debounced tile-error
 * honesty policy (TODO.md [0.3.0], designed 2026-07-02).
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

/**
 * Watch one raster source's tile loads and report honest status changes.
 * `report` receives `error` when the degrade threshold is crossed and
 * `ready` when a later successful tile load heals it; it is never called
 * after `detach()`.
 */
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report: (state: 'ready' | 'error') => void
): RasterTileWatch {
  let errorTimes: number[] = [];
  let degraded = false;

  const onError = (e: { error?: Error; sourceId?: string }): void => {
    if (e.sourceId !== sourceId) return;
    const now = Date.now();
    errorTimes = errorTimes.filter((t) => now - t < WINDOW_MS);
    errorTimes.push(now);
    if (!degraded && errorTimes.length >= ERROR_THRESHOLD) {
      degraded = true;
      console.warn(`[${sourceId}] repeated tile-load failures; reporting unavailable.`, e.error);
      report('error');
    }
  };

  const onSourceData = (e: { sourceId?: string; dataType?: string; tile?: unknown }): void => {
    if (e.sourceId !== sourceId || e.dataType !== 'source' || !e.tile) return;
    errorTimes = [];
    if (degraded) {
      degraded = false;
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
    }
  };
}
