/**
 * Color palettes for layered features. Each table is a direct port of the
 * vanilla baseline's `app.js` constants, preserving the visual identity of
 * v0.1.x while the rendering layer migrates from Leaflet to MapLibre.
 */

/* ---------------------------------------------------------------------------
 * North American drought minimap
 *
 * The minimap summarizes monthly NADM, so its colors derive from NADM below.
 * They are independent of the weekly USDM table. `none` is deliberately
 * white, per the map convention. Loading and unavailable states are separate
 * UI states and never receive a drought color.
 * ------------------------------------------------------------------------- */

export type DroughtSeverityCode = 'none' | 'D0' | 'D1' | 'D2' | 'D3' | 'D4';


/* ---------------------------------------------------------------------------
 * Wildfire minimap evidence hierarchy
 *
 * These colors encode three different, explicitly labelled conditions. Red
 * requires a positive current mapped NIFC wildfire-perimeter query. Orange and
 * yellow are static 2023 United States Forest Service WHP threshold summaries
 * used only after that current query returns zero. Neutral states never imply
 * that no wildfire exists.
 * ------------------------------------------------------------------------- */

export type MinimapWildfireColorKey =
  | 'mapped-wildfire'
  | 'high-potential'
  | 'moderate-potential'
  | 'below-threshold'
  | 'no-data'
  | 'unavailable';

export const MINIMAP_WILDFIRE_COLORS: Readonly<
  Record<MinimapWildfireColorKey, string>
> = {
  // DR-138 R5: borrow the NIFC mark and issuer WHP High/Moderate colors.
  'mapped-wildfire': '#ff4c00',
  'high-potential': '#ffa300',
  'moderate-potential': '#ffff63',
  'below-threshold': '#E2E8F0',
  'no-data': '#334155',
  'unavailable': '#1E293B'
};

/* ---------------------------------------------------------------------------
 * Ecoregions (EPA Level III)
 *
 * Names match the `US_L3NAME` field. The palette is designed to evoke
 * biome character: greens for forested marine regions, golds and tans for
 * arid plateau, browns for transitional foothills.
 * ------------------------------------------------------------------------- */

export const ECOREGION_COLORS: Readonly<Record<string, string>> = {
  'Cascades': '#2e7d32',
  'North Cascades': '#1b5e20',
  'Coast Range': '#4f7942',
  'Puget Lowland': '#00838f',
  'Willamette Valley': '#9ccc65',
  'Eastern Cascades Slopes and Foothills': '#8d6e63',
  'Columbia Plateau': '#d4b896',
  'Blue Mountains': '#6d4c41',
  'Northern Rockies': '#33691e',
  'Northern Basin and Range': '#e6b566',
  'Snake River Plain': '#daa55b',
  'Klamath Mountains': '#00695c',
  'Idaho Batholith': '#5d4037',
  'Middle Rockies': '#388e3c',
  'Canadian Rockies': '#2e7d32',
  'Sierra Nevada': '#4caf50'
};

export const ECOREGION_DEFAULT_COLOR = '#5a6b7d';

/* ---------------------------------------------------------------------------
 * NOAA CPC Seasonal Drought Outlook category palette
 *
 * NOAA cpc_drought_outlk MapServer layers 1 and 4 publish these class colors.
 * The vector adapter keys the outlook attribute; this table drives hatch ink,
 * outlines and swatches. DDM display opacity is a separate transform.
 * D3 M0 receipt: cpc-seasonal-drought-outlook, clause_verdicts_2026_10_07.
 * ------------------------------------------------------------------------- */

export const DROUGHT_COLORS: Readonly<Record<string, string>> = {
  PERSISTS: '#9B634A',
  DEVELOPS: '#FFDE63',
  IMPROVES: '#DED4BC',
  REMOVAL: '#B2AD69'
};

/* ---------------------------------------------------------------------------
 * National Weather Service (NWS) HeatRisk categories
 *
 * The NWS ImageServer publishes these issuer-owned class colors and meanings.
 * Source: https://mapservices.weather.noaa.gov/experimental/rest/services/
 * NWS_HeatRisk/ImageServer/legend and /info/iteminfo (verified 2026-07-28).
 * The raster remains colorized by the issuer. This table is the one mirror
 * used by every DDM surface that names a HeatRisk class.
 * ------------------------------------------------------------------------- */

export type HeatRiskValue = 0 | 1 | 2 | 3 | 4;

export interface HeatRiskCategory {
  readonly value: HeatRiskValue;
  readonly label: string;
  readonly color: string;
  readonly meaning: string;
}

