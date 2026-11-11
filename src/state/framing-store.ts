/**
 * Shared framing-context store (S2, the URL migration; D-0.7.0-039,
 * D-0.7.0-041; plan 9.11's camera-only framing context).
 *
 * The framing context is the FIRST named axis of the region-shell
 * selection architecture: a camera-only choice among the nine editorial
 * framings (src/config/framings.ts). It round-trips through the URL as
 * the optional `framing=` parameter (architecture invariant 2), in the
 * `basemap-store` pattern: the sidebar subscribes `onFramingChange` so
 * every change re-emits the canonical URL, and `pushUrl` reads
 * `getFraming()` when composing the sync state.
 *
 * Null means no explicit minimap camera, so the legacy `region=` path owns the
 * view. The minimap's distinct North American ALL camera uses `framing=all`;
 * this keeps an explicit ALL choice restorable without changing the honored
 * `region=national` legacy camera.
 *
 * A framing is CAMERA-ONLY: setting one here never selects a briefing
 * place, never changes the hazard cluster, and never claims coverage.
 * The camera fit itself is the consumer's job (the boot path in
 * src/ui/sidebar.ts today; the S3 minimap clicks later).
 */

import { FRAMINGS } from '../config/framings';
import type { FramingKey, FramingSelection } from '../config/framings';

let current: FramingSelection = null;

const listeners = new Set<() => void>();

/** The active minimap camera token, or null while legacy region state owns it. */
export function getFraming(): FramingSelection {
  return current;
}

/**
 * Record a framing change (null returns camera custody to `region=`) and notify
 * subscribers. Idempotent: setting the current value again emits
 * nothing, so a boot-time seed never triggers a redundant URL write.
 */
export function setFraming(next: FramingSelection): void {
  if (next === current) return;
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[framing-store] listener threw:', err);
    }
  }
}

/** Subscribe to framing changes. Returns an unsubscribe function. */
export function onFramingChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Parse a raw `framing=` parameter value. The nine shape keys and the explicit
 * `all` camera are valid; anything else reads as null and is dropped on the
 * next canonical write.
 */
export function parseFramingParam(raw: string | null): FramingSelection {
  if (raw === 'all') return 'all';
  if (raw !== null && Object.prototype.hasOwnProperty.call(FRAMINGS, raw)) {
    return raw as FramingKey;
  }
  return null;
}
