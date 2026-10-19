/**
 * The one search (U3c, 0.7.0): a single input that searches across
 * Tribal land areas, States, Cities, and Layers, rendering grouped results
 * in that order (Tribes first, the owner's 0.7.7 review).
 * Ports the ratified U3 note verbatim (the 2026-07-10 design-lens
 * ruling): "one search box and one set of grouped
 * results," reachable identically from wherever a caller mounts it, with
 * no visible fuzzy-match confidence score. Specialized hosts may omit
 * result kinds that cannot act visibly on that surface.
 *
 * PURE VIEW. This file imports only from 'preact', '@preact/signals'
 * (types only), 'preact/hooks', and the pure dependency-free text fold
 * in src/util/search-fold.ts (shared so query and haystack can never
 * diverge; wave A finding 1). All data (the synchronous States and
 * Layers items, the lazy Tribal and city loader) and all behavior (onSelect)
 * arrive as props; this component has no knowledge of the map, the URL,
 * the layer registry, or any config table. The caller owns wiring
 * `SearchItem[]` from `LAYER_DEFS`, the region table, and the BIA Tribal
 * land area fetch into the shapes below.
 *
 * Matching: every whitespace-separated token of the normalized query
 * must appear in an item's `haystack` (AND, substring, case-insensitive,
 * diacritic-insensitive on the query side; the caller is trusted to have
 * normalized `haystack` the same way; a Census area row may skip a generic word
 * such as "Nation", see matchesTokens). The one rank: within a group,
 * labels that start with the query come first (prefixFirst), and Enter
 * with no highlight opens an exact or else the first such row, or only
 * highlights the first row when none matches that way; no visible confidence
 * score. The main-shell instances keep the complete grouped vocabulary;
 * a specialized host may supply only the result kinds it can act on.
 *
 * Stewardship: this component holds no Tribal, Treaty, or
 * sovereign-jurisdiction data itself. `SearchItem` for `kind: 'tribal'`
 * carries only a LARNAME- or Census-code-keyed label and id that the caller supplies
 * (see the BIA Land Area Representation source, ddm-tribal-boundary-
 * mapping); this file performs plain substring matching over whatever
 * text arrives and never fetches or redistributes boundary data.
 * "Tribal" stays capitalized throughout, including in the loading and
 * empty-state copy (a project hard rule).
 *
 * Honest empty and zero-result copy (written before ship, per the
 * design-lens insist-on): Tribal Nation names often will not match
 * Census or USGS spellings, so the no-match line stays plain and never
 * implies the user typed something wrong.
 */

import type * as preact from 'preact';
import { useId, useRef, useState } from 'preact/hooks';

import { enterChoice, foldSearchText, matchesTokens, prefixFirst } from '../../util/search-fold';

export interface SearchItem {
  kind: 'place' | 'tribal' | 'city' | 'layer';
  id: string; // state code | LARNAME or census:<AIANNH code> | city name | layer key
  label: string; // primary display text
  sublabel?: string; // secondary line (layer source, or a land-area label)
  haystack: string; // pre-normalized lowercase search string (already includes label+sublabel tokens)
}

export interface SearchProps {
  /** Items available synchronously (Places + Layers). */
  items: SearchItem[];
  /** Optional lazy loader for Tribal land areas, called once on first focus or first keystroke. */
  loadTribal?: () => Promise<SearchItem[]>;
  /** Optional lazy loader for cities, loaded and failing independently of the Tribal list. */
  loadCities?: () => Promise<SearchItem[]>;
  /** Called when the user chooses a result (click or Enter). */
  onSelect: (item: SearchItem) => void;
  /** Input placeholder + accessible label, e.g. "Search Tribes, states, cities, and layers". */
  placeholder: string;
}

/** Per-group cap (corpus rule): a "keep typing" line stands in for a "show all". */
const GROUP_CAP = 8;

/** Fixed group order and headings (never reordered, never per-surface). */
const GROUP_TITLES: Record<SearchItem['kind'], string> = {
  tribal: 'Tribal land areas',
  place: 'States',
  city: 'Cities',
  layer: 'Layers'
};
const GROUP_ORDER: readonly SearchItem['kind'][] = ['tribal', 'place', 'city', 'layer'];

/**
 * The ONE search folding, shared with every other surface (wave A finding
 * 1): query and haystack normalize identically or punctuation and
 * diacritics silently break matching. See src/util/search-fold.ts.
 */
function normalizeQuery(raw: string): string {
  return foldSearchText(raw);
}

