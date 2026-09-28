/**
 * Pure chip glyph-state derivation (repair round on S30D D1 M10, register
 * items owner-1h, found-016, found-018, found-019; task DDM-P10-T11).
 *
 * The chip's six-state glyph used to be read back from a KeySpec's OWN
 * rendered text (`chipStateFromSpec` in src/ui/map-key.ts, a substring
 * match on `ariaLabel` and `itemsHtml`). That text is not a status
 * channel: the hillshade coverage qualification writes the words "no
 * data" into a live key's items (map-key.ts, `withTerrainCoverage`'s
 * HILLSHADE_COVERAGE_NOTE), and a multi-layer key such as the fire key
 * (`buildFireKey`) can carry a loading row for one product while another
 * is live, so the glyph could read "no data" or "loading" for a key that
 * is painted and live. Six honest layer states are a product invariant
 * ("N modes (DR-113)" 's sibling rule; palette-tokens.md section 2).
 *
 * This module derives the glyph from the layer registry's own recorded
 * `LayerStatus` (src/types/layer.ts) for the product key(s) a KeySpec
 * actually describes, never from rendered prose. It has no runtime
 * imports (the one import below is `import type`, erased by Node's type
 * stripping and by esbuild/tsc alike), so tests/chrome-n-modes.test.mjs
 * can exercise the aggregation rule as a plain Node test with no resolve
 * hook and no DOM.
 */

import type { LayerStatus } from '../types/layer';

export type ChipState = 'live' | 'live-partial' | 'loading' | 'unavailable' | 'no-data' | 'zoom-in';

/** The glyph's accessible title, word for word (palette-tokens.md section 2). */
export const CHIP_STATE_WORDS: Readonly<Record<ChipState, string>> = {
  live: 'live',
  'live-partial': 'live (partial)',
  loading: 'loading...',
  unavailable: 'unavailable',
  'no-data': 'no data',
  'zoom-in': 'zoom in to load'
};

/**
 * LayerStatus -> ChipState, the fixed one-to-one mapping the six-state
 * doc comment on `LayerStatus` (src/types/layer.ts) already states in
 * words: ready -> live, degraded -> live-partial, error -> unavailable,
 * no-data -> no-data, zoom-in -> zoom-in, loading -> loading.
 *
 * `undefined` (a key the registry has never recorded a status for, which
 * happens for the instant between `registry.activate(key)` and that
 * layer module's own first `registry.setStatus(key, ...)` call) reads as
 * 'loading': the layer is still initializing, never silently 'live'.
 */
export function chipStateForStatus(status: LayerStatus | undefined): ChipState {
  switch (status) {
    case 'ready':
      return 'live';
    case 'degraded':
      return 'live-partial';
    case 'error':
      return 'unavailable';
    case 'no-data':
      return 'no-data';
    case 'zoom-in':
      return 'zoom-in';
    case 'loading':
    default:
      return 'loading';
  }
}

/** A ChipState the glyph paints something for (a filled or half-filled mark). */
const PAINTED_STATES: ReadonlySet<ChipState> = new Set(['live', 'live-partial']);

/**
 * Non-painted specificity order used only by rule 4 below, most specific
 * first: an active, confirmed failure (unavailable) is more informative
 * than a confirmed absence of data (no-data), which is more informative
 * than a surface not yet in zoom range (zoom-in) -- each is a stronger,
 * more actionable claim than the one after it. Chosen here because the
 * repair brief left this one combination undetermined; documented so a
 * future case does not have to re-derive it.
 */
const NON_PAINTED_SPECIFICITY: readonly ChipState[] = ['unavailable', 'no-data', 'zoom-in'];

/**
 * Aggregate one KeySpec's backing product key(s) into the chip's single
 * six-state glyph (interface-chrome-popups-text.md section 2.4; the fire
 * key alone can name two: spc-fire-weather and nifc-fires). Priority
 * order:
 *
 *   1. All the same state -> that state (all ready -> live; all loading
 *      -> loading; all error -> unavailable; ...).
 *   2. Any painted (live or live-partial) together with any NOT painted
 *      -> live-partial: the key IS drawing something on the map, but not
 *      everything it names, which is exactly what 'live (partial)' means
 *      (e.g. ready plus loading).
 *   3. None painted, any loading -> loading: still resolving, so no
 *      terminal state is guessed early.
 *   4. Otherwise every member is a distinct terminal non-painted state
 *      (e.g. error plus no-data): the most specific shared state, by
 *      NON_PAINTED_SPECIFICITY above.
 *
 * An empty list returns undefined: no product key backs the spec (the
 * committed mode's no-key fallback, or a coverage-only synthetic spec),
 * so the chip carries no glyph state rather than inventing a seventh one
 * (interface-chrome-popups-text.md section 7, reconciliation: "An idle
 * line or a not-stated clock is a qualification, never a seventh state").
 */
export function aggregateChipState(states: readonly ChipState[]): ChipState | undefined {
  if (states.length === 0) return undefined;
  const first = states[0]!;
  if (states.every((state) => state === first)) return first;

  const anyPainted = states.some((state) => PAINTED_STATES.has(state));
  const anyUnpainted = states.some((state) => !PAINTED_STATES.has(state));
  if (anyPainted && anyUnpainted) return 'live-partial';

  if (states.some((state) => state === 'loading')) return 'loading';

  for (const candidate of NON_PAINTED_SPECIFICITY) {
    if (states.includes(candidate)) return candidate;
  }
  // Unreachable: every ChipState is either painted, 'loading', or one of
  // NON_PAINTED_SPECIFICITY's three members.
  return first;
}

/**
 * The layer key(s) a KeySpec's chip state should read (map-key.ts's
 * `hazardKey` if-chain), mapped through the registry's per-key status and
 * aggregated by `aggregateChipState`. Pure: the caller supplies each
 * key's current LayerStatus (from `registry.getStatus`) rather than this
 * module reaching into the registry itself, so it stays import-free.
 */
export function chipStateFromStatuses(
  statuses: readonly (LayerStatus | undefined)[]
): ChipState | undefined {
  return aggregateChipState(statuses.map(chipStateForStatus));
}
