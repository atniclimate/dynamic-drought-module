import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';

/**
 * Build the base MapLibre GL JavaScript style specification.
 *
 * Returns a minimal shared scene: a dark background and subdued OpenStreetMap
 * (OSM) ground beneath the default-on recent satellite context. Per-feature layer modules append
 * their own sources and layers on top at runtime via `map.addSource()` /
 * `map.addLayer()`, so the style file stays small and each layer owns its own
 * paint and visibility logic.
 *
 * Glyphs note (0.7.0 U0a): the `glyphs` template points at the SELF-HOSTED
 * PBF files under `public/fonts/glyphs/` (provenance and license in
 * `public/fonts/README.md`), so no third-party font host sees deployment
 * traffic. Symbol layers must name a hosted fontstack explicitly in
 * `text-font` (today: 'Noto Sans Regular'); MapLibre's implicit default
 * stack is not hosted and would fail visibly. The template is built
 * absolute from the page origin because a relative glyphs URL is not
 * reliably resolved across MapLibre versions.
 *
 * Attribution covers OpenStreetMap contributors. Recent NOAA imagery adds its
 * own source attribution when active.
 */
export function buildBaseStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: `${window.location.origin}${import.meta.env.BASE_URL}fonts/glyphs/{fontstack}/{range}.pbf`,
    sources: {
      // atni-geobase: terrain-source seam. The ATNI-GeoBase T0 elevation
      // baseline registers here as a `raster-dem` source (a LOCAL tile set
      // or a PMTiles archive; never a cloud terrain service), for example:
      //   terrain: { type: 'raster-dem', tiles: [...], tileSize: 512 }
      // and is enabled at the map-init seam in src/map/init.ts via
      // `map.setTerrain({ source: 'terrain' })`. Nothing else in the DDM
      // needs to change; the layer modules and UI are terrain-agnostic.
      // Contract details: docs/interop/GEOBASE-BRIDGE.md.
      basemap: {
        type: 'raster',
        tiles: [URLS.basemapOSM],
        tileSize: 256,
        // The linked form per the OSM attribution guidance (U4f); the
        // AttributionControl renders HTML.
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        minzoom: 0,
        maxzoom: 19
      }
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#0b1220'
        }
      },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        paint: {
          // Dark fallback in the same visual family as the historical ground.
          'raster-saturation': -1,
          'raster-brightness-min': 0.04,
          'raster-brightness-max': 0.42,
          'raster-contrast': 0.12,
          'raster-opacity': 0.72
        }
      }
    ]
  };
}
