import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';

/**
 * Build the base MapLibre GL JavaScript style specification.
 *
 * Returns the minimal style: a single OpenTopoMap raster source and its
 * matching layer. Per-feature layer modules (M3 through M9) append their
 * own sources and layers to this style at runtime via
 * `map.addSource()` / `map.addLayer()`. That keeps the style file small and
 * lets each layer module own its own glyphs, paint, and visibility logic.
 *
 * Glyphs note: the `glyphs` field points to the public MapLibre demotiles
 * font endpoint. This is the open-data default and is fine for the current
 * basemap (which is raster, so glyphs are not consulted). Once a vector
 * tile bundle ships, that bundle should host its own glyph PBF files and
 * this URL should be repointed to it; relying on a third-party glyph host
 * in production is a long-term reliability risk.
 *
 * Attribution covers OpenTopoMap (CC-BY-SA), OpenStreetMap (OSM)
 * contributors, and the Shuttle Radar Topography Mission (SRTM) elevation
 * underlay. MapLibre surfaces it through the AttributionControl which is
 * added in `createMap` (see `src/map/init.ts`).
 */
export function buildBaseStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      'basemap-topo': {
        type: 'raster',
        tiles: [URLS.basemapTopo],
        tileSize: 256,
        attribution:
          'OpenTopoMap (CC-BY-SA), OpenStreetMap contributors, SRTM',
        minzoom: 0,
        maxzoom: 17
      }
    },
    layers: [
      {
        id: 'basemap-topo',
        type: 'raster',
        source: 'basemap-topo'
      }
    ]
  };
}
