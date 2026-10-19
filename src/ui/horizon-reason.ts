import { HAZARD_CLUSTERS, TEMPORAL_HORIZON_KEYS } from '../config/clusters';
import type { HazardClusterKey, TemporalHorizonKey } from '../config/clusters';
import { HORIZON_CHROME, SHELL_HORIZON_KEY } from '../impact/horizon-chrome';
import { horizonSurfaceSignature } from '../state/timeline';

/**
 * The detail clause of the duplicate-surface reason: one sentence per
 * hazard whose recipe repeats across horizons (DDM-P8-T03, DR-017 a).
 * Named here rather than derived, because only the owning layer's own
 * doctrine explains why its one surface honestly answers every horizon
 * (`src/layers/heatrisk.ts`, `src/layers/sst-anomaly.ts`); drought and
 * wildfire never hit this branch (every one of their three recipes has
 * a distinct signature), so they carry no entry.
 */
const DUPLICATE_SURFACE_DETAIL: Partial<Record<HazardClusterKey, string>> = {
  heat:
    'the National Weather Service HeatRisk sequence publishes seven daily ' +
    'periods on one surface, and the Valid date control in the key selects the day.',
  enso:
    'the sea-surface-temperature anomaly field is one analysed daily ' +
    'surface at every horizon.'
};

/**
 * Why a committed cluster's horizon chip is disabled, or null when it
 * applies (DDM-P8-T03). The recipe's capability signature
 * (`horizonSurfaceSignature`, computed from `HAZARD_CLUSTERS` only, never
 * from a claim: no import of `matrix.ts`, `hydrate.ts` or any claim module
 * may appear in this file) decides. An empty recipe disables the chip even
 * when it is the committed horizon (a deep link into an unanswerable horizon
 * is exactly what "cannot answer" means). Otherwise, a signature that
 * repeats an EARLIER key's in `TEMPORAL_HORIZON_KEYS` disables the chip
 * with a reason naming that earlier horizon's title; `current` is first,
 * so this rule can never disable it and it always remains the way back.
 * The chip carries it as its title (src/ui/island/shell.tsx); the visible
 * text reads in Technical information (src/ui/map-technical-information.ts).
 */
export function clusterHorizonReason(
  cluster: HazardClusterKey,
  key: TemporalHorizonKey
): string | null {
  const signature = horizonSurfaceSignature(cluster, key);
  if (signature === null) {
    return (
      `${HORIZON_CHROME[SHELL_HORIZON_KEY[key]].title} is off for ` +
      `${HAZARD_CLUSTERS[cluster].title}: no verified map source for ` +
      'this time horizon exists yet, so none is shown rather than a guess.'
    );
  }

  const idx = TEMPORAL_HORIZON_KEYS.indexOf(key);
  for (let i = 0; i < idx; i++) {
    const earlierKey = TEMPORAL_HORIZON_KEYS[i]!;
    if (horizonSurfaceSignature(cluster, earlierKey) !== signature) continue;
    const ownTitle = HORIZON_CHROME[SHELL_HORIZON_KEY[key]].title;
    const earlierTitle = HORIZON_CHROME[SHELL_HORIZON_KEY[earlierKey]].title;
    const detail = DUPLICATE_SURFACE_DETAIL[cluster] ?? '';
    return `${ownTitle} shows the same map as ${earlierTitle} here: ${detail}`;
  }
  return null;
}
