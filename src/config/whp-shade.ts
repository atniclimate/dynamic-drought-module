import { USFS_WHP_PRESENTATION } from './wildfire-presentation';

export const WHP_SURFACE_OPACITY = 0.55;

/** Published WHP classes, restyled only for the desktop terrain view. */
export const WHP_SHADE_CATEGORIES = USFS_WHP_PRESENTATION.categories.map((category, index) => ({
  ...category,
  opacity: [0, 0.15, 0.38, 0.68, 1, 0, 0][index] ?? 0
}));

export const WHP_SHADE_QUALIFICATION =
  // vocab-allow: distinguishes static potential from a current condition or forecast
  'USFS Wildfire Hazard Potential 2023: whiter means a higher class. Transparent: Very Low, non-burnable, water, or missing coverage; not an all-clear. Static context, not current conditions or a forecast.';