export const HEATRISK_CATEGORIES: readonly HeatRiskCategory[] = [
  {
    value: 0,
    label: 'Little to no risk',
    color: '#E8F9E7',
    meaning: 'Little to no risk from expected heat.'
  },
  {
    value: 1,
    label: 'Minor',
    color: '#F4F257',
    meaning:
      'This level of heat affects primarily those individuals extremely sensitive to heat, especially when outdoors without effective cooling and/or adequate hydration.'
  },
  {
    value: 2,
    label: 'Moderate',
    color: '#F69632',
    meaning:
      'This level of heat affects most individuals sensitive to heat, especially those without effective cooling and/or adequate hydration. Impacts possible in some health systems and in heat-sensitive industries.'
  },
  {
    value: 3,
    label: 'Major',
    color: '#E22F33',
    meaning:
      'This level of heat affects anyone without effective cooling and/or adequate hydration. Impacts likely in some health systems, heat-sensitive industries and infrastructure.'
  },
  {
    value: 4,
    label: 'Extreme',
    color: '#7A0E7F',
    meaning:
      'This level of rare and/or long-duration extreme heat with little to no overnight relief affects anyone without effective cooling and/or adequate hydration. Impacts likely in most health systems, heat-sensitive industries and infrastructure.'
  }
];

/* ---------------------------------------------------------------------------
 * US Drought Monitor (USDM) category palette
 *
 * Indexed by the integer `DM` attribute the National Drought Mitigation
 * Center publishes (0 = D0 Abnormally Dry through 4 = D4 Exceptional Drought).
 * These are the official USDM display colors. One table drives the map fill
 * (src/layers/usdm.ts), the unified legend, and the conditions strip, so the
 * color and label for a category live in exactly one place. The `label` is
 * sentence case for inline reading ("Extreme drought in view"); popups that
 * want the full "D3 - Extreme Drought" form compose `code` and `label`.
 * ------------------------------------------------------------------------- */

export interface UsdmCategory {
  /** Short code shown as the headline value: D0 through D4. */
  readonly code: string;
  /** Human-readable category name, sentence case. */
  readonly label: string;
  /** Official USDM display color. */
  readonly color: string;
  /**
   * Plain-language read of what the category means on the ground, water and
   * agriculture and fire foregrounded. Adapted from the USDM's own published
   * "Possible Impacts" so a non-specialist learns what "D2" means without a
   * glossary (personas: decision-makers, community members). Calm and factual,
   * never alarm language, honest about severity (UX heuristic: agency over
   * alarm).
   */
  readonly impact: string;
}

export const USDM_CATEGORIES: ReadonlyArray<UsdmCategory> = [
  {
    code: 'D0',
    label: 'Abnormally dry',
    color: '#FFFF00',
    impact:
      'Short-term dryness slows planting and crop growth, or lingering deficits remain while coming out of drought. Fire risk begins to rise.'
  },
  {
    code: 'D1',
    label: 'Moderate drought',
    color: '#FCD37F',
    impact:
      'Some damage to crops and pastures; streams, reservoirs, or wells run low. Voluntary water conservation is often requested and fire risk is elevated.'
  },
  {
    code: 'D2',
    label: 'Severe drought',
    color: '#FFAA00',
    impact:
      'Crop or pasture losses are likely and water shortages are common; water-use restrictions may be imposed. Fire risk is high.'
  },
  {
    code: 'D3',
    label: 'Extreme drought',
    color: '#E60000',
    impact:
      'Major crop and pasture losses occur, with widespread water shortages or restrictions. Large fires become more likely.'
  },
  {
    code: 'D4',
    label: 'Exceptional drought',
    color: '#730000',
    impact:
      'Exceptional and widespread crop and pasture losses, with water emergencies from depleted reservoirs, streams, and wells. Fire danger is extreme.'
  }
];

/**
 * The no-polygon swatch. USDM publishes D0 through D4 polygons but does not
 * provide an analyzed-area mask in this client, so bare ground cannot be
 * promoted to a confident "no drought" reading. This entry names what the
 * renderer can prove: no D0-D4 category is drawn. Kept OUTSIDE
 * `USDM_CATEGORIES`: consumers index that array by drought level
 * (`USDM_CATEGORIES[dm]`), so a sixth element would shift the D0-D4 mapping.
 * The dark slate approximates the shared ground scene, not a data value; it
 * never paints a map fill.
 */
export const USDM_NONE_SWATCH: Readonly<{ code: string; label: string; color: string }> = {
  code: 'No polygon',
  label: 'No D0-D4 category drawn',
  color: '#253247'
};

/**
 * CDM source colors, independently owned from USDM/NADM.
 * AAFC ImageServer legend PNG interiors verified 2026-10-07 (D3 S3/M11).
 * Receipt: aafc-canadian-drought-monitor, clause_verdicts_2026_10_07.
 * https://agriculture.canada.ca/imagery-images/rest/services/canadian_drought_monitor/ImageServer/legend?f=pjson
 */
export const CDM_CATEGORIES = [
  { code: 'D0', color: '#FFFF00' },
  { code: 'D1', color: '#FFD37F' },
  { code: 'D2', color: '#E69800' },
  { code: 'D3', color: '#E60000' },
  { code: 'D4', color: '#730000' }
] as const;

/* ---------------------------------------------------------------------------
 * North American Drought Monitor (NADM) monthly consensus categories
 *
 * Kept separate from the weekly USDM palette; issuer D1 colors differ.
 * NADM is a tri-national monthly consensus product,
 * not a USDM extension or a field to blend with USDM, CDM, or BC basin levels.
 * ------------------------------------------------------------------------- */
