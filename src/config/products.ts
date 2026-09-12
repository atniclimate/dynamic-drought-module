import type { LayerKey } from './layers';
import type { MatrixLaneKey } from '../impact/matrix';
import type { URLS } from './urls';

/**
 * The URL-catalog key authority, read as a TYPE only (DDM-P14-T05 microtask
 * 1): every product that reads a live or bundled endpoint names the URLS
 * key that serves it, so a typo fails `tsc` instead of drifting silently.
 * `src/config/urls.ts` exports no such alias itself (it is a read-cap file,
 * never read whole); this derives it locally from the frozen `URLS` object's
 * own shape, which a type-only import still exposes to `keyof typeof`.
 */
export type UrlsKey = keyof typeof URLS;

/**
 * The product-key authority (DDM-P14-T05, mirroring `LAYER_KEYS` in
 * `src/config/layers.ts:31-55`): every key `PRODUCTS` defines, in the order
 * `PRODUCTS` produces them. A VALUE list rather than a type derived from
 * `PRODUCTS`'s own shape, for the same reason `LAYER_KEYS` is: it lets
 * `tests/product-catalog.spec.ts` assert the two stay in step without
 * inferring one from the other's literal keys.
 *
 * One product per DISTINCT issuer data product (the design ruling this file
 * follows, not a rule invented here). The first 23 keys are the layer-backed
 * products, one per `LAYER_DEFS` entry in that array's own order; the
 * remaining keys are briefing-only products no map layer draws. Five layer
 * products also carry a briefing lane, because the same issuer endpoint
 * feeds both the map and a matrix cell: `usdm`, `heatrisk`, `nifc-fires`,
 * `nws-alerts`, `spc-fire-weather`.
 */
export const PRODUCT_KEYS = Object.freeze([
  'hydrography',
  'ecoregions',
  'hillshade',
  'drought',
  'gridded-index',
  'usdm',
  'cdm-drought',
  'nadm-drought',
  'aiannh',
  'tribal',
  'treaty',
  'bia-reservations',
  'states',
  'places',
  'power-infrastructure',
  'nifc-fires',
  'nws-alerts',
  'hms-smoke',
  'heatrisk',
  'spc-fire-weather',
  'usfs-whp',
  'sst-anomaly',
  'telemetry',
  // Briefing-only products (no LayerDef reads them): DSCI, the NWS point
  // forecast, the two live CPC outlook reads, the cited CPC seasonal drought
  // prose, the NWRFC water-supply read, and the six distinct issuer products
  // the ENSO snapshot lane cites (one snapshot fetch, six named products,
  // each with its own source string in src/impact/enso.ts).
  'dsci',
  'nwsForecast',
  'cpcExtended',
  'cpcSeasonal',
  'cpcSeasonalTemp',
  'waterSupply',
  'ensoIndex',
  'ensoAuthority',
  'ensoTendency',
  'ensoNino34Monthly',
  'ensoNino34Weekly',
  'ensoOutlook'
] as const);

/** The union of every valid product key, derived from `PRODUCT_KEYS`. */
export type ProductKey = (typeof PRODUCT_KEYS)[number];

/**
 * The observed/outlook clock a product's claims and its layer's `no data`
 * framing both answer to (DR-070: one observed or outlook register per
 * claim). `cadence` is the issuer's own stated update cadence in a short
 * internal phrase; it is never rendered (a rendered cadence string needs
 * ddm-cite), so it stays approximate where the tree does not carry the
 * issuer's own stated frequency verbatim.
 */
export interface ProductClock {
  readonly register: 'observed' | 'outlook';
  readonly cadence: string;
  /**
   * Set only for the one ruled exception (DR-071): HeatRisk's claim evidence
   * stays 'classified' (the badge wording is unchanged), but its register
   * reads 'outlook' while the issuer's 24-hour window is still in force,
   * because the issuer's own words describe HeatRisk as a forecast product.
   */
  readonly note?: string;
}

/**
 * One entry per distinct issuer data product. `LayerDef.product` and
 * `SourcedClaim.product` (DDM-P14-T05 microtask 2) both point into this
 * catalog, so a claim or a layer can be traced to the agency that issues it,
 * the endpoint that serves it, the map layer that draws it, and the
 * briefing lane that reads it, in one place.
 */
