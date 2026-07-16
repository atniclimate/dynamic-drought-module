/**
 * User-visible provenance for the live Tribal-geography layers (the
 * umbrella build's Unit D; design finding 5: the "why compliant / how it
 * routes" story must be legible to a USER, in embed included, not only in
 * code comments).
 *
 * Two surfaces carry it: the per-feature popups (each layer's popup factory
 * in src/ui/popups.ts states publisher, fetched-live-not-bundled, vintage,
 * and the jurisdiction caveat) and the concise group-level disclosure below,
 * rendered by the catalog's Sources disclosure (src/ui/island/catalog.tsx)
 * so it survives desktop, mobile, and the 400 pixel embed. The Tribal
 * Nations umbrella (Unit F) hosts the same note at the group container.
 *
 * Wording rules: CLAUDE.md section 2 (representations, never jurisdictional
 * truth), hard rule 4 (no em dash), hard rules 5 and 6 (capitalization; no
 * abbreviated Tribe names).
 */

/**
 * The one-paragraph group-level provenance note for the Tribal Nations
 * layers. Kept to a single string so every surface that shows it shows the
 * same sentence (the pill-text lesson: shared text cannot drift).
 */
export const TRIBAL_NATIONS_PROVENANCE_NOTE =
  'The Tribal Nations layers are live federal representations: Tribal Lands ' +
  'is the US Census AIANNH product (vintage January 1, 2025); Reservation ' +
  'Boundaries is the BIA AIAN-LAR (no fixed published vintage; the BIA ' +
  'describes it as continuously updated; service verified live July 15, ' +
  '2026); Treaty & Ceded Lands is the US Forest Service Royce cession ' +
  'dataset (published May 29, 2018). Each is requested live from its agency ' +
  "when its layer first needs it and held only in this browser session's " +
  'memory; none of these three federal datasets is bundled with the module. ' +
  'The separate "your own data" slots hold only what a deployer adds under ' +
  'its own authorization. Every boundary shown is a representation for ' +
  'general reference, not a definitive depiction of Tribal jurisdiction; ' +
  'Tribal sovereignty is a matter of sovereign authority.';