// D3 S2: NOAA NADM hub's NADM_Current/FeatureServer/0 renderer, 2026-10-07.
// Exact RGBA receipt: private references ledger nadm-ncei, palette_review_2026_10_07.
export const NADM_CATEGORIES: ReadonlyArray<{
  readonly code: string;
  readonly label: string;
  readonly color: string;
}> = [
  { code: 'D0', label: 'Abnormally dry', color: '#FFFF00' },
  { code: 'D1', label: 'Moderate drought', color: '#FCD27E' },
  { code: 'D2', label: 'Severe drought', color: '#FFAA00' },
  { code: 'D3', label: 'Extreme drought', color: '#E60000' },
  { code: 'D4', label: 'Exceptional drought', color: '#730000' }
];

export const MINIMAP_DROUGHT_COLORS: Readonly<Record<DroughtSeverityCode, string>> = {
  none: '#FFFFFF',
  D0: NADM_CATEGORIES[0]!.color,
  D1: NADM_CATEGORIES[1]!.color,
  D2: NADM_CATEGORIES[2]!.color,
  D3: NADM_CATEGORIES[3]!.color,
  D4: NADM_CATEGORIES[4]!.color
};

/* ---------------------------------------------------------------------------
 * Province of British Columbia basin drought levels
 *
 * This is a separate scale from USDM. Levels are named numerically because
 * the FeatureServer publishes the number, not a USDM-equivalent category.
 * Value 99 is an explicit No update state and sits outside the severity ramp.
 * ------------------------------------------------------------------------- */

export interface BcDroughtLevel {
  readonly value: number;
  readonly code: string;
  readonly label: string;
  readonly color: string;
}

// D3 S4: BC portal webmap 02472f91813a4dac8fabf24f92a23c93 renderer, 2026-10-07.
// Exact RGBA receipt: private references ledger bc-drought-levels. DR-160 hold unchanged.
export const BC_DROUGHT_LEVELS: readonly BcDroughtLevel[] = [
  { value: 0, code: '0', label: 'Level 0', color: '#FFFFFF' },
  { value: 1, code: '1', label: 'Level 1', color: '#EBD1B8' },
  { value: 2, code: '2', label: 'Level 2', color: '#C2A57A' },
  { value: 3, code: '3', label: 'Level 3', color: '#8C683A' },
  { value: 4, code: '4', label: 'Level 4', color: '#5B3E22' },
  { value: 5, code: '5', label: 'Level 5', color: '#261A0F' }
];

export const BC_DROUGHT_NO_UPDATE: BcDroughtLevel = {
  value: 99,
  code: 'No update',
  label: 'Not measured right now',
  // Issuer alpha 191/255 is source data, separate from adapter display opacity.
  color: 'rgba(204, 204, 204, 0.7490196078431373)'
};

/* ---------------------------------------------------------------------------
 * Treaty area styling
 *
 * The `match` field is a substring tested against the GeoJSON feature name
 * by `pickTreatyEntry` / `pickTreatyColor`. The `tribe` field carries the
 * full formal Tribe name where the Treaty key uniquely names a Tribe
 * (Yakama, Nez Perce, Quinault). For Treaty-location keys (Medicine Creek,
 * Point Elliott, Point No Point, Walla Walla) the Treaty was signed by
 * multiple Tribes, so `tribe` is null and the popup falls back to whatever
 * value the source GeoJSON carries on the feature.
 *
 * Pacific Northwest (PNW) historical Treaties of 1854 and 1855.
 * ------------------------------------------------------------------------- */

export interface TreatyEntry {
  readonly match: string;
  readonly tribe: string | null;
  readonly color: string;
}

// Colors are the magenta-to-violet band of the Tribal-context boundary family
// (D-0.7.0-019; see the family note below). Each Treaty keeps a distinct hue so
// adjacent areas stay tellable apart, but every hue now sits inside the one
// family instead of the prior red/amber/teal/blue spread. Since E2
// (D-0.7.0-058 ruling 4) this table styles the BUNDLED deployer Treaty slot
// (treaty.ts) and names formal Tribes for popups.
export const TREATY_COLORS: ReadonlyArray<TreatyEntry> = [
  { match: 'Medicine Creek', tribe: null,                                                  color: '#ec4899' },
  { match: 'Yakama',         tribe: 'Confederated Tribes and Bands of the Yakama Nation',  color: '#c026d3' },
  { match: 'Nez Perce',      tribe: 'Nez Perce Tribe',                                     color: '#9333ea' },
  { match: 'Point Elliott',  tribe: null,                                                  color: '#d946ef' },
  { match: 'Point No Point', tribe: null,                                                  color: '#a855f7' },
  { match: 'Quinault',       tribe: 'Quinault Indian Nation',                              color: '#8b5cf6' },
  { match: 'Walla Walla',    tribe: null,                                                  color: '#7c3aed' }
];

export const TREATY_COLOR_DEFAULT = '#c026d3';

/**
 * Find the TREATY_COLORS entry whose `match` is a substring of the feature
 * name. Returns `null` if none match (the caller falls back to defaults).
 */
export function pickTreatyEntry(name: string | null | undefined): TreatyEntry | null {
  if (!name) return null;
  const haystack = String(name);
  for (const entry of TREATY_COLORS) {
    if (haystack.includes(entry.match)) return entry;
  }
  return null;
}

