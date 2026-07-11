/**
 * The one search (U3c, 0.7.0): a single input that searches across
 * Places, Tribal land areas, and Layers, rendering grouped results.
 * Ports the ratified U3 note verbatim (design-lens-product-2026-07-10.md
 * section 3, DESIGN_CORPUS.md): "one search box and one set of grouped
 * results," reachable identically from wherever a caller mounts it, with
 * no per-surface search filters and no visible fuzzy-match confidence
 * score.
 *
 * PURE VIEW. This file imports only from 'preact', '@preact/signals'
 * (types only) and 'preact/hooks'. All data (the synchronous Places and
 * Layers items, the lazy Tribal loader) and all behavior (onSelect)
 * arrive as props; this component has no knowledge of the map, the URL,
 * the layer registry, or any config table. The caller owns wiring
 * `SearchItem[]` from `LAYER_DEFS`, the region table, and the BIA Tribal
 * land area fetch into the shapes below.
 *
 * Matching: every whitespace-separated token of the normalized query
 * must appear in an item's `haystack` (AND, substring, case-insensitive,
 * diacritic-insensitive on the query side; the caller is trusted to have
 * normalized `haystack` the same way). No ranking, no visible confidence
 * score, no per-surface filters (ruled out for U3, see the design-lens
 * "Cut" list): roughly two dozen places, layers, and Tribal land areas
 * combined does not need search-product weight.
 *
 * Stewardship: this component holds no Tribal, Treaty, or
 * sovereign-jurisdiction data itself. `SearchItem` for `kind: 'tribal'`
 * carries only a LARNAME-keyed label and id that the caller supplies
 * (see the BIA Land Area Representation source, ddm-tribal-boundary-
 * mapping); this file performs plain substring matching over whatever
 * text arrives and never fetches or redistributes boundary data.
 * "Tribal" stays capitalized throughout, including in the loading and
 * empty-state copy, per CLAUDE.md section 4.
 *
 * Honest empty and zero-result copy (written before ship, per the
 * design-lens insist-on): Tribal Nation names often will not match
 * Census or USGS spellings, so the no-match line stays plain and never
 * implies the user typed something wrong.
 */

import type * as preact from 'preact';
import { useId, useRef, useState } from 'preact/hooks';

export interface SearchItem {
  kind: 'place' | 'tribal' | 'layer';
  id: string; // state code | LARNAME | layer key
  label: string; // primary display text
  sublabel?: string; // secondary line (layer source, or a land-area label)
  haystack: string; // pre-normalized lowercase search string (already includes label+sublabel tokens)
}

export interface SearchProps {
  /** Items available synchronously (Places + Layers). */
  items: SearchItem[];
  /** Lazy loader for Tribal land areas, called once on first focus or first keystroke; resolves to [] on failure. */
  loadTribal: () => Promise<SearchItem[]>;
  /** Called when the user chooses a result (click or Enter). */
  onSelect: (item: SearchItem) => void;
  /** Input placeholder + accessible label, e.g. "Search places, Tribal land areas, and layers". */
  placeholder: string;
}

/** Per-group cap (corpus rule): a "keep typing" line stands in for a "show all". */
const GROUP_CAP = 8;

/** Fixed group order and headings (never reordered, never per-surface). */
const GROUP_TITLES: Record<SearchItem['kind'], string> = {
  place: 'Places',
  tribal: 'Tribal land areas',
  layer: 'Layers'
};
const GROUP_ORDER: readonly SearchItem['kind'][] = ['place', 'tribal', 'layer'];

// The Unicode "Combining Diacritical Marks" block: what NFD decomposition
// leaves behind on a base letter (e.g. e + COMBINING ACUTE ACCENT for "e").
// Written as code points rather than a \u escape sequence in a regex, to
// keep the source in plain ASCII.
const COMBINING_MARK_MIN = 768; // U+0300 COMBINING GRAVE ACCENT
const COMBINING_MARK_MAX = 879; // U+036F COMBINING LATIN SMALL LETTER X

/** Drop combining marks left over from `String.prototype.normalize('NFD')`. */
function stripCombiningMarks(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= COMBINING_MARK_MIN && code <= COMBINING_MARK_MAX) continue;
    out += ch;
  }
  return out;
}

/**
 * Lowercase, strip diacritics (NFD decompose + drop combining marks), and
 * collapse whitespace. Applied to the query only; `haystack` arrives
 * pre-normalized from the caller (see the `SearchItem` doc comment).
 */
