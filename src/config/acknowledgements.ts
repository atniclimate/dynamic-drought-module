/**
 * The acknowledgements rows (S30D D1 M22; task DDM-P7-T11; register items
 * owner-1r-credits and found-027; design record
 * planning/2026-09-25-desktop-pass/design/acknowledgements-table.md sections
 * 1.8 to 2.4, as amended by DR-147, DR-159 and DR-160 to DR-166).
 *
 * One row per issuer. Every `src/config/products.ts` product names its rows
 * in `PRODUCT_CREDITS` below (a record over `ProductKey` of non-empty tuples
 * typed against `AcknowledgementId`, so `tsc` rejects a product with no
 * credit), and every non-catalog source the map or the briefing draws names
 * its rows in `PROVIDERS` below.
 *
 * THE WORDS RULE (DR-147). A credit, changes or notice sentence here is the
 * cited text exactly as the M22 cite batch (workflow wf_f7e3c5f0-9ec,
 * planning/references/register.yaml clause_verdicts_2026_09_29) recorded it;
 * `citeId` names the ledger slug it was recorded under, and a sentence with
 * a null `citeId` never renders. A row with no cited sentence renders the
 * issuer's name alone (DR-166, Q20: a REQUESTED or COURTESY credit still
 * pending ships name-only and is listed on the owner card). A product whose
 * REQUIRED sentence has not passed gets no row at all (DR-147): the British
 * Columbia basin edition is held (DR-160) and has none here.
 *
 * `html`, where present, is the same sentence with its issuer-given links
 * (first-party markup, rendered as-is); `tests/acknowledgements.spec.ts`
 * asserts that its text content equals `text` exactly, so a link can never
 * change a word.
 *
 * Only the lazy impact-panel runtime and the tests import this module (the
 * station layer's legend reads the DR-159 notice from
 * `src/config/ddm-notice.ts`, so its chunk never carries this table).
 * `scripts/check-activation-budget.mjs` keeps it out of the eager entry.
 */

import { DDM_NOTICE_LABEL, RAWS_PUBLIC_VIEW_NOTICE } from './ddm-notice';
import type { ProductKey } from './products';

/** Every row id, in no rendered order (the renderer groups and sorts). */
export const ACKNOWLEDGEMENT_IDS = [
  'noaa-nesdis',
  'nasa',
  'noaa-nws',
  'noaa-cpc',
  'noaa-wpc',
  'noaa-spc',
  'noaa-nwrfc',
  'noaa-ncep',
  'noaa-ospo',
  'noaa-nidis',
  'noaa-coops',
  'usgs',
  'usfs',
  'usda-nrcs',
  'usda-nw-climate-hub',
  'usbr',
  'usace',
  'nifc',
  'census',
  'bia',
  'hifld',
  'eia',
  'epa',
  'aafc',
  'statcan',
  'usdm-partners',
  'nadm',
  'natural-earth',
  'osm',
  'overture',
  'cocorahs-iem',
  'deployer'
] as const;

export type AcknowledgementId = (typeof ACKNOWLEDGEMENT_IDS)[number];

/**
 * Sources the map or the briefing draws that are not `products.ts` products
 * (design section 1.8, plus the two briefing and minimap inputs DR-165
 * credits). Each leaves this table when its source becomes a product or
 * leaves the tree.
 */
export const PROVIDER_KEYS = [
  'basemap-ground',
  'satellite-geocolor',
  'enso-flow',
  'structures',
  'terrain-archive',
  'whp-3d',
  'landscape-signature',
  'minimap-drought-metric'
] as const;

export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export interface CreditSentence {
  /** The cited words, verbatim (U+2013 kept where the issuer publishes it). */
  readonly text: string;
  /** The same words with their issuer-given links; text content === text. */
  readonly html?: string;
  /** The references-ledger slug the cite batch recorded; null never renders. */
  readonly citeId: string | null;
}

export type AcknowledgementGroup =
  | 'us-federal'
  | 'canada'
  | 'partnerships-and-other'
  | 'deployer';

export interface AcknowledgementRow {
  readonly id: AcknowledgementId;
  /** Styled text: the issuer's name, no colour, no emblem, no image. */
  readonly name: string;
  readonly group: AcknowledgementGroup;
  /** The issuer's credit sentences; empty = name-only. */
  readonly credits: readonly CreditSentence[];
  /** DDM's statement of its changes, where the terms ask for one. */
  readonly changes: readonly CreditSentence[];
  /** DDM's own notices about the source (DR-159), labelled as DDM's. */
  readonly notices: readonly CreditSentence[];
  /** A licence the terms ask to link, rendered as an https anchor. */
  readonly licence: { readonly name: string; readonly url: string } | null;
  /** Q-LOGOS (DR-106): every verdict is styled text today; no image. */
  readonly logo: { readonly verdict: 'styled-text' };
}

