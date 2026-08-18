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
  | 'nifcPerimeterEvidence'
  | 'cpcExtended'
  | 'enso'
  | 'waterSupply'
  | 'cpcSeasonal';

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
  'nifcPerimeterEvidence',
  'cpcExtended',
  'enso',
  'waterSupply',
  'cpcSeasonal'
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
  nifcPerimeterEvidence:
    'NIFC current mapped fire perimeters intersecting this place',
  cpcExtended: 'NOAA CPC extended-range outlooks',
  enso: 'ENSO phase context',
  waterSupply: 'NWRFC water-supply outlook',
  cpcSeasonal: 'NOAA CPC seasonal drought outlook'
};

type NationalHeatSourceKey =
  | 'pointHeat'
  | 'nwsForecast'
  | 'nwsAlerts'
  | 'heatRisk';

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
    )
  },
  alaska: {
    pointHeat: available('NWS point observation and grid guidance are supported.'),
    nwsForecast: available(NWS_FORECAST_SUPPORTED),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.')
  },
  hawaii: {
    pointHeat: available('NWS point observation and grid guidance are supported.'),
    nwsForecast: available(NWS_FORECAST_SUPPORTED),
    nwsAlerts: available(NWS_ALERTS_SUPPORTED),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.')
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
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.')
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
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.')
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
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.')
  },
  canada: {
    pointHeat: unavailable('The United States NWS point API is not used for Canada.'),
    nwsForecast: unavailable('The United States NWS point API is not used for Canada.'),
    // vocab-allow: names the upstream United States NWS alerts API
    nwsAlerts: unavailable('The United States NWS alerts API is not used for Canada.'),
    heatRisk: unavailable('The shipped HeatRisk raster covers CONUS only.')
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
    )
  },
  unknown: {
    pointHeat: unavailable('The selected point has no recognized source geography.'),
    nwsForecast: unavailable('The selected point has no recognized source geography.'),
    nwsAlerts: unavailable('The selected point has no recognized source geography.'),
    heatRisk: unavailable('The selected point has no recognized source geography.')
  }
};

type NationalFireSourceKey = 'nifcPerimeterEvidence';

/**
 * Canonical geography policy for the geometry-exact NIFC mapped-perimeter
 * evidence. Independent of the regional impactSynthesis axis, exactly like
 * the heat table above: WFIGS is a United States interagency service, so
 * availability rides the selection's canonical geography, never the PNW
 * coverage-family matrix.
 */
export const NATIONAL_FIRE_SOURCE_CAPABILITY: Readonly<
  Record<
    CanonicalGeographyKey,
    Readonly<Record<NationalFireSourceKey, SourceCapabilityCell>>
  >
> = {
  conus: {
    nifcPerimeterEvidence: available(
      'WFIGS current mapped perimeters cover CONUS.'
    )
  },
  alaska: {
    nifcPerimeterEvidence: available(
      'WFIGS current mapped perimeters cover Alaska.'
    )
  },
  hawaii: {
    nifcPerimeterEvidence: available(
      'WFIGS current mapped perimeters cover Hawaii.'
    )
  },
  'puerto-rico': {
    nifcPerimeterEvidence: available(
      'WFIGS current mapped perimeters cover Puerto Rico.'
    )
  },
  'served-territory': {
    nifcPerimeterEvidence: available(
      'WFIGS current mapped perimeters cover this United States territory.'
    )
  },
  'american-samoa': {
    nifcPerimeterEvidence: available(
      'WFIGS current mapped perimeters cover American Samoa.'
    )
  },
  canada: {
    nifcPerimeterEvidence: unavailable(
      'WFIGS is a United States interagency service and is not used for Canada.'
    )
  },
  transboundary: {
    nifcPerimeterEvidence: unavailable(
      'No point source runs until the selected point has a country-specific identity.'
    )
  },
  unknown: {
    nifcPerimeterEvidence: unavailable(
      'The selected point has no recognized source geography.'
    )
  }
};
