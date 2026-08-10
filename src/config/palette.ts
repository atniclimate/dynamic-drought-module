/**
 * Color palettes for layered features. Each table is a direct port of the
 * vanilla baseline's `app.js` constants, preserving the visual identity of
 * v0.1.x while the rendering layer migrates from Leaflet to MapLibre.
 */

/* ---------------------------------------------------------------------------
 * North American drought minimap
 *
 * The minimap is a condition overview, so it uses the shared D0 through D4
 * drought ramp rather than editorial region colors. `none` is deliberately
 * white, per the map convention. Loading and unavailable states are separate
 * UI states and never receive a drought color.
 * ------------------------------------------------------------------------- */

export type DroughtSeverityCode = 'none' | 'D0' | 'D1' | 'D2' | 'D3' | 'D4';

export const MINIMAP_DROUGHT_COLORS: Readonly<
  Record<DroughtSeverityCode, string>
> = {
  none: '#FFFFFF',
  D0: '#FFFF00',
  D1: '#FCD37F',
  D2: '#FFAA00',
  D3: '#E60000',
  D4: '#730000'
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
 * The CPC encodes status in a numeric attribute that maps to one of these
 * forecast categories. Used by the legend; the actual fill comes from the
 * upstream WMS so this table is for the sidebar swatches only.
 * ------------------------------------------------------------------------- */

export const DROUGHT_COLORS: Readonly<Record<string, string>> = {
  PERSISTS: '#cd853f',
  DEVELOPS: '#daa520',
  IMPROVES: '#9acd32',
  REMOVAL: '#3cb371'
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
 * The "none" swatch (U4b, 0.7.0). Areas under no USDM category render as
 * the bare desaturated basemap, and the design corpus found that grey reads
 * as "broken", not "drought-free". This entry names that grey in the key so
 * absence reads as a deliberate state. Kept OUTSIDE `USDM_CATEGORIES`:
 * consumers index that array by drought level (`USDM_CATEGORIES[dm]`), so a
 * sixth element would shift the D0-D4 mapping. The color approximates the
 * desaturated basemap the user actually sees (raster-saturation -0.8 over
 * OSM), not a data value; it never paints a map fill.
 */
export const USDM_NONE_SWATCH: Readonly<{ code: string; label: string; color: string }> = {
  code: 'None',
  label: 'No drought',
  color: '#e2e4e6'
};

/* ---------------------------------------------------------------------------
 * North American Drought Monitor (NADM) monthly consensus categories
 *
 * Kept separate from the weekly USDM palette even though the published class
 * names and colors align. NADM is a tri-national monthly consensus product,
 * not a USDM extension or a field to blend with USDM, CDM, or BC basin levels.
 * ------------------------------------------------------------------------- */

export const NADM_CATEGORIES: ReadonlyArray<{
  readonly code: string;
  readonly label: string;
  readonly color: string;
}> = [
  { code: 'D0', label: 'Abnormally dry', color: '#FFFF00' },
  { code: 'D1', label: 'Moderate drought', color: '#FCD37F' },
  { code: 'D2', label: 'Severe drought', color: '#FFAA00' },
  { code: 'D3', label: 'Extreme drought', color: '#E60000' },
  { code: 'D4', label: 'Exceptional drought', color: '#730000' }
];

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

export const BC_DROUGHT_LEVELS: readonly BcDroughtLevel[] = [
  { value: 0, code: '0', label: 'Level 0', color: '#2f855a' },
  { value: 1, code: '1', label: 'Level 1', color: '#f6e05e' },
  { value: 2, code: '2', label: 'Level 2', color: '#f6ad55' },
  { value: 3, code: '3', label: 'Level 3', color: '#ed8936' },
  { value: 4, code: '4', label: 'Level 4', color: '#e53e3e' },
  { value: 5, code: '5', label: 'Level 5', color: '#822727' }
];

export const BC_DROUGHT_NO_UPDATE: BcDroughtLevel = {
  value: 99,
  code: 'No update',
  label: 'Not measured right now',
  color: '#64748b'
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
 * Representation, AIAN-LAR, fetched live per CLAUDE.md hard rule 1: live
 * consumption, not redistribution). D-0.7.0-019 groups all three into ONE
 * magenta-to-violet tone family so a reader sees them as related "whose place is
 * this" layers, distinguished by opacity and line style rather than three
 * unrelated hues (the prior warm-orange Tribal Lands, seven-hue Treaty spread,
 * and indigo reservations). The visible reservation surface of record is the
 * LIVE BIA layer; the bundled Tribal Lands placeholder ships empty (CLAUDE.md
 * sections 2 and 4), so on the reference deployment the BIA magenta is what a
 * reader actually sees.
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

export const STATE_OUTLINE_COLOR = '#64748b';

/* ---------------------------------------------------------------------------
 * Municipal place labels (U4e; Natural Earth bundled points)
 *
 * Dark slate text with a light halo: the one combination the corpus's
 * both-basemaps rule accepts unchanged over the desaturated OSM default AND
 * over satellite imagery (the halo carries the contrast, not the text
 * color). These are the map-side tokens for label chrome; on-map paint
 * cannot read CSS custom properties, so palette.ts is their single source.
 * ------------------------------------------------------------------------- */

export const PLACE_LABEL_COLOR = '#334155';
export const PLACE_LABEL_HALO = '#f8fafc';

/* ---------------------------------------------------------------------------
 * Hillshade underlay (U4g)
 *
 * SUBTLE by contract (the cartography lens): terrain legibility under the
 * thematic surfaces, never a competing statement. Slate-family shadow and a
 * barely-off-white highlight keep the shading neutral against both the
 * desaturated OSM default and satellite; the low exaggeration constant is
 * the "subtle" knob and lives here so a design pass tunes one number.
 * ------------------------------------------------------------------------- */

export const HILLSHADE_SHADOW = '#1e293b';
export const HILLSHADE_HIGHLIGHT = '#f8fafc';
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
 * the Storm Prediction Center's own fire-weather display convention
 * (Elevated orange, Critical red, Extreme magenta), so the module never
 * invents its own severity language.
 * ------------------------------------------------------------------------- */

export const SPC_FIREWX_CATEGORIES: ReadonlyArray<{
  readonly dn: number;
  readonly label: string;
  readonly color: string;
}> = [
  { dn: 5, label: 'Elevated', color: '#e69800' },
  { dn: 8, label: 'Critical', color: '#e60000' },
  { dn: 10, label: 'Extreme', color: '#ff00ff' }
];

export const SPC_FIREWX_DEFAULT_COLOR = '#9ca3af';
