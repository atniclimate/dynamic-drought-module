/**
 * Located-boundary highlight (U3d, the search-locate fix).
 *
 * When the U3 search jumps to a Tribal land area, it has already fetched that
 * one feature's geometry live from the AIAN-LAR service to frame the camera and
 * open the briefing. This module renders THAT geometry as a dedicated highlight
 * overlay, so the searched land area reads clearly regardless of the live BIA
 * reservation layer's viewport-clipped state (the Codex plan-attack MAJOR 1: the
 * BIA layer, if already on, holds an older viewport and would not include a
 * land area the search flew to). The overlay is one feature, always the current
 * viewport's subject, cleared when the briefing closes.
 *
 * It is a highlight, not a data layer: it renders exactly what the search
 * located, as the chosen land area's own heavier line with no fill (visual
 * uniformity D9: a fill hid the hazard class under the place), above the
 * reference layers.
 * No sovereign polygons are bundled; the geometry is fetched live at selection
 * time (exactly the live-not-redistribute posture the BIA layer takes).
 *
 * Cleared on the place-selection close seam, the same seam the feature-state
 * emphasis (place-emphasis.ts) uses, so a closed briefing leaves no highlight.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Geometry } from 'geojson';

import { RESERVATION_OUTLINE_COLOR, TRIBAL_LINE_COLOR } from '../config/palette';
import { getPlaceSelection, onPlaceSelectionChange } from './place-selection';
import type { PlaceSelection } from './place-selection';

const SOURCE_ID = 'ddm-located-boundary';
const EDGE_LAYER_ID = 'ddm-located-boundary-edge';
const LINE_LAYER_ID = 'ddm-located-boundary-line';

/** The place the shown highlight depicts (null when none is shown). */
let shown: { code: string | null; name: string } | null = null;

function placeKeys(selection: PlaceSelection): { code: string | null; name: string } {
  const place = selection.context.place;
  return {
    code: place ? `${place.scheme}:${place.code}` : null,
    name: `${selection.label}|${selection.context.areaLabel ?? ''}`
  };
}

// One Nation title can cover several land areas, so two codes decide; a writer without one (the condition door) matches by title and area.
function samePlace(selection: PlaceSelection): boolean {
  if (!shown) return false;
  const next = placeKeys(selection);
  return shown.code && next.code ? shown.code === next.code : shown.name === next.name;
}

/** Render (or replace) the located-boundary highlight for one geometry. */
export function showLocatedBoundary(map: maplibregl.Map, geometry: Geometry | null | undefined): void {
  if (!geometry) {
    clearLocatedBoundary(map);
    return;
  }
  const selection = getPlaceSelection();
  shown = selection ? placeKeys(selection) : null;
  const data = {
    type: 'Feature' as const,
    properties: {},
    geometry
  };
  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: 'geojson', data });
  // Appended above every reference layer (no beforeId) so the located subject
  // reads over the BIA line and the basemap labels: it is the one thing the
  // user just asked to see. The widths are bia-reservations.ts's selected pair.
  map.addLayer({
    id: EDGE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: { 'line-color': RESERVATION_OUTLINE_COLOR, 'line-width': 4.6 }
  });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: { 'line-color': TRIBAL_LINE_COLOR, 'line-width': 2.6 }
  });
}

/** Remove the located-boundary highlight. Safe to call when nothing is shown. */
export function clearLocatedBoundary(map: maplibregl.Map): void {
  shown = null;
  if (map.getLayer(EDGE_LAYER_ID)) map.removeLayer(EDGE_LAYER_ID);
  if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Wire the clear seam: the highlight is dropped on a close (null) AND on a
 * subject change (a new briefing, a new popup; the U3 stage-5 major 4 fix),
 * because it depicts the selection that created it. A later write for the
 * SAME place (the briefing taking ownership of the searched place) keeps it.
 * The search-locate path sets the selection first and shows its highlight
 * after, so the place it records is its own. Called once at boot.
 * The show side is the search-locate path (search-controller.ts) and the
 * Place studio's exit briefing for a Nation (place-studio.tsx).
 *
 * Returns the store unsubscribe so a bounded-lifetime caller (a test) can
 * drop the subscription; the boot caller ignores it.
 */
export function initLocatedBoundary(map: maplibregl.Map): () => void {
  return onPlaceSelectionChange((selection) => {
    if (!selection || !samePlace(selection)) clearLocatedBoundary(map);
  });
}
