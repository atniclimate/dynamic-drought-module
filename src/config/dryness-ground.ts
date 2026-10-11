/**
 * Source identities are exact issuer RGB classes, not numeric pixel values.
 * STAR: nine runs pinned by tests/vhi-palette.test.mjs; transparent index0
 * is absent measurement. Do not infer VHI values from a palette index.
 * RG: rg_conus_week_data issuer legend, retrieved2026-10-07. The saved raw
 * response SHA256 is f8d6747a273986d4fdcb37b14ae5628149f1c945131a2644fba2105c186613c40.
 * Its fixture separately pins normalized bytes and exact source classes.
 *
 * The alphas below are DDM display derivations, NOT issuer colors (owner,
 * 2026-10-11, DR-199): every class draws WHITE at its alpha, so whiter means
 * more plant stress (STAR) or less green (RG), the same direction as the
 * white fuel-risk drape it adds to. The issuer's most stressed class is 40%
 * white, its healthiest a 4% lift so it is not the bare ground, with even
 * steps between (0.045 over nine classes, 0.04 over ten). Everything with no
 * value is fully transparent. Pinned by tests/vhi-palette.test.mjs. How the
 * two whites read together on the terrain is the owner's sitting.
 */
export type DrynessProduct = 'star-vhi' | 'relative-greenness';

export const STAR_DRYNESS_CLASSES = [
  { source: '#FF00A0', alpha: 0.4 },
  { source: '#F00050', alpha: 0.355 },
  { source: '#FF7878', alpha: 0.31 },
  { source: '#FFAA00', alpha: 0.265 },
  { source: '#FFFF55', alpha: 0.22 },
  { source: '#55FF55', alpha: 0.175 },
  { source: '#00AA00', alpha: 0.13 },
  { source: '#5555FF', alpha: 0.085 },
  { source: '#0000AA', alpha: 0.04 }
] as const;

export const RG_DRYNESS_CLASSES = [
  { source: '#732600', alpha: 0.4 },
  { source: '#E60000', alpha: 0.36 },
  { source: '#F57A7A', alpha: 0.32 },
  { source: '#FFD37F', alpha: 0.28 },
  { source: '#FFFF00', alpha: 0.24 },
  { source: '#C7D79E', alpha: 0.2 },
  { source: '#89CD66', alpha: 0.16 },
  { source: '#98E600', alpha: 0.12 },
  { source: '#70A800', alpha: 0.08 },
  { source: '#5C8944', alpha: 0.04 }
] as const;

// Ambiguous white is not interpreted as a measured zero class. No Data and
// Water remain not assessed; source product identity is unchanged.
export const RG_NOT_ASSESSED_COLORS = ['#FFFFFF', '#1E1E1E', '#73B2FF'] as const;

/**
 * NOAA NESDIS STAR land-cover map tiles (its "IGBP land type" ancillary
 * layer, built on the USGS Global Land Cover Characteristics Data Base), on
 * the same tile grid as the plant-health tiles of URLS.starVhiJ01TileTemplate:
 * 256 px palette PNG, index 0 transparent, wildcard CORS on 200, Z=8 answers
 * 500 with no CORS header, Cache-Control private, max-age=0 (observed
 * 2026-10-11). Never cached in the app, like the weeks.
 *
 * This address lives outside the URLS catalog on purpose: the catalog's
 * chunk rides every feature's first activation, and two activation budgets
 * had no room for one more entry (see the note in src/config/urls.ts). It
 * keeps the catalog's `key: 'https...'` form so scripts/check-upstream-drift.mjs
 * reads and probes it with the catalog.
 */
export const DRYNESS_GROUND_URLS = {
  starLandCoverTileTemplate:
    'https://www.star.nesdis.noaa.gov/smcd/emb/vci/VH/image_mapTile.php?type=ancillary//IGBPlandtype&Z={z}&X={x}&Y={y}'
} as const;

/**
 * The land-cover tiles' exact palette RGB, observed live 2026-10-11: eighteen
 * entries, index 0 transparent.
 * STAR lists the classes as 1 to 14 vegetated or built land, 15 Snow and Ice,
 * 16 Bare Ground, 17 Water Bodies, 0 Undefined, and says: "Currently we use
 * the class 16 (bare Ground) of USGS 'Global Land Cover Characteristics Data
 * Base (GLCC World)' as desert mask." Plant stress is drawn over the first
 * fourteen only. Open water arrives as the transparent index 0 in every tile
 * sampled (class 17's opaque navy was never observed), so a transparent
 * land-cover pixel is not drawn either. Any other colour rejects the tile.
 */
export const STAR_LAND_COVER_DRAWN = ['#008000', '#00FF00', '#99CC00', '#99FF99', '#339966', '#993366', '#FFCC99',
  '#CCFFCC', '#FFCC00', '#FF9900', '#006699', '#FFFF00', '#FF0000', '#999966'] as const;
export const STAR_LAND_COVER_MASKED = ['#FFFFFF', '#808080', '#000080'] as const;