export function pickTreatyColor(name: string | null | undefined): string {
  const entry = pickTreatyEntry(name);
  return entry ? entry.color : TREATY_COLOR_DEFAULT;
}

/* ---------------------------------------------------------------------------
 * The Tribal-context boundary family (magenta to violet; D-0.7.0-019)
 *
 * Three layers carry Tribal and Treaty place context: Tribal Lands (bundled,
 * deployer-populated, empty by default), Treaty Areas (hollow cession-area
 * outlines, colored by TREATY_COLORS above), and Bureau of Indian Affairs (BIA)
 * reservation boundaries (American Indian and Alaska Native Land Area
 * Representation, AIAN-LAR, fetched live per the no-redistribution hard rule:
 * live consumption, not redistribution). D-0.7.0-019 groups all three into ONE
 * magenta-to-violet tone family so a reader sees them as related "whose place is
 * this" layers, distinguished by opacity and line style rather than three
 * unrelated hues (the prior warm-orange Tribal Lands, seven-hue Treaty spread,
 * and indigo reservations). The visible reservation surface of record is the
 * LIVE BIA layer; the bundled Tribal Lands placeholder ships empty (the
 * empty-placeholder stewardship rule), so on the reference deployment the BIA
 * magenta is what a reader actually sees.
 *
 * Opacity hierarchy (ddm-visual-styling-and-readability, the 0.3 to 0.6 fill
 * band): Tribal Lands (deployer-authorized, so fillable) sits highest; BIA
 * reservations fill lower, as a representation and not a jurisdictional claim.
 * These are starting values, best refined in the browser (that skill owns the
 * tuning).
 *
 * E2 (D-0.7.0-058 ruling 3): the maintainer pinned the ONE Tribal boundary
 * color family to #8d006b on rendered v0.6.15 evidence. Every fill and
 * outline in the family derives from that hex; the distinction channels
 * remain outline WEIGHT and fill STRENGTH (D-0.7.0-043 part 4), never a
 * second hue. The per-layer opacity and width constants live in the layer
 * modules (aiannh.ts, bia-reservations.ts, tribal.ts).
 * ------------------------------------------------------------------------- */

/** The one ruled Tribal boundary family hex (D-0.7.0-058 ruling 3). */
export const TRIBAL_FAMILY_COLOR = '#8d006b';

/** Tribal Lands (bundled, deployer-populated). The family hex; the deployer
 * slot fills strongest (deployer-authorized data), per the hierarchy note. */
export const TRIBAL_FILL_COLOR = TRIBAL_FAMILY_COLOR;
export const TRIBAL_OUTLINE_COLOR = TRIBAL_FAMILY_COLOR;

/**
 * BIA reservation boundaries (AIAN-LAR, live). Since E1 (D-0.7.0-043
 * part 4, staged by D-0.7.0-041 part 2) the pair sits at the SAME pole of
 * the family as the AIANNH Tribal Lands layer: one Tribal color family,
 * never two competing hues; E2 (D-0.7.0-058 ruling 3) pins that pole to
 * #8d006b. The two representations stay distinguishable through a
 * NON-COLOR channel: bia-reservations.ts carries the stronger fill and the
 * heavier outline, aiannh.ts the lighter wash and the finer outline, and
 * the popup and pill wording name each agency source.
 */
export const RESERVATION_FILL_COLOR = TRIBAL_FAMILY_COLOR;
export const RESERVATION_OUTLINE_COLOR = TRIBAL_FAMILY_COLOR;

/**
 * US Census AIANNH Tribal Lands (live). The same ruled family hex as the
 * BIA reservation pair (see the note above): the deliberate AIANNH +
 * AIAN-LAR double-draw (D-0.7.0-033) reads as two agencies'
 * representations through weight and strength, never through two unrelated
 * hues and never as one blended dataset. The fill sits BELOW the BIA
 * reservation fill in the opacity hierarchy (see the header note): AIANNH
 * covers broad statistical geographies (Oklahoma Tribal Statistical Areas
 * span most of the state), so it renders as a light wash the stronger
 * reservation pair stays legible over.
 */
export const AIANNH_FILL_COLOR = TRIBAL_FAMILY_COLOR;
export const AIANNH_OUTLINE_COLOR = TRIBAL_FAMILY_COLOR;

/* ---------------------------------------------------------------------------
 * United States state boundaries (Census cartographic boundary file)
 *
 * A neutral slate administrative line, deliberately quieter than every
 * thematic layer: the state layer exists as a selectable reference frame for
 * the impact briefing and resource routing, not as a subject of the map. The
 * fill is a fully transparent hit area (MapLibre still hit-tests a fill layer
 * at opacity zero) so a click anywhere inside a state can open the briefing.
 * ------------------------------------------------------------------------- */

export { STATE_OUTLINE_COLOR } from './interface-tokens';

/* ---------------------------------------------------------------------------
 * Municipal place labels (U4e; Natural Earth bundled points)
 *
 * Dark slate text with a light halo: the one combination the corpus's
 * both-basemaps rule accepts unchanged over the desaturated OSM default AND
 * over satellite imagery (the halo carries the contrast, not the text
 * color). These are the map-side tokens for label chrome; on-map paint
 * cannot read CSS custom properties; interface-tokens owns these mirrors.
 * ------------------------------------------------------------------------- */

