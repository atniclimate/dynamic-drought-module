/**
 * Pure chip-label resolution (S30D D1 M10; register items owner-1h,
 * found-016, found-018, found-019; task DDM-P10-T11; design record
 * interface-chrome-popups-text.md section 2.4).
 *
 * The top-left chip's per-product label table used to live inside
 * src/ui/map-key.ts as a private const (`KEY_ELIGIBLE_LABELS`), a module
 * with many runtime imports (the registry, config/palette, config/layers,
 * DOM globals) that a plain `node --test` cannot load without a resolve
 * hook and a DOM stub. Moving the pure lookup here, with one runtime
 * import from src/config/clusters.ts (itself import-free: its one import
 * is `import type`, erased by Node's type stripping), lets
 * tests/chrome-n-modes.test.mjs (DR-113, the N-mode contract) run with no
 * resolve hook, and lets map-key.ts import the SAME table rather than
 * carry a second copy that could drift.
 */

import { HAZARD_CLUSTERS, type HazardClusterKey } from './clusters';

/**
 * The layer keys that can earn (or contribute to) the on-map chip, with
 * the word a whole-key loading placeholder renders under (W2-D6) and the
 * word slot 2 of the chip's grammar shows verbatim (interface-chrome
 * section 2.4). 'nws-alerts' reads "NWS alerts", not "Products"
 * (`check:vocabulary`; D1.md M10 Notes).
 */
export const KEY_ELIGIBLE_LABELS: Readonly<Record<string, string>> = {
  heatrisk: 'HeatRisk',
  'spc-fire-weather': 'Fire',
  'usfs-whp': 'Wildfire potential',
  'cdm-drought': 'Canada drought',
  'nadm-drought': 'North America drought',
  usdm: 'Drought',
  'sst-anomaly': 'Ocean temperature',
  'nifc-fires': 'Fire',
  // vocab-allow: the National Weather Service's own product name, not DDM's own read calling itself an alert (BRIEF L4).
  'nws-alerts': 'NWS alerts'
};

/**
 * The chip's label with no key eligible: the committed mode's own word,
 * so the chip never has to invent a word or hide (section 2.4, "the chip
 * never hides"). clusters.ts has no separate `label` field; `title` is
 * the exact button word a person already pressed (D-0.7.0-042), so it is
 * the honest fallback.
 */
export function chipFallbackLabel(mode: HazardClusterKey): string {
  return HAZARD_CLUSTERS[mode].title;
}
