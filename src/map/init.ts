import maplibregl from 'maplibre-gl';
import { buildBaseStyle } from './style';

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
