import { CPC_SEASONAL_PRODUCTION, createCpcSeasonalAdapter } from './cpc-seasonal-outlook';

/** The `cpc-610-precip` layer: CPC's 6-10 day precipitation outlook, national. */
export const { activate, deactivate, cancelActivation, fadeLayerIds, getSnapshot } =
  createCpcSeasonalAdapter({ variable: 'precipitation', window: '6-10', ...CPC_SEASONAL_PRODUCTION });
