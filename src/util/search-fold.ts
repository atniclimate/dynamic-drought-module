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
