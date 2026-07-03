/**
 * United States Department of Agriculture (USDA) Forest Service (USFS)
 * Wildfire Hazard Potential (WHP) layer.
 *
 * WHP is a five-class index (1=Very Low through 5=Very High) that quantifies
 * the relative potential for high-intensity wildfire across the conterminous
 * United States, produced by the USFS Rocky Mountain Research Station using
 * the FSim large-fire simulation system together with LANDFIRE 2020
 * vegetation and fuels data. Resolution is 270 m. The dataset is the
 * authoritative national WHP product as of the 2023 update; previous
 * vintages (2014, 2018, 2020, and the 2023 standalone images) were
 * superseded by a unified service in 2025.
 *
 * Endpoint choice. Three transport options were evaluated during M9:
 *   a. USFS Geospatial Data Discovery (GDD) image service at
 *      `apps.fs.usda.gov` -- HTTP 403 (Microsoft IIS) for a CORS preflight
 *      from a GitHub Pages origin; not usable from the browser.
 *   b. Open Geospatial Consortium (OGC) Web Map Service (WMS) on the
 *      same host -- same 403, same reason.
 *   c. Federal GeoPlatform imagery host
 *      `imagery.geoplatform.gov/iipp/...` -- this is the unified WHP
 *      ImageServer that the USFS ArcGIS Hub item points to. Returns
 *      Portable Network Graphics (PNG) tiles via the Environmental
 *      Systems Research Institute (ESRI) ImageServer `exportImage`
 *      operation. Cross-Origin Resource Sharing (CORS) is configured
 *      with origin echo (`Access-Control-Allow-Origin: <Origin>` under
 *      `Vary: Origin`) and the deployed origin
 *      `https://atniclimate.github.io` is allowed.
 *
 * Option (c) is the cleanest browser-reachable choice; we use it. Because
 * the service is an ImageServer (not a tile server) we do not have a
 * native XYZ tile template. Instead, MapLibre's raster source pulls each
 * tile via `exportImage` with the per-tile bounding box expanded from the
 * `{bbox-epsg-3857}` token. ESRI ImageServer accepts `bboxSR=3857` and
 * `imageSR=3857`, which keeps the projection round-trip lossless.
 *
 * Verification (2026-05-09):
 *   GET <URLS.usfsWhp>?f=json
 *     - HTTP 200, Content-Type: application/json;charset=UTF-8
 *     - Access-Control-Allow-Origin: https://atniclimate.github.io
 *     - Body confirms 5-class thematic ImageServer at 270 m, 3857.
 *   GET <URLS.usfsWhp>/exportImage?bbox=...&size=256,256&format=png&f=image
 *     - HTTP 200, Content-Type: image/png
 *     - Access-Control-Allow-Origin: https://atniclimate.github.io
 *     - Body: 256x256 PNG.
 *
 * Render. Raster source at 0.55 opacity so the basemap and
 * the USDM/Treaty/Tribal overlays remain legible underneath. The
 * conventional five-class palette is encoded server-side in the
 * `WHP_CLS_2023_8bit` raster function, so we do not need to recolor on
 * the client; we only choose the layer opacity. The reference palette
 * for the legend (rendered by M8 sidebar work, not this module) is
 * `['#1a9850', '#91cf60', '#fee08b', '#fc8d59', '#d73027']` matching
 * Very Low, Low, Moderate, High, Very High.
 */

import type maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import { registry } from '../state/registry';
import { watchRasterTiles, type RasterTileWatch } from '../util/raster-status';

const LAYER_KEY = 'usfs-whp';
const SOURCE_ID = 'usfs-whp';
const LAYER_ID = 'usfs-whp';

/** The tile-load honesty watcher (util/raster-status.ts); null when inactive. */
let tileWatch: RasterTileWatch | null = null;

type WhpStatus = 'loading' | 'ready' | 'error';

function reportStatus(state: WhpStatus): void {
  registry.setStatus(LAYER_KEY, state);
}

/**
 * Build the ESRI ImageServer `exportImage` URL template. MapLibre expands
 * `{bbox-epsg-3857}` to the tile's `minX,minY,maxX,maxY` extent in EPSG:3857
 * meters; the server projects and clips the WHP raster into a 256x256 PNG
 * for that extent. `imageSR=3857` and `bboxSR=3857` eliminate any
 * server-side reprojection so tile alignment matches MapLibre's expectation
 * exactly. `transparent=true` ensures the no-data and out-of-extent regions
 * (the WHP coverage is conterminous United States only) come back with an
 * alpha channel rather than a black or white border.
 */
function buildImageTileTemplate(): string {
  const params = [
    'bbox={bbox-epsg-3857}',
    'bboxSR=3857',
    'imageSR=3857',
    'size=256,256',
    'format=png',
    'transparent=true',
    'f=image'
  ].join('&');
  return `${URLS.usfsWhp}/exportImage?${params}`;
}

/**
 * Add the WHP raster source and layer to the map. Idempotent: a second
 * call with an existing source/layer is a no-op so URL-as-state restore
 * cannot stack duplicates.
 *
 * Network failures during the synchronous source addition are extremely
 * uncommon (MapLibre defers actual tile requests) but we still wrap the
 * setup in try/catch so a misconfiguration surfaces as `'error'`
 * instead of throwing into the caller's activation flow.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  reportStatus('loading');

  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [buildImageTileTemplate()],
        tileSize: 256,
        attribution: 'USDA Forest Service - Wildfire Hazard Potential'
      });
    }

    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          // 0.55 opacity preserves basemap topography and lets the USDM /
          // NIFC overlays read clearly when stacked above WHP.
          'raster-opacity': 0.55
        }
      });
    }

    tileWatch?.detach();
    tileWatch = watchRasterTiles(map, SOURCE_ID, reportStatus);
    reportStatus('ready');
  } catch (err) {
    console.warn('[usfs-whp] activation failed.', err);
    reportStatus('error');
  }
}

/**
 * Remove the WHP raster layer and source from the map. Symmetric with
 * `activate`; safe to call when the layer was never activated.
 */
export function deactivate(map: maplibregl.Map): void {
  tileWatch?.detach();
  tileWatch = null;
  if (map.getLayer(LAYER_ID)) {
    map.removeLayer(LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
}

/**
 * No-op popup binder. WHP is a server-rendered raster: we do not have
 * per-pixel attributes on the client, so there is nothing to attach a
 * click handler to. The interactive `identify` operation against
 * ImageServer is left to a future milestone (it would require a separate
 * `identify` call per click, which is out of scope for M9).
 *
 * The function is exported with the same shape as the GeoJSON layer
 * modules so the LayerRegistry (M7) can call it uniformly without
 * branching on layer kind.
 */
export function bindPopups(_map: maplibregl.Map): void {
  // Intentionally empty; WHP is a raster layer with no client-side
  // attributes. See JSDoc above.
}
