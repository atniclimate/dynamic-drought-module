/**
 * The shared, names-only Tribal land-area roster
 * (`public/data/tribal-roster.json`, built by scripts/build-tribal-roster.mjs
 * from the Federal Register roster and the BIA AIAN-LAR LARNAME audit;
 * D-0.7.0-026). Three consumers share the one gate helper below: the search
 * index (src/ui/search-controller.ts), the place catalog's Tribal Nations
 * list (src/config/place-catalog.ts, since DR-094), and other consumers that
 * need trusted formal names. Extracted with Unit I so the STRUCTURAL
 * provenance gate lives in exactly one place.
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

/**
 * The one gate helper (DR-094, DDM-P2-T10): a roster row's displayName is
 * shown only from trusted provenance; any other row's own BIA land-area name
 * (`larName`) is the honest fallback, with NO visible marker distinguishing
 * the two (titles stay uniform per DR-094; any caveat lives in metadata or
 * the Impact Briefing, never in a title). Both live callers of the gate
 * (src/ui/search-controller.ts and src/config/place-catalog.ts) call this
 * one function rather than re-deriving the rule.
 */
export function gatedDisplayName(area: TribalRosterArea): string {
  return TRUSTED_PROVENANCE.has(area.provenance ?? '') ? area.displayName : area.larName;
}

// Guarded so a pure Node test can import this module without a Vite-served
// page (the same idiom as src/config/urls-boot.ts:29, DDM-P2-T12).
const ROSTER_URL = (import.meta.env?.BASE_URL ?? '/dynamic-drought-module/') + 'data/tribal-roster.json';

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
