/**
 * Shared tile-load watcher for raster layers, in one mode: completeness
 * against a deadline (DDM-P14-T04).
 *
 * The gap it closes: a raster layer registers its XYZ or WMS tile template
 * and reports `ready`, but MapLibre fetches tiles lazily, so a tile-load
 * failure after activation surfaced as blank tiles under a stale "live"
 * pill. The watcher follows one source's tile events.
 *
 * Every consumer passes `requestCompletenessDeadlineMs`; there is no mode
 * without it. The no-deadline policy (the debounced tile-error rule of
 * 2026-07-02: a rolling error window that degrades to `error` on repeated
 * tile failures and heals to `ready` on a loaded tile) lives only in
 * raster-error-watch.ts, which the Fire 3D terrain watch imports directly
 * (fire3d.ts:79, a value import of `watchRasterTiles`). This module does
 * not import it, so no consumer's activation closure built on this
 * module's own runtime carries that chunk; Fire 3D's activation closure
 * carries raster-error-watch.ts instead, not neither module (fire3d.ts:80's
 * import of this module's `RasterTileWatch` type is type-only and
 * contributes no runtime code) (DR-085, DR-142;
 * tests/raster-readiness-contract.test.mjs holds both lines).
 *
 * The verdict is the CURRENT view's, read from the tiles of the source on
 * the map now (the tile manager's ideal tiles and the fallbacks retained for
 * them, fetched or restored from the cache): all loaded reads `ready`, some
 * `degraded` (live, partial), none `error`. A tile request opens a cycle and
 * arms the deadline (the first cycle is open from attach). The view is
 * read when the map idles, when the source settles, on the first frame after
 * a camera move while no cycle is open, and at the deadline, where the
 * found-042 floor holds while a tile of the view is still in flight. Known
 * limit (DDM-P14-T04 C1, carried OPEN to D2 under DR-143, DDM-P1-T11): the
 * deadline reads once and leaves its cycle open, so on a map that does not
 * idle (the 3D scene) a later return to cached tiles is not read again
 * until the next idle or settle; the ordinary 2D map does recover there. A
 * held view whose tiles all fail after the deadline is a different case:
 * MapLibre fires no event for a 404 and no idle follows an all-404 view
 * (:192-193 below; tests/raster-current-view.spec.ts:193-195), so the 2D
 * map gets no idle either, and a live (partial) verdict can persist over
 * the all-failed view until the next interaction on any map. Without a
 * tile manager the verdict falls back to the cycle's request sets, which
 * cannot see a cache restore.
 *
 * Known tradeoff, documented rather than hidden: a viewport entirely outside
 * a service's tile coverage (for example a fully off-coverage pan under the
 * national framing) can 404 every request and read as "unavailable" even
 * though the service is healthy elsewhere (DR-050 a keeps that reading for
 * the tile-proven rows). The same holds for a view that any error fails
 * whole, a transient 5xx included: once every tile of it has settled as
 * errored, the deadline reads "unavailable" even after a rendered frame.
 * Distinguishing "service down" from "no tiles here" would need
 * per-status-code policy and is deferred until a real case shows up.
 */

import type * as maplibregl from 'maplibre-gl';

import { isObject } from './guards';

/**
 * The completeness deadline every tile-proven raster row shares
 * (DDM-P14-T04: sst-anomaly and gridded-index, through TILE_PROOF_WATCH in
 * raster-proof.ts; hillshade is a documented tile-proof exception and
 * attaches no watch). It sits strictly below the 10 s boot-idle budget
 * (src/state/boot-idle.ts), so a row that never proves a tile still reaches
 * a terminal state inside a settled boot.
 * tests/raster-readiness-contract.test.mjs reads it from here.
 */
export const RASTER_PROOF_DEADLINE_MS = 8_000;

export interface RasterTileWatch {
  /** Detach every listener and forget all evidence. Call from deactivate. */
  detach(): void;
  /** Forget accumulated evidence (call after a product swap re-adds the source). */
  reset(): void;
}

