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
 */

import type { HorizonKey } from './types';

export interface HorizonChrome {
  /** The section heading. */
  readonly title: string;
  /** The short definition of the time window, shown beside the heading. */
  readonly subtitle: string;
}

export const HORIZON_CHROME: Readonly<Record<HorizonKey, HorizonChrome>> = {
  current: { title: 'Current conditions', subtitle: 'now' },
  nearTerm: { title: 'Near-term outlook', subtitle: 'days to a season' },
  longRange: { title: 'Long-range outlook', subtitle: 'season to water year' }
};