export { PLACE_LABEL_COLOR, PLACE_LABEL_HALO } from './interface-tokens';

/* ---------------------------------------------------------------------------
 * Hillshade underlay (U4g)
 *
 * SUBTLE by contract (the cartography lens): terrain legibility under the
 * thematic surfaces, never a competing statement. Slate-family shadow and a
 * barely-off-white highlight keep the shading neutral against both the
 * desaturated OSM default and satellite; the low exaggeration constant is
 * the "subtle" knob and lives here so a design pass tunes one number.
 * ------------------------------------------------------------------------- */

export { HILLSHADE_SHADOW, HILLSHADE_HIGHLIGHT } from './interface-tokens';
export const HILLSHADE_EXAGGERATION = 0.22;

/* ---------------------------------------------------------------------------
 * NWS heat and fire-weather alert polygons
 *
 * Colors follow the National Weather Service watch/warning/advisory display
 * standard (the weather.gov map colors users already know), so the module
 * never invents its own severity language. The NWS Hazard Simplification
 * project renamed Excessive Heat Warning to Extreme Heat Warning in 2025;
 * both names are carried so archived or transitional products still color
 * correctly.
 * ------------------------------------------------------------------------- */

export const NWS_ALERT_COLORS: Readonly<Record<string, string>> = {
  'Extreme Heat Warning': '#c71585', // vocab-allow: verbatim NWS product names, quoted source data
  'Excessive Heat Warning': '#c71585', // vocab-allow: verbatim NWS product names, quoted source data
  'Extreme Heat Watch': '#800000',
  'Excessive Heat Watch': '#800000',
  'Heat Advisory': '#ff7f50',
  'Red Flag Warning': '#ff1493', // vocab-allow: verbatim NWS product names, quoted source data
  'Fire Weather Watch': '#ffdead'
};

export const NWS_ALERT_DEFAULT_COLOR = '#9ca3af';

/* ---------------------------------------------------------------------------
 * SPC Fire Weather Outlook categories
 *
 * Keyed by the MapServer's integer `dn` (Data Number) field. Colors follow
 * NOAA SPC_firewx MapServer layers 1 and 4 publish these exact RGBA colors.
 * D3 M0 receipt: spc-fire-weather-days-1-8, clause_verdicts_2026_10_07.
 * Display opacity remains separate from the issuer's opaque class colors.
 * ------------------------------------------------------------------------- */

export const SPC_FIREWX_CATEGORIES: ReadonlyArray<{
  readonly dn: number;
  readonly label: string;
  readonly color: string;
}> = [
  { dn: 5, label: 'Elevated', color: '#e69800' },
  { dn: 8, label: 'Critical', color: '#FF0000' },
  // DDM-P7-T03 (science verdict, 2026-09-09): the MapServer renderer's own
  // word here is "Extreme", but SPC's public product word (about.html) is
  // "Extremely Critical"; the label is corrected to the issuer's word so the
  // map legend and the briefing agree (director grant, brief section 2).
  { dn: 10, label: 'Extremely Critical', color: '#E600A9' }
];

export const SPC_FIREWX_DEFAULT_COLOR = '#9ca3af';

/**
 * NASA GIBS GHRSST MUR SST anomaly, full v1.3 colormap.
 * Receipt: nasa-gibs-acknowledgement.palette_review_2026_10_07.
 * https://gibs.earthdata.nasa.gov/colormaps/v1.3/GHRSST_Sea_Surface_Temperature_Anomalies.xml
 * Intervals are source metadata in degrees C; no climatology baseline is inferred.
 * Ref 0 is transparent no-data, not a zero/near-usual class.
 */
