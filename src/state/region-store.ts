/**
 * Shared current-region store.
 *
 * Layer modules and the impact panel receive only `map`, not the active
 * region key; the sidebar owns region selection in its private `STATE`. The
 * kernel-integration work (the clickable impact panel) needs the region key
 * for resource framing (which state's supplementary resources to surface) and
 * could later use it to clip a query to the region bounds. Rather than thread
 * the key through every layer signature, this module is a tiny process-wide
 * store: the sidebar's `selectRegion` writes it, consumers may read it, and
 * the issuer-aware drought controller subscribes to region changes.
 *
 * This was deliberately deferred from the Phase 1 (BIA reservation) work; see
 * docs/KERNEL_INTEGRATION_CONTINUATION.md section 11. Keeping it minimal (a
 * getter, setter, and narrow listener set over a module-level variable)
 * avoids reintroducing the coupling the LayerRegistry event bus was built to
 * remove.
 */

import type { RegionKey } from '../config/regions';

let currentRegion: RegionKey | null = null;
type RegionChangeListener = (key: RegionKey) => void;
const listeners = new Set<RegionChangeListener>();

/**
 * The active region key, or `null` before the first `selectRegion` call at
 * boot. Consumers that need a guaranteed value should fall back to
 * `DEFAULT_REGION` themselves.
 */
export function getCurrentRegion(): RegionKey | null {
  return currentRegion;
}

/**
 * Record the active region key. Called by the sidebar's `selectRegion` on
 * every region change (boot fit, click, arrow-key). Idempotent writes do not
 * emit. U7's issuer-aware drought surface subscribes so it can remove the old
 * issuer before adding the source appropriate to the new region.
 */
export function setCurrentRegion(key: RegionKey): void {
  if (currentRegion === key) return;
  currentRegion = key;
  for (const listener of [...listeners]) listener(key);
}

/** Subscribe to active-region changes. Returns an unsubscribe function. */
export function onRegionChange(listener: RegionChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
