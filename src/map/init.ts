import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { buildBaseStyle } from './style';
import { BasemapSwitcherControl } from './basemap-switcher';
import { MAP_MIN_ZOOM } from '../config/regions';

/**
 * Register the PMTiles protocol with MapLibre exactly once, so any source
 * declared with a `pmtiles://` URL (the ecoregion vector bundle, and the
 * Phase D landscape bundles to come) resolves through HTTP Range Requests
 * against the static archive. PMTiles is an open, single-file tile format
 * (CLAUDE.md section 3 names it a supported path); the protocol handler is
 * client-side only and adds no backend. Guarded because `addProtocol` throws
 * if the same scheme is registered twice (a hot-reload hazard in dev).
 */
let pmtilesRegistered = false;
function registerPmtilesProtocol(): void {
  if (pmtilesRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  pmtilesRegistered = true;
}

/**
 * Default initial view. The Pacific Northwest (PNW) center sits over the
 * Cascades; the same point as the vanilla Leaflet baseline's `[47, -121]`
 * but expressed in MapLibre's `[longitude, latitude]` order.
 */
const DEFAULT_CENTER: [number, number] = [-121, 47];
const DEFAULT_ZOOM = 7;
// U4a: the zoom floor moved to src/config/regions.ts (MAP_MIN_ZOOM) so the
// whole-US fit invariant is testable in Node; see the rationale there.
const DEFAULT_MIN_ZOOM = MAP_MIN_ZOOM;
const DEFAULT_MAX_ZOOM = 14;

/**
 * Maximum width in CSS pixels of the scale control, expressed in imperial
 * units (miles / feet) per the project's domestic-US audience.
 */
const SCALE_MAX_WIDTH_PX = 160;

/**
 * Create and return the MapLibre GL JavaScript map instance.
 *
 * The caller (`src/main.ts`) is responsible for waiting on `map.on('load')`
 * before activating layers, fitting region bounds, or wiring popups. This
 * function deliberately does no further wiring so that initialization
 * stays a single, side-effect-light call.
 *
 * Open-data invariant: per CLAUDE.md section 4 rule 2, no proprietary tile
 * providers are configured. The base style uses OpenStreetMap standard
 * raster tiles, subdued via raster paint (see `buildBaseStyle()`); any
 * future basemap must remain an open-data source.
 */
export function createMap(containerId: string): maplibregl.Map {
  registerPmtilesProtocol();

  // atni-geobase: map-initialization seam. A 3D geospatial baseline (the
  // ATNI-GeoBase T0 terrain layer) attaches HERE and at the terrain-source
  // seam in src/map/style.ts, with no other DDM surface involved: enabling
  // 3D is `map.setPitch(..)` plus `map.setTerrain({ source: <raster-dem> })`
  // after this constructor returns. The lightest honest option is MapLibre's
  // native terrain over a LOCAL raster-dem source (no cloud terrain
  // dependency), which is also the GeoBase Light Engine's own render path,
  // so the seam and GeoBase converge on one stack.
  const map = new maplibregl.Map({
    container: containerId,
    style: buildBaseStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    minZoom: DEFAULT_MIN_ZOOM,
    maxZoom: DEFAULT_MAX_ZOOM,
    // The explicit control below is the single attribution surface; without
    // this flag the constructor adds its own default control and the two
    // stack as duplicate bars in the corner.
    attributionControl: false
  });

  // AUTO-compact (the MapLibre default): a full bar on desktop, collapsed
  // to the standard info toggle below 640 px map width. The U4 stage-5
  // browser matrix caught the forced full bar colliding with the legend
  // chip and the ATNI badge on the first-class 400x600 embed viewport;
  // the collapsed control is the accepted attribution pattern there, and
  // the satellite vintage notice stays independently visible in the dock
  // (the D-028 split; the review's only never-collapse requirement is the
  // vintage, not the legal bar).
  map.addControl(new maplibregl.AttributionControl());
  map.addControl(
    new maplibregl.ScaleControl({
      unit: 'imperial',
      maxWidth: SCALE_MAX_WIDTH_PX
    })
  );
  // The basemap switcher (U4d): satellite one tap away, never the default
  // (D-0.7.0-005). Present in embeds too; `basemap=` is durable URL state
  // (D-0.7.0-031) and an embedding site may pin it in its iframe src.
  // BOTTOM-right: the app's own overlay stack (Share view, About) owns the
  // map's top-right and intercepts pointer events there (caught by the U4d
  // switcher spec), so the switcher stacks in the corner MapLibre already
  // owns, directly above the attribution control.
  map.addControl(new BasemapSwitcherControl(), 'bottom-right');

  return map;
}
