/**
 * Color palettes for layered features. Each table is a direct port of the
 * vanilla baseline's `app.js` constants, preserving the visual identity of
 * v0.1.x while the rendering layer migrates from Leaflet to MapLibre.
 */

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

export const TREATY_COLORS: ReadonlyArray<TreatyEntry> = [
  { match: 'Medicine Creek', tribe: null,                                                  color: '#dc2626' },
  { match: 'Yakama',         tribe: 'Confederated Tribes and Bands of the Yakama Nation',  color: '#8b5cf6' },
  { match: 'Nez Perce',      tribe: 'Nez Perce Tribe',                                     color: '#f59e0b' },
  { match: 'Point Elliott',  tribe: null,                                                  color: '#ec4899' },
  { match: 'Point No Point', tribe: null,                                                  color: '#14b8a6' },
  { match: 'Quinault',       tribe: 'Quinault Indian Nation',                              color: '#3b82f6' },
  { match: 'Walla Walla',    tribe: null,                                                  color: '#a855f7' }
];

export const TREATY_COLOR_DEFAULT = '#f97316';

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
