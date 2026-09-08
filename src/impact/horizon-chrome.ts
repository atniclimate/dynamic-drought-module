/**
 * The interface's three horizon headings: the title and the short
 * time-window subtitle a reader sees for each of the three temporal
 * horizons, wherever the interface names one.
 *
 * ONE TABLE, THE WHOLE INTERFACE (DDM-P8-T03, owner ruling R1, 2026-09-07).
 * Originally "one table, two readers" (2026-09-07, session S10): the lazy
 * briefing composer (`src/impact/briefing.ts`) and the eager panel facade's
 * module-failure path (`src/ui/impact-panel.ts`), which had each carried
 * their own copy and drifted (the live near-term subtitle read "days to a
 * season" while the failure path read "days to weeks"). The same day, a
 * second collision surfaced: the map shell's horizon chips
 * (`src/ui/island/shell.tsx`) and the panel-foot response line
 * (`src/ui/island/panel-response.tsx`) read a SEPARATE table,
 * `TEMPORAL_HORIZON_CHIP_LABELS` in `src/config/clusters.ts`
 * ("Current" / "Weeks ahead" / "Season ahead"), so the same horizon read
 * "Near Term" in the briefing and "Weeks ahead" on the shell at the same
 * moment. `clusters.ts` had reserved that collision for an owner ruling
 * rather than resolve it by refactor. The ruling: this table is the single
 * source of horizon names for the whole interface. `TEMPORAL_HORIZON_CHIP_LABELS`
 * is retired; the shell chips and the response line now read this table too,
 * through `SHELL_HORIZON_KEY` below (the map shell's registers stay keyed
 * `current | weeks-ahead | season-ahead` for routing; only the display text
 * moved). `TEMPORAL_HORIZON_LABELS`, the map shell's separate prose-cadence
 * table ("next seven days"), had zero production consumers by 2026-09-07 (its
 * only reader was a test pin) and was removed outright rather than folded in,
 * the smaller diff; `tests/heat-h1-heatrisk.spec.ts` re-points its pin at this
 * table.
 *
 * WHY THIS IS ITS OWN MODULE. The eager panel facade may not import the
 * composer (`scripts/check-activation-budget.mjs` forbids `briefing.ts` in
 * the initial static set) and deliberately does not import the matrix module
 * either, whose per-cell absence prose is a kilobyte the failure path never
 * renders (`impact-panel.ts`, the comment on `unavailableCells`). A table of
 * three headings with a single type-only import costs the entry chunk
 * nothing it was not already carrying, and gives every reader the same
 * source of truth.
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

import type { TemporalHorizonKey } from '../config/clusters';
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

/**
 * The map shell's `TemporalHorizonKey` (routing: URL tokens, recipe
 * selection) maps to this table's `HorizonKey` one for one, so a shell
 * consumer can read `HORIZON_CHROME[SHELL_HORIZON_KEY[key]]` and never
 * carry its own copy of the words.
 */
export const SHELL_HORIZON_KEY: Readonly<Record<TemporalHorizonKey, HorizonKey>> = {
  current: 'current',
  'weeks-ahead': 'nearTerm',
  'season-ahead': 'longRange'
};
