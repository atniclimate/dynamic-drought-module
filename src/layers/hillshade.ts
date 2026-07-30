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

import maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import {
  HILLSHADE_SHADOW,
  HILLSHADE_HIGHLIGHT,
  HILLSHADE_EXAGGERATION
} from '../config/palette';
import { firstLayerIdAbove, BOTTOM_STACK_IDS } from '../map/layer-order';
import { fetchWithBudget } from '../util/fetch';
import { registry } from '../state/registry';

const LAYER_KEY = 'hillshade';
const SOURCE_ID = 'hillshade-dem';
const LAYER_ID = 'hillshade';

/** Whether the map-level error listener for the DEM source is wired. */
let errorListenerWired = false;

/** Fade targets for the sidebar's toggle transitions (LayerModule contract). */
export const fadeLayerIds = [LAYER_ID] as const;

/** Budget for the archive-header probe (same-origin, first 16 KiB). */
const PROBE_TIMEOUT_MS = 10_000;

let masterController: AbortController | null = null;

function reportStatus(state: 'loading' | 'ready' | 'error'): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Probe the archive HEADER before trusting it (the stage-5 adversarial
 * major 7: a 200 HTML fallback, a corrupt file, or a server that ignores
 * Range would otherwise pass and fail later as a silent style error).
 * Requires the response to be OK, reads only the leading bytes, and
 * validates the PMTiles v3 magic ("PMTiles", 0x50 4D 54 69 6C 65 73) plus
 * spec version 3 at byte 7. A 206 is the expected shape; a 200 is
 * tolerated (some dev servers ignore Range) because only the first bytes
 * are read from the stream before cancelling.
 */
async function probeArchiveHeader(
  url: string,
  signal: AbortSignal
): Promise<void> {
  const response = await fetchWithBudget(
    url,
    { headers: { Range: 'bytes=0-127' } },
    signal,
    PROBE_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('unreadable response body');
  let bytes = new Uint8Array(0);
  while (bytes.length < 8) {
    const { done, value } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(bytes.length + value.length);
    merged.set(bytes);
    merged.set(value, bytes.length);
    bytes = merged;
  }
  void reader.cancel().catch(() => undefined);
  const magic = String.fromCharCode(...bytes.slice(0, 7));
  if (magic !== 'PMTiles' || bytes[7] !== 3) {
    throw new Error('not a PMTiles v3 archive (magic mismatch)');
  }
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
    map.on('error', (e: { sourceId?: string }) => {
      if (e?.sourceId !== SOURCE_ID) return;
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
