/**
 * Terrain shading (U4g, 0.7.0).
 *
 * A MapLibre `hillshade` layer over the bundled raster-dem PMTiles archive
 * (public/data/hillshade-dem-pnw.pmtiles: USGS 3D Elevation Program via the
 * 3DEPElevation ImageServer, terrarium-encoded, 512 px tiles, zooms 0-8,
 * whole-meter quantized. Above
 * zoom 8 MapLibre overzooms the deepest level, which reads as progressively
 * softer shading; acceptable by design for a SUBTLE underlay (the
 * cartography lens), and the honest trade for an archive that fits the
 * same-origin Pages hosting path (D-0.7.0-029).
 *
 * Stacking: the shading sits directly above the basemap (and above the
 * satellite layer when active) and below every data layer, so terrain
 * texture never competes with a thematic surface's color statement.
 *
 * Status honesty: the archive header is probed with a budgeted fetch before
 * the source is added, so a missing or unpublished archive reads
 * `unavailable` on the pill instead of a silent style error (invariant 6).
 *
 * Documented tile-proof exception (DDM-P14-T04, director's ruling): every
 * other raster row in this build (gridded-index, sst-anomaly) waits for
 * `watchRasterTiles` to prove a real tile before it reports `ready`. This
 * layer does not. Measured at build time: with the shared tile-proof watcher
 * wired here, the Fire 3D pair (fire3d-mode.spec.ts, view-contracts.spec.ts)
 * fell from 57/59 to 47/59, because the 3D scene's own animation suppresses
 * map idle, so the proof waits out its full deadline on every 3D boot; with
 * this layer restored to a probe-then-add design (no tile proof) the pair
 * returned to 58/59. The archive is bundled, same-origin and deterministic
 * (no upstream provider to fail after a clean probe), so the residual risk
 * a tile proof would catch here is small next to the 3D cost it imposes.
 *
 * Elevation is public physical reference data, not sovereign-jurisdiction
 * data (ddm-terrain-elevation stewardship note); bundling it is consistent
 * with hard rule 1.
 */

import type * as maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import {
  HILLSHADE_SHADOW,
  HILLSHADE_HIGHLIGHT,
  HILLSHADE_EXAGGERATION
} from '../config/palette';
import { firstLayerIdAbove, BOTTOM_STACK_IDS } from '../map/layer-order';
import type { LayerActivation } from '../config/layers';
import { linkAbort } from '../util/fetch';
import { probeArchiveHeader } from '../util/pmtiles-probe';
import type { PmtilesHeader } from '../util/pmtiles-probe';
import { isObject } from '../util/guards';
import { registry } from '../state/registry';

const LAYER_KEY = 'hillshade';
const SOURCE_ID = 'hillshade-dem';
const LAYER_ID = 'hillshade';

/**
 * The map-level error listener for the DEM source, if one is wired. Kept
 * per-instance (not a "wired once, ever" module flag) and removed in
 * `deactivate`: the flag design left a listener attached to whichever map
 * first activated the layer and never rewired it for a later map instance
 * (a mode switch or a fresh boot in a test), so a second map's tile errors
 * went unheard while the first map kept a listener no one would ever
 * detach.
 */
let errorHandler: ((e: maplibregl.ErrorEvent) => void) | null = null;
let errorHandlerMap: maplibregl.Map | null = null;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

let masterController: AbortController | null = null;

function reportStatus(state: 'loading' | 'ready' | 'error'): void {
  registry.setStatus(LAYER_KEY, state);
}

/** The bundled archive that answered its probe, with the header it declared. */
export interface ResolvedHillshadeArchive {
  readonly url: string;
  readonly header: PmtilesHeader;
}

/**
 * Prefer the deployer's bundled archive. A host with a per-file size ceiling
 * may omit it and use the verified byte-identical ATNI copy instead.
 */
export async function resolveHillshadeArchiveUrl(
  signal: AbortSignal
): Promise<string> {
  return (await resolveHillshadeArchive(signal)).url;
}

/**
 * The same ladder, keeping the probed header: the 3D scene's coverage
 * sentence names the depth of the archive that actually resolved (DR-083),
 * and the header is where that depth lives.
 */
export async function resolveHillshadeArchive(
  signal: AbortSignal
): Promise<ResolvedHillshadeArchive> {
  try {
    const header = await probeArchiveHeader(URLS.hillshadePmtilesLocal, signal);
    return { url: URLS.hillshadePmtilesLocal, header };
  } catch (localError) {
    if (signal.aborted) throw localError;
    try {
      const header = await probeArchiveHeader(URLS.hillshadePmtilesFallback, signal);
      return { url: URLS.hillshadePmtilesFallback, header };
    } catch (fallbackError) {
      if (signal.aborted) throw fallbackError;
      const localMessage =
        localError instanceof Error ? localError.message : String(localError);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `local archive failed (${localMessage}); ATNI fallback failed (${fallbackMessage})`
      );
    }
  }
}

