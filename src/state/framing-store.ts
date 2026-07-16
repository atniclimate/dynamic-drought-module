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
 * ABSENCE IS THE TRUTH (D-0.7.0-041 part 1): the ALL state is a null
 * framing, and `framing=` is written only while a non-ALL framing is
 * active. The legacy `region=national` link is honored as an alias of
 * that ALL state: it keeps its exact camera behavior through the legacy
 * `region` path (honored forever, D-0.7.0-039) and never produces a
 * `framing=` token, because no framing token exists for the national
 * fit; the national default camera is what absence means.
 *
 * A framing is CAMERA-ONLY: setting one here never selects a briefing
 * place, never changes the hazard cluster, and never claims coverage.
 * The camera fit itself is the consumer's job (the boot path in
 * src/ui/sidebar.ts today; the S3 minimap clicks later).
 */

import { FRAMINGS } from '../config/framings';
import type { FramingKey } from '../config/framings';

let current: FramingKey | null = null;

const listeners = new Set<() => void>();

/** The active framing, or null for the ALL state (the default). */
export function getFraming(): FramingKey | null {
  return current;
}

/**
 * Record a framing change (null clears back to ALL) and notify
 * subscribers. Idempotent: setting the current value again emits
 * nothing, so a boot-time seed never triggers a redundant URL write.
 */
export function setFraming(next: FramingKey | null): void {
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
 * Parse a raw `framing=` parameter value. Only the nine FramingKey
 * tokens select a framing; anything else (absent, empty, unknown) reads
 * as null, the ALL state, per the URL-schema policy's unknown-value
 * rule. Null is also what a duplicate-free canonical write re-derives,
 * so an invalid token is dropped on the next sync rather than echoed.
 */
export function parseFramingParam(raw: string | null): FramingKey | null {
  if (raw !== null && Object.prototype.hasOwnProperty.call(FRAMINGS, raw)) {
    return raw as FramingKey;
  }
  return null;
}
