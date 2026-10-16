/**
 * The NOAA National Hurricane Center (NHC) and Central Pacific Hurricane
 * Center (CPHC) Tropical Weather MapServer, as the tropical cyclones layer
 * reads and draws it (ENSO block B3; admission
 * planning/2026-09-25-desktop-pass/admissions/noaa-tropical-cyclones.md).
 *
 * Import-free on purpose: the layer, its reader, its popup builder, the map
 * key and a plain `node --test` all read these tables, and none of them pulls
 * the eager palette chunk for it.
 *
 * Every label and colour here is the issuer's: the layer 240 to 243
 * `drawingInfo` renderers and field aliases of the service, read on
 * 2026-10-13 (DR-101, never recoloured). Line widths are the renderer's
 * points converted to CSS pixels (4/3). One exception, stated: the
 * Forecast Points renderer draws picture icons (esriPMS), not colours, so
 * the map draws a neutral circle per renderer class, sized by the class,
 * and labels it with the renderer's own words.
 */

/** The three basins of the NHC and CPHC area of responsibility, five slots each. */
export const TROPICAL_BASINS = [
  { code: 'AT', name: 'Atlantic', centre: 'nhc' },
  { code: 'EP', name: 'Eastern North Pacific', centre: 'nhc' },
  { code: 'CP', name: 'Central North Pacific', centre: 'cphc' }
] as const;

export type TropicalBasinCode = (typeof TROPICAL_BASINS)[number]['code'];
export type TropicalPart = 'points' | 'track' | 'cone' | 'ww';

export interface TropicalSlot {
  /** The service's bin number, for example "EP5". */
  readonly bin: string;
  readonly basin: TropicalBasinCode;
  /** The slot's group layer id; its sublayers sit at fixed offsets. */
  readonly base: number;
}

/** Sublayer offsets from a slot's base id (all 60 names checked 2026-10-13). */
export const TROPICAL_PART_OFFSET: Readonly<Record<TropicalPart, number>> = {
  points: 2,
  track: 3,
  cone: 4,
  ww: 5
};

/** The fifteen slots, AT1 to CP5, base = 4 + 26n. Slots are not filled in order. */
export const TROPICAL_SLOTS: readonly TropicalSlot[] = TROPICAL_BASINS.flatMap((basin, b) =>
  [1, 2, 3, 4, 5].map((k, i) => ({ bin: `${basin.code}${k}`, basin: basin.code, base: 4 + 26 * (b * 5 + i) }))
);

export const TROPICAL_ISSUERS = {
  nhc: { name: 'NOAA National Hurricane Center', link: { label: 'National Hurricane Center', href: 'https://www.nhc.noaa.gov/' } },
  cphc: { name: 'NOAA Central Pacific Hurricane Center', link: { label: 'Central Pacific Hurricane Center', href: 'https://www.nhc.noaa.gov/?cpac' } },
  both: { name: 'NOAA National Hurricane Center and Central Pacific Hurricane Center', link: { label: 'National Hurricane Center', href: 'https://www.nhc.noaa.gov/' } }
} as const;

/** The issuing centre for a bin number (the slot id is the centre key; `basin` is not). */
export function tropicalCentre(bin: unknown): keyof typeof TROPICAL_ISSUERS {
  const code = typeof bin === 'string' ? bin.slice(0, 2) : '';
  const basin = TROPICAL_BASINS.find((b) => b.code === code);
  return basin ? basin.centre : 'both';
}

/** A basin code's name, or null for a code outside the three basins (drawn, named unknown). */
export function tropicalBasinName(code: unknown): string | null {
  return TROPICAL_BASINS.find((b) => b.code === code)?.name ?? null;
}

/** The empty state, in the owner's words (enso-mode-expansion.yaml F2). */
export const TROPICAL_EMPTY_TEXT = 'No active tropical cyclones';

