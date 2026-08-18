/**
 * Frame-stepping engine (0.5.0b, critical-review Section 5 item 4).
 *
 * The honesty-of-time doctrine: smoothness is a property of the
 * data-generating process, not the renderer. This module gives temporal
 * layers the three honest techniques the smooth tools actually use, and
 * nothing more:
 *
 *   - Preload adjacent frames (a dated LRU cache with polite prefetch),
 *     so a step is instant instead of a stutter.
 *   - Crossfade, never interpolate: an opacity-only fade between two REAL,
 *     dated states. At every instant the user sees a blend of two published
 *     products. No phantom geometry, no tweened vertices, ever.
 *   - A steady clock is the caller's job (the Play loop holds a fixed
 *     cadence and shows the date readout); this module only guarantees the
 *     fade duration is predictable.
 *
 * The bright line (the data-honesty invariant, endorsed by both review
 * passes): analyst-authored polygons are never tweened. A crossfade is
 * visually distinct from a morph precisely because the geometry snaps and
 * only opacity moves; keep it that way.
 *
 * Rural-bandwidth reality (critical-review item 3): prefetch is polite. It
 * is skipped entirely when the browser signals data saving or a constrained
 * connection, it never runs more than one speculative fetch at a time, and
 * a prefetch failure is silent (the on-demand path will retry with real
 * error surfacing when the user actually steps there).
 *
 * Reduced motion: crossfades degrade to an instant swap (WCAG 2.3.3,
 * mirroring src/util/motion.ts and src/util/layer-fade.ts).
 */

import type maplibregl from 'maplibre-gl';

import { prefersReducedMotion } from './motion';
import { sleepUnlessAborted } from './fetch';

/**
 * Crossfade duration between two dated frames. Inside the 150-250 ms range
 * the review spec names: long enough to read as an intentional transition,
 * short enough that the two-real-states blend never lingers as a false
 * "in-between" reading.
 */
export const FRAME_FADE_MS = 200;

// ---------------------------------------------------------------------------
// Polite prefetch gating
// ---------------------------------------------------------------------------

/**
 * Subset of the Network Information API this module reads. Typed locally:
 * the API is not in the TypeScript DOM lib on every target, and only these
 * two advisory fields matter here.
 */
interface ConnectionHint {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/**
 * True when speculative frame prefetch is appropriate on this connection.
 * Honors the Save-Data signal and backs off on 2g-class effective types.
 * An absent API (Firefox, Safari) allows prefetch; the cache's
 * one-speculative-fetch-at-a-time rule still bounds the cost.
 */
export function prefetchAllowed(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as Navigator & { connection?: ConnectionHint }).connection;
  if (!conn) return true;
  if (conn.saveData === true) return false;
  const et = conn.effectiveType ?? '';
  return et !== 'slow-2g' && et !== '2g';
}

// ---------------------------------------------------------------------------
// Dated frame cache
// ---------------------------------------------------------------------------

/**
 * A small least-recently-used cache of dated frames (GeoJSON weeks, tile
 * date lists, anything keyed by an ISO-ish date string), with single-flight
 * loads and polite speculative prefetch of adjacent frames.
 *
 * The loader is passed per call, not per cache, so one cache instance can
 * serve a keyed family of URLs while the caller keeps URL construction in
 * one place next to its verification stamp.
 */
export class FrameCache<T> {
  private readonly frames = new Map<string, T>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private prefetching = false;

  constructor(private readonly capacity: number = 12) {}

  /** The cached frame for `key`, or undefined; refreshes LRU recency. */
  peek(key: string): T | undefined {
    const hit = this.frames.get(key);
    if (hit !== undefined) {
      this.frames.delete(key);
      this.frames.set(key, hit);
    }
    return hit;
  }

