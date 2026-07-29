/**
 * Interaction target precedence for the InteractionCoordinator (S1;
 * D-0.7.0-041 part 2, adopting the ratified Codex design review,
 * C:/dev/_reviews/ddm/2026-07-16_desktop-first-open-design.md section
 * B; the cross-cutting hover/click cleanliness item in the region shell
 * decision register).
 *
 * THE RULE: smallest intentional subject before contextual surface.
 * For one pointer point, the coordinator resolves exactly ONE primary
 * target by this order; lower-priority hits surface only through the
 * "Other map features here" disclosure, never as stacked popups. The
 * order is SEMANTIC and deterministic: it must never depend on paint
 * order, network completion, or listener registration (the defect class
 * the review confirmed in the shipped per-layer click handlers).
 *
 * The condition surface is deliberately LAST: it blankets every other
 * target, and ranking it higher would make sovereign geography visible
 * but unreachable.
 *
 * S1 lands only this table; the coordinator that consumes it is a later
 * unit (it feeds S4 and the embed response feeds S6). (The Unit I
 * related-cessions probe this note once described was retired with the
 * live Treaty layer, D-0.7.0-065.)
 */

/**
 * The interaction target classes, from most to least intentional. The
 * mapping from LAYER_DEFS keys and other hit sources onto these kinds
 * belongs to the coordinator's registration step, not this table:
 *
 *   point-event          monitoring station, wildfire perimeter, alert,
 *                        named place label
 *   selected-place       the already selected typed place or located
 *                        boundary highlight, when the click falls
 *                        within it
 *   reservation-boundary the BIA AIAN-LAR representation
 *   tribal-lands         the Census AIANNH representation
 *   treaty-cession       the deployer-provided Treaty representation (the
 *                        own-data slot, `src/layers/treaty.ts`), which
 *                        registers this rank when activated; the retired
 *                        LIVE cession layer (D-0.7.0-065) has no producer
 *   ecoregion-watershed  ecoregion or watershed boundary when active
 *   state-boundary       state outline
 *   condition-surface    the active condition surface (USDM and peers)
 */
export type InteractionTargetKind =
  | 'point-event'
  | 'selected-place'
  | 'reservation-boundary'
  | 'tribal-lands'
  | 'treaty-cession'
  | 'ecoregion-watershed'
  | 'state-boundary'
  | 'condition-surface';

/** Precedence order, highest priority first. */
export const INTERACTION_TARGET_RANKS: readonly InteractionTargetKind[] = [
  'point-event',
  'selected-place',
  'reservation-boundary',
  'tribal-lands',
  'treaty-cession',
  'ecoregion-watershed',
  'state-boundary',
  'condition-surface'
];

/**
 * Numeric rank for a target kind; lower wins. Exposed so the
 * coordinator can sort hit lists without re-deriving the table.
 */
export function interactionRank(kind: InteractionTargetKind): number {
  return INTERACTION_TARGET_RANKS.indexOf(kind);
}
