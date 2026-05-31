import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { buildBaseStyle } from './style';

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
const DEFAULT_MIN_ZOOM = 5;
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

  const map = new maplibregl.Map({
    container: containerId,
    style: buildBaseStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    minZoom: DEFAULT_MIN_ZOOM,
    maxZoom: DEFAULT_MAX_ZOOM
  });

  map.addControl(new maplibregl.AttributionControl({ compact: false }));
  map.addControl(
    new maplibregl.ScaleControl({
      unit: 'imperial',
      maxWidth: SCALE_MAX_WIDTH_PX
    })
  );

  return map;
}
