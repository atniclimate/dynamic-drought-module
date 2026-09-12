/**
 * United States state, district, and territory postal codes: pure config,
 * no briefing logic. Split out of `src/impact/resources.ts` (the impact
 * briefing cluster's resource routing) so an eager-graph import that only
 * needs the type guard never hoists the whole cluster into the initial
 * chunk (`scripts/check-activation-budget.mjs`'s "impact briefing cluster
 * resource routing" rule). `resources.ts` re-exports `StateCode` and
 * `isStateCode` from here so every existing `from './resources'` import
 * inside the briefing cluster keeps compiling unchanged; only a module
 * reachable from the eager graph should import this file directly.
 */

/**
 * Two-letter state, district, or territory postal code used for resource
 * routing. Covers the 52 features in the bundled Census cartographic boundary
 * file (public/data/us-states.geojson): the 50 states, the District of
 * Columbia, and Puerto Rico.
 */
export type StateCode =
  | 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'FL' | 'GA'
  | 'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS' | 'KY' | 'LA' | 'ME' | 'MD'
  | 'MA' | 'MI' | 'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH' | 'NJ'
  | 'NM' | 'NY' | 'NC' | 'ND' | 'OH' | 'OK' | 'OR' | 'PA' | 'RI' | 'SC'
  | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' | 'WA' | 'WV' | 'WI' | 'WY'
  | 'DC' | 'PR';

/** Federal Information Processing Standards (FIPS) state codes. */
export const STATE_FIPS: Record<StateCode, number> = {
  AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, FL: 12, GA: 13,
  HI: 15, ID: 16, IL: 17, IN: 18, IA: 19, KS: 20, KY: 21, LA: 22, ME: 23,
  MD: 24, MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31, NV: 32,
  NH: 33, NJ: 34, NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40, OR: 41,
  PA: 42, RI: 44, SC: 45, SD: 46, TN: 47, TX: 48, UT: 49, VT: 50, VA: 51,
  WA: 53, WV: 54, WI: 55, WY: 56, DC: 11, PR: 72
};

/** Whether a raw uppercased string is a state, district, or territory code this catalog covers. */
export function isStateCode(code: string): code is StateCode {
  return code in STATE_FIPS;
}
