/**
 * The briefing's three horizon headings: the title and the short time-window
 * subtitle a reader sees above each column of the four-hazard by
 * three-horizon matrix.
 *
 * ONE TABLE, TWO READERS. The lazy composer (`src/impact/briefing.ts`) builds
 * the live briefing from it, and the eager panel facade
 * (`src/ui/impact-panel.ts`) builds the module-failure presentation from it.
 * Until 2026-09-07 each carried its own copy and they had already drifted:
 * the live near-term subtitle read "days to a season" while the failure path
 * read "days to weeks", and long-range read "season to water year" against
 * "months". A reader could see two different definitions of the same horizon
 * depending on whether a chunk loaded.
 *
 * WHY THIS IS ITS OWN MODULE. The eager facade may not import the composer
 * (`scripts/check-activation-budget.mjs` forbids `briefing.ts` in the initial
 * static set) and deliberately does not import the matrix module either, whose
 * per-cell absence prose is a kilobyte the failure path never renders
 * (`impact-panel.ts`, the comment on `unavailableCells`). A table of three
 * headings with a single type-only import costs the entry chunk nothing it was
 * not already carrying, and gives both readers the same source of truth.
 *
 * This is NOT `TEMPORAL_HORIZON_LABELS` in `src/config/clusters.ts`. That table
 * is keyed by the map shell's registers (`current | weeks-ahead | season-ahead`)
 * and holds prose cadence fragments ("next seven days"); this one is keyed by
 * the briefing's `HorizonKey` and holds column headings. The two are separate
 * on purpose, and that module says so in its own words.
 *
 * Chrome only: nothing here is a claim, an absence note, or an issuer's product
 * name. Those stay where the evidence is.
 *
 * THE WORDS, owner-decided 2026-09-07 (session S10, closing DDM-P12-T02). The
 * near-term and long-range headings used to end in "outlook". Under the
 * near-term one sat an ENSO claim whose own text says it is not a forecast
 * (DR-031 a), and the DDM-P12-T02 acceptance says no horizon may imply a
 * forecast the app does not have. A heading is part of the horizon. So no
 * heading says "outlook" or "forecast" now, the titles carry no hyphen
 * ("Near Term", never "Near-Term"), and tests/enso-horizons.spec.ts pins both
 * against this table. Issuer product names that ARE outlooks (the CPC Seasonal
 * Drought Outlook) keep the word; they live in claim text, not here.
 */

import type { HorizonKey } from './types';

export interface HorizonChrome {
  /** The section heading. */
  readonly title: string;
  /** The short definition of the time window, shown beside the heading. */
  readonly subtitle: string;
}

export const HORIZON_CHROME: Readonly<Record<HorizonKey, HorizonChrome>> = {
  current: { title: 'Current Conditions', subtitle: 'now' },
  nearTerm: { title: 'Near Term', subtitle: 'days to weeks' },
  longRange: { title: 'Long Range', subtitle: 'season to water year' }
};
