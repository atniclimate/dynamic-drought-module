import type maplibregl from 'maplibre-gl';

import type { LayerRole } from '../types/layer';

/**
 * Layer module contract: every layer file under `src/layers/` exports
 * `activate`, `deactivate`, and (optionally) `bindPopups` per CLAUDE.md
 * section 8. The registry below pairs each module with the UI metadata
 * the sidebar (M8) consumes when building the toggle list.
 */
export interface LayerModule {
  activate(map: maplibregl.Map): Promise<void>;
  deactivate(map: maplibregl.Map): void;
  bindPopups?(map: maplibregl.Map): void;
  /**
   * Map layer ids this module renders, consumed by the sidebar's fade
   * transitions (src/util/layer-fade.ts) on toggle. Optional: a module
   * that renders DOM markers instead of style layers (telemetry) omits it
   * and owns its own presentation.
   */
  readonly fadeLayerIds?: readonly string[];
}

/**
 * Per-layer registry entry.
 *
 * `load` is a dynamic import of the layer module, so each layer's code is its
 * own chunk fetched on first activation rather than shipped in the initial
 * bundle. This honors CLAUDE.md section 6 invariant 3 (lazy-loaded layers) at
 * the CODE level, not just the data level: before this, activation was lazy but
 * all fifteen modules were eagerly imported into the main chunk. The default-on
 * layers load at boot as before; the rest arrive on first toggle.
 * `loadLayerModule` caches the resolved module so `deactivate` and `bindPopups`
 * reach the same instance a later toggle uses.
 */
export interface LayerDef {
  readonly key: string;
  readonly name: string;
  readonly source: string;
  /**
   * UX-1 role (see LayerRole in src/types/layer.ts). Surfaces are mutually
   * exclusive; the other three roles stack freely over the active surface.
   */
  readonly role: LayerRole;
  readonly defaultOn: boolean;
  readonly load: () => Promise<LayerModule>;
  /**
   * Keys that co-activate with this layer: turning THIS layer on through a user
   * toggle also turns them on (each stays individually toggleable off
   * afterward). Applied ONLY on the user-toggle path (`activate`), never on the
   * URL / deep-link restore path (`applyLayerSet`), so a shared link stays
   * authoritative about exactly which layers were on. Cascades one level: a
   * co-activated partner does not re-trigger co-activation. Used by the
   * wildfire event pair (Active Wildfires + Smoke Plumes, D-0.7.0-018).
   */
  readonly coActivateWith?: readonly string[];
}

/**
 * Layer registry in display order. The sidebar renders toggles in this
 * order; boot-time activation of `defaultOn` layers also follows it. Layer
 * stacking on the map is owed to insertion order plus each layer's own
 * `beforeId` strategy (most layers anchor to `'first-symbol'` if present,
 * otherwise append).
 *
 * Default-on is the demo-ready set: US Drought Monitor (the headline drought
 * layer), Tribal Lands (intentional empty placeholder per stewardship), and
 * Telemetry. Hydrography is intentionally off by default; the live Overpass
 * query is slow and fragile, so leading the bare URL with it produced a
 * flaky first paint. Users can still toggle it on.
 */
export const LAYER_DEFS: readonly LayerDef[] = [
  { key: 'hydrography', name: 'Hydrography', source: 'OpenStreetMap (Overpass)', role: 'reference', defaultOn: false, load: () => import('../layers/hydrography') },
  { key: 'ecoregions', name: 'Ecoregions (Level III/IV)', source: 'EPA Omernik · PMTiles', role: 'reference', defaultOn: false, load: () => import('../layers/ecoregions') },
  { key: 'hillshade', name: 'Terrain Shading', source: 'USGS 3DEP · PMTiles', role: 'reference', defaultOn: false, load: () => import('../layers/hillshade') },
  { key: 'drought', name: 'Drought Outlook (CPC)', source: 'NOAA CPC · Monthly & Seasonal', role: 'surface', defaultOn: false, load: () => import('../layers/drought') },
  { key: 'gridded-index', name: 'Gridded Drought Index (SPI)', source: 'NOAA NIDIS · raster tiles', role: 'surface', defaultOn: false, load: () => import('../layers/gridded-index') },
  { key: 'usdm', name: 'US Drought Monitor', source: 'NDMC · FeatureServer', role: 'surface', defaultOn: true, load: () => import('../layers/usdm') },
  { key: 'tribal', name: 'Tribal Lands', source: 'BIA · bundled GeoJSON', role: 'reference', defaultOn: true, load: () => import('../layers/tribal') },
  { key: 'treaty', name: 'Treaty Areas', source: 'WA DAHP · bundled GeoJSON', role: 'reference', defaultOn: false, load: () => import('../layers/treaty') },
  { key: 'bia-reservations', name: 'Reservation Boundaries', source: 'BIA · AIAN-LAR (live)', role: 'reference', defaultOn: false, load: () => import('../layers/bia-reservations') },
  { key: 'states', name: 'State Boundaries', source: 'US Census · bundled GeoJSON', role: 'reference', defaultOn: true, load: () => import('../layers/states') },
  { key: 'places', name: 'City & Town Labels', source: 'Natural Earth · bundled', role: 'reference', defaultOn: false, load: () => import('../layers/places') },
  { key: 'nifc-fires', name: 'Active Wildfires (NIFC)', source: 'NIFC WFIGS · FeatureServer', role: 'event', defaultOn: false, coActivateWith: ['hms-smoke'], load: () => import('../layers/nifc-fires') },
  { key: 'nws-alerts', name: 'Heat & Fire Weather Alerts', source: 'NOAA NWS · MapServer', role: 'event', defaultOn: false, load: () => import('../layers/nws-alerts') },
  { key: 'hms-smoke', name: 'Smoke Plumes (HMS)', source: 'NOAA OSPO · FeatureServer', role: 'event', defaultOn: false, coActivateWith: ['nifc-fires'], load: () => import('../layers/hms-smoke') },
  { key: 'heatrisk', name: 'HeatRisk · Today (Experimental)', source: 'NOAA NWS/WPC · ImageServer', role: 'surface', defaultOn: false, load: () => import('../layers/heatrisk') },
  { key: 'spc-fire-weather', name: 'Fire Weather Outlook (Day 1)', source: 'NOAA SPC · MapServer', role: 'surface', defaultOn: false, load: () => import('../layers/spc-fire-weather') },
  { key: 'usfs-whp', name: 'Wildfire Hazard Potential', source: 'USFS · GeoPlatform', role: 'surface', defaultOn: false, load: () => import('../layers/usfs-whp') },
  { key: 'sst-anomaly', name: 'Ocean Temperature Anomaly', source: 'NASA GIBS · GHRSST MUR', role: 'surface', defaultOn: false, load: () => import('../layers/sst-anomaly') },
  // Monitoring stations left the default-on set 2026-07-09 (D-0.7.0-018
  // item 1, strengthening the D-0.7.0-007 zoom threshold): at region zoom
  // the layer could only say "zoom in to load", so opening with it on
  // bought noise, not signal.
  { key: 'telemetry', name: 'Monitoring stations', source: 'USGS · USBR · NRCS · USACE', role: 'stations', defaultOn: false, load: () => import('../layers/telemetry') }
];