export interface ProductDef {
  readonly key: ProductKey;
  /**
   * The issuing agency, in the words the tree already uses in `LayerDef.source`
   * or a claim's `source` field. Never a new public string authored here;
   * every value below is copied verbatim from one of those two places (see
   * the microtask 1 report for the handful of sites where the tree states
   * more than one candidate string and a choice had to be made).
   */
  readonly issuer: string;
  /** The URLS key that serves this product, or null for one with no endpoint
   * (fixed prose, or a product whose LayerDef reads more than one issuer
   * endpoint under a single visual layer and so cannot honestly name one). */
  readonly endpointKey: UrlsKey | null;
  /** The map layer that visualizes this product, or null for a briefing-only
   * product no LayerDef draws. */
  readonly layerKey: LayerKey | null;
  /** The briefing lane that reads this product, or null for a map-only
   * product no matrix cell cites. */
  readonly lane: MatrixLaneKey | null;
  readonly clock: ProductClock;
}

/**
 * The full product catalog. `tests/product-catalog.spec.ts` is what keeps
 * this in step with `LAYER_DEFS` and with every `makeClaim` construction
 * site in `src/impact/*.ts`; it asserts both sets, printing (never failing
 * on) the products with no visualization, the layers with no claim, and the
 * endpoint keys with no reader.
 */
