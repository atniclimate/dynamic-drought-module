/**
 * The forbidden forward-looking language shared by the ENSO specs.
 *
 * Written for DDM-P12-T02 in `tests/enso-horizons.spec.ts` and lifted here
 * unchanged by S11 (DDM-P12-T03) so the citations spec asserts the SAME list
 * rather than a second copy that could drift from it. This file is not a spec:
 * it declares no test, and Playwright's `testMatch` does not pick it up.
 *
 * Language that would make a cell read as a statement about what the ocean is
 * going to do. Built from what `src/impact/enso.ts` already treats as needing
 * a denial: every `vocab-allow` comment in that module marks an honesty
 * disclaimer that "denies being a forecast", and the module's own MODULATORS,
 * tendency and plume strings each end in one.
 *
 * `forecast` is checked separately below, because the module uses the word
 * legitimately and only to deny being one. These patterns are deliberately
 * about future CONDITIONS rather than any modal verb: the module says "RONI
 * values may change up to two months" about revisions and "a new RONI season
 * has likely posted" about its own staleness, and neither is a claim about
 * the ocean's future.
 */
import { expect } from '@playwright/test';

export const FORWARD_LOOKING: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'will + condition verb', re: /\bwill\s+(be|remain|continue|persist|strengthen|weaken|warm|cool|develop)\b/i },
  { name: 'is/are expected to', re: /\b(is|are|were|was)\s+expected\s+to\b/i },
  { name: 'predict / project / anticipate', re: /\b(predicts?|predicted|projects?|projected|anticipates?|anticipated)\b/i },
  { name: 'the coming/next weeks, months or seasons', re: /\b(coming|next)\s+(weeks?|months?|seasons?)\b/i },
  { name: 'through the end of / into the season', re: /\bthrough\s+the\s+(end\s+of\s+)?(winter|spring|summer|fall|autumn|season)\b/i }
];

/** `forecast` is allowed only immediately inside a denial. */
export const FORECAST_WORD = /\bforecasts?\b/gi;
export const FORECAST_DENIED = /\b(not|never|no)\b[^.]{0,40}\bforecasts?\b/i;

/**
 * Assert that one block of rendered text makes no claim about the future.
 * `label` names what is being checked so a failure says which cell or claim.
 */
export function expectNoForecastLanguage(label: string, text: string): void {
  for (const { name, re } of FORWARD_LOOKING) {
    expect(re.test(text), `${label} uses forward-looking language (${name}): "${text}"`).toBe(false);
  }
  const uses = text.match(FORECAST_WORD) ?? [];
  if (uses.length > 0) {
    expect(
      FORECAST_DENIED.test(text),
      `${label} says "forecast" outside a denial: "${text}"`
    ).toBe(true);
  }
}