  /**
   * The frame for `key`, loading it via `loader` on a miss. Concurrent
   * callers for the same key share one load (single-flight). A failed load
   * rejects every waiter and leaves the cache clean so the next attempt
   * retries the fetch.
   */
  async get(key: string, loader: (key: string) => Promise<T>): Promise<T> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = loader(key).then(
        (frame) => {
          this.inFlight.delete(key);
          this.store(key, frame);
          return frame;
        },
        (err: unknown) => {
          this.inFlight.delete(key);
          throw err;
        }
      );
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  /**
   * Speculatively warm the cache for `keys` (typically the N-1 and N+1
   * neighbors of the frame just shown). Fire-and-forget: failures are
   * swallowed (the on-demand path surfaces real errors), at most one
   * speculative load runs at a time, and the whole call is a no-op on a
   * constrained connection.
   */
  prefetch(keys: readonly string[], loader: (key: string) => Promise<T>): void {
    if (this.prefetching || !prefetchAllowed()) return;
    const missing = keys.filter(
      (k) => !this.frames.has(k) && !this.inFlight.has(k)
    );
    if (missing.length === 0) return;
    this.prefetching = true;
    void (async () => {
      try {
        for (const key of missing) {
          try {
            await this.get(key, loader);
          } catch {
            // Silent by design; see the JSDoc.
          }
        }
      } finally {
        this.prefetching = false;
      }
    })();
  }

  /** Drop every cached frame and forget in-flight bookkeeping. */
  clear(): void {
    this.frames.clear();
    this.inFlight.clear();
  }

  private store(key: string, frame: T): void {
    this.frames.set(key, frame);
    while (this.frames.size > this.capacity) {
      const oldest = this.frames.keys().next().value;
      if (oldest === undefined) break;
      this.frames.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Opacity-only crossfade
// ---------------------------------------------------------------------------

/** One paint property on one layer, with the opacity it should end at. */
export interface FadeTarget {
  readonly layerId: string;
  /** An opacity paint property (`fill-opacity`, `raster-opacity`, ...). */
  readonly prop: string;
  /** The spec opacity this property holds when fully visible. */
  readonly target: number;
}

/** Set a paint property with a transition duration, guarding absent layers. */
function setWithTransition(
  map: maplibregl.Map,
  t: FadeTarget,
  value: number,
  durationMs: number
): void {
  if (!map.getLayer(t.layerId)) return;
  map.setPaintProperty(t.layerId, `${t.prop}-transition`, {
    duration: durationMs,
    delay: 0
  });
  map.setPaintProperty(t.layerId, t.prop, value);
}

/**
 * Crossfade between two sets of already-added map layers: `incoming` rises
 * from 0 to its spec opacity while `outgoing` falls to 0, opacity only,
 * over `FRAME_FADE_MS`. Both frames are real, dated states already on the
 * map; nothing is interpolated but alpha.
 *
 * Under `prefers-reduced-motion` the swap is instant (duration 0), which is
 * the honest degradation: the step semantics are identical, only the
 * easing disappears.
 *
 * The caller is responsible for having set `incoming` layers to opacity 0
 * before this call (add the layer, zero its opacity with a zero-duration
 * transition, let a frame render, then crossfade). Resolves after the fade
 * has played so the caller can safely hide or remove the outgoing layers.
 */
export async function crossfadeFrames(
  map: maplibregl.Map,
  outgoing: readonly FadeTarget[],
  incoming: readonly FadeTarget[]
): Promise<void> {
  const duration = prefersReducedMotion() ? 0 : FRAME_FADE_MS;

  for (const t of incoming) setWithTransition(map, t, t.target, duration);
  for (const t of outgoing) setWithTransition(map, t, 0, duration);

  if (duration > 0) {
    // Small buffer past the nominal duration so the last frame lands before
    // the caller tears down the outgoing layers (same margin as layer-fade).
    await sleepUnlessAborted(duration + 50, null);
  }
}

/**
 * Prepare just-added layers to receive a fade-in: zero their opacity with
 * no transition so the first rendered frame is transparent. Call between
 * `map.addLayer` and `crossfadeFrames`.
 */
export function primeForFadeIn(
  map: maplibregl.Map,
  targets: readonly FadeTarget[]
): void {
  for (const t of targets) setWithTransition(map, t, 0, 0);
}
