import { CPC_SEASONAL_PRODUCTION, createCpcSeasonalAdapter } from './cpc-seasonal-outlook';

/** The `cpc-seasonal-temp` layer: CPC's seasonal temperature outlook, Lead 1, national. */
export const { activate, deactivate, cancelActivation, fadeLayerIds, getSnapshot, bindPopups } =
  createCpcSeasonalAdapter({ variable: 'temperature', ...CPC_SEASONAL_PRODUCTION });
