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
   * Optional synchronous cancellation seam, invoked by the layer controller
   * the moment off intent is recorded, BEFORE the serialized teardown op
   * reaches the module. A module with a long-running activation fetch aborts
   * it here immediately (CLAUDE.md section 6 invariant 5) instead of letting
   * it run out its network budget behind the per-key op queue; it must NOT
   * touch map state (sources/layers), which remains `deactivate`'s job.
   * Added with the Tribal Nations umbrella build (Codex Unit B finding 1,
   * C:\dev\_reviews\ddm\2026-07-15_unit-B-codex.md).
   */
  cancelActivation?(): void;
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
   * Optional presentation override for the `no-data` status (Unit C of the
   * Tribal Nations umbrella build; closes standing task #9 for the live
   * layers). The canonical six-state union is untouched: this re-words ONE
   * state's user-visible text where the default "empty placeholder (see
   * data/README.md)" would be dishonest. A LIVE layer that returns zero
   * features for the current view is not a placeholder; it says so
   * (`LIVE_NO_FEATURES_LABEL`). Bundled placeholder layers omit this and
   * keep the canonical wording. Resolved in ONE place
   * (`resolveStatusPillText` in src/ui/island/pill-text.ts) shared by the
   * status pill and the live-region announcer, so the two can never drift.
   */
  readonly noDataLabel?: string;
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
  /**
   * Hidden from every default UI surface (no catalog row, no search result)
   * while OFF; the row appears only when the layer is on (a `?layers=` deep
   * link), so the URL keeps round-tripping and the user can still turn it
   * off. The Unit I mechanism (D-0.7.0-038 part 3) for the deployer-owned
   * own-data slots: "not a public-facing UI feature" governs the default UI,
   * while the keys stay shipped, documented, and URL-reachable.
   */
  readonly uiHidden?: boolean;
}

/**
 * Layer registry in display order. The sidebar renders toggles in this
 * order; boot-time activation of `defaultOn` layers also follows it. Layer
 * stacking on the map is owed to insertion order plus each layer's own
 * `beforeId` strategy (most layers anchor to `'first-symbol'` if present,
 * otherwise append).
 *
 * Default-on is the demo-ready set (deliberately changed by the Tribal
 * Nations umbrella build, D-0.7.0-032/033, then narrowed by Unit I,
 * D-0.7.0-038; both recorded in docs/URL_SCHEMA_POLICY.md as deliberate
 * default changes, not silent ones): US Drought Monitor (the headline
 * drought layer), the two live PRESENT-DAY Tribal-geography layers (Census
 * AIANNH Tribal Lands and BIA Reservation Boundaries; Tribal Nations MUST
 * display on first load), State Boundaries, and (since E1, D-0.7.0-043
 * part 3) Terrain Shading. Treaty & Ceded Lands (the
 * historical Royce record) is default-off and joins via the Tribal Nations
 * button, its own toggle, or a boundary click. The bundled deployer slots
 * (`tribal`, `treaty`) are default-off AND ui-hidden: they are only
 * meaningful once a deployer populates them with their own authorized
 * data. Hydrography is
 * intentionally off by default; the live Overpass query is slow and
 * fragile, so leading the bare URL with it produced a flaky first paint.
 */
/**
 * The honest zero-state wording for LIVE viewport-queried layers: the agency
 * answered and had no features intersecting this view. Distinct from the
 * bundled-placeholder wording by design (a live layer is never a
 * placeholder, and pointing a user at data/README.md for it was wrong; see
 * the Unit C note on `LayerDef.noDataLabel`).
 */
export const LIVE_NO_FEATURES_LABEL = 'no features returned for this view';