export const SST_ANOMALY_SCALE: ReadonlyArray<{
  readonly ref: number;
  readonly interval: string | null;
  readonly color: string;
  readonly transparent: boolean;
}> = [
  { ref: 0, interval: null, color: '#000000', transparent: true },
  { ref: 1, interval: '[-INF,-3.0)', color: '#6b00db', transparent: false },
  { ref: 2, interval: '[-3.0,-2.9)', color: '#7400d6', transparent: false },
  { ref: 3, interval: '[-2.9,-2.8)', color: '#7f00d3', transparent: false },
  { ref: 4, interval: '[-2.8,-2.7)', color: '#8900cf', transparent: false },
  { ref: 5, interval: '[-2.7,-2.6)', color: '#9600ca', transparent: false },
  { ref: 6, interval: '[-2.6,-2.5)', color: '#9109cc', transparent: false },
  { ref: 7, interval: '[-2.5,-2.4)', color: '#7f1ad1', transparent: false },
  { ref: 8, interval: '[-2.4,-2.3)', color: '#6031dc', transparent: false },
  { ref: 9, interval: '[-2.3,-2.2)', color: '#414be6', transparent: false },
  { ref: 10, interval: '[-2.2,-2.1)', color: '#2264f1', transparent: false },
  { ref: 11, interval: '[-2.1,-2.0)', color: '#087cfb', transparent: false },
  { ref: 12, interval: '[-2.0,-1.9)', color: '#0094ff', transparent: false },
  { ref: 13, interval: '[-1.9,-1.8)', color: '#00aeff', transparent: false },
  { ref: 14, interval: '[-1.8,-1.7)', color: '#00caff', transparent: false },
  { ref: 15, interval: '[-1.7,-1.6)', color: '#00e3ff', transparent: false },
  { ref: 16, interval: '[-1.6,-1.5)', color: '#03f8fa', transparent: false },
  { ref: 17, interval: '[-1.5,-1.4)', color: '#18fce5', transparent: false },
  { ref: 18, interval: '[-1.4,-1.3)', color: '#2fffce', transparent: false },
  { ref: 19, interval: '[-1.3,-1.2)', color: '#47ffb6', transparent: false },
  { ref: 20, interval: '[-1.2,-1.1)', color: '#60ff9e', transparent: false },
  { ref: 21, interval: '[-1.1,-1.0)', color: '#76ff8c', transparent: false },
  { ref: 22, interval: '[-1.0,-0.9)', color: '#88ff84', transparent: false },
  { ref: 23, interval: '[-0.9,-0.8)', color: '#97ff8b', transparent: false },
  { ref: 24, interval: '[-0.8,-0.7)', color: '#a4ff91', transparent: false },
  { ref: 25, interval: '[-0.7,-0.6)', color: '#b1ff98', transparent: false },
  { ref: 26, interval: '[-0.6,-0.5)', color: '#bdfe9e', transparent: false },
  { ref: 27, interval: '[-0.5,-0.4)', color: '#bff4a3', transparent: false },
  { ref: 28, interval: '[-0.4,-0.3)', color: '#bfe8a9', transparent: false },
  { ref: 29, interval: '[-0.3,-0.2)', color: '#bfdbb0', transparent: false },
  { ref: 30, interval: '[-0.2,-0.1)', color: '#bfd0b6', transparent: false },
  { ref: 31, interval: '[-0.1,0.0)', color: '#c2cab8', transparent: false },
  { ref: 32, interval: '[0.0,0.1)', color: '#cacab7', transparent: false },
  { ref: 33, interval: '[0.1,0.2)', color: '#d5d5ac', transparent: false },
  { ref: 34, interval: '[0.2,0.3)', color: '#e2e2a2', transparent: false },
  { ref: 35, interval: '[0.3,0.4)', color: '#eded98', transparent: false },
  { ref: 36, interval: '[0.4,0.5)', color: '#f9f88d', transparent: false },
  { ref: 37, interval: '[0.5,0.6)', color: '#fff679', transparent: false },
  { ref: 38, interval: '[0.6,0.7)', color: '#ffea5e', transparent: false },
  { ref: 39, interval: '[0.7,0.8)', color: '#ffde43', transparent: false },
  { ref: 40, interval: '[0.8,0.9)', color: '#ffd025', transparent: false },
  { ref: 41, interval: '[0.9,1.0)', color: '#ffc209', transparent: false },
  { ref: 42, interval: '[1.0,1.1)', color: '#ffb601', transparent: false },
  { ref: 43, interval: '[1.1,1.2)', color: '#ffaa00', transparent: false },
  { ref: 44, interval: '[1.2,1.3)', color: '#ff9d00', transparent: false },
  { ref: 45, interval: '[1.3,1.4)', color: '#ff9100', transparent: false },
  { ref: 46, interval: '[1.4,1.5)', color: '#ff8200', transparent: false },
  { ref: 47, interval: '[1.5,1.6)', color: '#ff7100', transparent: false },
  { ref: 48, interval: '[1.6,1.7)', color: '#ff5900', transparent: false },
  { ref: 49, interval: '[1.7,1.8)', color: '#ff3d00', transparent: false },
  { ref: 50, interval: '[1.8,1.9)', color: '#ff2100', transparent: false },
  { ref: 51, interval: '[1.9,2.0)', color: '#fe0900', transparent: false },
  { ref: 52, interval: '[2.0,2.1)', color: '#f90113', transparent: false },
  { ref: 53, interval: '[2.1,2.2)', color: '#f3002d', transparent: false },
  { ref: 54, interval: '[2.2,2.3)', color: '#ec004a', transparent: false },
  { ref: 55, interval: '[2.3,2.4)', color: '#e60067', transparent: false },
  { ref: 56, interval: '[2.4,2.5)', color: '#de007d', transparent: false },
  { ref: 57, interval: '[2.5,2.6)', color: '#d30085', transparent: false },
  { ref: 58, interval: '[2.6,2.7)', color: '#bf0068', transparent: false },
  { ref: 59, interval: '[2.7,2.8)', color: '#ab0048', transparent: false },
  { ref: 60, interval: '[2.8,2.9)', color: '#9a002c', transparent: false },
  { ref: 61, interval: '[2.9,3.0)', color: '#88000f', transparent: false },
  { ref: 62, interval: '[3.0,+INF)', color: '#800000', transparent: false }
];

