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
 * existing row above changes shape. F2 (S20 fix round): round 1's comment
 * falsely cited verify-spc-nifc.md for an extent claim that receipt never
 * made. A dedicated science verifier then ran on this extent
 * (science-verdict-extent.md, S20 round 2): SPC's own about.html states the
 * outlook depicts risk "across the continental United States" (VERIFIED,
 * cited on the `conus` row), and the service's own EPSG:3857 `fullExtent`,
 * converted that session to about 25 N-50 N, 125 W-67 W, corroborates a
 * CONUS-shaped bound; but SPC never states an explicit Alaska, Hawaii,
 * Puerto Rico, served-territory, or American Samoa exclusion, and it
 * publishes nothing about Canada at all (UNVERIFIED for that specific
 * claim). The six non-conus rows below are therefore worded as a DDM
 * convention derived from the measured extent plus the issuer's own
 * domain sentence, never as a quoted issuer exclusion, and all six stay
 * `unavailable`, the conservative default, unchanged by this round. The
 * note strings themselves are reader-facing copy (src/impact/hydrate.ts
 * settles a policy-gated lane with `sources[key].note`, which the panel
 * renders as the cell note), so each is one short sentence on the model of
 * the HeatRisk and CPC rows above; the provenance lives here, in this
 * comment, and in I:/claude-temp/ddm-s20/DDM-P7-T03/science-verdict-extent.md
 * (a director edit at the merge, S20 round 2).
 */
export const SPC_FIRE_OUTLOOK_CAPABILITY: Readonly<
  Record<CanonicalGeographyKey, SourceCapabilityCell>
> = {
  conus: available(
    'The SPC Fire Weather Outlook covers the continental United States, in SPC\'s own words (verified 2026-09-09).'
  ),
  alaska: unavailable(
    'The SPC Fire Weather Outlook\'s own service extent does not reach this geography.'
  ),
  hawaii: unavailable(
    'The SPC Fire Weather Outlook\'s own service extent does not reach this geography.'
  ),
  'puerto-rico': unavailable(
    'The SPC Fire Weather Outlook\'s own service extent does not reach this geography.'
  ),
  'served-territory': unavailable(
    'The SPC Fire Weather Outlook\'s own service extent does not reach this geography.'
  ),
  'american-samoa': unavailable(
    'The SPC Fire Weather Outlook\'s own service extent does not reach this geography.'
  ),
  canada: unavailable(
    'The SPC Fire Weather Outlook is a NOAA product whose stated coverage is the continental United States.'
  ),
  transboundary: unavailable(
    'No point source runs until the selected point has a country-specific identity.'
  ),
  unknown: unavailable('The selected point has no recognized source geography.')
};