/** Section group headings, in rendered order (design section 1.9). */
export const ACKNOWLEDGEMENT_GROUPS: readonly {
  readonly key: AcknowledgementGroup;
  readonly heading: string;
}[] = [
  { key: 'us-federal', heading: 'United States federal agencies' },
  { key: 'canada', heading: 'Canadian governments' },
  { key: 'partnerships-and-other', heading: 'Partnerships and other publishers' },
  { key: 'deployer', heading: "This deployment's own data" }
];

const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const OGL_CANADA_URL = 'https://open.canada.ca/en/open-government-licence-canada';
const CC_BY_4_URL = 'https://creativecommons.org/licenses/by/4.0/';

// The public-view RAWS notice and the DDM notice label (DR-159) live in
// their own two-literal module so the station legend's chunk never carries
// this table; re-exported here for every other reader.
export { DDM_NOTICE_LABEL, RAWS_PUBLIC_VIEW_NOTICE };

/** The one OpenStreetMap credit string (DR-117, DR-162; src/map/style.ts:47-48). */
// ledger: osm-basemap-ground-credit (cite sheet c02); osm-overpass-hydrography (c03)
export const OSM_CREDIT: CreditSentence = {
  text: '© OpenStreetMap contributors',
  html: `© <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap</a> contributors`,
  citeId: 'osm-basemap-ground-credit'
};

// ledger: nws-web-disclaimer (cite sheet c26), the shared NWS-family line
const NWS_FAMILY_LINE: CreditSentence = {
  text:
    "Material from NOAA National Weather Service offices is in the public domain, unless specifically noted otherwise, and is not subject to copyright protection. DDM's display of it is not official NWS material and implies no endorsement by or affiliation with NOAA or the NWS.",
  citeId: 'nws-web-disclaimer'
};

// ledger: aafc-canadian-drought-monitor; nadm-canadian-portion-ogl-canada (cite sheet c18)
const OGL_CANADA_AAFC: CreditSentence = {
  text:
    'Agriculture and Agri-Food Canada. Contains information licensed under the Open Government Licence – Canada.',
  html: `Agriculture and Agri-Food Canada. Contains information licensed under the <a href="${OGL_CANADA_URL}">Open Government Licence – Canada</a>.`,
  citeId: 'aafc-canadian-drought-monitor'
};

const NONE: readonly CreditSentence[] = [];
const STYLED = { verdict: 'styled-text' } as const;

/** Name-only row (DR-166 Q20): the issuer's name, no sentence yet. */
function nameOnly(
  id: AcknowledgementId,
  name: string,
  group: AcknowledgementGroup = 'us-federal'
): AcknowledgementRow {
  return { id, name, group, credits: NONE, changes: NONE, notices: NONE, licence: null, logo: STYLED };
}