/** Existing qualitative orientation words, not issuer-defined numeric bins. */
export const SST_ANOMALY_LABELS = [
  'Warmer than usual', 'Near usual', 'Cooler than usual'
] as const;

/** R8: NDMC USDM signed change classes, exact issuer metadata colors.
 * Receipt: usdm-change-maps-drought-gov, clause_verdicts_2026_10_07.
 * Transparent unmatched values are a DDM absence treatment, not an issuer class.
 */
export const USDM_CHANGE_COLORS = [
  { dn: -5, color: '#003D75' },
  { dn: -4, color: '#016678' },
  { dn: -3, color: '#359766' },
  { dn: -2, color: '#8AD48C' },
  { dn: -1, color: '#CCFFD4' },
  { dn: 0, color: '#CCCCCC' },
  { dn: 1, color: '#FFFF73' },
  { dn: 2, color: '#FFD438' },
  { dn: 3, color: '#FF9900' },
  { dn: 4, color: '#A87000' },
  { dn: 5, color: '#543005' },
] as const;

export const SST_ANOMALY_LEGEND_TITLE = 'Ocean temperature anomaly';

/** D3 M11, S13: product-specific CPC reference-guide colors.
 * ONI: cpc-oni-data-file.palette_review_2026_10_07 (historical v5 HTML).
 * RONI: cpc-roni-product-page.guide_colors_2026_10_07 (operational CSS).
 * These guides do not classify episodes or recolor measured series/plumes.
 */
export const ENSO_INDEX_GUIDE_COLORS = {
  ONI: { warm: '#ff0000', cold: '#0000ff' },
  RONI: { warm: '#e80016', cold: '#195fe4' }
} as const;

/** D3 M2, S13: current DDM probability-plume colors frozen before chrome migration.
 * CPC issuer-color receipts remain pending. These are not newly verified CPC
 * display standards; a later correction must cite that receipt.
 */
export const ENSO_PHASE_COLORS = {
  elNino: '#f59e0b',
  neutral: '#94a3b8',
  laNina: '#06b6d4'
} as const;

/** CPC 6-10 and 8-14 day unique-value renderers, exact cat,prob pairs.
 * D3 M0/S14 receipt: cpc-extended-range-outlook, renderer_review_2026_10_07.
 * The prob field has no declared domain; these are renderer matches, not
 * forecast probability bounds or intervals. Unmatched input has no issuer hue.
 */
export const CPC_OUTLOOK_TERCILE_COLORS = {
  temperature: {
    'Above,33': '#E7B168',
    'Above,40': '#E38B4B',
    'Above,50': '#DA5731',
    'Above,60': '#C93B1A',
    'Above,70': '#B32E05',
    'Above,80': '#912600',
    'Above,90': '#702100',
    'Normal,36': '#A0A0A0',
    'Below,33': '#BFCBE4',
    'Below,40': '#A0C0DF',
    'Below,50': '#77B5E2',
    'Below,60': '#389FDC',
    'Below,70': '#005DA1',
    'Below,80': '#2E216F',
    'Below,90': '#221852'
  },
  precipitation: {
    'Above,33': '#B3D9AB',
    'Above,40': '#95CE7F',
    'Above,50': '#48B430',
    'Above,60': '#009620',
    'Above,70': '#007814',
    'Above,80': '#28600A',
    'Above,90': '#285300',
    'Normal,36': '#A0A0A0',
    'Below,33': '#F0D493',
    'Below,40': '#D8A74F',
    'Below,50': '#BB6D33',
    'Below,60': '#9B5031',
    'Below,70': '#934639',
    'Below,80': '#804000',
    'Below,90': '#4F2F2F'
  }
} as const;

/** DDM observation/index marks, frozen independently of interface ink. */
/** D3 M7 / M-027: neutral OKLab steps for D8 classes 1, 2 and 3.
 * Class 1: TIGER S1100; class 2: qualifying S1200; class 3: remaining S1200.
 * NRN classification and ferry connectors remain D8's responsibility.
 * Retokened at t=.30/.15/0 to meet the two NIFC-neutral separation floors.
 * These are DDM display tokens, not an issuer road-safety classification.
 */
export const ROAD_CLASS_COLORS = {
  1: '#898A8B',
  2: '#767677',
  3: '#636363'
} as const;
export const ROAD_CASING = '#010B13';
export const ROAD_HALO = { color: '#E8ECF0', opacity: 0.6 } as const;
export const ROAD_NOT_ASSESSED_KNOCKOUT = { color: '#010B13', opacity: 0.9 } as const;

/** S15: adopted conditional fallback, not a verified FHWA digital color.
 * Proposed #FED141 failed the digital comparison. Exact issuer web hex and
 * physical CFR compliance remain unverified; see M-027.
 * Caution/source separation remains unresolved for USDM change +2 #FFD438.
 */
export const CAUTION_LINE_COLORS = { yellow: '#FFD100', black: '#000000' } as const;

export const OBSERVATION_SERIES_COLOR = '#06b6d4';
export const INDEX_SERIES_COLORS = { primary: '#f1f5f9', comparison: '#94a3b8' } as const;

