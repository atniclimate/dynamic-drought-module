/**
 * Shared basemap-mode store (U4d, D-0.7.0-031).
 *
 * The basemap switcher is a durable, user-visible mode, so it round-trips
 * through the URL as the optional `basemap=` parameter (architecture
 * invariant 2). This store follows the `timeline` pattern: the sidebar
 * subscribes `onBasemapChange(pushUrl)` so every mode change re-emits the
 * canonical URL, and `pushUrl` reads `getBasemapMode()` when composing the
 * sync state. The store deliberately knows nothing about MapLibre; the
 * switcher control (src/map/basemap-switcher.ts) owns the map side.
 *
 * The mode vocabulary is the stable URL token set: 'default' (the subdued
 * OpenStreetMap ground) and 'satellite' (recent NOAA imagery context). Each
 * hazard mode declares the basemap it opens on (`defaultBasemap` in
 * src/config/clusters.ts, owner 2026-10-13). The canonical URL carries
 * `basemap=` only when the live mode differs from the active mode's default.
 */

import { HAZARD_CLUSTERS } from '../config/clusters';
import type { HazardClusterKey } from '../config/clusters';

export type BasemapMode = 'default' | 'satellite';

/** The basemap a hazard mode opens on; the one table read the URL code and
 * the mode switch share. */
export function defaultBasemapFor(cluster: HazardClusterKey): BasemapMode {
  return HAZARD_CLUSTERS[cluster].defaultBasemap;
}

// Drought is the boot mode when the link names none.
let mode: BasemapMode = defaultBasemapFor('drought');

const listeners = new Set<() => void>();

/** The active basemap mode; the boot mode's default until a switch or URL seed. */
export function getBasemapMode(): BasemapMode {
  return mode;
}

/**
 * Record a basemap-mode change and notify subscribers (the sidebar's URL
 * sync, the switcher button state). Idempotent: setting the current mode
 * again emits nothing, so a boot-time seed never triggers a redundant
 * URL write.
 */
export function setBasemapMode(next: BasemapMode): void {
  if (next === mode) return;
  mode = next;
  listeners.forEach((fn) => {
    fn();
  });
}

/** Subscribe to basemap-mode changes. Returns an unsubscribe function. */
export function onBasemapChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Parse a raw `basemap=` parameter value for the mode being parsed. Only the
 * exact tokens 'satellite' and 'default' are honored; an absent parameter and
 * malformed values resolve to that mode's default.
 */
export function parseBasemapParam(
  raw: string | null,
  cluster: HazardClusterKey
): BasemapMode {
  return raw === 'satellite' || raw === 'default' ? raw : defaultBasemapFor(cluster);
}