function normalizeQuery(raw: string): string {
  return stripCombiningMarks(raw.normalize('NFD'))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ').filter((t) => t.length > 0);
}

function matchesAllTokens(item: SearchItem, tokens: string[]): boolean {
  return tokens.every((t) => item.haystack.includes(t));
}

interface GroupResult {
  kind: SearchItem['kind'];
  title: string;
  visible: SearchItem[];
  overflow: number;
}

function buildGroup(kind: SearchItem['kind'], matches: SearchItem[]): GroupResult {
  return {
    kind,
    title: GROUP_TITLES[kind],
    visible: matches.slice(0, GROUP_CAP),
    overflow: Math.max(0, matches.length - GROUP_CAP)
  };
}

interface FlatRow {
  item: SearchItem;
  id: string;
  kind: SearchItem['kind'];
}

export function Search(props: SearchProps): preact.JSX.Element {
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [tribalItems, setTribalItems] = useState<SearchItem[]>([]);
  const [tribalPending, setTribalPending] = useState(false);
  const tribalStarted = useRef(false);
  // A per-instance id prefix so multiple mounts (the console catalog, the Brief
  // head, the mobile sheet) never collide on element ids (invalid HTML that
  // would break the aria-controls / aria-activedescendant references).
  const uid = useId();

  // Called once on first focus OR first keystroke, whichever comes first
  // (the ref guard makes the second caller a no-op). loadTribal is
  // documented to resolve to [] on failure; the catch is a defensive
  // fallback to the same honest empty state, never a fake result.
  const startTribalLoad = (): void => {
    if (tribalStarted.current) return;
    tribalStarted.current = true;
    setTribalPending(true);
    props
      .loadTribal()
      .then((loaded) => {
        setTribalItems(loaded);
        setTribalPending(false);
      })
      .catch(() => {
        setTribalItems([]);
        setTribalPending(false);
      });
  };

  const rawTrimmed = query.trim();
  const tokens = tokenize(normalizeQuery(query));
  const isEmptyQuery = rawTrimmed.length === 0 || tokens.length === 0;

  const placeMatches = isEmptyQuery
    ? []
    : props.items.filter((i) => i.kind === 'place' && matchesAllTokens(i, tokens));
  const layerMatches = isEmptyQuery
    ? []
    : props.items.filter((i) => i.kind === 'layer' && matchesAllTokens(i, tokens));
  const tribalMatches = isEmptyQuery
    ? []
    : tribalItems.filter((i) => matchesAllTokens(i, tokens));

  const placeGroup = buildGroup('place', placeMatches);
  const tribalGroup = buildGroup('tribal', tribalMatches);
  const layerGroup = buildGroup('layer', layerMatches);

  // The Tribal group appears while its load is pending (showing only the
  // loading line) even before any items resolve; once settled, it only
  // appears if it actually has matches (an empty resolve never shows a
  // heading with nothing under it).
  const showTribalGroup = !isEmptyQuery && (tribalPending || tribalGroup.visible.length > 0);
  const groupsForRender = GROUP_ORDER.map((kind) => {
    if (kind === 'place') return placeGroup;
    if (kind === 'layer') return layerGroup;
    return tribalGroup;
  }).filter((g) => (g.kind === 'tribal' ? showTribalGroup : g.visible.length > 0));

  // Flat, ordered, ID-stamped list for keyboard nav and aria-activedescendant.
  // IDs are position-based within a render; stable enough for the single
  // purpose they serve (naming the currently highlighted DOM option).
  let flatIdx = 0;
  const flatRows: FlatRow[] = [];
  for (const kind of GROUP_ORDER) {
    const group = kind === 'place' ? placeGroup : kind === 'layer' ? layerGroup : tribalGroup;
    if (kind === 'tribal' && !showTribalGroup) continue;
    for (const item of group.visible) {
      flatRows.push({ item, id: `${uid}-opt-${flatIdx}`, kind });
      flatIdx += 1;
    }
  }

  // Out-of-range highlights (list shrank under the current highlight)
  // collapse to "no highlight" rather than clamping to the last row,
  // which would silently move the selection to an unrelated item.
  const activeIndex =
    highlightedIndex >= 0 && highlightedIndex < flatRows.length ? highlightedIndex : -1;
  const activeRow = activeIndex >= 0 ? flatRows[activeIndex] : undefined;

  const totalMatches = placeMatches.length + tribalMatches.length + layerMatches.length;
  const noGroupsShown = groupsForRender.length === 0;
  // The zero-match line only appears once the Tribal load has settled
  // (design-lens: written before ship, plain-language, never blaming the
  // user, since Tribal Nation names often will not match agency spellings).
  const showZeroMatch = !isEmptyQuery && noGroupsShown && !tribalPending;

  const liveText = isEmptyQuery
    ? ''
    : tribalPending && totalMatches === 0
      ? 'Loading Tribal land areas.'
      : totalMatches === 0
        ? `No matches for "${rawTrimmed}".`
        : `${totalMatches} result${totalMatches === 1 ? '' : 's'}.`;

  const selectItem = (item: SearchItem): void => {
    props.onSelect(item);
    // Clearing the query is what closes the results (an empty query
    // renders the guidance line, not a list); the caller navigates away,
    // so the input keeps focus rather than being blurred.
    setQuery('');
    setHighlightedIndex(-1);
  };

  const onInput = (event: Event): void => {
    const value = (event.currentTarget as HTMLInputElement).value;
    setQuery(value);
    setHighlightedIndex(-1);
    startTribalLoad();
  };

  const onFocus = (): void => {
    startTribalLoad();
  };

  // Arrow keys clamp at the list boundaries; they do not wrap. From "no
  // highlight" (-1), either direction lands on the first row: the point
  // is to bring a highlight into view, not to jump to the far end (my
  // call, documented per the mission's "your call" allowance).
  const moveHighlight = (delta: number): void => {
    if (flatRows.length === 0) return;
    const base = activeIndex < 0 ? -1 : activeIndex;
    const next = Math.min(Math.max(base + delta, 0), flatRows.length - 1);
    setHighlightedIndex(next);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === 'Enter') {
      if (flatRows.length === 0) return;
      event.preventDefault();
      const chosen = activeRow ?? flatRows[0];
      if (chosen) selectItem(chosen.item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      setHighlightedIndex(-1);
    }
  };

  const renderGroup = (group: GroupResult, rows: FlatRow[]) => {
    const headingId = `${uid}-heading-${group.kind}`;
    return (
      <div class="ddm-search-group" data-search-group={group.kind} key={group.kind}>
        <div class="ddm-search-group-title" id={headingId}>
          {group.title}
        </div>
        {group.kind === 'tribal' && tribalPending ? (
          <p class="ddm-search-loading">Loading Tribal land areas...</p>
        ) : null}
        {rows.map((row) => {
          const isActive = activeRow?.id === row.id;
          return (
            <div
              key={row.id}
              id={row.id}
              role="option"
              aria-selected={isActive ? 'true' : 'false'}
              class={isActive ? 'ddm-search-result is-active' : 'ddm-search-result'}
              data-search-kind={row.kind}
              data-search-id={row.item.id}
              onClick={() => selectItem(row.item)}
            >
              <span class="ddm-search-result-label">{row.item.label}</span>
              {row.item.sublabel ? (
                <span class="ddm-search-result-sublabel">{row.item.sublabel}</span>
              ) : null}
            </div>
          );
        })}
        {group.overflow > 0 ? (
          <p class="ddm-search-more">... and {group.overflow} more, keep typing</p>
        ) : null}
      </div>
    );
  };

  const rowsByKind = (kind: SearchItem['kind']): FlatRow[] =>
    flatRows.filter((r) => r.kind === kind);

  return (
    <div class="ddm-search">
      <input
        class="ddm-search-input"
        data-ddm-search=""
        type="text"
        role="combobox"
        aria-expanded={!isEmptyQuery}
        aria-controls={`${uid}-listbox`}
        aria-autocomplete="list"
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        value={query}
        onInput={onInput}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        {...(activeRow ? { 'aria-activedescendant': activeRow.id } : {})}
      />
      <div class="ddm-search-live" aria-live="polite">
        {liveText}
      </div>
      {isEmptyQuery ? <p class="ddm-search-empty">{props.placeholder}</p> : null}
      <div class="ddm-search-results" role="listbox" id={`${uid}-listbox`}>
        {!isEmptyQuery
          ? groupsForRender.map((group) => renderGroup(group, rowsByKind(group.kind)))
          : null}
        {showZeroMatch ? (
          <p class="ddm-search-empty">No matches for "{rawTrimmed}".</p>
        ) : null}
      </div>
    </div>
  );
}