function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ').filter((t) => t.length > 0);
}

function matchesAllTokens(item: SearchItem, tokens: string[]): boolean {
  // Only Census rows relax: a land-area row skipping "Oklahoma" would match another state's Nation.
  return matchesTokens(item.haystack, tokens, item.kind === 'tribal' && item.id.startsWith('census:'));
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

interface LazyItems {
  items: SearchItem[];
  pending: boolean;
  failed: boolean;
  start: () => void;
}

/**
 * One lazy item source. Started on first focus OR first keystroke, whichever
 * comes first (the ref guard makes the second caller a no-op). The loader
 * REJECTS on failure (invariant 6): the failure renders as an honest
 * "unavailable" line, never as a fake empty result, and the guard resets so a
 * later focus or keystroke retries.
 */
function useLazyItems(load: (() => Promise<SearchItem[]>) | undefined): LazyItems {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const start = (): void => {
    if (!load || started.current) return;
    started.current = true;
    setPending(true);
    setFailed(false);
    load()
      .then((loaded) => {
        setItems(loaded);
        setPending(false);
      })
      .catch(() => {
        setItems([]);
        setPending(false);
        setFailed(true);
        started.current = false;
      });
  };
  return { items, pending, failed, start };
}

export function Search(props: SearchProps): preact.JSX.Element {
  const [query, setQuery] = useState('');
  // The keyboard highlight is keyed by the ITEM (kind + id), never by list
  // position: the Tribal group resolves asynchronously and inserts ABOVE the
  // Layers group, so a position-keyed highlight would silently slide onto an
  // unrelated row when the roster lands (the U3 stage-5 minor 8 fix). If the
  // highlighted item leaves the list, the highlight collapses to none.
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const tribal = useLazyItems(props.loadTribal);
  const cities = useLazyItems(props.loadCities);
  const { items: tribalItems, pending: tribalPending, failed: tribalFailed } = tribal;
  // A per-instance id prefix so multiple mounts (the console catalog, the Brief
  // head, the mobile sheet) never collide on element ids (invalid HTML that
  // would break the aria-controls / aria-activedescendant references).
  const uid = useId();
  const tribalEnabled = props.loadTribal !== undefined;
  const startLazyLoads = (): void => {
    tribal.start();
    cities.start();
  };

  const rawTrimmed = query.trim();
  const tokens = tokenize(normalizeQuery(query));
  const isEmptyQuery = rawTrimmed.length === 0 || tokens.length === 0;

  const foldedQuery = tokens.join(' ');
  // Matches of one kind, labels that start with the query first.
  const matchesOf = (kind: SearchItem['kind'], from: SearchItem[]): SearchItem[] =>
    isEmptyQuery
      ? []
      : prefixFirst(
          from.filter((i) => i.kind === kind && matchesAllTokens(i, tokens)),
          foldedQuery
        );
  const placeMatches = matchesOf('place', props.items);
  const layerMatches = matchesOf('layer', props.items);
  const tribalMatches = matchesOf('tribal', tribalItems);
  const cityMatches = matchesOf('city', cities.items);

  const groups: Record<SearchItem['kind'], GroupResult> = {
    tribal: buildGroup('tribal', tribalMatches),
    place: buildGroup('place', placeMatches),
    city: buildGroup('city', cityMatches),
    layer: buildGroup('layer', layerMatches)
  };
  const tribalGroup = groups.tribal;

  // The Tribal group appears while its load is pending (showing only the
  // loading line) even before any items resolve; once settled, it only
  // appears if it actually has matches (an empty resolve never shows a
  // heading with nothing under it) OR if the load FAILED (the honest
  // unavailable line; a service failure is never dressed up as no results).
  const showTribalGroup =
    tribalEnabled &&
    !isEmptyQuery &&
    (tribalPending || tribalFailed || tribalGroup.visible.length > 0);
  // The city group also shows its own unavailable line after a failed load.
  const showCityGroup = !isEmptyQuery && (cities.failed || groups.city.visible.length > 0);
  const showGroup = (kind: SearchItem['kind']): boolean =>
    kind === 'tribal'
      ? showTribalGroup
      : kind === 'city'
        ? showCityGroup
        : groups[kind].visible.length > 0;
  const groupsForRender = GROUP_ORDER.map((kind) => groups[kind]).filter((g) => showGroup(g.kind));

  // Flat, ordered, ID-stamped list for keyboard nav and aria-activedescendant.
  // The DOM ids are position-based within a render (they only name the
  // currently highlighted DOM option for aria-activedescendant); the
  // HIGHLIGHT itself is keyed by the stable item key so async list changes
  // never move it to an unrelated row.
  let flatIdx = 0;
  const flatRows: FlatRow[] = [];
  for (const kind of GROUP_ORDER) {
    if (!showGroup(kind)) continue;
    for (const item of groups[kind].visible) {
      flatRows.push({ item, id: `${uid}-opt-${flatIdx}`, kind });
      flatIdx += 1;
    }
  }

  const rowKey = (row: FlatRow): string => `${row.kind}:${row.item.id}`;

  // A highlight whose item left the list (the query changed, the roster
  // resolved differently) collapses to "no highlight" rather than sliding
  // to whatever row now occupies its old position.
  const activeIndex =
    highlightedKey === null ? -1 : flatRows.findIndex((r) => rowKey(r) === highlightedKey);
  const activeRow = activeIndex >= 0 ? flatRows[activeIndex] : undefined;

  const totalMatches =
    placeMatches.length + tribalMatches.length + cityMatches.length + layerMatches.length;
  const noGroupsShown = groupsForRender.length === 0;
  // The zero-match line only appears once the Tribal load has settled
  // (design-lens: written before ship, plain-language, never blaming the
  // user, since Tribal Nation names often will not match agency spellings).
  const showZeroMatch = !isEmptyQuery && noGroupsShown && !tribalPending && !cities.pending;

  const liveText = isEmptyQuery
    ? ''
    : tribalPending && totalMatches === 0
      ? 'Loading Tribal land areas.'
      : tribalFailed && totalMatches === 0
        ? 'Tribal land area search is unavailable right now.'
        : cities.pending && totalMatches === 0
          ? 'Loading cities.'
          : cities.failed && totalMatches === 0
            ? 'City search is unavailable right now.'
            : totalMatches === 0
              ? `No matches for "${rawTrimmed}".`
              : `${totalMatches} result${totalMatches === 1 ? '' : 's'}.`;

  const selectItem = (item: SearchItem): void => {
    props.onSelect(item);
    // Clearing the query is what closes the results (an empty query
    // renders the guidance line, not a list); the caller navigates away,
    // so the input keeps focus rather than being blurred.
    setQuery('');
    setHighlightedKey(null);
  };

  const onInput = (event: Event): void => {
    const value = (event.currentTarget as HTMLInputElement).value;
    setQuery(value);
    setHighlightedKey(null);
    startLazyLoads();
  };

  const onFocus = (): void => {
    startLazyLoads();
  };

  // Arrow keys clamp at the list boundaries; they do not wrap. From "no
  // highlight", either direction lands on the first row: the point is to
  // bring a highlight into view, not to jump to the far end (my call,
  // documented per the mission's "your call" allowance). The step computes
  // over the CURRENT row order but stores the landed row's stable key.
  const moveHighlight = (delta: number): void => {
    if (flatRows.length === 0) return;
    const base = activeIndex < 0 ? -1 : activeIndex;
    const next = Math.min(Math.max(base + delta, 0), flatRows.length - 1);
    const landed = flatRows[next];
    if (landed) setHighlightedKey(rowKey(landed));
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
      // With the Tribal group first, a typed state or city name still wins
      // Enter over a Tribe whose name merely starts with it. With no exact or
      // prefix row, Enter highlights the first row instead of opening it: it
      // may be another Nation's area, and a second Enter opens what is seen.
      const chosen =
        activeRow?.item ??
        enterChoice(
          flatRows.map((r) => r.item),
          foldedQuery
        );
      if (chosen) selectItem(chosen);
      else setHighlightedKey(rowKey(flatRows[0]));
    } else if (event.key === 'Escape' && query) {
      // An empty box leaves Escape unhandled so the sheet and studio close on it.
      event.preventDefault();
      setQuery('');
      setHighlightedKey(null);
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
        {group.kind === 'tribal' && tribalFailed && !tribalPending ? (
          <p class="ddm-search-unavailable">
            Tribal land area search is unavailable right now. States and layers still work.
          </p>
        ) : null}
        {group.kind === 'city' && cities.failed ? (
          <p class="ddm-search-unavailable">City search is unavailable right now.</p>
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
      {/* DEG-1 (U-UX-FIX-1): the at-rest guidance paragraph is GONE. It
          rendered the placeholder text a second, visible time directly under
          the input; the input already carries the same words as both its
          placeholder and its aria-label, so assistive tech loses nothing.
          The honest zero-match line below (inside the results) stays. */}
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
