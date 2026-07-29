/**
 * Selected-place emphasis (U3h, headroom A1; the U1 carry).
 *
 * When a boundary is selected (a click on a Tribal, Treaty, reservation, or
 * state boundary, or a Tribal land area chosen from the U3 search), the chosen
 * feature stays visually lit while its popup or briefing is open, so the user
 * never loses track of which place the panel is describing. The emphasis is a
 * MapLibre `feature-state` flag (`selected`) that each boundary layer's paint
 * reads to lift its fill opacity and outline weight.
 *
 * Two seams drive it, kept deliberately apart:
 *   - SET happens where the feature id is known: the
 *     InteractionCoordinator's place-bearing commits (each boundary
 *     registration supplies its emphasis targets; a place commit with
 *     none clears the prior subject's) and the search-locate path (the
 *     BIA layer's `LARID`, stable via `promoteId`). The place-selection
 *     store carries only a display context, not a feature id, so it
 *     cannot drive the set.
 *   - CLEAR happens when the selection ends: `initPlaceEmphasis` subscribes to
 *     the place-selection store and drops the emphasis the moment the store
 *     goes null (popup or briefing closed). A selection replaced by another
 *     boundary (store non-null throughout) is handled by the new SET clearing
 *     the prior feature.
 *
 * Feature ids: BIA reservations use `promoteId: 'LARID'` (a stable federal id,
 * so the search can emphasize a land area it located without a click); Tribal
 * Lands, Treaty Areas, and state boundaries use `generateId: true` (no
 * dependency on a deployer-supplied unique field, per the Codex plan-attack
 * finding). Either way the click event carries the id this module needs.
 *
 * Stewardship: this module surfaces no Tribal, Treaty, or sovereign data; it
 * only toggles a render flag on whichever feature the selection flow supplies.
 */

import type maplibregl from 'maplibre-gl';

import { onPlaceSelectionChange } from './place-selection';

/** One emphasized feature identity. */
export interface EmphasisTarget {
  readonly source: string;
  readonly sourceLayer?: string;
  readonly id: string | number;
}

/** The currently emphasized features (empty when nothing is lit). */
let current: readonly EmphasisTarget[] = [];

function sameTarget(a: EmphasisTarget, b: EmphasisTarget): boolean {
  return a.source === b.source && a.id === b.id && a.sourceLayer === b.sourceLayer;
}

/**
 * Set (or move) the emphasis to one feature. A prior emphasis on a different
 * feature is cleared first. A missing id (a source without `promoteId` /
 * `generateId`, which should not happen for the boundary layers) clears any
 * current emphasis rather than lighting an unknown feature.
 *
 * `sourceLayer` is required for VECTOR sources (the ecoregion PMTiles
 * bundle); GeoJSON sources omit it, exactly as MapLibre's own
 * setFeatureState contract requires.
 */
export function emphasizePlace(
  map: maplibregl.Map,
  source: string,
  id: string | number | undefined | null,
  sourceLayer?: string
): void {
  if (id === undefined || id === null) {
    clearEmphasis(map);
    return;
  }
  emphasizePlaces(
    map,
    sourceLayer === undefined ? [{ source, id }] : [{ source, sourceLayer, id }]
  );
}

/**
 * Set the emphasis to a SET of features at once (swarm findings R4 M5 and
 * R2 H3): a Tribal Nation can be represented by several matched land-area
 * polygons, and lighting only the first would present a partial highlight
 * as the whole selected Nation. Prior targets not in the new set are
 * cleared; the set replaces the whole emphasis state.
 */
export function emphasizePlaces(
  map: maplibregl.Map,
  targets: readonly EmphasisTarget[]
): void {
  for (const prior of current) {
    if (!targets.some((t) => sameTarget(t, prior))) applyState(map, prior, false);
  }
  for (const target of targets) applyState(map, target, true);
  current = [...targets];
}

/**
 * The currently emphasized feature identities (empty when nothing is
 * lit). The InteractionCoordinator reads this to rank a click that
 * falls on the already selected place ('selected-place' promotion).
 */
export function getEmphasisTargets(): readonly EmphasisTarget[] {
  return current;
}

/** Clear any current emphasis. Safe to call when nothing is lit. */
export function clearEmphasis(map: maplibregl.Map): void {
  for (const target of current) applyState(map, target, false);
  current = [];
}

/**
 * Write the `selected` feature-state, guarding both the source being gone (the
 * layer was toggled off) and the feature being absent from the current source
 * data (a viewport-clipped refetch that does not include it). Either case is a
 * silent no-op, not an error.
 */
function applyState(
  map: maplibregl.Map,
  sel: { source: string; sourceLayer?: string; id: string | number },
  selected: boolean
): void {
  if (!map.getSource(sel.source)) return;
  try {
    map.setFeatureState(
      sel.sourceLayer === undefined
        ? { source: sel.source, id: sel.id }
        : { source: sel.source, sourceLayer: sel.sourceLayer, id: sel.id },
      { selected }
    );
  } catch {
    // The feature is not present in the current (clipped) source data; the
    // paint simply never reads a state for it. Not an error.
  }
}

/**
 * Wire the close seam: when the place selection clears (popup or briefing
 * closed), drop the emphasis. Called once at boot. The SET side lives in the
 * boundary layers' click handlers and the search-locate path.
 *
 * Returns the store's unsubscribe function so a caller with a bounded lifetime
 * (a test) can drop the subscription; the boot caller ignores it (the seam
 * lives for the session).
 */
export function initPlaceEmphasis(map: maplibregl.Map): () => void {
  return onPlaceSelectionChange((selection) => {
    if (!selection) clearEmphasis(map);
  });
}
