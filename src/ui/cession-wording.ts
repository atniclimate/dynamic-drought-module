/**
 * The related Treaty & Ceded Lands slot and its outcome wording (Unit I,
 * D-0.7.0-038 decision 2). A LEAF module (no app imports) so the popup
 * factories, the lookup orchestrator (src/impact/related-cessions.ts), and
 * the specs share one voice without dragging the popup module's telemetry
 * graph (or `import.meta.env`) into a Node test context.
 */

/**
 * The related-cession status slot in the Tribal Lands and Reservation
 * Boundaries popups. `data-related-cessions` is the hook
 * `hydrateRelatedCessions` fills once the safe name match against the Royce
 * record resolves. Static markup, no interpolation.
 */
export const RELATED_CESSIONS_SLOT_HTML =
  '<div class="popup-cessions" data-related-cessions>Checking the Royce record for related Treaty and Ceded Lands…</div>';

/** The outcome of one related-cession lookup, for the slot wording.
 * `activated: false` on a match means the lookup did NOT turn the layer on
 * (the user turned it off while the probe ran; their toggle wins). */
export type RelatedCessionOutcome =
  | { readonly state: 'matched'; readonly count: number; readonly activated: boolean }
  | { readonly state: 'no-match' }
  | { readonly state: 'unmatchable' }
  | { readonly state: 'unavailable' };

/**
 * The honest user-facing line for each related-cession outcome (Unit I's
 * mandatory no-match honesty; D-0.7.0-038 decision 2). The no-match line
 * never claims a Tribe lacks a Treaty relationship (Royce documents
 * 19th-century cessions only), an ambiguous name match refuses rather than
 * guesses (the D-0.7.0-026 discipline), and a failed check claims nothing.
 */
export function relatedCessionsStatusText(outcome: RelatedCessionOutcome): string {
  switch (outcome.state) {
    case 'matched': {
      // Fact first (the record exists), then the toggle state, never a
      // render claim the layer may not yet (or ever) fulfill (Codex Unit I
      // review, finding 3): the checkbox is what this module changed; the
      // pill carries the layer's own honest load status.
      const base = `Treaty & Ceded Lands: ${outcome.count} related Royce cession${
        outcome.count === 1 ? '' : 's'
      } on file for this land area.`;
      return outcome.activated
        ? `${base} The layer is on; the matches are highlighted as it loads.`
        : `${base} Turn the Treaty & Ceded Lands layer on to see them highlighted.`;
    }
    case 'no-match':
      return 'Treaty & Ceded Lands: no Royce cession on file for this land area. Royce documents 19th-century cessions only; absence is not evidence that a Tribe lacks a Treaty relationship.';
    case 'unmatchable':
      return 'Treaty & Ceded Lands: this land area could not be matched to the Royce cession record by name (names are matched only when the link is certain), so none are highlighted. The Treaty & Ceded Lands layer can still be turned on to explore all cessions.';
    case 'unavailable':
      return 'Treaty & Ceded Lands: the Royce cession record could not be checked right now.';
  }
}
