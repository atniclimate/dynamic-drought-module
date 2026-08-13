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
 * OpenStreetMap ground) and 'satellite' (recent NOAA imagery context). Recent
 * satellite is the product default and is therefore omitted from canonical
 * URLs; `basemap=default` records an explicit off choice.
 */

export type BasemapMode = 'default' | 'satellite';

let mode: BasemapMode = 'satellite';

const listeners = new Set<() => void>();

/** The active basemap mode; 'satellite' until a switch or URL seed. */
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
 * Parse a raw `basemap=` parameter value to a mode. Only the exact token
 * 'default' turns satellite imagery off. The established `satellite` token,
 * an absent parameter, and malformed values all resolve to the product
 * default.
 */
export function parseBasemapParam(raw: string | null): BasemapMode {
  return raw === 'default' ? 'default' : 'satellite';
}