export const LAYER_DEFS: readonly LayerDef[] = [
  { key: 'hydrography', name: 'Hydrography', source: 'OpenStreetMap (Overpass)', role: 'reference', defaultOn: false, load: () => import('../layers/hydrography') },
  { key: 'ecoregions', name: 'Ecoregions (Level III/IV)', source: 'EPA Omernik · PMTiles', role: 'reference', defaultOn: false, load: () => import('../layers/ecoregions') },
  // Default-on since E1 (D-0.7.0-043 part 3): terrain shading joins the
  // calm default composition so the E1 paint tuning accounts for it from
  // the start; it renders inside the bottom stack, below every data layer.
  { key: 'hillshade', name: 'Terrain Shading', source: 'USGS 3DEP · PMTiles', role: 'reference', defaultOn: true, load: () => import('../layers/hillshade') },
  { key: 'drought', name: 'Drought Outlook (CPC)', source: 'NOAA CPC · Monthly & Seasonal', role: 'surface', defaultOn: false, load: () => import('../layers/drought') },
  { key: 'gridded-index', name: 'Gridded Drought Index (SPI)', source: 'NOAA NIDIS · raster tiles', role: 'surface', defaultOn: false, load: () => import('../layers/gridded-index') },
  // noDataLabel on the live agency layers below (usdm, wildfire pair, NWS
  // alerts, SPC, bia-reservations): a zero-feature live response is a real,
  // good answer ("no smoke drawn today"), never an "empty placeholder"; the
  // placeholder wording stays only on the bundled deployer slots (tribal,
  // treaty). Unit C of the umbrella build + the Codex Unit C pass.
  { key: 'usdm', name: 'US Drought Monitor', source: 'NDMC · FeatureServer', role: 'surface', defaultOn: true, noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/usdm') },
  // The Tribal Nations members (D-0.7.0-032/033, narrowed by D-0.7.0-038):
  // the two live present-day layers are default-on (Tribal Nations MUST
  // display); the live historical cession record is default-off; the two
  // bundled deployer slots are default-off, ui-hidden, and labeled so "your
  // own data" is unmistakable. The deployer keys (`tribal`, `treaty`) are
  // shipped public identifiers and keep their meaning (URL policy rule 4);
  // only display names and visibility changed.
  { key: 'aiannh', name: 'Tribal Lands', source: 'US Census · AIANNH (live)', role: 'reference', defaultOn: true, noDataLabel: 'no features returned for this view (Census-defined Tribal areas only)', load: () => import('../layers/aiannh') },
  { key: 'tribal', name: 'Tribal Lands (your own data)', source: 'deployer · bundled GeoJSON', role: 'reference', defaultOn: false, uiHidden: true, load: () => import('../layers/tribal') },
  // treaty-cessions is default-OFF since Unit I (D-0.7.0-038 decision 1,
  // narrowing D-0.7.0-033 decision 3): the passive page-load default carries
  // the two present-day representations; the historical cession record joins
  // on the Tribal Nations button, the manual toggle, or a boundary click
  // (src/impact/related-cessions.ts).
  // E2 (D-0.7.0-058 ruling 4): treaty-cessions leaves the visible catalog
  // through the same uiHidden mechanism as the deployer slots below; the
  // key stays shipped, URL-reachable (?layers=treaty-cessions), commanded
  // by the Tribal Nations button, and opened by the Unit I related-cessions
  // click. The LAYERS studio (D-0.7.0-055) is its future visible home.
  { key: 'treaty-cessions', name: 'Treaty & Ceded Lands', source: 'USFS · Royce cessions (live)', role: 'reference', defaultOn: false, uiHidden: true, noDataLabel: 'no features returned for this view (a historical record; not every Treaty area is digitized)', load: () => import('../layers/treaty-cessions') },
  { key: 'treaty', name: 'Treaty Areas (your own data)', source: 'deployer · bundled GeoJSON', role: 'reference', defaultOn: false, uiHidden: true, load: () => import('../layers/treaty') },
  // The BIA label carries the design-required coverage caveat: AIAN-LAR
  // returning nothing here is a statement about the DATASET's coverage (it
  // omits most Oklahoma Tribal Statistical Areas and landless Tribal
  // Nations), never a verified absence of Tribal presence.
  { key: 'bia-reservations', name: 'Reservation Boundaries', source: 'BIA · AIAN-LAR (live)', role: 'reference', defaultOn: true, noDataLabel: 'no features returned for this view (AIAN-LAR does not cover every Tribal Nation)', load: () => import('../layers/bia-reservations') },
  { key: 'states', name: 'State Boundaries', source: 'US Census · bundled GeoJSON', role: 'reference', defaultOn: true, load: () => import('../layers/states') },
  { key: 'places', name: 'City & Town Labels', source: 'Natural Earth · bundled', role: 'reference', defaultOn: false, load: () => import('../layers/places') },
  { key: 'nifc-fires', name: 'Active Wildfires (NIFC)', source: 'NIFC WFIGS · FeatureServer', role: 'event', defaultOn: false, coActivateWith: ['hms-smoke'], noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/nifc-fires') },
  { key: 'nws-alerts', name: 'Heat & Fire Weather Alerts', source: 'NOAA NWS · MapServer', role: 'event', defaultOn: false, noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/nws-alerts') },
  { key: 'hms-smoke', name: 'Smoke Plumes (HMS)', source: 'NOAA OSPO · FeatureServer', role: 'event', defaultOn: false, coActivateWith: ['nifc-fires'], noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/hms-smoke') },
  { key: 'heatrisk', name: 'HeatRisk · Today (Experimental)', source: 'NOAA NWS/WPC · ImageServer', role: 'surface', defaultOn: false, load: () => import('../layers/heatrisk') },
  { key: 'spc-fire-weather', name: 'Fire Weather Outlook (Day 1)', source: 'NOAA SPC · MapServer', role: 'surface', defaultOn: false, noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/spc-fire-weather') },
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