/**
 * The four roles in sidebar display order (UX-1): condition surfaces first
 * (the state of the place), then the reference boundaries a person orients
 * by, then events, then stations.
 */
export const LAYER_ROLE_ORDER: readonly LayerRole[] = [
  'surface',
  'reference',
  'event',
  'stations'
];

/**
 * Resolve a layer-key list to the one-surface-at-a-time invariant: the
 * FIRST surface named in the list is kept and every later surface is
 * dropped; non-surface keys (including unknown keys, which carry no role
 * and are rejected downstream by the registry) pass through untouched.
 *
 * This is the deterministic back-compatibility rule for inbound `?layers=`
 * parameters written before UX-1, when several surfaces could be active at
 * once and old shared links may still name them all. `syncUrl` serializes
 * the active set in activation order, so the first surface in an old link
 * is the one its author turned on first. Documented in CHANGES.md (UX-1).
 */
export function resolveExclusiveSurface(keys: readonly string[]): string[] {
  let surfaceSeen = false;
  const resolved: string[] = [];
  for (const key of keys) {
    const def = getLayerDef(key);
    if (def?.role === 'surface') {
      if (surfaceSeen) continue;
      surfaceSeen = true;
    }
    resolved.push(key);
  }
  return resolved;
}

/**
 * Set of layer keys that should be activated at boot when no `?layers=`
 * parameter is present on the URL.
 */
export const DEFAULT_ON_KEYS: ReadonlySet<string> = new Set(
  LAYER_DEFS.filter((def) => def.defaultOn).map((def) => def.key)
);

/**
 * Look up a layer definition by key. Returns null when the key is unknown
 * (typically a stale URL parameter); callers ignore such keys silently.
 */
export function getLayerDef(key: string): LayerDef | null {
  return LAYER_DEFS.find((def) => def.key === key) ?? null;
}

/**
 * Cache of loaded layer modules. The first activation of a layer awaits its
 * dynamic import (fetching that layer's chunk); subsequent activations, and
 * every deactivate, reuse the cached instance, so a layer that has been toggled
 * on once behaves exactly like the previous eager-module design.
 */
const moduleCache = new Map<string, LayerModule>();

/**
 * In-flight imports, so concurrent calls for the same key share one chunk
 * fetch (single-flight). Without this, a rapid toggle off/on while the
 * first import was still resolving started a second import and a second
 * independent activation. A failed import is removed from the map so the
 * next toggle-on retries cleanly (a stale-chunk 404 after a redeploy must
 * not poison the layer for the rest of the session).
 */
const moduleInFlight = new Map<string, Promise<LayerModule>>();

/** Load (and cache) a layer's module, fetching its chunk on first call. */
export function loadLayerModule(def: LayerDef): Promise<LayerModule> {
  const cached = moduleCache.get(def.key);
  if (cached) return Promise.resolve(cached);
  let pending = moduleInFlight.get(def.key);
  if (!pending) {
    pending = def.load().then(
      (mod) => {
        moduleCache.set(def.key, mod);
        moduleInFlight.delete(def.key);
        return mod;
      },
      (err: unknown) => {
        moduleInFlight.delete(def.key);
        throw err;
      }
    );
    moduleInFlight.set(def.key, pending);
  }
  return pending;
}

/** The already-loaded module for a key, or undefined if it was never loaded. */
export function getLoadedLayerModule(key: string): LayerModule | undefined {
  return moduleCache.get(key);
}
