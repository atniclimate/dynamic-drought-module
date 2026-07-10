import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';

/**
 * Build the base MapLibre GL JavaScript style specification.
 *
 * Returns a minimal style: a light background layer plus the OpenStreetMap
 * (OSM) standard raster basemap. Per-feature layer modules append their own
 * sources and layers on top at runtime via `map.addSource()` /
 * `map.addLayer()`, so the style file stays small and each layer owns its
 * own paint and visibility logic.
 *
 * Subdued basemap. The drought layers (especially the bright USDM D0-D4
 * ramp) are the focus, so the basemap is deliberately muted: OSM standard
 * tiles desaturated and flattened with raster paint, drawn at partial
 * opacity, so the result reads as a near-neutral light backdrop while roads
 * and labels still give spatial reference for watersheds, reservations, and
 * reservoirs. The basemap stays an open, pre-approved provider (CLAUDE.md
 * rule 2; no proprietary tiles). The paint values below are tuned starting
 * points; iterate them in the browser with USDM on over the Columbia
 * headwaters, Yakima, and Klamath, where the warm ramp sits over both
 * forested and arid OSM tones.
 *
 * The light background layer is load-bearing: the app chrome behind the map
 * is dark slate, so a partly-transparent basemap composited directly over it
 * would look muddy. Compositing over a light background instead pushes the
 * basemap toward a clean light gray.
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
 * Attribution covers OpenStreetMap (OSM) contributors. MapLibre surfaces it
 * through the AttributionControl added in `createMap` (see `src/map/init.ts`).
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
        attribution: '© OpenStreetMap contributors',
        minzoom: 0,
        maxzoom: 19
      }
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#e9eef3'
        }
      },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        paint: {
          // Subdue OSM so the drought ramp dominates. Tuned starting values
          // (maintainer, 2026-05-21); iterate in the browser with USDM on.
          'raster-saturation': -0.8,
          'raster-brightness-min': 0.6,
          'raster-brightness-max': 1.0,
          'raster-contrast': -0.3,
          'raster-opacity': 0.7
        }
      }
    ]
  };
}
