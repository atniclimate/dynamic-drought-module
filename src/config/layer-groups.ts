/**
 * Layer-group definitions: the single source of truth for the Tribal
 * Nations umbrella (D-0.7.0-033; the umbrella build's Unit F). The group's
 * label, its ordered members, and its button's action set live HERE and
 * nowhere else; the catalog umbrella (src/ui/island/catalog.tsx) and the
 * eager Brief-door action (src/ui/tribal-nations-action.ts) both read this
 * table, never a per-LayerDef groupLabel and never `defaultOn` (an
 * absent-URL default and a user-invoked group command are separate policy
 * surfaces even while their sets currently match; the Codex front-end
 * consultation, risk 7).
 */

export interface LayerGroupDef {
  /** The group container selector value (`data-layer-group-key`). */
  readonly key: string;
  /** The visible label; also the prominent button's text. */
  readonly label: string;
  /**
   * Ordered member layer keys: the granular-disclosure render order. Every
   * member must exist in LAYER_DEFS exactly once and carry the `reference`
   * role (asserted by tests/umbrella-config.spec.ts).
   */
  readonly members: readonly string[];
  /**
   * The prominent button's action set, in invocation order; a subset of
   * `members`. The two deployer own-data slots are deliberately NOT in it:
   * the button never turns on a layer whose data only a deployer can
   * authorize.
   */
  readonly buttonActivates: readonly string[];
  /** One-sentence effect description (the button's aria-describedby). */
  readonly actionDescription: string;
}

export const TRIBAL_NATIONS_GROUP: LayerGroupDef = {
  key: 'tribal-nations',
  label: 'Tribal Nations',
  members: ['aiannh', 'bia-reservations', 'treaty-cessions', 'tribal', 'treaty'],
  buttonActivates: ['aiannh', 'bia-reservations', 'treaty-cessions'],
  actionDescription:
    'Turns on Tribal Lands, Reservation Boundaries, and Treaty & Ceded Lands.'
};

export const LAYER_GROUPS: readonly LayerGroupDef[] = [TRIBAL_NATIONS_GROUP];
