import type { CanonicalGeographyKey } from './geography';

/**
 * Every independently gated source family in the impact briefing. Keeping
 * this list explicit prevents one broad regional boolean from activating
 * unrelated network work.
 */
export type BriefingSourceKey =
  | 'pointHeat'
  | 'nwsForecast'
  | 'nwsAlerts'
  | 'heatRisk'
  | 'usdm'
  | 'dsci'
  | 'nifc'
  | 'cpcExtended'
  | 'enso'
  | 'waterSupply'
  | 'cpcSeasonal'
  | 'cpcSeasonalTemp'
  | 'spcFireOutlook';

export type SourceCapabilityState =
  | 'available'
  | 'conditional'
  | 'unavailable';

export interface SourceCapabilityCell {
  readonly state: SourceCapabilityState;
  readonly note: string;
}

export const BRIEFING_SOURCE_KEYS: readonly BriefingSourceKey[] = [
  'pointHeat',
  'nwsForecast',
  'nwsAlerts',
  'heatRisk',
  'usdm',
  'dsci',
  'nifc',
  'cpcExtended',
  'enso',
  'waterSupply',
  'cpcSeasonal',
  'cpcSeasonalTemp',
  'spcFireOutlook'
];

export const BRIEFING_SOURCE_LABELS: Readonly<
  Record<BriefingSourceKey, string>
> = {
  pointHeat: 'NWS point observation and grid guidance',
  // vocab-allow: names the upstream NWS point forecast product
  nwsForecast: 'NWS point forecast',
  // vocab-allow: names the upstream NWS active alerts product
  nwsAlerts: 'NWS active alerts',
  heatRisk: 'NWS HeatRisk',
  usdm: 'U.S. Drought Monitor point category',
  dsci: 'U.S. Drought Monitor statewide DSCI',
  nifc: 'NIFC current mapped fire perimeters',
  cpcExtended: 'NOAA CPC extended-range outlooks',
  enso: 'ENSO phase context',
  waterSupply: 'NWRFC water-supply outlook',
  cpcSeasonal: 'NOAA CPC seasonal drought outlook',
  cpcSeasonalTemp: 'NOAA CPC seasonal temperature outlook',
  // DDM-P7-T03 (DR-022 a): SPC Day 1-8 Fire Weather Outlook, near-term fire.
  spcFireOutlook: 'NOAA SPC Day 1-8 Fire Weather Outlook'
};

type NationalHeatSourceKey =
  | 'pointHeat'
  | 'nwsForecast'
  | 'nwsAlerts'
  | 'heatRisk'
  | 'cpcSeasonalTemp';

const available = (note: string): SourceCapabilityCell => ({
  state: 'available',
  note
});

const conditional = (note: string): SourceCapabilityCell => ({
  state: 'conditional',
  note
});

const unavailable = (note: string): SourceCapabilityCell => ({
  state: 'unavailable',
  note
});

// vocab-allow: describes support for the upstream NWS point forecast product
const NWS_FORECAST_SUPPORTED = 'NWS point forecast discovery is supported.';
// vocab-allow: describes support for upstream NWS alert queries
const NWS_ALERTS_SUPPORTED = 'NWS point alert queries are supported.';

/**
 * Canonical geography policy for heat-related issuers. The remaining
 * briefing sources retain their separately validated regional policy in
 * src/impact/source-policy.ts.
 */
export const NATIONAL_HEAT_SOURCE_CAPABILITY: Readonly<
  Record<
    CanonicalGeographyKey,
    Readonly<Record<NationalHeatSourceKey, SourceCapabilityCell>>
  >