/**
 * Add the hillshade layer over an already-present source, in the bottom
 * stack (layer-order.ts): under every data layer, over the basemap and
 * satellite, in any activation order. Factored out so the fresh-activation
 * path and the "source survived, layer did not" repair path add the exact
 * same layer definition; the two must never diverge.
 */
function addHillshadeLayer(map: maplibregl.Map): void {
  map.addLayer(
    {
      id: LAYER_ID,
      type: 'hillshade',
      source: SOURCE_ID,
      paint: {
        'hillshade-exaggeration': HILLSHADE_EXAGGERATION,
        'hillshade-shadow-color': HILLSHADE_SHADOW,
        'hillshade-highlight-color': HILLSHADE_HIGHLIGHT
      }
    },
    firstLayerIdAbove(map, BOTTOM_STACK_IDS)
  );
}

/**
 * Probe the archive, then add the raster-dem source and the hillshade
 * layer. Idempotent: a second call with the source already present skips
 * the probe and the source setup, but still reports the layer's terminal
 * status, and restores the layer itself if only the layer (not the
 * source) is missing. A caller may set `loading` and then reuse an
 * existing source (an activation the layer controller does not always
 * skip, since it only checks its own active-key set, not this module's
 * source state); without the checks below that `loading` was never
 * resolved, and the pill (and anything reading the registry) never
 * learns the retained source is actually `ready` -- and a style that
 * dropped just the layer (removeLayer without removeSource, or a style
 * reset that MapLibre repopulates sources for but not custom layers)
 * stayed invisible on the map while the pill still read `ready`
 * (review finding C6).
 */
export async function activate(
  map: maplibregl.Map,
  activation?: LayerActivation
): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    if (!map.getLayer(LAYER_ID)) {
      try {
        addHillshadeLayer(map);
      } catch (err) {
        console.warn('[hillshade] layer restore over an existing source failed.', err);
        reportStatus('error');
        return;
      }
    }
    reportStatus('ready');
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  // The controller-owned attempt signal joins the private controller, so an
  // off intent aborts the held archive read at that moment and not at the
  // queued teardown behind the probe budget (plan rule 5, found-131). The
  // link lasts only while the read is held.
  const unlink = linkAbort(masterController, activation?.signal ?? null);

  reportStatus('loading');

  let archiveUrl: string;
  try {
    archiveUrl = await resolveHillshadeArchiveUrl(signal);
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[hillshade] the terrain archive is unreachable or invalid.', err);
    reportStatus('error');
    return;
  } finally {
    unlink();
  }
  if (signal.aborted) return;

  if (map.getSource(SOURCE_ID)) return;
  try {
    map.addSource(SOURCE_ID, {
      type: 'raster-dem',
      url: 'pmtiles://' + archiveUrl,
      encoding: 'terrarium',
      tileSize: 512
    });
    addHillshadeLayer(map);
  } catch (err) {
    // Transactional rollback: a half-built setup must not make the next
    // toggle a silent no-op.
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    console.warn('[hillshade] setup failed.', err);
    reportStatus('error');
    return;
  }

  // Wire this map instance's own error listener, replacing (never
  // stacking on top of) any earlier one first: async tile/source failures
  // after a clean probe (a truncated file, a CDN hiccup) downgrade the
  // pill instead of staying a silent style error, and the layer stays for
  // a manual retry via the toggle.
  if (errorHandler && errorHandlerMap) {
    errorHandlerMap.off('error', errorHandler);
  }
  errorHandler = (e: maplibregl.ErrorEvent) => {
    // MapLibre attaches the failing source's id to the error event
    // through the style's evented-parent data, but the v6 `ErrorEvent`
    // type declares only `error`, so read it through a guard. A generic
    // map error carries no id and is ignored, exactly as before.
    const sourceId = isObject(e) && typeof e.sourceId === 'string' ? e.sourceId : null;
    if (sourceId !== SOURCE_ID) return;
    if (!map.getLayer(LAYER_ID)) return;
    reportStatus('error');
  };
  errorHandlerMap = map;
  map.on('error', errorHandler);

  reportStatus('ready');
}

/**
 * Abort any in-flight probe, detach this instance's error listener, and
 * remove the layer and source. Defensive guards so callers can invoke
 * `deactivate` without checking state first.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (errorHandler && errorHandlerMap) {
    errorHandlerMap.off('error', errorHandler);
  }
  errorHandler = null;
  errorHandlerMap = null;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
