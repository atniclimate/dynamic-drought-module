import type maplibregl from 'maplibre-gl';

import type { LayerRole } from '../types/layer';
import * as biaReservations from '../layers/bia-reservations';
import * as drought from '../layers/drought';
import * as ecoregions from '../layers/ecoregions';
import * as griddedIndex from '../layers/gridded-index';
import * as heatrisk from '../layers/heatrisk';
import * as hydrography from '../layers/hydrography';
import * as nifcFires from '../layers/nifc-fires';
import * as nwsAlerts from '../layers/nws-alerts';
import * as spcFireWeather from '../layers/spc-fire-weather';
import * as states from '../layers/states';
import * as telemetry from '../layers/telemetry';
import * as treaty from '../layers/treaty';
import * as tribal from '../layers/tribal';
import * as usdm from '../layers/usdm';
import * as usfsWhp from '../layers/usfs-whp';

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
}

/**
 * Per-layer registry entry.
 *
 * Deviation from CLAUDE.md section 8: the kickoff prescribed
 * `lazyLoad: () => Promise<void>` (a single function reference). We carry
 * the full module instead so `deactivate` and `bindPopups` are reachable
 * from the same registry entry; this matches how the boot wires region
 * change, embed-flag transitions, and per-layer popup binding without
 * each consumer needing to import each layer module separately. Documented
 * in CHANGES.md under "Phase B".
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
  readonly module: LayerModule;
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
  { key: 'hydrography', name: 'Hydrography',                source: 'OpenStreetMap (Overpass)',  role: 'reference', defaultOn: false, module: hydrography },
  { key: 'ecoregions',  name: 'Ecoregions (Level III/IV)',  source: 'EPA Omernik · PMTiles',      role: 'reference', defaultOn: false, module: ecoregions },
  { key: 'drought',     name: 'Seasonal Drought Outlook',   source: 'NOAA CPC · WMS',            role: 'surface',   defaultOn: false, module: drought },
  { key: 'gridded-index', name: 'Gridded Drought Index (SPI)', source: 'NOAA NIDIS · raster tiles', role: 'surface',   defaultOn: false, module: griddedIndex },
  { key: 'usdm',        name: 'US Drought Monitor',         source: 'NDMC · FeatureServer',      role: 'surface',   defaultOn: true,  module: usdm },
  { key: 'tribal',      name: 'Tribal Lands',               source: 'BIA · bundled GeoJSON',     role: 'reference', defaultOn: true,  module: tribal },
  { key: 'treaty',      name: 'Treaty Areas',               source: 'WA DAHP · bundled GeoJSON', role: 'reference', defaultOn: false, module: treaty },
  { key: 'bia-reservations', name: 'Reservation Boundaries', source: 'BIA · AIAN-LAR (live)',     role: 'reference', defaultOn: false, module: biaReservations },
  { key: 'states',      name: 'State Boundaries',           source: 'US Census · bundled GeoJSON', role: 'reference', defaultOn: false, module: states },
  { key: 'nifc-fires',  name: 'Active Wildfires (NIFC)',    source: 'NIFC WFIGS · FeatureServer', role: 'event',     defaultOn: false, module: nifcFires },
  { key: 'nws-alerts',  name: 'Heat & Fire Weather Alerts', source: 'NOAA NWS · MapServer',       role: 'event',     defaultOn: false, module: nwsAlerts },
  { key: 'heatrisk',    name: 'HeatRisk · Today (Experimental)', source: 'NOAA NWS/WPC · ImageServer', role: 'surface', defaultOn: false, module: heatrisk },
  { key: 'spc-fire-weather', name: 'Fire Weather Outlook (Day 1)', source: 'NOAA SPC · MapServer', role: 'surface', defaultOn: false, module: spcFireWeather },
  { key: 'usfs-whp',    name: 'Wildfire Hazard Potential',  source: 'USFS · GeoPlatform',         role: 'surface',   defaultOn: false, module: usfsWhp },
  { key: 'telemetry',   name: 'Telemetry Stations',         source: 'USGS · USBR · NRCS · USACE', role: 'stations',  defaultOn: true,  module: telemetry }
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
