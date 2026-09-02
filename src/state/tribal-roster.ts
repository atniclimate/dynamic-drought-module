/**
 * The shared, names-only Tribal land-area roster
 * (`public/data/tribal-roster.json`, built by scripts/build-tribal-roster.mjs
 * from the Federal Register roster and the BIA AIAN-LAR LARNAME audit;
 * D-0.7.0-026). Two consumers: the search index (src/ui/search-controller.ts)
 * and other consumers that need trusted formal names. Extracted
 * with Unit I so the STRUCTURAL provenance gate lives in exactly one place.
 *
 * Stewardship: the roster carries NAMES ONLY (no geometry). A formal Tribal
 * Nation name may be used ONLY from a row whose provenance is trusted; any
 * other row keeps the BIA land-area label verbatim (hard rules 5 and 6,
 * D-0.7.0-026). Consumers must not soften this gate.
 */

import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';

/** One land-area row of the shipped roster artifact. */
export interface TribalRosterArea {
  readonly larName: string;
  readonly displayName: string;
  readonly provenance?: string;
}

/**
 * The STRUCTURAL provenance gate (D-0.7.0-026): a Tribal Nation name may
 * render or match ONLY from a roster row whose provenance is one of these
 * values. Any other row (including a row from an older or hand-edited roster
 * with no provenance field at all) is used as the BIA land-area label only.
 */
export const TRUSTED_PROVENANCE: ReadonlySet<string> = new Set([
  'bia-authoritative',
  'safe-match'
]);

const ROSTER_URL = import.meta.env.BASE_URL + 'data/tribal-roster.json';

/**
 * Deadline for the roster load, milliseconds. The artifact is same-origin and
 * about 52 kB, so ten seconds is generous even on a rural connection, while
 * still honoring invariant 7 (non-trivial network work must be cancellable and
 * time-bounded). Previously this was a bare `fetch` with no signal and no
 * timeout (ARCH-05).
 */
const ROSTER_TIMEOUT_MS = 10_000;

let rosterCache: readonly TribalRosterArea[] | null = null;
let rosterInFlight: Promise<readonly TribalRosterArea[]> | null = null;

/**
 * Lazy-load the roster's area rows (once, cached). REJECTS on failure
 * (invariant 6: a failed load must surface honestly, never masquerade as an
 * empty roster); a later attempt can retry.
 */
export function loadTribalRoster(): Promise<readonly TribalRosterArea[]> {
  if (rosterCache) return Promise.resolve(rosterCache);
  if (rosterInFlight) return rosterInFlight;
  rosterInFlight = (async () => {
    try {
      const json = await fetchJsonWithBudget(
        ROSTER_URL,
        null,
        null,
        ROSTER_TIMEOUT_MS
      );
      const areas = isObject(json) ? json['areas'] : undefined;
      rosterCache = Array.isArray(areas) ? (areas as readonly TribalRosterArea[]) : [];
      return rosterCache;
    } catch (err) {
      console.warn('[tribal-roster] roster load failed.', err);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      rosterInFlight = null;
    }
  })();
  return rosterInFlight;
}

/**
 * The formal Tribal Nation name for a BIA land area, or null when the roster
 * has no TRUSTED row for it (the safe residue: never a guessed name). Pure
 * over the supplied rows so the gate is unit-testable without a fetch.
 *
 * Currently no caller invokes this (ARCH-12). The one live application of the
 * gate open-codes the same rule at `src/ui/search-controller.ts:105`, which
 * imports `TRUSTED_PROVENANCE` directly; `src/config/place-catalog.ts` takes
 * formal names from the crosswalk artifact instead and does not consult
 * provenance at all. Kept, not deleted, because it is the single readable
 * statement of D-0.7.0-026: the next consumer should call this rather than
 * re-derive the rule. Adopting it in `search-controller.ts` is a change in
 * that file's owner's hands.
 */
export function trustedNameFor(
  larName: string,
  areas: readonly TribalRosterArea[]
): string | null {
  const target = larName.trim().toLowerCase();
  if (target === '') return null;
  for (const area of areas) {
    if (area.larName.trim().toLowerCase() !== target) continue;
    return TRUSTED_PROVENANCE.has(area.provenance ?? '') ? area.displayName : null;
  }
  return null;
}
