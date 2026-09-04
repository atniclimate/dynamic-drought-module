import type * as maplibregl from 'maplibre-gl';

import type { LayerRole } from '../types/layer';

/**
 * Layer module contract: every layer file under `src/layers/` exports
 * `activate`, `deactivate`, and (optionally) `bindPopups`; these names are
 * a frozen contract. The registry below pairs each module with the UI metadata
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
   * it here immediately (the cancellation invariant) instead of letting
   * it run out its network budget behind the per-key op queue; it must NOT
   * touch map state (sources/layers), which remains `deactivate`'s job.
   * Added with the Tribal Nations umbrella build (Codex Unit B finding 1,
   * 2026-07-15).
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
 * bundle. This honors the lazy-loaded-layers invariant at
 * the CODE level, not just the data level: before this, activation was lazy but
 * every layer module in the catalog was eagerly imported into the main chunk
 * (fifteen of them when this note was written; the catalog holds twenty-three
 * today). The default-on layers load at boot as before; the rest arrive on
 * first toggle. `loadLayerModule` caches the resolved module so `deactivate`
 * and `bindPopups` reach the same instance a later toggle uses.
 *
 * Scope of that guarantee (ARCH-03): it covers `src/layers/**` modules, not
 * every table a layer reads. Since DR-008a (2026-09-02 and 2026-09-03) the
 * tables that used to ride the entry chunk beside this catalog no longer do:
 * the map key and the telemetry network adapters load lazily, the featured
 * station table arrives with the Water & Snow list, and the URL catalog is
 * read at boot only through its two-value boot slice
 * (`src/config/urls-boot.ts`). The activation gate
 * (`scripts/check-activation-budget.mjs`) forbids the URL and station
 * catalogs from the initial static set; the palette and the preset and
 * cluster tables remain eager by design, because first paint reads them.
 */
export interface LayerDef {
  readonly key: string;
  readonly name: string;
  readonly source: string;
  /** Optional discoverability terms that do not alter the source-honest
   * visible layer name. Used when a familiar hazard term is broader or
   * narrower than the mapped product's formal label. */
  readonly searchTerms?: readonly string[];
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
   * state's user-visible text where the default "no data (see
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
   * wildfire event pair (Current Mapped Fire Perimeters + Smoke Plumes,
   * D-0.7.0-018).
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
 * D-0.7.0-038; both were ratified as deliberate
 * default changes, not silent ones): US Drought Monitor (the headline
 * drought layer), the two live PRESENT-DAY Tribal-geography layers (Census
 * AIANNH Tribal Lands and BIA Reservation Boundaries; Tribal Nations MUST
 * display on first load), State Boundaries, and (since E1, D-0.7.0-043
 * part 3) Terrain Shading. The bundled deployer slots (`tribal`, `treaty`)
 * are default-off AND ui-hidden: they are only
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

export interface DroughtSurfacePresentation {
  readonly edition: 'usdm' | 'bc-basin';
  readonly name: string;
  readonly source: string;
  readonly sourceDate: string | null;
}

const USDM_PRESENTATION: DroughtSurfacePresentation = {
  edition: 'usdm',
  name: 'US Drought Monitor',
  source: 'NDMC · FeatureServer',
  sourceDate: null
};

let droughtSurfacePresentation: DroughtSurfacePresentation = USDM_PRESENTATION;

/**
 * The registered `usdm` key is the one issuer-aware drought controller.
 * The catalog reads these getters on every registry render, so a region or
 * source-date change updates the one existing row without a second surface.
 */
export function setDroughtSurfacePresentation(
  presentation: DroughtSurfacePresentation
): void {
  droughtSurfacePresentation = presentation;
}

export function resetDroughtSurfacePresentation(): void {
  droughtSurfacePresentation = USDM_PRESENTATION;
}

export function getDroughtSurfacePresentation(): DroughtSurfacePresentation {
  return droughtSurfacePresentation;
}

const DROUGHT_CONDITIONS_DEF: LayerDef = {
  key: 'usdm',
  get name() {
    return droughtSurfacePresentation.name;
  },
  get source() {
    return droughtSurfacePresentation.source;
  },
  role: 'surface',
  defaultOn: false,
  noDataLabel: 'no coverage returned by the active drought source',
  load: () => import('../layers/usdm')
};