> = {
  conus: {
    pointHeat: available('NWS point observation and grid guidance are supported.'),
    nwsForecast: available(NWS_FORECAST_SUPPORTED),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: conditional(
      'HeatRisk is available only inside the issuer raster coverage and while the layer has a selected frame.'
    ),
    // DDM-P7-T07, DR-075 a (director ruling): the coverage gate follows the
    // issuer's own service extent (STEP 0, verified 2026-09-09: layer
    // extent lat ~18.9 to 71.4N, nearly the full longitude range), not the
    // drought-impact-synthesis doctrine region.
    cpcSeasonalTemp: available(
      'The CPC seasonal temperature outlook service extent covers CONUS (verified 2026-09-09).'
    )
  },
  alaska: {
    pointHeat: available('NWS point observation and grid guidance are supported.'),
    nwsForecast: available(NWS_FORECAST_SUPPORTED),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.'),
    cpcSeasonalTemp: available(
      'The CPC seasonal temperature outlook service extent covers Alaska (verified 2026-09-09).'
    )
  },
  hawaii: {
    pointHeat: available('NWS point observation and grid guidance are supported.'),
    nwsForecast: available(NWS_FORECAST_SUPPORTED),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.'),
    cpcSeasonalTemp: available(
      'The CPC seasonal temperature outlook service extent covers Hawaii (verified 2026-09-09).'
    )
  },
  'puerto-rico': {
    pointHeat: available(
      'NWS point observation and grid guidance were live-verified for Puerto Rico.'
    ),
    nwsForecast: available(
      // vocab-allow: describes live verification of the upstream NWS point forecast product
      'NWS point forecast discovery was live-verified for Puerto Rico.'
    ),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.'),
    // DR-075 a follow-up (director ruling, 2026-09-09): the STEP 0 extent
    // is not confirmed for Puerto Rico specifically, so this mirrors the
    // HeatRisk row above rather than asserting coverage; see this task's
    // Owner decisions for the ambiguity.
    cpcSeasonalTemp: unavailable(
      'The CPC seasonal temperature outlook coverage for Puerto Rico is not confirmed.'
    )
  },
  'served-territory': {
    pointHeat: conditional(
      'NWS point heat is attempted only when point discovery publishes the required links.'
    ),
    nwsForecast: conditional(
      // vocab-allow: names the upstream forecast link published by NWS point discovery
      'NWS point forecast is attempted only when point discovery publishes a forecast link.'
    ),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.'),
    cpcSeasonalTemp: unavailable(
      'The CPC seasonal temperature outlook coverage for this territory is not confirmed.'
    )
  },
  'american-samoa': {
    pointHeat: conditional(
      'NWS point discovery is checked once; missing grid and station links become no data.'
    ),
    nwsForecast: conditional(
      // vocab-allow: describes absence of the upstream NWS forecast link
      'NWS point discovery is checked once; a missing forecast link becomes no data.'
    ),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.'),
    // STEP 0's extent (ymin ~18.9N) does not reach American Samoa (~-14S).
    cpcSeasonalTemp: unavailable(
      'The CPC seasonal temperature outlook service extent does not reach American Samoa.'
    )
  },
  canada: {
    pointHeat: unavailable('The United States NWS point API is not used for Canada.'),
    nwsForecast: unavailable('The United States NWS point API is not used for Canada.'),
    // vocab-allow: names the upstream United States NWS alerts API
    nwsAlerts: unavailable('The United States NWS alerts API is not used for Canada.'),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.'),
    cpcSeasonalTemp: unavailable(
      'The CPC seasonal temperature outlook is a United States CPC product, not issued for Canada.'
    )
  },
  transboundary: {
    pointHeat: unavailable(
      'No point source runs until the selected point has a country-specific identity.'
    ),
    nwsForecast: unavailable(
      'No point source runs until the selected point has a country-specific identity.'
    ),
    nwsAlerts: unavailable(
      'No point source runs until the selected point has a country-specific identity.'
    ),
    heatRisk: unavailable(
      'No point source runs until the selected point has a country-specific identity.'
    ),
    cpcSeasonalTemp: unavailable(
      'No point source runs until the selected point has a country-specific identity.'
    )
  },
  unknown: {
    pointHeat: unavailable('The selected point has no recognized source geography.'),
    nwsForecast: unavailable('The selected point has no recognized source geography.'),
    nwsAlerts: unavailable('The selected point has no recognized source geography.'),
    heatRisk: unavailable('The selected point has no recognized source geography.'),
    cpcSeasonalTemp: unavailable('The selected point has no recognized source geography.')
  }
};

/**
 * DDM-P7-T03 (DR-022 a): the SPC Day 1-8 Fire Weather Outlook's own service
 * extent, the same national-geography model DDM-P7-T07 used above for the
 * CPC seasonal temperature outlook, bounded to this one new key so no
 * existing row above changes shape. The verify-spc-nifc.md receipt (S20)
 * states the service covers the continental United States; no extent probe
 * was run for Alaska, Hawaii, or the territories, so those geographies read
 * unavailable naming the same CONUS-only extent, matching the shipped
 * HeatRisk row's pattern for a CONUS-only product.
 */
export const SPC_FIRE_OUTLOOK_CAPABILITY: Readonly<
  Record<CanonicalGeographyKey, SourceCapabilityCell>
> = {
  conus: available(
    'The SPC Day 1-8 Fire Weather Outlook service extent covers the continental United States (verified 2026-09-09).'
  ),
  alaska: unavailable(
    'The SPC Day 1-8 Fire Weather Outlook service extent covers the continental United States only.'
  ),
  hawaii: unavailable(
    'The SPC Day 1-8 Fire Weather Outlook service extent covers the continental United States only.'
  ),
  'puerto-rico': unavailable(
    'The SPC Day 1-8 Fire Weather Outlook service extent covers the continental United States only.'
  ),
  'served-territory': unavailable(
    'The SPC Day 1-8 Fire Weather Outlook service extent covers the continental United States only.'
  ),
  'american-samoa': unavailable(
    'The SPC Day 1-8 Fire Weather Outlook service extent covers the continental United States only.'
  ),
  canada: unavailable(
    'The SPC Day 1-8 Fire Weather Outlook is a United States NOAA product, not issued for Canada.'
  ),
  transboundary: unavailable(
    'No point source runs until the selected point has a country-specific identity.'
  ),
  unknown: unavailable('The selected point has no recognized source geography.')
};
