import type maplibregl from 'maplibre-gl';

import * as biaReservations from '../layers/bia-reservations';
import * as drought from '../layers/drought';
import * as ecoregions from '../layers/ecoregions';
import * as griddedIndex from '../layers/gridded-index';
import * as hydrography from '../layers/hydrography';
import * as nifcFires from '../layers/nifc-fires';
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
  { key: 'hydrography', name: 'Hydrography',                source: 'OpenStreetMap (Overpass)',  defaultOn: false, module: hydrography },
  { key: 'ecoregions',  name: 'Ecoregions (Level III/IV)',  source: 'EPA Omernik · PMTiles',      defaultOn: false, module: ecoregions },
  { key: 'drought',     name: 'Seasonal Drought Outlook',   source: 'NOAA CPC · WMS',            defaultOn: false, module: drought },
  { key: 'gridded-index', name: 'Gridded Drought Index (SPI)', source: 'NOAA NIDIS · raster tiles', defaultOn: false, module: griddedIndex },
  { key: 'usdm',        name: 'US Drought Monitor',         source: 'NDMC · FeatureServer',      defaultOn: true,  module: usdm },
  { key: 'tribal',      name: 'Tribal Lands',               source: 'BIA · bundled GeoJSON',     defaultOn: true,  module: tribal },
  { key: 'treaty',      name: 'Treaty Areas',               source: 'WA DAHP · bundled GeoJSON', defaultOn: false, module: treaty },
  { key: 'bia-reservations', name: 'Reservation Boundaries', source: 'BIA · AIAN-LAR (live)',     defaultOn: false, module: biaReservations },
  { key: 'nifc-fires',  name: 'Active Wildfires (NIFC)',    source: 'NIFC WFIGS · FeatureServer', defaultOn: false, module: nifcFires },
  { key: 'usfs-whp',    name: 'Wildfire Hazard Potential',  source: 'USFS · GeoPlatform',         defaultOn: false, module: usfsWhp },
  { key: 'telemetry',   name: 'Telemetry Stations',         source: 'USGS · USBR · NRCS · USACE', defaultOn: true,  module: telemetry }
];

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
