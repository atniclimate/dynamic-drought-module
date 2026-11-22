/** MapLibre cannot read CSS custom properties. These presentation-only colors
 * mirror the adopted interface palette; no issuer class table imports them.
 * Source: D3 M5, palette-tokens section "Map-side mirrors".
 */
export const MAP_GROUND_COLOR = '#010B13'; // app.css --surface-base
/**
 * The font name a Nation's own-language name is drawn with (the Tribal Lands
 * labels, src/layers/aiannh.ts). It resolves through the style's `font-faces`
 * (src/map/style.ts) to one self-hosted file cut from Noto Sans
 * (scripts/cut-nation-names-font.py), fetched only when such a name is on
 * screen. A separate name on purpose: a `font-faces` entry for `Noto Sans
 * Regular` would move every map label from the glyph files to browser drawing.
 * MapLibre draws a letter with its combining marks as one cluster through the
 * browser, and this file's mark tables place them; without it the cluster
 * falls to the viewer's system font.
 */
export const NATION_NAME_FONT = 'DDM Nation Names';
// Light names on a dark halo since DDM's own dark base map (design pass 2026-11-13): the white halos
// were the loudest marks on the map, made for the retired raster ground.
export const PLACE_LABEL_COLOR = '#C6CBD4'; // app.css --ink-soft
export const PLACE_LABEL_HALO = '#010B13'; // app.css --surface-base
// The base map's own names (owner, 2026-11-22: state text hard to read; "outline free capitalized
// transparent grey type"). No drawn outline: a soft dark cushion under each name, invisible on the dark
// ground, darkens a Drought Monitor yellow or a bright cloud just enough to carry the letters. States in
// translucent grey capitals, cities in brighter sentence case, so a city never reads as a state.
export const MAP_LABEL_CUSHION = 'rgba(1, 11, 19, 0.8)'; // app.css --surface-base at 80 percent
export const REGION_LABEL_COLOR = 'rgba(198, 203, 212, 0.92)'; // app.css --ink-soft at 92 percent
export const BASE_PLACE_LABEL_COLOR = '#E8ECF0'; // app.css --ink
export const STATE_OUTLINE_COLOR = '#8A94A6'; // app.css --ink-faint
export const BASE_LAND_COLOR = '#1E242C'; // app.css --surface-overlay
export const BASE_GLACIER_COLOR = '#2A3138'; // app.css --surface-hover
export const BASE_REGION_LINE_COLOR = '#636363'; // app.css --rule-strong
export const BASE_WATER_LABEL_COLOR = '#8A94A6'; // app.css --ink-faint
export const HILLSHADE_SHADOW = '#1E242C'; // app.css --surface-overlay
export const HILLSHADE_HIGHLIGHT = '#F4F7FB'; // adopted light/print tint
export const STUDIO_SELECTION_COLOR = '#FFFFFF'; // app.css --ink-strong
export const STUDIO_SELECTION_CASING = '#010B13'; // app.css --surface-base
