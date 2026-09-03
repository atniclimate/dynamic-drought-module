import type * as maplibregl from 'maplibre-gl';

/**
 * Z-order discipline for the map's permanent stacking contract (the U4
 * stage-5 adversarial major 2: insertion must be correct by construction,
 * never by activation-order luck).
 *
 * The contract, bottom to top:
 *
 *   background -> basemap (OSM fallback)
 *     -> basemap-satellite (recent NOAA) -> hillshade
 *     -> condition surfaces -> event overlays -> reference boundaries
 *     -> reference labels
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
 * Condition surfaces, bottom to top. Every known surface is named here so
 * one late network response cannot paint over sovereign and reference
 * outlines. Dynamic SST frames insert immediately below the named Nino line
 * in their owning module and therefore inherit the same ruled position.
 */
export const CONDITION_SURFACE_IDS: readonly string[] = [
  'whp-2023',
  'gridded-index-raster',
  'sst-anomaly',
  'nino34-box-line',
  'nino34-box-label',
  'heatrisk',
  'usfs-whp',
  'drought-outlook-fill',
  'drought-outlook-outline',
  'spc-fire-weather-fill',
  'spc-fire-weather-outline',
  'nadm-drought-fill',
  'nadm-drought-outline',
  'cdm-drought-fill',
  'cdm-drought-outline',
  'bc-drought-fill',
  'bc-drought-outline',
  'usdm-frame-a-fill',
  'usdm-frame-a-outline',
  'usdm-frame-a-d4-rim',
  'usdm-frame-b-fill',
  'usdm-frame-b-outline',
  'usdm-frame-b-d4-rim',
  'usdm-change-fill',
  'usdm-change-outline'
];

/**
 * Infrastructure context overlays (issuer-published built environment):
 * above condition fields so lines and plant points stay readable over a
 * drape, below event overlays so mapped incidents always read on top.
 *
 * The structures pair is present only while the 3D Fire mode is active.
 * The power surfaces became an ordinary catalog layer 2026-08-19 and can
 * now appear in any view from zoom 6, so this band is no longer 3D-only;
 * their seat is unchanged, which is the point of listing them here.
 */
export const CONTEXT_OVERLAY_IDS: readonly string[] = [
  'structures-3d',
  'structures-3d-est',
  'power-lines',
  'power-lines-unknown',
  'power-plants-clusters',
  'power-plants-cluster-count',
  'power-plants'
];

/** Observed and advisory event overlays that stay above condition fields. */
export const EVENT_OVERLAY_IDS: readonly string[] = [
  'hms-smoke-fill',
  'hms-smoke-volume',
  'hms-smoke-outline',
  'nifc-fires-fill',
  'nifc-fires-outline',
  'nifc-prescribed-fill',
  'nifc-prescribed-outline',
  'nifc-other-outline',
  'nws-alerts-fill',
  'nws-alerts-outline'
];

/**
 * Reference boundaries, bottom to top. Agency Treaty polygons remain
 * representations, not jurisdictional truth. This array governs paint order
 * only and does not change the source or stewardship caveats of any module.
 */
export const REFERENCE_BOUNDARY_IDS: readonly string[] = [
  'hydrography',
  'us-states-fill',
  'us-states-casing',
  'us-states-outline',
  'tribal-lands-fill',
  'tribal-lands-outline',
  'aiannh-fill',
  'aiannh-outline',
  'bia-reservations-fill',
  'bia-reservations-outline',
  'treaty-areas-outline'
];

/**
 * The complete deterministic thematic chain, bottom to top. With the bottom
 * stack beneath it and reference labels above it, the full contract reads:
 *
 *   basemap < terrain < conditions < events < references < labels
 *
 * The ids are mirrored literals from the owning layer modules so lazy chunks
 * stay independent. `reassertThematicOrder` re-seats every present member
 * after each activation, so the stack is stable regardless of fetch
 * completion order. The ecoregion context underlay stays below this chain.
 */
export const THEMATIC_STACK_IDS: readonly string[] = [
  ...CONDITION_SURFACE_IDS,
  ...CONTEXT_OVERLAY_IDS,
  ...EVENT_OVERLAY_IDS,
  ...REFERENCE_BOUNDARY_IDS
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
 * Re-seat every known thematic member in the ruled chain. Idempotent and
 * cheap; the layer controller calls it after each successful activation,
 * beside `reassertLabelOrder`, so order never depends on which activation's
 * network fetch resolved first.
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