export interface RasterTileWatchOptions {
  /**
   * The completeness deadline in milliseconds, positive and finite (every
   * consumer passes a named constant). It starts with the watcher, so even a
   * source that emits no tile events reaches a terminal state, and it is
   * required: this module has no mode without it.
   */
  readonly requestCompletenessDeadlineMs: number;
  /**
   * Read by nothing here: the current-view verdict already reports the first
   * proven tile. It stays so the consumers that set it keep type-checking;
   * only the no-deadline watch (raster-error-watch.ts) acts on it.
   */
  readonly reportInitialSuccess?: boolean;
  /**
   * Outcome for an open cycle whose view holds no tile of the selected
   * frame, when the map idles or the source settles. The default remains
   * `ready` for the bounded-coverage consumers (HeatRisk, WHP, satellite).
   * gridded-index and the SST anomaly set `error` through TILE_PROOF_WATCH
   * because they must prove at least one visible tile (DR-050 a). The
   * deadline reads an empty open cycle as `error` whichever is set (with the
   * found-042 floor after a rendered frame).
   */
  readonly emptyIdleOutcome?: 'ready' | 'error';
}

export type RasterTileOutcome = 'ready' | 'degraded' | 'error';
/** The outcomes an empty view can read: `degraded` needs a loaded tile. */
type EmptyCycleOutcome = Exclude<RasterTileOutcome, 'degraded'>;

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
 * Watch one raster source's tile loads against a completeness deadline.
 * `report` receives the current view's verdict each time that verdict
 * changes (the module header says when the view is read); it is never called
 * after `detach()`. A watch with no deadline is not a mode of this function:
 * it is raster-error-watch.ts's `watchRasterTiles`.
 */
