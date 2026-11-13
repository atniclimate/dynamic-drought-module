import type * as maplibregl from 'maplibre-gl';
// The boot slice of the URL catalog, not the catalog (DR-008a): the base
// style needs its three archive URLs, and importing `URLS` here would carry the
// whole 70-entry table into the entry chunk for them.
import { BOOT_URLS } from '../config/urls-boot';
import {
  BASE_GLACIER_COLOR,
  BASE_LAND_COLOR,
  BASE_REGION_LINE_COLOR,
  BASE_WATER_LABEL_COLOR,
  MAP_GROUND_COLOR,
  PLACE_LABEL_COLOR,
  PLACE_LABEL_HALO,
  STATE_OUTLINE_COLOR
} from '../config/interface-tokens';
import { ROAD_CLASS_COLORS } from '../config/palette';

/**
 * The absolute same-origin glyph template under the deployed base: the page's
 * own directory when `BASE_URL` is relative (`./`, today's Vite `base`), the
 * origin-rooted path when it is absolute. `{fontstack}` and `{range}` are
 * appended as text after the URL is resolved, because `URL` would percent
 * encode the braces and MapLibre would never find its placeholders.
 */
function glyphTemplate(): string {
  const root = new URL(`${import.meta.env.BASE_URL}fonts/glyphs/`, document.baseURI);
  return `${root.href}{fontstack}/{range}.pbf`;
}

const NA = 'base';
const WORLD = 'base-world';
const ROADS = 'base-roads';
const FONT = ['Noto Sans Regular'];
const NAME = ['get', 'name'] as maplibregl.ExpressionSpecification;
const HAS_NAME = ['!=', NAME, ''] as maplibregl.ExpressionSpecification;

/** Smaller rank is more prominent (scripts/build-base-tiles.mjs placeRank). */
const PLACE_RANK_LIMIT: maplibregl.ExpressionSpecification = ['step', ['zoom'], 1, 3.5, 2, 5, 3, 6, 4, 7, 5, 8, 6, 9.5, 7];

