import { CPC_SEASONAL_PRODUCTION, createCpcSeasonalAdapter } from './cpc-seasonal-outlook';

/** The `cpc-814-precip` layer: CPC's 8-14 day precipitation outlook, national. */
export const { activate, deactivate, cancelActivation, fadeLayerIds, getSnapshot, bindPopups } =
  createCpcSeasonalAdapter({ variable: 'precipitation', window: '8-14', ...CPC_SEASONAL_PRODUCTION });
