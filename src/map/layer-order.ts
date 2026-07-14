import type maplibregl from 'maplibre-gl';

/**
 * Z-order discipline for the map's permanent stacking contract (the U4
 * stage-5 adversarial major 2: insertion must be correct by construction,
 * never by activation-order luck).
 *
 * The contract, bottom to top:
 *
 *   background -> basemap (OSM) -> basemap-satellite -> hillshade
 *     -> data layers (surfaces, boundaries, events) -> reference labels
 *
 * Three mechanisms enforce it:
 *   1. `firstLayerIdAbove(map, skip)` computes an insertion anchor by
 *      skipping the named bottom-stack ids, so a bottom-stack member
 *      inserted LATE still lands inside the stack (and a data layer
 *      inserted late lands above it).
 *   2. `BOTTOM_STACK_IDS` is the shared skip list, so a module that
 *      inserts "directly above the basemap" (ecoregions) skips the whole
 *      stack rather than a hardcoded pair.
 *   3. `reassertLabelOrder(map)` moves the reference label layers back to
 *      the very top; the layer controller calls it after every successful
 *      activation, so a surface activated AFTER the labels can never bury
 *      them.
 */

/** The permanent bottom-stack ids, in stacking order. */
export const BOTTOM_STACK_IDS: readonly string[] = [
  'background',
  'basemap',
  'basemap-satellite',
  'hillshade'
];

/** Reference label layers that always read above every data layer. */
const TOP_LABEL_IDS: readonly string[] = ['us-places-labels'];

/**
 * The id of the first style layer whose id is NOT in `skip`, or undefined
 * when every layer is skipped (the new layer then appends at the top,
 * which for an empty or bottom-stack-only style is correct).
 */
export function firstLayerIdAbove(
  map: maplibregl.Map,
  skip: readonly string[]
): string | undefined {
  const layers = map.getStyle().layers ?? [];
  for (const l of layers) {
    if (skip.includes(l.id)) continue;
    return l.id;
  }
  return undefined;
}

/**
 * Move the always-on-top label layers back above everything. Idempotent
 * and cheap; called by the layer controller after each successful
 * activation so later-activated surfaces never cover the labels.
 */
export function reassertLabelOrder(map: maplibregl.Map): void {
  for (const id of TOP_LABEL_IDS) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}
