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
 * Wording rules, all project hard rules: representations, never
 * jurisdictional truth; no em dash; Tribal/Nation capitalization; no
 * abbreviated Tribe names.
 */

/**
 * The one-paragraph group-level provenance note for the Tribal Nations
 * layers. Kept to a single string so every surface that shows it shows the
 * same sentence (the pill-text lesson: shared text cannot drift).
 */
export const TRIBAL_NATIONS_PROVENANCE_NOTE =
  'The Tribal Nations layers are live federal representations: Tribal Lands ' +
  'is the US Census AIANNH product (vintage January 1, 2025); Reservation ' +
  'Boundaries uses BIA LAR. LAR feature definitions were last published in ' +
  '2019. The live BIA service separately reports continuing spatial-accuracy ' +
  'and attribute updates, and each BIA boundary popup shows the browser ' +
  'retrieval date. BIA authority is limited to BIA mission use; the layer is ' +
  'illustrative, reference, and statistical only, not legal, survey, or ' +
  'jurisdictional truth. Each federal layer is requested live from its agency ' +
  "when its layer first needs it and held only in this browser session's " +
  'memory; neither federal dataset is bundled with the module. ' +
  'The separate "your own data" slots hold only what a deployer adds under ' +
  'its own authorization. Every boundary shown is a representation for ' +
  'general reference, not a definitive depiction of Tribal jurisdiction; ' +
  "Tribal sovereignty and each Tribe's understanding of its territory are " +
  'matters of sovereign authority, and absence from a federal layer is not ' +
  'absence of a Tribal Nation or its rights.';
