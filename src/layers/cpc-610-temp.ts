import { CPC_SEASONAL_PRODUCTION, createCpcSeasonalAdapter } from './cpc-seasonal-outlook';

/** The `cpc-610-temp` layer: CPC's 6-10 day temperature outlook, national. */
export const { activate, deactivate, cancelActivation, fadeLayerIds, getSnapshot } =
  createCpcSeasonalAdapter({ variable: 'temperature', window: '6-10', ...CPC_SEASONAL_PRODUCTION });
