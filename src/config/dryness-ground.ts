/**
 * Source identities are exact issuer RGB classes, not numeric pixel values.
 * STAR: nine runs pinned by tests/vhi-palette.test.mjs; transparent index0
 * is absent measurement. Do not infer VHI values from a palette index.
 * RG: rg_conus_week_data issuer legend, retrieved2026-10-07. The saved raw
 * response SHA256 is f8d6747a273986d4fdcb37b14ae5628149f1c945131a2644fba2105c186613c40.
 * Its fixture separately pins normalized bytes and exact source classes.
 *
 * Greys below are DDM display derivations, NOT issuer colors. Equally spaced
 * CIE L* targets12..38 (nine or ten steps), D65/sRGB, rounded to8-bit output.
 * Tentative until the D5 N10 native lightness/appearance proof. This module
 * neither activates a layer nor asserts that the presentation is admitted.
 */
export type DrynessProduct = 'star-vhi' | 'relative-greenness';

export const STAR_DRYNESS_CLASSES = [
  { source: '#FF00A0', grey: '#1F1F1F' },
  { source: '#F00050', grey: '#262626' },
  { source: '#FF7878', grey: '#2D2D2D' },
  { source: '#FFAA00', grey: '#343434' },
  { source: '#FFFF55', grey: '#3B3B3B' },
  { source: '#55FF55', grey: '#434343' },
  { source: '#00AA00', grey: '#4A4A4A' },
  { source: '#5555FF', grey: '#525252' },
  { source: '#0000AA', grey: '#595959' }
] as const;

export const RG_DRYNESS_CLASSES = [
  { source: '#732600', grey: '#1F1F1F' },
  { source: '#E60000', grey: '#252525' },
  { source: '#F57A7A', grey: '#2C2C2C' },
  { source: '#FFD37F', grey: '#323232' },
  { source: '#FFFF00', grey: '#383838' },
  { source: '#C7D79E', grey: '#3F3F3F' },
  { source: '#89CD66', grey: '#454545' },
  { source: '#98E600', grey: '#4C4C4C' },
  { source: '#70A800', grey: '#535353' },
  { source: '#5C8944', grey: '#595959' }
] as const;

// Ambiguous white is not interpreted as a measured zero class. No Data and
// Water remain not assessed; source product identity is unchanged.
export const RG_NOT_ASSESSED_COLORS = ['#FFFFFF', '#1E1E1E', '#73B2FF'] as const;
export const DRYNESS_NOT_ASSESSED_COLOR = '#858585';
