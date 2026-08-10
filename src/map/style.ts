import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';

/**
 * Build the base MapLibre GL JavaScript style specification.
 *
 * Returns a minimal shared scene: a dark background, subdued OpenStreetMap
 * (OSM) fallback, and the historical EOxCloudless Sentinel-2 2016 ground.
 * The EOX layer starts hidden and is revealed only after the bounded probe in
 * `src/map/historical-ground.ts` succeeds. Per-feature layer modules append
 * their own sources and layers on top at runtime via `map.addSource()` /
 * `map.addLayer()`, so the style file stays small and each layer owns its own
 * paint and visibility logic.
 *
 * The EOX paint is the selected Firefly Candidate A treatment from the design
 * transfer: dark enough for one-scene continuity while retaining land-cover
 * texture beneath official condition palettes. OSM is always present below
 * it and uses a matching dark treatment, so an EOX outage degrades to a map,
 * never a blank rectangle. The sources remain open and require no key.
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
 * Attribution covers OpenStreetMap (OSM) contributors and EOxCloudless. The
 * latter is also repeated in the always-visible historical-ground caption so
 * compact attribution controls cannot hide the imagery identity or vintage.
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
      },
      'basemap-ground': {
        type: 'raster',
        tiles: [URLS.eoxCloudless2016],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 14,
        attribution:
          '<a href="https://cloudless.eox.at">EOxCloudless</a> by ' +
          '<a href="https://eox.at">EOX IT Services GmbH</a> ' +
          '(Contains modified Copernicus Sentinel data 2016), ' +
          '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>'
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
      },
      {
        id: 'basemap-ground',
        type: 'raster',
        source: 'basemap-ground',
        layout: { visibility: 'none' },
        paint: {
          // Firefly Candidate A. These values affect presentation only; the
          // pixels remain the fixed EOX Sentinel-2 2016 mosaic.
          'raster-brightness-min': 0,
          'raster-brightness-max': 0.62,
          'raster-saturation': -0.55,
          'raster-contrast': 0.1,
          'raster-opacity': 1
        }
      }
    ]
  };
}
