/**
 * The six canonical layer states mapped to user-visible pill text, per
 * the v0.1.2 wording plus the 0.7.0 H4 `degraded` addition. CLAUDE.md
 * section 6 invariant 3 fixes this contract; the `LayerStatus` union in
 * `src/types/layer.ts` is the source of truth for the keys.
 *
 * Shared (eagerly) between the sidebar's live-region announcements and
 * the island's status pills so the two surfaces can never drift; kept
 * out of the island chunk because the announcer runs before it mounts.
 *
 * Note the punctuation: an ellipsis is rendered as three ASCII dots
 * (`loading...`) per the same v0.1.2 convention; em dashes are forbidden
 * by CLAUDE.md section 4.
 */

import type { LayerStatus } from '../../types/layer';

export const STATUS_PILL_TEXT: Record<LayerStatus, string> = {
  loading: 'loading...',
  ready: 'live',
  degraded: 'live (partial)',
  error: 'unavailable',
  'no-data': 'empty placeholder (see data/README.md)',
  'zoom-in': 'zoom in to load'
};
