/**
 * The safe Royce-cession matcher (Unit I, D-0.7.0-038 decision 2): pure
 * name matching between a clicked Tribal land area and the `presdaytrb`
 * ("Present-Day Tribe") field of USFS Royce cession features.
 *
 * Discipline (D-0.7.0-026 applied at runtime; the design note
 * docs/design/UNIT_I_RELATED_CESSIONS_2026-07-15.md records the calls): a
 * cession is attributed to a clicked Tribe ONLY on a match that cannot
 * misattribute one Tribal Nation's history to another.
 *
 *   1. FORMAL names (the Federal Register form, obtained only through the
 *      trusted roster rows): normalized equality with a presdaytrb segment,
 *      or whole-phrase containment in either direction (the service segment
 *      often carries a trailing state the roster form omits, and older
 *      Federal Register wordings drift). A full formal name is distinctive,
 *      so containment of the WHOLE name is safe.
 *   2. LOOSE names (the clicked feature's own label: BASENAME / NAME /
 *      LARNAME): whole-phrase containment in a segment, accepted only when
 *      every hit for that needle agrees on ONE present-day-Tribe value
 *      across the supplied feature set. Two distinct values matching the
 *      same needle is AMBIGUOUS and the matcher refuses (never a guess).
 *      Needles under four normalized characters are refused outright.
 *
 * `presdaytrb` frequently carries several names separated by semicolons;
 * every rule works per segment. Matched features are identified by their
 * cession number (the promoted feature id the map's feature-state uses).
 */

import type { Feature, GeoJsonProperties, Geometry } from 'geojson';

import { readTableQualifiedField } from '../util/table-qualified';

/** The exact promoted-id property of the cession polygons (see
 * src/layers/treaty-cessions.ts; the table-qualified join key). */
export const CESSNUM_PROPERTY = 'edw.s_usa.BdyPol_TribalCededLands.cessnum';

/** The candidate names for one clicked land area, strongest lane first. */
export interface CessionMatchQuery {
  /** Federal Register formal names from TRUSTED roster rows only. */
  readonly formalNames: readonly string[];
  /** The clicked feature's own labels (BASENAME / NAME / LARNAME). */
  readonly looseNames: readonly string[];
}

export type CessionMatchResult =
  | { readonly state: 'matched'; readonly ids: ReadonlyArray<string | number> }
  | { readonly state: 'none' }
  | { readonly state: 'ambiguous' };

/** Minimum normalized needle length for the loose-containment lane. */
const MIN_LOOSE_NEEDLE = 4;

/**
 * Minimum token count for a presdaytrb segment to match by REVERSE
 * containment (segment contained in the formal name). Without this, a
 * one-word segment ("Cheyenne") inside a long trusted formal name
 * ("Cheyenne and Arapaho Tribes, Oklahoma") would be accepted as certain
 * and could attribute another Nation's cession (Codex Unit I review,
 * finding 1). A shorthand segment is exactly the class D-0.7.0-026
 * refuses; three or more tokens is a substantially spelled-out name.
 */
const MIN_REVERSE_SEGMENT_TOKENS = 3;

/** Lowercase, diacritic-stripped, punctuation-to-space, collapsed. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-phrase containment on normalized strings (word boundaries hold). */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === '') return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** The normalized presdaytrb segments of one cession feature. */
function presdaySegments(props: GeoJsonProperties): string[] {
  const raw = readTableQualifiedField(props, 'presdaytrb');
  if (!raw) return [];
  return raw
    .split(';')
    .map((segment) => normalizeName(segment))
    .filter((segment) => segment !== '');
}

/** The feature's cession-number id (the promoted feature id), if present. */
function cessionId(props: GeoJsonProperties): string | null {
  if (!props) return null;
  const exact = (props as Record<string, unknown>)[CESSNUM_PROPERTY];
  if (typeof exact === 'string' && exact !== '') return exact;
  if (typeof exact === 'number' && Number.isFinite(exact)) return String(exact);
  const bare = (props as Record<string, unknown>)['cessnum'];
  if (typeof bare === 'string' && bare !== '') return bare;
  if (typeof bare === 'number' && Number.isFinite(bare)) return String(bare);
  return null;
}

/**
 * Match a set of cession features against a query. Pure and cheap: the
 * caller re-runs it after every viewport refresh so emphasis follows the
 * data. Features without a readable cession number cannot be emphasized and
 * are skipped (they cannot carry feature-state either).
 */
export function matchCessionFeatures(
  query: CessionMatchQuery,
  features: ReadonlyArray<Feature<Geometry | null, GeoJsonProperties>>
): CessionMatchResult {
  const formal = query.formalNames.map(normalizeName).filter((n) => n !== '');
  const loose = query.looseNames
    .map(normalizeName)
    .filter((n) => n.length >= MIN_LOOSE_NEEDLE);

  // Lane 1: formal names.
  const formalIds: Array<string | number> = [];
  for (const feature of features) {
    const id = cessionId(feature.properties ?? null);
    if (id === null) continue;
    const segments = presdaySegments(feature.properties ?? null);
    const hit = segments.some((segment) =>
      formal.some(
        (name) =>
          segment === name ||
          containsPhrase(segment, name) ||
          // Reverse containment (a segment shorter than the formal name)
          // only for substantially spelled-out segments; a one- or
          // two-word shorthand is refused (see MIN_REVERSE_SEGMENT_TOKENS).
          (segment.split(' ').length >= MIN_REVERSE_SEGMENT_TOKENS &&
            containsPhrase(name, segment))
      )
    );
    if (hit) formalIds.push(id);
  }
  if (formalIds.length > 0) return { state: 'matched', ids: formalIds };

  // Lane 2: loose needles, each under the one-Tribe uniqueness guard.
  const looseIds = new Set<string | number>();
  let sawAmbiguous = false;
  for (const needle of loose) {
    const values = new Set<string>();
    const hits: Array<string | number> = [];
    for (const feature of features) {
      const id = cessionId(feature.properties ?? null);
      if (id === null) continue;
      const raw = readTableQualifiedField(feature.properties ?? null, 'presdaytrb');
      if (!raw) continue;
      const segments = presdaySegments(feature.properties ?? null);
      if (segments.some((segment) => containsPhrase(segment, needle))) {
        values.add(normalizeName(raw));
        hits.push(id);
      }
    }
    if (values.size > 1) {
      sawAmbiguous = true;
      continue;
    }
    for (const id of hits) looseIds.add(id);
  }
  if (looseIds.size > 0) return { state: 'matched', ids: [...looseIds] };
  return sawAmbiguous ? { state: 'ambiguous' } : { state: 'none' };
}