export const ACKNOWLEDGEMENTS: Readonly<Record<AcknowledgementId, AcknowledgementRow>> = {
  'noaa-nesdis': nameOnly('noaa-nesdis', 'NOAA NESDIS Satellite Maps'),
  nasa: nameOnly(
    'nasa',
    "NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)"
  ),
  'noaa-nws': { ...nameOnly('noaa-nws', 'NOAA National Weather Service'), credits: [NWS_FAMILY_LINE] },
  'noaa-cpc': { ...nameOnly('noaa-cpc', 'NOAA Climate Prediction Center'), credits: [NWS_FAMILY_LINE] },
  'noaa-wpc': { ...nameOnly('noaa-wpc', 'NOAA Weather Prediction Center'), credits: [NWS_FAMILY_LINE] },
  'noaa-spc': { ...nameOnly('noaa-spc', 'NOAA Storm Prediction Center'), credits: [NWS_FAMILY_LINE] },
  'noaa-nwrfc': {
    // vocab-allow: the issuing office's own name (NOAA NWS Northwest River Forecast Center), an upstream name
    ...nameOnly('noaa-nwrfc', 'NOAA NWS Northwest River Forecast Center'),
    credits: [NWS_FAMILY_LINE]
  },
  'noaa-ncep': {
    ...nameOnly('noaa-ncep', 'NOAA National Centers for Environmental Prediction'),
    credits: [NWS_FAMILY_LINE]
  },
  'noaa-ospo': nameOnly('noaa-ospo', 'NOAA NESDIS Office of Satellite and Product Operations'),
  'noaa-nidis': nameOnly(
    'noaa-nidis',
    'NOAA National Integrated Drought Information System (drought.gov)'
  ),
  'noaa-coops': nameOnly('noaa-coops', 'NOAA Tides and Currents (CO-OPS)'),
  usgs: {
    ...nameOnly('usgs', 'U.S. Geological Survey'),
    credits: [
      // ledger: usgs-3dep-landscape-signature (cite sheet c17)
      {
        text:
          "Elevation, slope and aspect summaries computed by DDM from USGS 3D Elevation Program (3DEP) 1/3 arc-second seamless DEM, courtesy of the U.S. Geological Survey. DDM's changes: the roughly 10 m elevation grid was resampled onto a 30 m EPSG:5070 analysis grid and used to compute area-weighted mean elevation, Horn 3x3 slope and aspect, ten elevation-band area shares, and an eight-cardinal-plus-flat-plus-excluded aspect distribution for each ecoregion. These summaries are DDM's, not a USGS product, and USGS has not reviewed or endorsed them.",
        citeId: 'usgs-3dep-landscape-signature'
      }
    ],
    changes: [
      // ledger: usgs-3dep-hillshade-pnw-changes (cite sheet c15)
      {
        text:
          'Changes by DDM: elevation was requested from the USGS 3DEPElevation ImageServer on 2026-07-14 (3DEP data current as of 2026-05-19) as 512-pixel Web Mercator tiles for zoom levels 0 to 8 over 125°W to 110.5°W and 41.5°N to 49.5°N, quantized to whole meters, with ocean and source no-data cells set to 0 m, and stored as Terrarium-encoded PNG; the map computes its shading from these tiles. The USGS has not approved or endorsed these changes.',
        citeId: 'usgs-3dep-hillshade-pnw-changes'
      },
      // ledger: usgs-3dep-terrain-archive-changes (cite sheet c16)
      {
        text:
          'Changes by DDM: for the 3D Fire view, elevation was requested from the USGS 3DEPElevation ImageServer on 2026-09-10 as 512-pixel Web Mercator tiles for zoom levels 0 to 10 over 125°W to 110.5°W and 41.5°N to 49.5°N, quantized to whole meters and stored as Terrarium-encoded PNG; the scene exaggerates this relief 2.4 times vertically for display. When this archive is unavailable the scene uses the zoom 0 to 8 archive described above. The USGS has not approved or endorsed these changes.',
        citeId: 'usgs-3dep-terrain-archive-changes'
      }
    ]
  },
  usfs: nameOnly('usfs', 'USDA Forest Service'),
  'usda-nrcs': nameOnly('usda-nrcs', 'USDA Natural Resources Conservation Service'),
  'usda-nw-climate-hub': nameOnly('usda-nw-climate-hub', 'USDA Northwest Climate Hub'),
  usbr: nameOnly('usbr', 'Bureau of Reclamation'),
  usace: nameOnly('usace', 'U.S. Army Corps of Engineers'),
  nifc: {
    ...nameOnly('nifc', 'National Interagency Fire Center'),
    notices: [RAWS_PUBLIC_VIEW_NOTICE]
  },
  census: {
    ...nameOnly('census', 'U.S. Census Bureau'),
    credits: [
      // ledger: census-cb-2023-state-20m (cite sheet c28)
      {
        text:
          'Source: U.S. Census Bureau, 2023 Cartographic Boundary File, State and Equivalent Entities for United States, 1:20,000,000; TIGERweb, American Indian, Alaska Native, and Native Hawaiian Areas.',
        citeId: 'census-cb-2023-state-20m'
      }
    ]
  },
  bia: nameOnly('bia', 'Bureau of Indian Affairs'),
  hifld: {
    ...nameOnly('hifld', 'HIFLD (U.S. Government)'),
    credits: [
      // ledger: esri-fuc-transmission-lines-host (cite sheet c05; DR-163 cut the OSM clause)
      {
        text:
          'Transmission lines: U.S. Electric Power Transmission Lines (U.S. Government), archived copy last updated 2024-09-30, via the Esri Federal User Community.',
        citeId: 'esri-fuc-transmission-lines-host'
      }
    ]
  },
  // The EIA sentence (cite sheet c04) carries the live reporting period, so
  // it renders in the power layer's own key while the plants draw
  // (src/layers/power-3d.ts); this row is the issuer's name.
  eia: nameOnly('eia', 'U.S. Energy Information Administration'),
  epa: nameOnly('epa', 'U.S. Environmental Protection Agency'),
  aafc: {
    ...nameOnly('aafc', 'Agriculture and Agri-Food Canada', 'canada'),
    credits: [OGL_CANADA_AAFC],
    licence: { name: 'Open Government Licence – Canada', url: OGL_CANADA_URL }
  },
  statcan: {
    ...nameOnly('statcan', 'Statistics Canada', 'canada'),
    credits: [
      // ledger: statcan-2021-digital-boundary-files (cite sheet c19)
      {
        text:
          'Nunavut analysis exclusion adapted from Statistics Canada, 2021 Digital Boundary Files. This does not constitute an endorsement by Statistics Canada of this product. Contains information licensed under the Open Government Licence – Canada.',
        html: `Nunavut analysis exclusion adapted from Statistics Canada, 2021 Digital Boundary Files. This does not constitute an endorsement by Statistics Canada of this product. Contains information licensed under the <a href="${OGL_CANADA_URL}">Open Government Licence – Canada</a>.`,
        citeId: 'statcan-2021-digital-boundary-files'
      }
    ],
    licence: { name: 'Open Government Licence – Canada', url: OGL_CANADA_URL }
  },
  'usdm-partners': {
    ...nameOnly('usdm-partners', 'U.S. Drought Monitor', 'partnerships-and-other'),
    credits: [
      // ledger: usdm (cite sheet c24; DR-166 adopts J9 Q10)
      {
        text:
          'The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.',
        citeId: 'usdm'
      }
    ]
  },
  nadm: {
    ...nameOnly('nadm', 'North American Drought Monitor', 'partnerships-and-other'),
    credits: [
      // ledger: nadm-ncei; nadm-eccc; nadm-smn-conagua (cite sheet c25; DR-166 adopts J9 Q11)
      {
        text:
          'North American Drought Monitor (NADM), tri-national consensus. Sources: NOAA/NCEI, National Drought Mitigation Center, U.S. Department of Agriculture, Environment Canada, Agriculture and Agrifood Canada, National Meteorological Service of Mexico, Mexican National Commission of Water.',
        citeId: 'nadm-ncei'
      }
    ]
  },
  'natural-earth': nameOnly('natural-earth', 'Natural Earth', 'partnerships-and-other'),
  osm: {
    ...nameOnly('osm', 'OpenStreetMap contributors', 'partnerships-and-other'),
    credits: [OSM_CREDIT],
    licence: { name: 'Open Database License', url: ODBL_URL }
  },
  overture: {
    ...nameOnly('overture', 'Overture Maps Foundation', 'partnerships-and-other'),
    credits: [
      // ledger: overture-buildings-theme (cite sheet c06; DR-164)
      {
        text:
          'Building footprints (3D Fire, central Oregon pilot): © OpenStreetMap contributors, Overture Maps Foundation. Overture buildings theme, release 2026-07-22.0, available under the Open Database License (ODbL 1.0).',
        html: `Building footprints (3D Fire, central Oregon pilot): © <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap contributors</a>, <a href="https://docs.overturemaps.org/attribution/">Overture Maps Foundation</a>. Overture buildings theme, release 2026-07-22.0, available under the <a href="${ODBL_URL}">Open Database License</a> (ODbL 1.0).`,
        citeId: 'overture-buildings-theme'
      },
      // ledger: overture-buildings-theme (cite sheet c07, the lead-in to c08 to c10)
      { text: "Overture's buildings theme credits these sources:", citeId: 'overture-buildings-theme' },
      // ledger: overture-source-esri-community-maps (cite sheet c08)
      {
        text: 'Esri Community Maps contributors. Available under CC BY 4.0.',
        html: `<a href="https://communitymaps.arcgis.com/home/">Esri Community Maps contributors</a>. Available under <a href="${CC_BY_4_URL}">CC BY 4.0</a>.`,
        citeId: 'overture-source-esri-community-maps'
      },
      // ledger: overture-source-microsoft-ml-buildings (cite sheet c09)
      {
        text: 'Global ML Building Footprints. Licensed by Microsoft under the Open Database License.',
        citeId: 'overture-source-microsoft-ml-buildings'
      },
      // ledger: overture-source-usgs-3dep (cite sheet c10)
      {
        text: 'USGS 3D Elevation Program Digital Elevation Program.',
        html: '<a href="https://www.usgs.gov/3d-elevation-program">USGS 3D Elevation Program Digital Elevation Program</a>.',
        citeId: 'overture-source-usgs-3dep'
      }
    ],
    changes: [
      // ledger: overture-buildings-theme (cite sheet c11)
      {
        text:
          'DDM selected these footprints within a central Oregon bounding box, kept outline, height and floor count only, rounded heights to 0.1 m and cut them into map tiles.',
        citeId: 'overture-buildings-theme'
      }
    ],
    licence: { name: 'Open Database License', url: ODBL_URL }
  },
  'cocorahs-iem': {
    ...nameOnly('cocorahs-iem', 'CoCoRaHS, through the Iowa Environmental Mesonet', 'partnerships-and-other'),
    credits: [
      // ledger: cocorahs-data-usage-policy; iem-disclaimer (cite sheet c27)
      {
        text:
          'Community Collaborative Rain, Hail and Snow Network (CoCoRaHS) station names and locations, Copyright © 1998-2025 Colorado Climate Center, licensed under Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/); terms and disclaimer at https://www.cocorahs.org/content.aspx?page=datausagepolicy. Retrieved through the Iowa Environmental Mesonet, Iowa State University. DDM filters the list to the map view and shows each name and location unchanged.',
        citeId: 'cocorahs-data-usage-policy'
      }
    ]
  },
  deployer: nameOnly('deployer', "This deployment's own data", 'deployer')
};

