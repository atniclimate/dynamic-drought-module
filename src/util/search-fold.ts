/**
 * The ONE text normalization for search matching, shared by every search
 * surface (the shared search component and wiring, and the PLACE studio
 * filter). Query and haystack MUST fold identically or punctuation and
 * diacritics silently break matching: a formal Tribal Nation name such as
 * "Absentee-Shawnee Tribe of Indians of Oklahoma" or a pasted layer label
 * such as "City & Town Labels" must match its punctuation-free typing and
 * its exact spelling alike (wave A finding 1, 2026-07-17; the roster build
 * script applies the same folding).
 *
 * Folding: lowercase, decompose and strip combining marks (diacritics),
 * replace every non-alphanumeric with a space, collapse whitespace, trim.
 */
export function foldSearchText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The one rank the search applies (no confidence score): a stable partition
 * that puts items whose folded label starts with the folded query first, so
 * "oregon" lists the state ahead of a Tribe whose name ends in "Oregon".
 */
export function prefixFirst<T extends { label: string }>(
  items: readonly T[],
  foldedQuery: string
): T[] {
  const starts = (i: T): boolean => foldSearchText(i.label).startsWith(foldedQuery);
  return [...items.filter(starts), ...items.filter((i) => !starts(i))];
}

/** Words a formal Tribal name carries that a Census area name lacks ("Cherokee Nation" vs "Cherokee OTSA"). */
const TRIBAL_GENERIC_WORDS = ['nation', 'tribe', 'tribes', 'band', 'indians', 'of', 'the'];

/**
 * Every query token appears in the folded haystack. For a Tribal row a
 * missing token that is (the start of) a generic Tribal word is skipped, as
 * long as one token does appear, so a formal Nation name finds its Census
 * area. Only matching relaxes; the row's label is unchanged.
 */
export function matchesTokens(haystack: string, tokens: readonly string[], tribal: boolean): boolean {
  const skip = (t: string): boolean => tribal && TRIBAL_GENERIC_WORDS.some((w) => w.startsWith(t));
  return (
    tokens.some((t) => haystack.includes(t)) && tokens.every((t) => haystack.includes(t) || skip(t))
  );
}

/**
 * What Enter picks with no highlighted row, across the search's groups: a
 * label equal to the query, else the first label that starts with it, else
 * nothing. A typed-out "Colorado" opens the state, not an earlier Tribal row
 * whose name begins with "Colorado". An id equal to the query counts as
 * exact, so a state code such as "CA" opens California. No first-row
 * fallback: a row that only contains the words may be another Nation's area
 * ("Seneca Nation" finds only "Seneca-Cayuga Nation"), so the caller
 * highlights it and a second Enter opens what the person can see.
 */
export function enterChoice<T extends { label: string; id?: string }>(
  items: readonly T[],
  foldedQuery: string
): T | undefined {
  const folded = items.map((i) => foldSearchText(i.label));
  const at = (pick: (f: string, i: number) => boolean): T | undefined => items[folded.findIndex(pick)];
  return (
    at((f, i) => f === foldedQuery || foldSearchText(items[i].id ?? '') === foldedQuery) ??
    at((f) => f.startsWith(foldedQuery))
  );
}
