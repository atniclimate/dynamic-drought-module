/**
 * NWS HeatRisk layer (experimental product; E2).
 *
 * Renders today's National Weather Service / Weather Prediction Center
 * HeatRisk class raster: five classes of expected heat impact (0 little to
 * none, 1 minor, 2 moderate, 3 major, 4 extreme), CONUS coverage, colorized
 * server-side per the published HeatRisk legend. NWS flags the product as
 * experimental; the sidebar label says so and the attribution carries the
 * agency name.
 *
 * Time handling (the load-bearing caveat from adversarial verification; see
 * `URLS.nwsHeatRisk` in urls.ts): the ImageServer is a rolling 6-day
 * forecast mosaic, and a request WITHOUT a `time` parameter serves an
 * arbitrary forecast day (verified: the +2-day raster), not today. This
 * module therefore reads `timeInfo.timeExtent[0]` (the current issuance's
 * first forecast day) from the service metadata at every activation and
 * bakes it into the tile template as `time=<epoch ms>`. If the metadata
 * fetch fails the layer reports `'error'` rather than guessing a time;
 * showing the wrong day's heat forecast without saying so would violate the
 * honest-feedback invariant. A session left open across the daily issuance
 * keeps the activation-time day until the layer is toggled off and on;
 * `deactivate` then `activate` refreshes it.
 *
 * Raster pattern follows `usfs-whp.ts` (ESRI ImageServer exportImage via
 * MapLibre's `{bbox-epsg-3857}` template); the metadata fetch follows the
 * cancellation contract (CLAUDE.md section 6 invariant 5).
 */

import type maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import { registry } from '../state/registry';

const LAYER_KEY = 'heatrisk';
const SOURCE_ID = 'heatrisk';
const LAYER_ID = 'heatrisk';

/** Per-call network budget for the service-metadata fetch. */
const FETCH_TIMEOUT_MS = 10_000;

type Status = 'loading' | 'ready' | 'error';

/**
 * Master cancellation controller for the metadata fetch. Aborted on
 * `deactivate` and replaced on each `activate`.
 */
let masterController: AbortController | null = null;

function reportStatus(state: Status): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Read the start of the service's advertised time extent (epoch
 * milliseconds of the current issuance's first forecast day). Returns null
 * when the metadata does not carry a usable extent.
 */
function extractTimeExtentStart(json: unknown): number | null {
  if (!isObject(json)) return null;
  const timeInfo = json.timeInfo;
  if (!isObject(timeInfo)) return null;
  const extent = timeInfo.timeExtent;
  if (!Array.isArray(extent) || extent.length < 1) return null;
  const start = extent[0];
  return typeof start === 'number' && Number.isFinite(start) ? start : null;
}

/**
 * Build the exportImage tile template with the day-1 `time` baked in.
 * MapLibre substitutes `{bbox-epsg-3857}` per tile; everything else is
 * static for the lifetime of this activation.
 */
function buildImageTileTemplate(timeMs: number): string {
  const params = [
    'bbox={bbox-epsg-3857}',
    'bboxSR=3857',
    'imageSR=3857',
    'size=256,256',
    'format=png32',
    'transparent=true',
    `time=${timeMs}`,
    'f=image'
  ].join('&');
  return `${URLS.nwsHeatRisk}/exportImage?${params}`;
}

/**
 * Resolve today's issuance time from the service metadata, then add the
 * raster source and layer. Idempotent. A metadata failure is `'error'`;
 * there is no honest fallback (see the module comment).
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(SOURCE_ID)) {
    return;
  }

  // Supersede any prior in-flight metadata fetch.
  if (masterController) masterController.abort();
  masterController = new AbortController();
  const signal = masterController.signal;

  reportStatus('loading');

  let timeMs: number | null = null;
  try {
    const response = await fetchWithBudget(
      `${URLS.nwsHeatRisk}?f=json`,
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    timeMs = extractTimeExtentStart(await response.json());
  } catch (err) {
    if (signal.aborted) return;
    console.warn('[heatrisk] service metadata fetch failed.', err);
    reportStatus('error');
    return;
  }

  if (signal.aborted) return;

  if (timeMs === null) {
    // No advertised time extent: refusing to guess which forecast day the
    // mosaic would serve. Error, not a silent wrong-day render.
    console.warn('[heatrisk] service metadata carried no time extent.');
    reportStatus('error');
    return;
  }

  map.addSource(SOURCE_ID, {
    type: 'raster',
    tiles: [buildImageTileTemplate(timeMs)],
    tileSize: 256,
    attribution: 'NOAA NWS HeatRisk (experimental)'
  });

  map.addLayer({
    id: LAYER_ID,
    type: 'raster',
    source: SOURCE_ID,
    paint: {
      'raster-opacity': 0.55
    }
  });

  reportStatus('ready');
}

/**
 * Abort any in-flight metadata fetch and remove the layer and source.
 * Toggling the layer back on re-resolves the issuance time, which is also
 * the refresh path across the daily issuance boundary.
 */
export function deactivate(map: maplibregl.Map): void {
  if (masterController) {
    masterController.abort();
    masterController = null;
  }
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