/** A non-empty list of the rows that credit one source. */
export type CreditRows = readonly [AcknowledgementId, ...AcknowledgementId[]];

/**
 * Every `products.ts` product and the rows that credit it (design section
 * 2.4 as amended by DR-160, DR-163 and DR-166). A record over `ProductKey`,
 * so `tsc` rejects a product with no entry, and a non-empty tuple, so it
 * rejects an entry with no row. 2026-09-30: this map lives here, outside
 * `ProductDef`, because `src/config/products.ts` rides the evidence chunk
 * that the point-heat briefing's first activation loads statically, and
 * these rows pushed that closure over its DR-085 budget (33.9 kB against
 * 33.8 kB); nothing that closure imports statically may import this module.
 */
export const PRODUCT_CREDITS: Readonly<Record<ProductKey, CreditRows>> = {
  hydrography: ['osm'],
  ecoregions: ['epa'],
  hillshade: ['usgs'],
  drought: ['noaa-cpc'],
  'gridded-index': ['noaa-nidis'],
  usdm: ['usdm-partners'],
  'cdm-drought': ['aafc'],
  'nadm-drought': ['nadm', 'aafc'],
  aiannh: ['census'],
  tribal: ['deployer'],
  treaty: ['deployer'],
  'bia-reservations': ['bia'],
  states: ['census'],
  places: ['natural-earth', 'usgs'],
  'power-infrastructure': ['hifld', 'eia'],
  'nifc-fires': ['nifc'],
  'nws-alerts': ['noaa-nws'],
  'hms-smoke': ['noaa-ospo'],
  heatrisk: ['noaa-nws', 'noaa-wpc'],
  'spc-fire-weather': ['noaa-spc'],
  'usfs-whp': ['usfs'],
  'sst-anomaly': ['nasa'],
  telemetry: ['usgs', 'usda-nrcs', 'usbr', 'usace', 'nifc', 'noaa-coops', 'cocorahs-iem', 'noaa-nwrfc'],
  dsci: ['usdm-partners'],
  nwsForecast: ['noaa-nws'],
  cpcExtended: ['noaa-cpc'],
  cpcSeasonal: ['noaa-cpc'],
  cpcSeasonalTemp: ['noaa-cpc'],
  waterSupply: ['noaa-nwrfc'],
  ensoIndex: ['noaa-cpc'],
  ensoAuthority: ['noaa-cpc'],
  ensoTendency: ['noaa-cpc', 'usda-nw-climate-hub'],
  ensoNino34Monthly: ['noaa-cpc'],
  ensoNino34Weekly: ['noaa-cpc'],
  ensoOutlook: ['noaa-cpc']
};

/** Non-catalog sources and the rows that credit them (design section 2.4). */
export const PROVIDERS: Readonly<
  Record<ProviderKey, readonly [AcknowledgementId, ...AcknowledgementId[]]>
> = {
  // The OSM raster ground, drawn by default and under satellite.
  'basemap-ground': ['osm'],
  'satellite-geocolor': ['noaa-nesdis'],
  // The ENSO flow overlay keeps its interim credits in its own key (DR-161,
  // src/layers/enso-flow.ts); DR-115 allows no Open-Meteo or Copernicus row.
  'enso-flow': ['noaa-ncep'],
  structures: ['overture'],
  'terrain-archive': ['usgs'],
  'whp-3d': ['usfs'],
  // public/data/landscape-signature-pnw.json, the briefing's terrain facts.
  'landscape-signature': ['usgs'],
  // The minimap drought metric: CDM input and the Nunavut exclusion mask.
  'minimap-drought-metric': ['aafc', 'statcan']
};