const placeLayer = (id: string, source: string): maplibregl.SymbolLayerSpecification => ({
  id,
  type: 'symbol',
  source,
  'source-layer': 'place',
  filter: ['<=', ['get', 'rank'], PLACE_RANK_LIMIT] as maplibregl.FilterSpecification,
  layout: {
    'text-field': NAME,
    'text-font': FONT,
    'text-size': ['interpolate', ['linear'], ['zoom'], 3, ['match', ['get', 'rank'], 1, 12, 10.5], 8, ['match', ['get', 'rank'], 1, 15, 2, 14, 3, 13, 12]],
    // Within a rank the larger place first, and room around each name, so the suburbs thin out
    // and isolated small towns stay (design pass 2026-11-13).
    'symbol-sort-key': ['-', ['*', ['get', 'rank'], 1e8], ['get', 'pop']],
    'text-padding': 12,
    'text-max-width': 8
  },
  paint: { 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': PLACE_LABEL_HALO, 'text-halo-width': 1.4 }
});

/** Peak names in a warm grey, so a summit never reads as a water name. */
const PEAK_LABEL_COLOR = '#C2B89F';

/** Faint spaced capitals for the large names under the cities: states and provinces, then ranges. */
const quietCapitals = (size: maplibregl.DataDrivenPropertyValueSpecification<number>, spacing: number): NonNullable<maplibregl.SymbolLayerSpecification['layout']> => ({
  'text-field': NAME,
  'text-font': FONT,
  'text-size': size,
  'text-transform': 'uppercase',
  'text-letter-spacing': spacing,
  'text-max-width': 9,
  'text-padding': 6
});

const waterLabelLayer = (id: string, source: string): maplibregl.SymbolLayerSpecification => ({
  id,
  type: 'symbol',
  source,
  'source-layer': 'water_label',
  // Below zoom 4 only the oceans and seas are named, so bays do not outnumber cities in the national view.
  filter: ['<=', ['get', 'rank'], ['step', ['zoom'], ['match', ['get', 'kind'], 'sea', 1, 0], 4, 2, 6, 3, 8, 4]] as maplibregl.FilterSpecification,
  layout: {
    'text-field': NAME,
    'text-font': FONT,
    'text-size': ['match', ['get', 'kind'], 'sea', 12, 11],
    'text-letter-spacing': 0.12,
    'text-max-width': 7
  },
  paint: { 'text-color': BASE_WATER_LABEL_COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
});

/**
 * Build the base MapLibre GL JavaScript style specification.
 *
 * DDM's own base map from public files (DDM-P17-T12): no request leaves for
 * any tile host. Three same-origin PMTiles vector archives,
 * baked by `scripts/build-base-tiles.mjs`: North America to zoom 8 (land,
 * lakes, reservoirs, wetlands, glaciers, rivers and canals, country, province
 * and county lines, federal and state highways, place, lake and sea names;
 * Census, USGS, Natural Resources Canada) and the world to zoom 5 (Natural
 * Earth). The map overzooms both, so the base stays mesoscale at close zoom;
 * inside Tribal areas the street layer (src/layers/tribal-streets.ts) adds
 * street names live from the Census. The ground fills sit under satellite
 * imagery, the lines and names above it (src/map/layer-order.ts). Per-feature
 * layer modules append their own sources and layers on top at runtime.
 *
 * Glyphs note (0.7.0 U0a): the `glyphs` template points at the SELF-HOSTED
 * PBF files under `public/fonts/glyphs/` (provenance and license in
 * `public/fonts/README.md`), so no third-party font host sees deployment
 * traffic. Symbol layers must name a hosted fontstack explicitly in
 * `text-font` (today: 'Noto Sans Regular'); MapLibre's implicit default
 * stack is not hosted and would fail visibly. The template is built
 * absolute because a relative glyphs URL is not reliably resolved across
 * MapLibre versions, and from the document base rather than by gluing
 * `window.location.origin` to `BASE_URL` (found-039). See `glyphTemplate`.
 *
 * Credits live in the Acknowledgements (src/config/acknowledgements.ts,
 * `basemap-ground`), never on the map chrome.
 */
export function buildBaseStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: glyphTemplate(),
    sources: {
      // atni-geobase: terrain-source seam. The ATNI-GeoBase T0 elevation
      // baseline registers here as a `raster-dem` source (a LOCAL tile set
      // or a PMTiles archive; never a cloud terrain service), for example:
      //   terrain: { type: 'raster-dem', tiles: [...], tileSize: 512 }
      // and is enabled at the map-init seam in src/map/init.ts via
      // `map.setTerrain({ source: 'terrain' })`. Nothing else in the DDM
      // needs to change; the layer modules and UI are terrain-agnostic.
      [WORLD]: { type: 'vector', url: 'pmtiles://' + BOOT_URLS.baseWorldPmtiles },
      [NA]: { type: 'vector', url: 'pmtiles://' + BOOT_URLS.baseNaPmtiles },
      [ROADS]: { type: 'vector', url: 'pmtiles://' + BOOT_URLS.baseRoadsPmtiles }
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': MAP_GROUND_COLOR } },
      // Ground: water is the background, land is drawn over it, lakes over land.
      { id: 'base-world-land', type: 'fill', source: WORLD, 'source-layer': 'land', paint: { 'fill-color': BASE_LAND_COLOR } },
      { id: 'base-land', type: 'fill', source: NA, 'source-layer': 'land', paint: { 'fill-color': BASE_LAND_COLOR } },
      { id: 'base-world-water', type: 'fill', source: WORLD, 'source-layer': 'water', paint: { 'fill-color': MAP_GROUND_COLOR } },
      {
        id: 'base-water',
        type: 'fill',
        source: NA,
        'source-layer': 'water',
        filter: ['match', ['get', 'kind'], ['lake', 'reservoir', 'river', 'intermittent'], true, false],
        paint: { 'fill-color': MAP_GROUND_COLOR, 'fill-opacity': ['match', ['get', 'kind'], 'intermittent', 0.6, 1] }
      },
      {
        id: 'base-wetland',
        type: 'fill',
        source: NA,
        'source-layer': 'water',
        filter: ['match', ['get', 'kind'], ['wetland', 'dry'], true, false],
        paint: { 'fill-color': MAP_GROUND_COLOR, 'fill-opacity': 0.35 }
      },
      {
        id: 'base-glacier',
        type: 'fill',
        source: NA,
        'source-layer': 'water',
        filter: ['==', ['get', 'kind'], 'glacier'],
        paint: { 'fill-color': BASE_GLACIER_COLOR }
      },
      {
        id: 'base-river',
        type: 'line',
        source: NA,
        'source-layer': 'river',
        // Stream order (Strahler; 3 for canals): only the big rivers at the national view.
        filter: ['>=', ['get', 'rank'], ['step', ['zoom'], 7, 4.5, 6, 5.5, 5, 6.5, 4, 7.5, 0]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': MAP_GROUND_COLOR,
          'line-opacity': ['match', ['get', 'kind'], 'intermittent', 0.6, 1],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            4, ['*', 0.15, ['-', ['get', 'rank'], 2]],
            8, ['*', 0.35, ['-', ['get', 'rank'], 2]],
            12, ['*', 0.7, ['-', ['get', 'rank'], 2]]]
        }
      },
      // Lines, above imagery.
      {
        id: 'base-county',
        type: 'line',
        source: NA,
        'source-layer': 'county',
        minzoom: 5,
        paint: {
          'line-color': BASE_GLACIER_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 8, 0.6, 12, 1],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 6.5, 1]
        }
      },
      {
        id: 'base-region',
        type: 'line',
        source: NA,
        'source-layer': 'boundary',
        filter: ['==', ['get', 'kind'], 'region'],
        paint: { 'line-color': BASE_REGION_LINE_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 8, 1, 12, 1.6] }
      },
      {
        id: 'base-world-country',
        type: 'line',
        source: WORLD,
        'source-layer': 'boundary',
        paint: { 'line-color': STATE_OUTLINE_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 5, 0.9] }
      },
      {
        id: 'base-country',
        type: 'line',
        source: NA,
        'source-layer': 'boundary',
        filter: ['==', ['get', 'kind'], 'country'],
        paint: { 'line-color': STATE_OUTLINE_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.3, 12, 2] }
      },
      {
        id: 'base-road',
        type: 'line',
        source: ROADS,
        'source-layer': 'road',
        minzoom: 4,
        // Class 1 freeways first, U.S. and principal highways, then state and secondary highways.
        filter: ['<=', ['get', 'cls'], ['step', ['zoom'], 1, 5.5, 2, 6.5, 3]],
        layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['-', 0, ['get', 'cls']] },
        paint: {
          'line-color': ['match', ['get', 'cls'], 1, ROAD_CLASS_COLORS[1], 2, ROAD_CLASS_COLORS[2], ROAD_CLASS_COLORS[3]],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            4, ['match', ['get', 'cls'], 1, 0.6, 0.3],
            8, ['match', ['get', 'cls'], 1, 1.4, 2, 1, 0.7],
            12, ['match', ['get', 'cls'], 1, 2.6, 2, 2, 1.4]]
        }
      },
      // Names, on top (TOP_LABEL_IDS re-seats them after every activation).
      {
        id: 'base-river-label',
        type: 'symbol',
        source: NA,
        'source-layer': 'river',
        minzoom: 7,
        filter: ['all', HAS_NAME, ['>=', ['get', 'rank'], ['step', ['zoom'], 6, 9, 4, 11, 0]]],
        layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': FONT, 'text-size': 10.5, 'symbol-spacing': 400, 'text-letter-spacing': 0.05 },
        paint: { 'text-color': BASE_WATER_LABEL_COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
      },
      {
        id: 'base-road-label',
        type: 'symbol',
        source: ROADS,
        'source-layer': 'road',
        minzoom: 8,
        filter: ['all', HAS_NAME, ['<=', ['get', 'cls'], ['step', ['zoom'], 2, 10, 3]]],
        layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': FONT, 'text-size': 10, 'symbol-spacing': 500 },
        paint: { 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': PLACE_LABEL_HALO, 'text-halo-width': 1.2 }
      },
      // Mountain ranges and peaks (visual idea 4: they appear as the regional cities do),
      // then state, province and Mexican state names at national to regional zoom (idea 3).
      {
        id: 'base-range-label',
        type: 'symbol',
        source: NA,
        'source-layer': 'range_label',
        minzoom: 4.5,
        maxzoom: 9,
        filter: ['<=', ['get', 'rank'], ['step', ['zoom'], 2, 5.5, 3, 6.5, 9]],
        layout: quietCapitals(10, 0.3),
        paint: { 'text-color': PEAK_LABEL_COLOR, 'text-opacity': 0.75, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1 }
      },
      {
        id: 'base-peak',
        type: 'symbol',
        source: NA,
        'source-layer': 'peak',
        minzoom: 5,
        filter: ['>=', ['get', 'elev'], ['step', ['zoom'], 4000, 6, 3000, 7, 0]],
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 10.5, 'text-max-width': 7, 'symbol-sort-key': ['-', 0, ['get', 'elev']] },
        paint: { 'text-color': PEAK_LABEL_COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1.2 }
      },
      {
        id: 'base-region-label',
        type: 'symbol',
        source: NA,
        'source-layer': 'region_label',
        minzoom: 3.5,
        maxzoom: 7.5,
        layout: quietCapitals(['interpolate', ['linear'], ['zoom'], 3.5, 9.5, 6, 12], 0.25),
        // Quiet by the muted ink, not by transparency: 5.11:1 on land (design pass 2026-11-13).
        paint: { 'text-color': BASE_WATER_LABEL_COLOR, 'text-halo-color': MAP_GROUND_COLOR, 'text-halo-width': 1 }
      },
      waterLabelLayer('base-world-water-label', WORLD),
      waterLabelLayer('base-water-label', NA),
      placeLayer('base-world-place', WORLD),
      placeLayer('base-place', NA)
    ]
  };
}