/**
 * S12: decoded ACIS Grid 1 SPI legend.png class interiors, all five offered
 * windows, 2026-10-07. Receipt: nidis-gridded-drought-indices,
 * scale_review_2026_10_07. These are legend pixels, not numeric bin metadata.
 * The white slot is unlabeled by the issuer; null does not assert zero/no-data.
 */
export const GRIDDED_INDEX_RAMP = [
  { code: 'D4', color: '#730000' },
  { code: 'D3', color: '#E60000' },
  { code: 'D2', color: '#FFAA00' },
  { code: 'D1', color: '#FCD37F' },
  { code: 'D0', color: '#FFFF00' },
  { code: null, color: '#FFFFFF' },
  { code: 'W0', color: '#AAFF55' },
  { code: 'W1', color: '#01FFFF' },
  { code: 'W2', color: '#00AAFF' },
  { code: 'W3', color: '#0000FF' },
  { code: 'W4', color: '#0000AA' }
] as const;

/** CPC seasonal Lead 1 uniqueValue renderer, cat+prob, 2026-10-07 metadata.
 * Precip SHA256 547953231f105348e8e6eadfec9aec7f2c248f0c2339a865d8266af8b7c20553.
 * Temp SHA256 52695582302e38969e0e8e2d0c80952066714df8a421490dc7562c9c65b46da5.
 * Source RGBA, including distinct transparent EC RGB, not a DDM class transform.
 */
export const CPC_SEASONAL_COLORS = {
  precipitation: [
    { cat: 'Above', prob: 90, label: 'Above, 90%', color: [40, 83, 0, 255] },
    { cat: 'Above', prob: 80, label: 'Above, 80%', color: [40, 96, 10, 255] },
    { cat: 'Above', prob: 70, label: 'Above, 70%', color: [0, 120, 20, 255] },
    { cat: 'Above', prob: 60, label: 'Above, 60%', color: [0, 150, 32, 255] },
    { cat: 'Above', prob: 50, label: 'Above, 50%', color: [72, 180, 48, 255] },
    { cat: 'Above', prob: 40, label: 'Above, 40%', color: [149, 206, 127, 255] },
    { cat: 'Above', prob: 33, label: 'Above, 33%', color: [179, 217, 171, 255] },
    { cat: 'Normal', prob: 33, label: 'Near Normal, 33%', color: [215, 217, 217, 255] },
    { cat: 'Normal', prob: 40, label: 'Near Normal, 40%', color: [160, 160, 160, 255] },
    { cat: 'Below', prob: 33, label: 'Below, 33%', color: [240, 212, 147, 255] },
    { cat: 'Below', prob: 40, label: 'Below, 40%', color: [216, 167, 79, 255] },
    { cat: 'Below', prob: 50, label: 'Below, 50%', color: [187, 109, 51, 255] },
    { cat: 'Below', prob: 60, label: 'Below, 60%', color: [155, 80, 49, 255] },
    { cat: 'Below', prob: 70, label: 'Below, 70%', color: [147, 70, 57, 255] },
    { cat: 'Below', prob: 80, label: 'Below, 80%', color: [128, 64, 0, 255] },
    { cat: 'Below', prob: 90, label: 'Below, 90%', color: [79, 47, 47, 255] },
    { cat: 'EC', prob: 33, label: 'Equal Chances', color: [0, 0, 0, 0] }
  ],
  temperature: [
    { cat: 'Above', prob: 90, label: 'Above, 90%', color: [112, 33, 0, 255] },
    { cat: 'Above', prob: 80, label: 'Above, 80%', color: [145, 38, 0, 255] },
    { cat: 'Above', prob: 70, label: 'Above, 70%', color: [179, 46, 5, 255] },
    { cat: 'Above', prob: 60, label: 'Above, 60%', color: [201, 59, 26, 255] },
    { cat: 'Above', prob: 50, label: 'Above, 50%', color: [218, 87, 49, 255] },
    { cat: 'Above', prob: 40, label: 'Above, 40%', color: [227, 139, 75, 255] },
    { cat: 'Above', prob: 33, label: 'Above, 33%', color: [231, 177, 104, 255] },
    { cat: 'Normal', prob: 33, label: 'Near Normal, 33%', color: [215, 217, 217, 255] },
    { cat: 'Normal', prob: 40, label: 'Near Normal, 40%', color: [160, 160, 160, 255] },
    { cat: 'Below', prob: 33, label: 'Below, 33%', color: [191, 203, 228, 255] },
    { cat: 'Below', prob: 40, label: 'Below, 40%', color: [160, 192, 223, 255] },
    { cat: 'Below', prob: 50, label: 'Below, 50%', color: [119, 181, 226, 255] },
    { cat: 'Below', prob: 60, label: 'Below, 60%', color: [56, 159, 220, 255] },
    { cat: 'Below', prob: 70, label: 'Below, 70%', color: [0, 93, 161, 255] },
    { cat: 'Below', prob: 80, label: 'Below, 80%', color: [46, 33, 111, 255] },
    { cat: 'Below', prob: 90, label: 'Below, 90%', color: [34, 24, 82, 255] },
    { cat: 'EC', prob: 33, label: 'Equal Chances', color: [255, 255, 255, 0] }
  ],
} as const;
