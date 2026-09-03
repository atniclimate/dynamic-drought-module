/**
 * The Place studio's ephemeral selected-boundary display (the PS-WATER
 * substrate).
 *
 * Watersheds have no catalog map layer: their geometry arrives
 * per-selection from the Watershed Boundary Dataset provider while the
 * studio is open, and it must never become catalog or URL state. This
 * module manages ONE session-scoped GeoJSON source and its two paint
 * layers directly on the shared map instance, entirely outside the layer
 * controller (it is a selection surface, not a data layer: no catalog
 * row, no status pill, no persistence).
 *
 * Visual language: the interaction accent (the cyan the app already uses
 * for selection affordances), a 2 px boundary with a faint fill lift, so
 * the shape reads as "your current selection" rather than as an agency
 * data product.
 *
 * Stewardship: this module renders only the geometry a federal source
 * returned for the user's explicit selection; it adds no wording and no
 * derived claims.
 */

import type * as maplibregl from 'maplibre-gl';

const SOURCE_ID = 'place-studio-boundary';
const FILL_LAYER_ID = 'place-studio-boundary-fill';
const LINE_LAYER_ID = 'place-studio-boundary-line';

/** The app's interaction accent (src/styles/app.css --accent). */
const ACCENT = '#06b6d4';

export type StudioBoundaryGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/**
 * Show (or replace) the studio's selected-boundary geometry. Idempotent:
 * a repeat call with new geometry updates the one source in place.
 */
export function showStudioBoundary(
  map: maplibregl.Map,
  geometry: StudioBoundaryGeometry
): void {
  const data: GeoJSON.Feature = { type: 'Feature', geometry, properties: {} };
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: 'geojson', data });
  map.addLayer({
    id: FILL_LAYER_ID,
    type: 'fill',
    source: SOURCE_ID,
    paint: { 'fill-color': ACCENT, 'fill-opacity': 0.1 }
  });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: { 'line-color': ACCENT, 'line-width': 2 }
  });
}

/** Remove the boundary display entirely. Safe when nothing is shown. */
export function clearStudioBoundary(map: maplibregl.Map): void {
  if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}
