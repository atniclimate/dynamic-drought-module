import { USFS_WHP_PRESENTATION } from './wildfire-presentation';

export const WHP_SURFACE_OPACITY = 0.55;

/** Published WHP classes, restyled only for the desktop terrain view. */
export const WHP_SHADE_CATEGORIES = USFS_WHP_PRESENTATION.categories.map((category, index) => ({
  ...category,
  opacity: [0, 0.15, 0.38, 0.68, 1, 0, 0][index] ?? 0
}));

/**
 * The Wildfire 3D drape alone (src/layers/whp-3d.ts; owner, DR-199): the
 * effective white opacity of each class, because that layer draws at opacity
 * 1. Very Low 0, Low 0.10, Moderate 0.20, High 0.40, Very High 0.80, so the
 * drape adds to the plant-stress whites under it. The flat view's table
 * above is unchanged.
 */
export const WHP_3D_SHADE_CATEGORIES = USFS_WHP_PRESENTATION.categories.map((category, index) => ({
  ...category,
  opacity: [0, 0.1, 0.2, 0.4, 0.8, 0, 0][index] ?? 0
}));

export const WHP_SHADE_QUALIFICATION =
  // vocab-allow: distinguishes static potential from a current condition or forecast
  'USFS Wildfire Hazard Potential 2023: whiter means higher risk. Transparent: Very Low, non-burnable, water, or missing coverage; not an all-clear. Static context, not current conditions or a forecast.';

/** The Wildfire 3D drape's key: the same words, plus the one thing only that drape does (owner, 2026-10-12). */
export const WHP_3D_SHADE_QUALIFICATION = `${WHP_SHADE_QUALIFICATION} Not drawn inside fire perimeters.`;
