import { createWhpLayer } from './usfs-whp';

/**
 * The USFS Wildfire Hazard Potential in the issuer's own class colours, a
 * Layer studio row (owner, 2026-10-19). Its own module so a chunk retry
 * (src/util/chunk-retry.ts) re-imports a namespace whose `activate` is this
 * layer's, never Fuel risk's.
 */
export const { activate, deactivate, bindPopups, fadeLayerIds } = createWhpLayer('usfs-whp-classes', false);
