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
 * located, in the selected magenta emphasis tone, above the reference layers.
 * No sovereign polygons are bundled; the geometry is fetched live at selection
 * time (exactly the live-not-redistribute posture the BIA layer takes).
 *
 * Cleared on the place-selection close seam, the same seam the feature-state
 * emphasis (place-emphasis.ts) uses, so a closed briefing leaves no highlight.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Geometry } from 'geojson';

import { RESERVATION_FILL_COLOR, RESERVATION_OUTLINE_COLOR } from '../config/palette';
import { getPlaceSelection, onPlaceSelectionChange } from './place-selection';

const SOURCE_ID = 'ddm-located-boundary';
const FILL_LAYER_ID = 'ddm-located-boundary-fill';
const LINE_LAYER_ID = 'ddm-located-boundary-line';

/** The selection label the shown highlight depicts (null when none is shown). */
let shownLabel: string | null = null;

/** Render (or replace) the located-boundary highlight for one geometry. */
export function showLocatedBoundary(map: maplibregl.Map, geometry: Geometry | null | undefined): void {
  if (!geometry) {
    clearLocatedBoundary(map);
    return;
  }
  shownLabel = getPlaceSelection()?.label ?? null;
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
  // reads over the BIA fill and the basemap labels: it is the one thing the
  // user just asked to see.
  map.addLayer({
    id: FILL_LAYER_ID,
    type: 'fill',
    source: SOURCE_ID,
    paint: {
      'fill-color': RESERVATION_FILL_COLOR,
      'fill-opacity': 0.5
    }
  });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: {
      'line-color': RESERVATION_OUTLINE_COLOR,
      'line-width': 2.6,
      'line-opacity': 1
    }
  });
}

/** Remove the located-boundary highlight. Safe to call when nothing is shown. */
export function clearLocatedBoundary(map: maplibregl.Map): void {
  shownLabel = null;
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Wire the clear seam: the highlight is dropped on a close (null) AND on a
 * subject change (a new briefing, a new popup; the U3 stage-5 major 4 fix),
 * because it depicts the selection that created it. A later write for the
 * SAME label (the briefing taking ownership of the searched place) keeps it.
 * The search-locate path sets the selection first and shows its highlight
 * after, so the label it records is its own. Called once at boot.
 * shortcut: two different subjects sharing one title keep the highlight; key
 * on a boundary id if that ever happens.
 * The show side is the search-locate path (search-controller.ts).
 *
 * Returns the store unsubscribe so a bounded-lifetime caller (a test) can
 * drop the subscription; the boot caller ignores it.
 */
export function initLocatedBoundary(map: maplibregl.Map): () => void {
  return onPlaceSelectionChange((selection) => {
    if (!selection || selection.label !== shownLabel) clearLocatedBoundary(map);
  });
}
