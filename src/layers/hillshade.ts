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
 * Elevation is public physical reference data, not sovereign-jurisdiction
 * data (ddm-terrain-elevation stewardship note); bundling it is consistent
 * with hard rule 1.
 */

import * as maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import {
  HILLSHADE_SHADOW,
  HILLSHADE_HIGHLIGHT,
  HILLSHADE_EXAGGERATION
} from '../config/palette';
import { firstLayerIdAbove, BOTTOM_STACK_IDS } from '../map/layer-order';
import { probeArchiveHeader } from '../util/pmtiles-probe';
import { isObject } from '../util/guards';
import { registry } from '../state/registry';

const LAYER_KEY = 'hillshade';
const SOURCE_ID = 'hillshade-dem';
const LAYER_ID = 'hillshade';

/** Whether the map-level error listener for the DEM source is wired. */
let errorListenerWired = false;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

let masterController: AbortController | null = null;

function reportStatus(state: 'loading' | 'ready' | 'error'): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Prefer the deployer's bundled archive. A host with a per-file size ceiling
 * may omit it and use the verified byte-identical ATNI copy instead.
 */
export async function resolveHillshadeArchiveUrl(
  signal: AbortSignal
): Promise<string> {
  try {
    await probeArchiveHeader(URLS.hillshadePmtilesLocal, signal);
    return URLS.hillshadePmtilesLocal;
  } catch (localError) {
    if (signal.aborted) throw localError;
    try {
      await probeArchiveHeader(URLS.hillshadePmtilesFallback, signal);
      return URLS.hillshadePmtilesFallback;
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
 * Probe the archive, then add the raster-dem source and the hillshade
 * layer. Idempotent: a second call with the source present is a no-op.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let archiveUrl: string;
  try {
    archiveUrl = await resolveHillshadeArchiveUrl(signal);
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[hillshade] the terrain archive is unreachable or invalid.', err);
    reportStatus('error');
    return;
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
    // Into the bottom stack (layer-order.ts): under every data layer, over
    // the basemap and satellite, in any activation order.
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
  } catch (err) {
    // Transactional rollback: a half-built setup must not make the next
    // toggle a silent no-op.
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    console.warn('[hillshade] setup failed.', err);
    reportStatus('error');
    return;
  }

  if (!errorListenerWired) {
    errorListenerWired = true;
    // Async tile/source failures after a clean probe (a truncated file, a
    // CDN hiccup) downgrade the pill instead of staying a silent style
    // error; the layer stays for a manual retry via the toggle.
    map.on('error', (e: maplibregl.ErrorEvent) => {
      // MapLibre attaches the failing source's id to the error event
      // through the style's evented-parent data, but the v6 `ErrorEvent`
      // type declares only `error`, so read it through a guard. A generic
      // map error carries no id and is ignored, exactly as before.
      const sourceId = isObject(e) && typeof e.sourceId === 'string' ? e.sourceId : null;
      if (sourceId !== SOURCE_ID) return;
      if (!map.getLayer(LAYER_ID)) return;
      reportStatus('error');
    });
  }

  reportStatus('ready');
}

/**
 * Abort any in-flight probe and remove the layer and source. Defensive
 * guards so callers can invoke `deactivate` without checking state first.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
