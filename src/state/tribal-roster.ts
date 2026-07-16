/**
 * The shared, names-only Tribal land-area roster
 * (`public/data/tribal-roster.json`, built by scripts/build-tribal-roster.mjs
 * from the Federal Register roster and the BIA AIAN-LAR LARNAME audit;
 * D-0.7.0-026). Two consumers: the search index (src/ui/search-controller.ts)
 * and the related-cession matcher (src/impact/related-cessions.ts). Extracted
 * with Unit I so the STRUCTURAL provenance gate lives in exactly one place.
 *
 * Stewardship: the roster carries NAMES ONLY (no geometry). A formal Tribal
 * Nation name may be used ONLY from a row whose provenance is trusted; any
 * other row keeps the BIA land-area label verbatim (hard rules 5 and 6,
 * D-0.7.0-026). Consumers must not soften this gate.
 */

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
      const res = await fetch(ROSTER_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { areas?: TribalRosterArea[] };
      rosterCache = json.areas ?? [];
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