export const PRODUCTS: Readonly<Record<ProductKey, ProductDef>> = Object.freeze({
  hydrography: {
    key: 'hydrography',
    issuer: 'OpenStreetMap (Overpass)',
    endpointKey: 'overpassMirrors',
    layerKey: 'hydrography',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  ecoregions: {
    key: 'ecoregions',
    issuer: 'EPA Omernik · PMTiles',
    endpointKey: 'ecoregionsPmtilesLocal',
    layerKey: 'ecoregions',
    lane: null,
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  hillshade: {
    key: 'hillshade',
    issuer: 'USGS 3DEP · PMTiles · Pacific Northwest bake only',
    endpointKey: 'hillshadePmtilesLocal',
    layerKey: 'hillshade',
    lane: null,
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  drought: {
    key: 'drought',
    issuer: 'NOAA CPC · Monthly & Seasonal',
    endpointKey: 'cpcDroughtOutlookVectorMapServer',
    layerKey: 'drought',
    lane: null,
    clock: { register: 'outlook', cadence: 'monthly & seasonal' }
  },
  'gridded-index': {
    key: 'gridded-index',
    issuer: 'NOAA NIDIS · raster tiles · contiguous United States only',
    endpointKey: 'nidisGriddedTileRoot',
    layerKey: 'gridded-index',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  usdm: {
    key: 'usdm',
    // The registered `usdm` LayerDef's `source` is a live getter
    // (getDroughtSurfacePresentation) that reads 'NDMC · FeatureServer' by
    // default and swaps to a British Columbia basin issuer string when that
    // edition is active (src/config/layers.ts DROUGHT_CONDITIONS_DEF,
    // src/layers/bc-drought.ts). A ProductDef.issuer is a fixed string, so
    // this names the default USDM_PRESENTATION issuer; see the microtask 1
    // report.
    issuer: 'NDMC · FeatureServer',
    endpointKey: 'usdmFeatureServer',
    layerKey: 'usdm',
    lane: 'usdm',
    clock: { register: 'observed', cadence: 'weekly, Thursday' }
  },
  'cdm-drought': {
    key: 'cdm-drought',
    issuer: 'Agriculture and Agri-Food Canada · committed monthly snapshot',
    endpointKey: 'cdmDroughtAreasLocal',
    layerKey: 'cdm-drought',
    lane: null,
    clock: { register: 'observed', cadence: 'committed monthly snapshot' }
  },
  'nadm-drought': {
    key: 'nadm-drought',
    issuer: 'Tri-national consensus · NCEI direct GeoJSON',
    endpointKey: 'nadmCurrentGeojson',
    layerKey: 'nadm-drought',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  aiannh: {
    key: 'aiannh',
    issuer: 'US Census · AIANNH (live)',
    endpointKey: 'censusAiannhMapServer',
    layerKey: 'aiannh',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  tribal: {
    key: 'tribal',
    issuer: 'deployer · bundled GeoJSON',
    endpointKey: 'tribalLandsLocal',
    layerKey: 'tribal',
    lane: null,
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  treaty: {
    key: 'treaty',
    issuer: 'deployer · bundled GeoJSON',
    endpointKey: 'treatyAreasLocal',
    layerKey: 'treaty',
    lane: null,
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  'bia-reservations': {
    key: 'bia-reservations',
    issuer: 'BIA · AIAN-LAR (live)',
    endpointKey: 'biaLarFeatureServer',
    layerKey: 'bia-reservations',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  states: {
    key: 'states',
    issuer: 'US Census · bundled GeoJSON',
    endpointKey: 'usStatesLocal',
    layerKey: 'states',
    lane: null,
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  places: {
    key: 'places',
    issuer: 'Natural Earth · bundled',
    endpointKey: 'usPlacesLocal',
    layerKey: 'places',
    lane: null,
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  'power-infrastructure': {
    key: 'power-infrastructure',
    issuer: 'HIFLD archive (2024-09-30) · EIA (live)',
    // Two issuer endpoints under one visual layer (a bundled HIFLD power-line
    // PMTiles archive plus a live EIA power-plant FeatureLayer query); naming
    // either alone would misstate the other, so this is null. See the
    // microtask 1 report.
    endpointKey: null,
    layerKey: 'power-infrastructure',
    lane: null,
    clock: { register: 'observed', cadence: 'archive (2024-09-30) + on demand' }
  },
  'nifc-fires': {
    key: 'nifc-fires',
    issuer: 'NIFC WFIGS · FeatureServer',
    endpointKey: 'nifcFires',
    layerKey: 'nifc-fires',
    lane: 'nifc',
    clock: { register: 'observed', cadence: 'on demand' }
  },
  'nws-alerts': {
    key: 'nws-alerts',
    issuer: 'NOAA NWS · MapServer',
    // The map layer reads the Watches/Warnings/Advisories MapServer; the
    // `nwsAlerts` briefing lane reads the api.weather.gov active-alerts feed
    // (URLS.nwsApi) instead, a different technical endpoint for the same
    // conceptual NWS alert product. This names the layer's own endpoint; see
    // the microtask 1 report.
    endpointKey: 'nwsWwaMapServer',
    layerKey: 'nws-alerts',
    lane: 'nwsAlerts',
    clock: { register: 'observed', cadence: 'on demand' }
  },
  'hms-smoke': {
    key: 'hms-smoke',
    issuer: 'NOAA OSPO · FeatureServer',
    endpointKey: 'noaaHmsSmokeFeatureServer',
    layerKey: 'hms-smoke',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  heatrisk: {
    key: 'heatrisk',
    issuer: 'NOAA NWS/WPC · ImageServer',
    endpointKey: 'nwsHeatRisk',
    layerKey: 'heatrisk',
    lane: 'heatRisk',
    clock: {
      register: 'outlook',
      cadence: 'daily',
      note:
        'DR-071: claim evidence stays classified; the register reads outlook while the issuer-stated 24-hour window is still in force.'
    }
  },
  'spc-fire-weather': {
    key: 'spc-fire-weather',
    issuer: 'NOAA SPC · MapServer',
    endpointKey: 'spcFireWeatherOutlookMapServer',
    layerKey: 'spc-fire-weather',
    lane: 'spcFireOutlook',
    clock: { register: 'outlook', cadence: 'on demand' }
  },
  'usfs-whp': {
    key: 'usfs-whp',
    issuer: 'USFS · GeoPlatform',
    endpointKey: 'usfsWhp',
    layerKey: 'usfs-whp',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  'sst-anomaly': {
    key: 'sst-anomaly',
    issuer: 'NASA GIBS · GHRSST MUR',
    endpointKey: 'gibsSstAnomalyWmts',
    layerKey: 'sst-anomaly',
    // Not the same endpoint the ENSO briefing lane reads: the ENSO snapshot
    // (URLS.ensoIndicesLocal) never queries GIBS imagery. No shared lane.
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },
  telemetry: {
    key: 'telemetry',
    issuer: 'USGS · USBR · NRCS · USACE',
    // Four agencies behind src/config/station-registry.ts, each its own URLS
    // key (usgsIV, nrcsAwdbStations, nifcRawsFeatureServer, noaaCoopsStations,
    // usbrAgrimetSitesJs, iemCocorahsNetwork and more); no single key names
    // this layer honestly. See the microtask 1 report.
    endpointKey: null,
    layerKey: 'telemetry',
    lane: null,
    clock: { register: 'observed', cadence: 'on demand' }
  },

  // -- Briefing-only products: no LayerDef draws these. --------------------

  dsci: {
    key: 'dsci',
    issuer: 'USDM Data Services (NDMC)',
    endpointKey: 'usdmDataServices',
    layerKey: null,
    lane: 'dsci',
    clock: { register: 'observed', cadence: 'weekly, Thursday' }
  },
  nwsForecast: {
    key: 'nwsForecast',
    // vocab-allow: names the NWS point forecast, upstream product; the same allowance src/impact/sources.ts carries at its claim site
    issuer: 'NWS forecast',
    endpointKey: 'nwsApi',
    layerKey: null,
    lane: 'nwsForecast',
    clock: { register: 'outlook', cadence: 'on demand' }
  },
  cpcExtended: {
    key: 'cpcExtended',
    issuer: 'NOAA CPC extended-range outlooks',
    // Two window variants of one issuance (6-10 day and 8-14 day), each its
    // own URLS key; this names the 6-10 day key as representative. See the
    // microtask 1 report.
    endpointKey: 'cpc610OutlookMapServer',
    layerKey: null,
    lane: 'cpcExtended',
    clock: { register: 'outlook', cadence: 'daily' }
  },
  cpcSeasonal: {
    key: 'cpcSeasonal',
    issuer: 'NOAA CPC Seasonal Drought Outlook',
    // Fixed prose (src/impact/hydrate.ts:72), re-stamped by hand when
    // re-verified against the live product; no endpoint DDM fetches.
    endpointKey: null,
    layerKey: null,
    lane: 'cpcSeasonal',
    clock: { register: 'outlook', cadence: 'bundled, static' }
  },
  cpcSeasonalTemp: {
    key: 'cpcSeasonalTemp',
    issuer: 'NOAA Climate Prediction Center seasonal temperature outlook',
    endpointKey: 'cpcSeasonalTempOutlookMapServer',
    layerKey: null,
    lane: 'cpcSeasonalTemp',
    clock: { register: 'outlook', cadence: 'monthly' }
  },
  waterSupply: {
    key: 'waterSupply',
    // vocab-allow: names the NWRFC Water Supply Forecast, upstream product; the same allowance src/impact/water-supply.ts carries at its claim site
    issuer: 'NWRFC Water Supply Forecast',
    endpointKey: 'nwrfcWsReportCsv',
    layerKey: null,
    lane: 'waterSupply',
    // This one product's two claim sites carry different evidence (an
    // observed runoff-to-date companion and the outlook forecast itself);
    // the product's own register names the forecast, its headline read. See
    // the microtask 1 report.
    clock: { register: 'outlook', cadence: 'on demand' }
  },
  ensoIndex: {
    key: 'ensoIndex',
    issuer: 'NOAA CPC Relative Oceanic Nino Index (RONI) and observed ENSO indices',
    endpointKey: 'ensoIndicesLocal',
    layerKey: null,
    lane: 'enso',
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  ensoAuthority: {
    key: 'ensoAuthority',
    issuer: 'NOAA CPC ENSO Diagnostic Discussion',
    endpointKey: 'ensoIndicesLocal',
    layerKey: null,
    lane: 'enso',
    clock: { register: 'observed', cadence: 'monthly, second Thursday' }
  },
  ensoTendency: {
    key: 'ensoTendency',
    // Three candidate issuer strings live at this one claim site, chosen by
    // the current ENSO phase (src/impact/enso.ts tendency()): the USDA
    // Northwest Climate Hub for an active El Nino or La Nina phase, or NOAA
    // CPC's own composites for neutral. This names the neutral-phase issuer
    // as representative. See the microtask 1 report.
    issuer: 'NOAA CPC ENSO Temperature and Precipitation Composites',
    endpointKey: 'ensoIndicesLocal',
    layerKey: null,
    lane: 'enso',
    clock: { register: 'observed', cadence: 'bundled, static' }
  },
  ensoNino34Monthly: {
    key: 'ensoNino34Monthly',
    issuer: 'NOAA CPC analyzed monthly Nino 3.4 sea surface temperature anomaly',
    endpointKey: 'ensoIndicesLocal',
    layerKey: null,
    lane: 'enso',
    clock: { register: 'observed', cadence: 'monthly' }
  },
  ensoNino34Weekly: {
    key: 'ensoNino34Weekly',
    issuer: 'NOAA CPC weekly Nino 3.4 sea surface temperature anomaly',
    endpointKey: 'ensoIndicesLocal',
    layerKey: null,
    lane: 'enso',
    clock: { register: 'observed', cadence: 'weekly' }
  },
  ensoOutlook: {
    key: 'ensoOutlook',
    issuer: 'NOAA CPC official probabilistic ENSO outlook (CPC/IRI consensus)',
    endpointKey: 'ensoIndicesLocal',
    layerKey: null,
    lane: 'enso',
    clock: { register: 'outlook', cadence: 'monthly' }
  }
});
