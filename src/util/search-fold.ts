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
