/**
 * Tile-proven readiness for the raster surfaces (DDM-P14-T04, register item
 * found-001; DR-050 a).
 *
 * A raster layer registers a tile template and MapLibre fetches the tiles
 * lazily, so a module that reports `ready` right after `addSource` claims a
 * render nobody has seen. The tile-proven rows (sst-anomaly, gridded-index)
 * therefore reach `ready` only through the shared completeness watcher in
 * `raster-status.ts`, configured once here, and sst-anomaly's stepping path
 * waits on the shared first-tile proof below instead of a private wait that
 * could not tell a proven frame from a timeout.
 *
 * Kept apart from `raster-status.ts` on purpose: that module sits in the
 * Fire 3D activation closure (src/map/fire3d.ts imports it, and
 * src/layers/hillshade.ts, which it also imports, uses it too), whose
 * activation budget has almost no headroom (DR-085). Only the layers that
 * need this wait import it.
 */

import type * as maplibregl from 'maplibre-gl';

import { RASTER_PROOF_DEADLINE_MS } from './raster-status';

/**
 * The completeness watch every tile-proven raster row passes to
 * `watchRasterTiles`. `ready` needs the view's selected-frame tiles; a mixed
 * cycle reads `degraded` (live, partial); a cycle with no tile evidence at
 * all reads `error` (unavailable), never `ready` (DR-050 a: off coverage is
 * not live). The deadline sits below the boot-idle budget.
 */
export const TILE_PROOF_WATCH = {
  reportInitialSuccess: true,
  requestCompletenessDeadlineMs: RASTER_PROOF_DEADLINE_MS,
  emptyIdleOutcome: 'error'
} as const;

/** What a wait proved: at least one tile of the source loaded, or not. */
export type RasterTileProof = 'proven' | 'unproven';

type SourceEvent = { readonly sourceId?: string; readonly tile?: unknown };

/**
 * Wait until a raster source's visible tiles settle (MapLibre's
 * `isSourceLoaded`, which counts an errored tile as settled) or `deadlineMs`
 * passes, and say whether a tile of that source was PROVEN, that is, loaded.
 * A source that settles with every tile failed, a deadline with no tile, and
 * a cancel all resolve `unproven`; only a loaded tile resolves `proven`. The
 * wait itself writes no status: a caller reads `live` only from tile
 * evidence, so an unproven wait can never report `ready`.
 *
 * `proven` seeds evidence gathered before the wait began (a lookahead frame
 * whose tiles loaded while it was hidden). A cancel detaches the listener
 * and clears the deadline at once, leaving no pending work.
 */
export function waitForRasterTileProof(
  map: maplibregl.Map,
  sourceId: string,
  signal: AbortSignal,
  deadlineMs: number = RASTER_PROOF_DEADLINE_MS,
  proven = false
): Promise<RasterTileProof> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('unproven');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      map.off('sourcedata', onData);
      signal.removeEventListener('abort', finish);
      if (timer !== null) clearTimeout(timer);
      resolve(proven && !signal.aborted ? 'proven' : 'unproven');
    };
    const onData = (e: SourceEvent): void => {
      if (e.sourceId !== sourceId) return;
      if (e.tile) proven = true;
      if (map.isSourceLoaded(sourceId)) finish();
    };
    if (map.isSourceLoaded(sourceId)) {
      finish();
      return;
    }
    timer = setTimeout(finish, deadlineMs);
    signal.addEventListener('abort', finish);
    map.on('sourcedata', onData);
  });
}
