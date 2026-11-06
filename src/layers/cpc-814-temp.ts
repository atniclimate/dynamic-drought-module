import { CPC_SEASONAL_PRODUCTION, createCpcSeasonalAdapter } from './cpc-seasonal-outlook';

/** The `cpc-814-temp` layer: CPC's 8-14 day temperature outlook, national. */
export const { activate, deactivate, cancelActivation, fadeLayerIds, getSnapshot, bindPopups } =
  createCpcSeasonalAdapter({ variable: 'temperature', window: '8-14', ...CPC_SEASONAL_PRODUCTION });
