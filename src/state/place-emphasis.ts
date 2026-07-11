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
 *   - SET happens where the feature id is known: each boundary layer's click
 *     handler (`e.features[0].id`) and the search-locate path (the BIA layer's
 *     `LARID`, stable via `promoteId`). The place-selection store carries only
 *     a display context, not a feature id, so it cannot drive the set.
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

/** The currently emphasized feature, or null when nothing is lit. */
let current: { source: string; id: string | number } | null = null;

/**
 * Set (or move) the emphasis to one feature. A prior emphasis on a different
 * feature is cleared first. A missing id (a source without `promoteId` /
 * `generateId`, which should not happen for the boundary layers) clears any
 * current emphasis rather than lighting an unknown feature.
 */
export function emphasizePlace(
  map: maplibregl.Map,
  source: string,
  id: string | number | undefined | null
): void {
  if (id === undefined || id === null) {
    clearEmphasis(map);
    return;
  }
  if (current && (current.source !== source || current.id !== id)) {
    applyState(map, current, false);
  }
  current = { source, id };
  applyState(map, current, true);
}

/** Clear any current emphasis. Safe to call when nothing is lit. */
export function clearEmphasis(map: maplibregl.Map): void {
  if (!current) return;
  applyState(map, current, false);
  current = null;
}

/**
 * Write the `selected` feature-state, guarding both the source being gone (the
 * layer was toggled off) and the feature being absent from the current source
 * data (a viewport-clipped refetch that does not include it). Either case is a
 * silent no-op, not an error.
 */
function applyState(
  map: maplibregl.Map,
  sel: { source: string; id: string | number },
  selected: boolean
): void {
  if (!map.getSource(sel.source)) return;
  try {
    map.setFeatureState({ source: sel.source, id: sel.id }, { selected });
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
