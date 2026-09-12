/**
 * DR-090 (owner, 2026-09-11 prep session): "gate impact synthesis by the
 * place's coverage (`containing`), not the camera region." This module is
 * the PLACE-keyed twin of `src/config/region-capability.ts` (the
 * camera-keyed hook): it turns a `CanonicalGeography` (the place, resolved
 * by `resolveCanonicalGeography` in `src/config/geography.ts`, place before
 * camera) into a `CoverageFamilyKey`
 * (`src/config/capability-matrix.ts`), then into a capability level or
 * note the same way `regionCapabilityLevel`/`regionCapabilityNote` do for a
 * `RegionKey`. Kept separate for the same reason as that module: so
 * `src/config/capability-matrix.ts` stays import-free for the
 * coverage-matrix generator, and the matrix only enters a consumer's graph
 * through a behavioral hook like this one.
 *
 * THE POSTAL-CODE-TO-FAMILY HOP, the one authority this module adds (no
 * state-to-coverage-family mapping existed anywhere under src/ before this):
 * `PLACE_COVERAGE_OVERRIDES` below lists every US postal code that does NOT
 * take the CONUS default, and which family it takes instead.
 *
 *   - Washington, Oregon, Idaho -> 'pnw'. This membership is anchored in an
 *     existing declaration rather than invented here: `src/impact/water-supply.ts`'s
 *     NWRFC domain gate already documents "Claims are produced only for
 *     selections that resolve to Washington, Oregon, or Idaho" (its doc
 *     comment, about :18-23). Reusing that boundary is SESSION-PROPOSED
 *     pending ratification, not an owner ruling of its own.
 *   - Alaska, Hawaii -> 'ak-hi'.
 *   - every other US postal code -> 'conus' (the default; not listed below).
 *   - a geography with no US postal code follows its own key:
 *     'canada' -> 'canada', 'transboundary' -> 'transboundary'; anything
 *     else (unknown, puerto-rico, served-territory, american-samoa) -> null,
 *     which reads as capability level 'none', the same honest-unknown
 *     answer `regionCapabilityLevel` gives for an unrecognized region.
 *
 * OPEN QUESTION for the owner card, named rather than answered: whether
 * Montana, Wyoming, Nevada, or Utah should also read as 'pnw' (the Columbia
 * and Snake basin framing reaches parts of them). Deliberately excluded
 * here; do not add them without a ruling.
 */

import type { CanonicalGeography } from './geography';
import { CAPABILITY_MATRIX } from './capability-matrix';
import type {
  CapabilityAxisKey,
  CapabilityLevel,
  CoverageFamilyKey
} from '../types/capability-matrix';

/**
 * One row: a US postal code this table gives an EXPLICIT family membership
 * that differs from the CONUS default. `PostalCodeOverrideKey` is derived
 * from this list (the LAYER_KEYS pattern, `src/config/layers.ts`), so this
 * table is the one authority for the postal-code-to-family hop.
 */
export const PLACE_COVERAGE_OVERRIDES = Object.freeze([
  { postalCode: 'WA', family: 'pnw' },
  { postalCode: 'OR', family: 'pnw' },
  { postalCode: 'ID', family: 'pnw' },
  { postalCode: 'AK', family: 'ak-hi' },
  { postalCode: 'HI', family: 'ak-hi' }
] as const);

/** The union of postal codes `PLACE_COVERAGE_OVERRIDES` names, derived. */
export type PostalCodeOverrideKey =
  (typeof PLACE_COVERAGE_OVERRIDES)[number]['postalCode'];

const FAMILY_BY_OVERRIDDEN_POSTAL_CODE: ReadonlyMap<string, CoverageFamilyKey> =
  new Map(PLACE_COVERAGE_OVERRIDES.map((row) => [row.postalCode, row.family]));

const UNKNOWN_PLACE_NOTE =
  'Drought impact analysis and resource routing are unavailable because this selection has no recognized coverage region.';

/**
 * The postal-code-to-family hop: postal code first (the overrides table,
 * else the CONUS default for any other US code), then the geography's own
 * key for a postal-code-free geography (Canada, transboundary), else null.
 */
export function coverageFamilyForGeography(
  geography: CanonicalGeography
): CoverageFamilyKey | null {
  if (geography.postalCode) {
    const overridden = FAMILY_BY_OVERRIDDEN_POSTAL_CODE.get(geography.postalCode);
    if (overridden) return overridden;
  }
  if (geography.key === 'conus') return 'conus';
  if (geography.key === 'canada') return 'canada';
  if (geography.key === 'transboundary') return 'transboundary';
  return null;
}

/**
 * The honest-disablement hook, keyed by the PLACE rather than the camera
 * region. Mirrors `regionCapabilityLevel` (src/config/region-capability.ts).
 */
export function placeCapabilityLevel(
  geography: CanonicalGeography,
  axis: CapabilityAxisKey
): CapabilityLevel {
  const family = coverageFamilyForGeography(geography);
  return family === null ? 'none' : CAPABILITY_MATRIX[family][axis].level;
}

/** The matrix note paired with `placeCapabilityLevel`, for honest UI copy. */
export function placeCapabilityNote(
  geography: CanonicalGeography,
  axis: CapabilityAxisKey
): string {
  const family = coverageFamilyForGeography(geography);
  return family === null
    ? UNKNOWN_PLACE_NOTE
    : CAPABILITY_MATRIX[family][axis].note;
}
