import type { GeoJsonProperties } from 'geojson';

/**
 * Read a field from a table-qualified property bag, deterministically. The
 * USFS EDW Royce cession service is an ESRI JOIN of two tables, so its
 * GeoJSON property keys arrive FULLY TABLE-QUALIFIED (for example
 * `edw.s_usa.BdyPol_TribalCededLandsTable.presdaytrb`); a bare-name read
 * would silently miss them (see the urls.ts `usfsRoyceCessions` receipt).
 *
 * Resolution order (Codex Unit B2 finding 5: never let upstream property
 * enumeration order pick a value on a stewardship-sensitive surface):
 *   1. exactly ONE key ending `.<suffix>` (case-insensitive): return it;
 *   2. two or more such keys: AMBIGUOUS; return null (the caller omits the
 *      value rather than guessing which joined table's value to show);
 *   3. no suffix match: an exact bare-name key, if present.
 * `endsWith('.<suffix>')` cannot match `mapname1`..`mapname6` when asked for
 * `mapname`. Returns null when the field is absent or empty.
 *
 * A leaf module (no app imports) so the popup factories, the cession layer,
 * and the pure cession matcher share one implementation.
 */
export function readTableQualifiedField(
  props: GeoJsonProperties,
  suffix: string
): string | null {
  if (!props) return null;
  const needle = `.${suffix}`.toLowerCase();
  const bare = suffix.toLowerCase();
  let suffixValue: string | null = null;
  let suffixMatches = 0;
  let bareValue: string | null = null;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === '') continue;
    const k = key.toLowerCase();
    if (k.endsWith(needle)) {
      suffixMatches += 1;
      if (suffixMatches === 1) suffixValue = String(value);
    } else if (k === bare && bareValue === null) {
      bareValue = String(value);
    }
  }
  if (suffixMatches === 1) return suffixValue;
  if (suffixMatches > 1) return null;
  return bareValue;
}