export function watchRasterTiles(
  map: maplibregl.Map,
  sourceId: string,
  report: (state: RasterTileOutcome) => void,
  options: RasterTileWatchOptions
): RasterTileWatch {
  const deadlineMs = options.requestCompletenessDeadlineMs;
  // found-042: a tile of this source has rendered since attach or reset.
  let rendered = false;
  let requestedTiles = new Set<unknown>();
  let successfulTiles = new Set<unknown>();
  // The deadline starts with the watcher, so the first cycle is open at once.
  let requestCycleActive = true;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCompletenessOutcome: RasterTileOutcome | null = null;

  const clearDeadline = (): void => {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };

  const reportCompleteness = (
    emptyCycleOutcome: EmptyCycleOutcome = 'error',
    floorAtPartial = false
  ): void => {
    // [tiles, loaded] for this source on the map now. MapLibre INTERNAL, read
    // behind a guard: `map.style.tileManagers` (MapLibre 6.6,
    // node_modules/maplibre-gl/src/tile/tile_manager.ts). Its ids are the
    // view's ideal tiles and the fallbacks retained for them, whether fetched
    // or restored from the out-of-view cache, which fires no event; a loaded
    // tile that leaves goes to that cache silently.
    let view: [number, number] | undefined;
    // Tiles of the view still in flight: neither loaded nor errored.
    let inFlight = 0;
    try {
      const manager = map.style.tileManagers[sourceId];
      const ids = manager.getIds();
      view = [ids.length, ids.filter((id) => manager.getTileByID(id)?.hasData()).length];
      inFlight = ids.filter((id) => {
        const state = manager.getTileByID(id)?.state;
        return state !== 'loaded' && state !== 'errored';
      }).length;
    } catch {
      // No style, a removed source, a test double, or a MapLibre that moved
      // any of it: the request sets decide, as before the view was read.
    }
    // Outside a cycle, an empty view (a hidden source) keeps its verdict.
    if (!requestCycleActive && !view?.[0]) return;
    const [total, loaded] = view ?? [requestedTiles.size, successfulTiles.size];
    // A frame the view proves has rendered, cache restores included.
    if (loaded) rendered = true;
    let outcome: RasterTileOutcome =
      total === 0
        ? emptyCycleOutcome
        : loaded === 0
          ? 'error'
          : loaded < total
            ? 'degraded'
            : 'ready';
    // found-042: after a rendered frame, a later cycle's deadline alone never
    // reads below live (partial); only settled evidence can. The deadline
    // passes `rendered` here; a finished cycle, idle and the post-move read
    // (whose view has no pending tile) pass nothing. A view whose every tile
    // has settled IS that evidence: MapLibre fires no event for a 404 and no
    // idle follows an all-404 view, so the deadline is its only read. The
    // floor therefore lifts only a view with a tile still in flight, or a
    // verdict read from the request sets without a tile manager.
    if (floorAtPartial && outcome === 'error' && (view === undefined || inFlight > 0)) outcome = 'degraded';
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
    report(outcome);
  };

  const scheduleDeadline = (): void => {
    clearDeadline();
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (!requestCycleActive) return;
      // An open cycle at its deadline: an empty view reads `error`, never the
      // idle outcome, and the found-042 floor holds after a rendered frame.
      reportCompleteness('error', rendered);
    }, deadlineMs);
  };

  // A tile event opens a cycle and arms its deadline. The request sets below
  // decide the verdict ONLY when `reportCompleteness` has no tile manager to
  // read; they are request history, blind to a cache restore and to a loaded
  // tile leaving. For that fallback, a closed cycle with holes carries into
  // the next one (MapLibre fires nothing for a 404 tile while it stays on the
  // map, and may request its fallback parent a frame after the cycle
  // closed): whole while the camera is still, holes only after a move
  // (`onMove` drops every success; a hole leaves with `sourcedataabort`). A
  // cycle without holes starts fresh.
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

  const finishRequestCycle = (emptyCycleOutcome: EmptyCycleOutcome = 'error'): void => {
    clearDeadline();
    reportCompleteness(emptyCycleOutcome);
    requestCycleActive = false;
  };

  const onMove = (): void => {
    if (requestCycleActive) return;
    for (const key of successfulTiles) requestedTiles.delete(key);
    successfulTiles.clear();
  };

  // A camera move that requests nothing (every tile of the new view cached)
  // opens no cycle, so read the view once it is current: at `moveend` the
  // manager still holds the old view (a jump fires `moveend` before the next
  // frame updates the tile managers), so read on that frame's `render`. A
  // move that requested tiles opened a cycle, and its end decides.
  const onRender = (): void => {
    map.off('render', onRender);
    if (!requestCycleActive) reportCompleteness();
  };

  const onMoveEnd = (): void => {
    map.on('render', onRender);
  };

  // The completeness verdict needs the whole view before it can distinguish
  // total failure from usable partial coverage: a failed tile stays in the
  // view (or, without a tile manager, in the request set), so idle or the
  // deadline reports `error` when nothing loaded and `degraded` when
  // something did. The three-error shortcut is the no-deadline watch's
  // (raster-error-watch.ts), so a tile error changes nothing here. The
  // listener stays registered, doing nothing, exactly as the completeness
  // watch's always did: MapLibre prints an error event that no listener
  // hears (`Evented.fire`), so removing it could change what the console
  // shows.
  const onError = (): void => {};

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
      const key = tileEventKey(e);
      if (key !== null) {
        beginRequestCycle();
        requestedTiles.add(key);
        successfulTiles.add(key);
        rendered = true;
      }
    }
    // A source-loaded metadata event can precede viewport tile requests.
    // Require tile evidence before completing independently of map idle.
    if (requestCycleActive && requestedTiles.size > 0 && e.isSourceLoaded === true) {
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

  // Idle reads the view even with no cycle open: a return to cached tiles
  // opens none. With no manager and no cycle, `reportCompleteness` returns.
  const onIdle = (): void => {
    finishRequestCycle(options.emptyIdleOutcome ?? 'ready');
  };

  map.on('error', onError);
  map.on('sourcedataloading', onSourceLoading);
  map.on('sourcedata', onSourceData);
  map.on('sourcedataabort', onSourceAbort);
  map.on('idle', onIdle);
  map.on('move', onMove);
  map.on('moveend', onMoveEnd);
  scheduleDeadline();

  return {
    detach(): void {
      map.off('error', onError);
      map.off('sourcedataloading', onSourceLoading);
      map.off('sourcedata', onSourceData);
      map.off('sourcedataabort', onSourceAbort);
      map.off('idle', onIdle);
      map.off('move', onMove);
      map.off('moveend', onMoveEnd);
      map.off('render', onRender);
      clearDeadline();
      requestCycleActive = false;
      requestedTiles.clear();
      successfulTiles.clear();
    },
    reset(): void {
      clearDeadline();
      rendered = false;
      requestedTiles = new Set();
      successfulTiles = new Set();
      lastCompletenessOutcome = null;
      requestCycleActive = true;
      scheduleDeadline();
    }
  };
}
