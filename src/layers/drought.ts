/**
 * NOAA Climate Prediction Center (CPC) Seasonal Drought Outlook layer.
 *
 * Direct port of the `loadDrought` function from the vanilla `app.js`
 * baseline (lines ~703 to 723) onto MapLibre GL JavaScript. The upstream
 * service is a Web Map Service (WMS) endpoint hosted by the National
 * Oceanic and Atmospheric Administration (NOAA) CPC. We render it as a
 * MapLibre raster source whose tiles are GET requests against the WMS
 * GetMap operation.
 *
 * Layer choice. The WMS GetCapabilities document advertises four numbered
 * layers:
 *   1  Seasonal Drought Outlook For US Island Territories
 *   2  Seasonal Drought Outlook For US and Puerto Rico
 *   4  Monthly  Drought Outlook For US Island Territories
 *   5  Monthly  Drought Outlook For US and Puerto Rico
 * The vanilla baseline used `LAYERS=0`, which appears to be a synthetic
 * combined view that the server still honors but is not formally listed.
 * For the Pacific Northwest (PNW) deployment we explicitly select
 * `LAYERS=2` (Seasonal Drought Outlook For US and Puerto Rico) because
 * that is the product the README documents and it is a stable, listed
 * layer identifier.
 *
 * STYLES quirk. The CPC WMS server rejects requests that omit the
 * `STYLES` query parameter entirely with HTTP 400 and ServiceException
 * `StylesNotDefined`. An empty value (`STYLES=`) is accepted and selects
 * the layer's default style. This was verified during the v0.1.2 polish
 * pass; do not strip the empty `STYLES=` from the URL template.
 *
 * CRS quirk. WMS 1.3.0 spells the projection parameter `CRS`. The older
 * 1.1.1 dialect used `SRS`. We pin `VERSION=1.3.0` and pass
 * `CRS=EPSG:3857` so MapLibre's `{bbox-epsg-3857}` token expands into a
 * matching projection.
 */

import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';

const SOURCE_ID = 'drought-outlook';
const LAYER_ID = 'drought-outlook';
const LEGEND_ID = 'legend-panel';

/**
 * Build the WMS GetMap URL template that MapLibre will expand per tile.
 * The `{bbox-epsg-3857}` token is replaced by MapLibre with the tile's
 * `minX,minY,maxX,maxY` extent in EPSG:3857 meters, which the WMS server
 * uses to render the matching slice of the Seasonal Drought Outlook.
 */
function buildWmsTileTemplate(): string {
  const params = [
    'SERVICE=WMS',
    'VERSION=1.3.0',
    'REQUEST=GetMap',
    'LAYERS=2',
    // Empty STYLES is REQUIRED; the server returns HTTP 400 if absent.
    'STYLES=',
    'FORMAT=image/png',
    'TRANSPARENT=true',
    'WIDTH=256',
    'HEIGHT=256',
    'CRS=EPSG:3857',
    'BBOX={bbox-epsg-3857}'
  ].join('&');
  return `${URLS.cpcDroughtWMS}?${params}`;
}

/**
 * Show or hide the sidebar legend panel that documents the CPC drought
 * forecast categories. Toggles the `hidden` HTML attribute (matching the
 * vanilla baseline) so the panel returns to its CSS-defined layout when
 * revealed.
 */
function setLegendVisibility(visible: boolean): void {
  const el = document.getElementById(LEGEND_ID);
  if (!el) return;
  el.hidden = !visible;
}

/**
 * Add the CPC Seasonal Drought Outlook source and raster layer to the
 * map and reveal the sidebar legend. Idempotent: re-activating an
 * already-active layer is a no-op so the URL-as-state restore path
 * cannot stack duplicates.
 */
export async function activate(map: maplibregl.Map): Promise<void> {
  try {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [buildWmsTileTemplate()],
        tileSize: 256,
        attribution: 'NOAA CPC'
      });
    }

    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: {
          // 0.6 opacity preserves the vanilla v0.1.x transparency so the
          // basemap shows through the forecast tint.
          'raster-opacity': 0.6
        }
      });
    }

    setLegendVisibility(true);
    console.info('[drought]', 'ready');
  } catch (err) {
    console.info('[drought]', 'error');
    throw err;
  }
}

/**
 * Remove the CPC Seasonal Drought Outlook layer and source from the map
 * and hide the sidebar legend. Symmetric with `activate`; safe to call
 * when the layer has not been activated.
 */
export function deactivate(map: maplibregl.Map): void {
  if (map.getLayer(LAYER_ID)) {
    map.removeLayer(LAYER_ID);
  }
  if (map.getSource(SOURCE_ID)) {
    map.removeSource(SOURCE_ID);
  }
  setLegendVisibility(false);
}
