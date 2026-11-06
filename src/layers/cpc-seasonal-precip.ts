import { CPC_SEASONAL_PRODUCTION, createCpcSeasonalAdapter } from './cpc-seasonal-outlook';

/** The `cpc-seasonal-precip` layer: CPC's seasonal precipitation outlook, Lead 1, national. */
export const { activate, deactivate, cancelActivation, fadeLayerIds, getSnapshot, bindPopups } =
  createCpcSeasonalAdapter({ variable: 'precipitation', ...CPC_SEASONAL_PRODUCTION });