export const LAYER_DEFS: readonly LayerDef[] = [
  { key: 'hydrography', name: 'Hydrography', source: 'OpenStreetMap (Overpass)', role: 'reference', defaultOn: false, load: () => import('../layers/hydrography') },
  { key: 'ecoregions', name: 'Ecoregions (Level III/IV)', source: 'EPA Omernik · PMTiles', role: 'reference', defaultOn: false, load: () => import('../layers/ecoregions') },
  // Default-on since E1 (D-0.7.0-043 part 3): terrain shading joins the
  // calm default composition so the E1 paint tuning accounts for it from
  // the start; it renders inside the bottom stack, below every data layer.
  // FIRE-09: the archive is the Pacific Northwest bake (bbox
  // [-125, 41.5, -110.5, 49.5]; scripts/build-whp-tiles.mjs, and
  // src/config/urls.ts on the hillshade entry), but the layer is default-on at
  // every viewport, so a user in Alaska, Hawaii, or the Southeast saw a
  // `live` pill over an empty basemap with nothing saying why. The coverage
  // qualification rides the source line, mirroring FIRE3D_COVERAGE_NOTE
  // ("Terrain relief covers the Pacific Northwest data bake; outside it the
  // ground renders flat."), which the 3D control has always shown.
  { key: 'hillshade', name: 'Terrain Shading', source: 'USGS 3DEP · PMTiles · Pacific Northwest bake only', role: 'reference', defaultOn: true, load: () => import('../layers/hillshade') },
  { key: 'drought', name: 'Drought Outlook (CPC)', source: 'NOAA CPC · Monthly & Seasonal', role: 'surface', defaultOn: false, load: () => import('../layers/drought') },
  // The NIDIS gridded index carries its coverage limit on the source line, the
  // same way `hillshade` above does: drought.gov gives the ACIS "Grid 1"
  // dataset's Data Coverage as "Contiguous U.S.", and every wired SPI window
  // publishes `bbox: -128.8,24.4,-66.0,50.3` in its own `info.json`
  // (re-verified 2026-09-03). Alaska, Hawaii, Puerto Rico and the Pacific
  // territories are outside it, and a row that said only "raster tiles" left
  // that for the user to discover as an empty map.
  { key: 'gridded-index', name: 'Gridded Drought Index (SPI)', source: 'NOAA NIDIS · raster tiles · contiguous United States only', role: 'surface', defaultOn: false, load: () => import('../layers/gridded-index') },
  // noDataLabel on the live agency layers below (usdm, wildfire pair, NWS
  // alerts, SPC, bia-reservations): a zero-feature live response is a real,
  // good answer ("no smoke drawn in the query window"), never an "empty placeholder"; the
  // placeholder wording stays only on the bundled deployer slots (tribal,
  // treaty). Unit C of the umbrella build + the Codex Unit C pass.
  DROUGHT_CONDITIONS_DEF,
  { key: 'cdm-drought', name: 'Canadian Drought Monitor', source: 'Agriculture and Agri-Food Canada · committed monthly snapshot', role: 'surface', defaultOn: false, load: () => import('../layers/cdm-drought') },
  { key: 'nadm-drought', name: 'North American Drought Monitor', source: 'Tri-national consensus · NCEI direct GeoJSON', role: 'surface', defaultOn: true, noDataLabel: 'no continental polygons returned by the active source', load: () => import('../layers/nadm-drought') },
  // The Tribal Nations members (D-0.7.0-032/033, narrowed by D-0.7.0-038):
  // the two live present-day layers are default-on (Tribal Nations MUST
  // display); the two bundled deployer slots are default-off, ui-hidden, and
  // labeled so "your own data" is unmistakable. The deployer keys (`tribal`,
  // `treaty`) are shipped public identifiers and keep their meaning (URL
  // policy rule 4); only display names and visibility changed.
  { key: 'aiannh', name: 'Tribal Lands', source: 'US Census · AIANNH (live)', role: 'reference', defaultOn: true, noDataLabel: 'no features returned for this view (Census-defined Tribal areas only)', load: () => import('../layers/aiannh') },
  { key: 'tribal', name: 'Tribal Lands (your own data)', source: 'deployer · bundled GeoJSON', role: 'reference', defaultOn: false, uiHidden: true, load: () => import('../layers/tribal') },
  { key: 'treaty', name: 'Treaty Areas (your own data)', source: 'deployer · bundled GeoJSON', role: 'reference', defaultOn: false, uiHidden: true, load: () => import('../layers/treaty') },
  // The BIA label carries the design-required coverage caveat: AIAN-LAR
  // returning nothing here is a statement about the DATASET's coverage (it
  // omits most Oklahoma Tribal Statistical Areas and landless Tribal
  // Nations), never a verified absence of Tribal presence.
  { key: 'bia-reservations', name: 'Reservation Boundaries', source: 'BIA · AIAN-LAR (live)', role: 'reference', defaultOn: true, noDataLabel: 'no features returned for this view (AIAN-LAR does not cover every Tribal Nation)', load: () => import('../layers/bia-reservations') },
  { key: 'states', name: 'State Boundaries', source: 'US Census · bundled GeoJSON', role: 'reference', defaultOn: true, load: () => import('../layers/states') },
  { key: 'places', name: 'City & Town Labels', source: 'Natural Earth · bundled', role: 'reference', defaultOn: false, load: () => import('../layers/places') },
  // Power infrastructure became a catalog row 2026-08-19 (owner direction).
  // It shipped as a companion of the 3D Fire scene, which meant it was
  // always on there and unreachable everywhere else; one toggle now governs
  // it in every view, off by default, drawn from zoom 6. The name states
  // BOTH surfaces because they have different vintages and different
  // failure modes, and either can be live without the other.
  { key: 'power-infrastructure', name: 'Power Lines & Plants', source: 'HIFLD archive (2024-09-30) · EIA (live)', searchTerms: ['transmission', 'electric', 'grid', 'power plant', 'utility'], role: 'reference', defaultOn: false, load: () => import('../layers/power-3d') },
  { key: 'nifc-fires', name: 'Current Mapped Fire Perimeters (NIFC)', source: 'NIFC WFIGS · FeatureServer', searchTerms: ['wildfire', 'Prescribed fire', 'fire perimeter'], role: 'event', defaultOn: false, coActivateWith: ['hms-smoke'], noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/nifc-fires') },
  // vocab-allow: names the NWS alert products layer, upstream data
  { key: 'nws-alerts', name: 'Heat & Fire Weather Alerts', source: 'NOAA NWS · MapServer', role: 'event', defaultOn: false, noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/nws-alerts') },
  { key: 'hms-smoke', name: 'Smoke Plumes (HMS)', source: 'NOAA OSPO · FeatureServer', role: 'event', defaultOn: false, coActivateWith: ['nifc-fires'], noDataLabel: LIVE_NO_FEATURES_LABEL, load: () => import('../layers/hms-smoke') },
  { key: 'heatrisk', name: 'HeatRisk (Experimental)', source: 'NOAA NWS/WPC · ImageServer', role: 'surface', defaultOn: false, load: () => import('../layers/heatrisk') },
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
 * is the one its author turned on first (a UX-1 decision).
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
 * Key-to-definition index, built once beside `DEFAULT_ON_KEYS`. `getLayerDef`
 * runs on every status change, on every controller entry point, and once per
 * key inside `resolveExclusiveSurface`, so the previous linear `find` sat on
 * the boot path (ARCH-15). Behavior is identical: the catalog is a frozen
 * module-level table. The entries are reversed before the Map is built so a
 * duplicate key would resolve to the FIRST definition, exactly as `find` did;
 * no test asserts key uniqueness, so the old behavior is preserved rather than
 * assumed away.
 */
const LAYER_DEFS_BY_KEY: ReadonlyMap<string, LayerDef> = new Map(
  LAYER_DEFS.map((def) => [def.key, def] as const).reverse()
);

/**
 * Look up a layer definition by key. Returns null when the key is unknown
 * (typically a stale URL parameter); callers ignore such keys silently.
 */
export function getLayerDef(key: string): LayerDef | null {
  return LAYER_DEFS_BY_KEY.get(key) ?? null;
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
