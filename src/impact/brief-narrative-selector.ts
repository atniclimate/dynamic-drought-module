import type { ImpactBriefing } from './types';

/**
 * Select the succinct at-hand line already used by the briefing surfaces.
 * This module does not compose or rewrite impact language.
 */
export function selectBriefNarrativeLine(
  briefing: ImpactBriefing
): string | null {
  const text = briefing.horizons.current.claims[0]?.text.trim();
  return text ? text : null;
}
