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

/**
 * Resolve the user-visible text for a status, honoring a layer's optional
 * `noDataLabel` override (Unit C of the Tribal Nations umbrella build): a
 * LIVE viewport-queried layer that returns zero features is not an "empty
 * placeholder" and must not point at data/README.md. Every surface that
 * renders or announces a status goes through THIS function (the island's
 * pills and the sidebar's live-region announcer), so pill and announcement
 * can never disagree. Only the `no-data` state is overridable; the other
 * five keep the canonical table above.
 */
export function resolveStatusPillText(
  status: LayerStatus,
  noDataLabel?: string
): string {
  if (status === 'no-data' && noDataLabel) return noDataLabel;
  return STATUS_PILL_TEXT[status];
}
