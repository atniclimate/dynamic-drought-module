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
 * The deterministic thematic chain (E1 deliverable 2, D-0.7.0-041 part 2;
 * the 2026-07-16 design review E1.3), bottom to top: the US Drought Monitor
 * surface, the state hairline, the Tribal Lands wash/outline, and the
 * Reservation Boundaries wash/outline. With the bottom stack below it and
 * the reference labels above it, the full contract reads:
 *
 *   basemap < hillshade < USDM < state hairline < Tribal Lands
 *     < Reservation Boundaries < labels
 *
 * The ids are mirrored literals from the owning layer modules (the same
 * mirroring pattern `BIA_FILL_LAYER_ID` uses in aiannh.ts) so the layer
 * chunks stay independent. `reassertThematicOrder` re-seats every present
 * member after each activation, so the stack is stable regardless of which
 * network fetch completed first; the existing AIANNH-below-BIA pair rule is
 * carried by the chain order itself. Layers not named here (events, treaty
 * cessions, hydrography, the other surfaces) keep their insertion-order
 * position ABOVE the chain; the ecoregion underlay stays below it.
 */
export const THEMATIC_STACK_IDS: readonly string[] = [
  // US Drought Monitor (src/layers/usdm.ts): both frame slots + change pair.
  'usdm-frame-a-fill',
  'usdm-frame-a-outline',
  'usdm-frame-b-fill',
  'usdm-frame-b-outline',
  'usdm-change-fill',
  'usdm-change-outline',
  // State hairline (src/layers/states.ts).
  'us-states-fill',
  'us-states-outline',
  // Tribal Lands wash/outline (src/layers/aiannh.ts); stays BELOW the pair.
  'aiannh-fill',
  'aiannh-outline',
  // Reservation Boundaries wash/outline (src/layers/bia-reservations.ts).
  'bia-reservations-fill',
  'bia-reservations-outline'
];

/**
 * Non-chain layers that stay BELOW the thematic chain besides the bottom
 * stack: the ecoregion underlay inserts directly above the basemap by
 * construction (src/layers/ecoregions.ts) and must not become the chain's
 * anchor, which would seat the chain underneath it.
 */
const BELOW_THEMATIC_IDS: readonly string[] = [
  'ecoregions-l3-fill',
  'ecoregions-l3-outline',
  'ecoregions-l4-fill',
  'ecoregions-l4-outline'
];

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

/**
 * Re-seat the thematic chain (E1 deliverable 2): every present member of
 * `THEMATIC_STACK_IDS` moves, in chain order, to sit directly below the
 * lowest non-chain data layer (events and every other unnamed data layer
 * stay above the chain; the bottom stack and the ecoregion underlay stay
 * below it). Idempotent and cheap; the layer controller calls it after
 * each successful activation, beside `reassertLabelOrder`, so the stack
 * never depends on which activation's network fetch resolved first.
 */
export function reassertThematicOrder(map: maplibregl.Map): void {
  const skip = [...BOTTOM_STACK_IDS, ...BELOW_THEMATIC_IDS, ...THEMATIC_STACK_IDS];
  const anchor = firstLayerIdAbove(map, skip);
  for (const id of THEMATIC_STACK_IDS) {
    if (!map.getLayer(id)) continue;
    if (anchor !== undefined) {
      map.moveLayer(id, anchor);
    } else {
      map.moveLayer(id);
    }
  }
}