/** Layer 240's renderer: `dvlbl,stormsrc` to its label, verbatim, with the circle size DDM gives each class. */
export const TROPICAL_POINT_CLASSES = [
  { key: 'M,Tropical Cyclone', label: 'Sustained Wind > 110 mph', radius: 9 },
  { key: 'H,Tropical Cyclone', label: 'Sustained Wind 73 -110 mph', radius: 7.5 },
  { key: 'S,Tropical Cyclone', label: 'Sustained Wind 39-73 mph', radius: 6 },
  { key: 'D,Tropical Cyclone', label: 'Sustained Wind < 39 mph', radius: 4.5 },
  { key: 'H,Post-Tropical Cyclone', label: 'Sustained Wind > 73 mph', radius: 7.5 },
  { key: 'S,Post-Tropical Cyclone', label: 'Sustained Wind 39-73 mph', radius: 6 },
  { key: 'D,Post-Tropical Cyclone', label: 'Sustained Wind < 39 mph', radius: 4.5 }
] as const;
export const TROPICAL_POINT_UNKNOWN_RADIUS = 4;
/** The neutral circle: forecast positions hollow, the tau 0 position filled. */
export const TROPICAL_POINT_INK = '#1f2937';
export const TROPICAL_POINT_PAPER = '#ffffff';

/** Layer 243's renderer, `tcww` code to label, verbatim; colour and width are the renderer's. */
export const TROPICAL_WW_CLASSES = [
  { code: 'HWA', label: 'Hurricane Watch', color: '#ff7f7f', width: 6.67 },
  // vocab-allow: verbatim NHC product name, the issuer renderer's label
  { code: 'HWR', label: 'Hurricane Warning', color: '#ff0000', width: 6.67 },
  { code: 'TWA', label: 'Tropical Storm Watch', color: '#ffff00', width: 2.67 },
  // vocab-allow: verbatim NHC product name, the issuer renderer's label
  { code: 'TWR', label: 'Tropical Storm Warning', color: '#004da8', width: 2.67 }
] as const;
/** An unrecognised `tcww` code: neutral, thin, never drawn as a warning. */
export const TROPICAL_WW_UNKNOWN = { color: '#9ca3af', width: 2 } as const;

/** Layer 241's renderer (a solid black 1.5 pt line) and layer 242's (fill 225,225,225, outline 230,0,0 at 0.4 pt). */
export const TROPICAL_TRACK = { color: '#000000', width: 2 } as const;
export const TROPICAL_CONE = { fill: '#e1e1e1', fillOpacity: 0.3, outline: '#e60000', outlineWidth: 0.53 } as const;

/** The service layer names for each part, as the service titles them. */
export const TROPICAL_PART_NAMES: Readonly<Record<TropicalPart, string>> = {
  // vocab-allow: the issuer's own layer names (Forecast Points, Forecast Track, Forecast Cone)
  points: 'Forecast Points',
  // vocab-allow: the issuer's own layer name
  track: 'Forecast Track',
  // vocab-allow: the issuer's own layer name
  cone: 'Forecast Cone',
  // vocab-allow: the issuer's own layer name
  ww: 'Watch-Warning'
};

/**
 * `tcdvlp` values: the issuer's metadata lists Tropical Depression, Tropical
 * Storm, Hurricane, Subtropical Storm and Subtropical Depression (TCDVLP,
 * https://www.nhc.noaa.gov/gis/); the live service also carries Major Hurricane.
 * Any other value, or none, is shown as the issuer's raw code marked unrecognised.
 */
export const TROPICAL_CLASSIFICATIONS: readonly string[] = [
  'Major Hurricane',
  'Hurricane',
  'Tropical Storm',
  'Tropical Depression',
  'Subtropical Storm',
  'Subtropical Depression'
];

/**
 * `stormtype` codes: the five the issuer's shapefile metadata lists (TD, TS, HU,
 * SS, SD; https://www.nhc.noaa.gov/gis/ forecast `_5day_pts.shp.xml`, STORMTYPE)
 * plus MH and STD, which the live service carries and that metadata does not list.
 */
export const TROPICAL_STORM_TYPES: readonly string[] = ['TD', 'TS', 'HU', 'SS', 'SD', 'MH', 'STD', 'STS'];

/** The issuer's missing-value sentinel on forecast positions (mslp, tcdir, tcspd). */
export const TROPICAL_MISSING = 9999;
