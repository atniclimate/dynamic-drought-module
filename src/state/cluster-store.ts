/**
 * Shared hazard-cluster store (S2, the URL migration; D-0.7.0-042,
 * D-0.7.0-044, D-0.7.0-053; plan 9.11).
 *
 * The active hazard cluster is the COMMITTED display state the URL
 * serializes from (D-0.7.0-044): while the display is a clean cluster,
 * `syncUrl` emits ONLY the one-word `cluster=` token in place of the
 * granular `layers=` list; Drought, the default display, is absence.
 * The store follows the `basemap-store` pattern: the sidebar subscribes
 * `onHazardClusterChange(pushUrl)` and reads the getters when composing
 * the sync state.
 *
 * The ocean framing rides here rather than in its own store because it
 * is VALID ONLY WITH THE ENSO CLUSTER (D-0.7.0-042/053): an ocean click
 * is an entry into ENSO (display plus that ocean's camera in one
 * gesture), so `ocean=` without `cluster=enso` is meaningless and is
 * ignored on parse and dropped on sync. The setter enforces the
 * invariant so no writer can commit an ocean against a hazard cluster.
 *
 * APPLICATION MECHANICS LIVE ELSEWHERE (S3): this store holds and
 * parses the committed cluster/ocean claim only. Resolving a cluster's
 * horizon-aware recipe, applying it through the layer controller, and
 * clearing the claim when the granular intent diverges are the S3
 * cluster service's job (`src/state/cluster-service.ts`), which
 * replaced the S2 interim mechanics that briefly lived here
 * (composeClusterBootLayers / reconcileClusterWithLayerIntent). The
 * semantics carried over unchanged: the URL never claims a cluster the
 * display is not (D-0.7.0-044).
 */

import { HAZARD_CLUSTERS } from '../config/clusters';
import type { HazardClusterKey } from '../config/clusters';
import { OCEANS } from '../config/oceans';
import type { OceanKey } from '../config/oceans';

let currentCluster: HazardClusterKey = 'drought';
let currentOcean: OceanKey | null = null;

const listeners = new Set<() => void>();

/** The active hazard cluster; 'drought' (the default display) at boot. */
export function getHazardCluster(): HazardClusterKey {
  return currentCluster;
}

/** The active ocean framing; non-null only while the cluster is ENSO. */
export function getOceanFraming(): OceanKey | null {
  return currentOcean;
}

/**
 * Record a cluster change, with an optional ocean framing. The ocean is
 * kept only alongside `cluster === 'enso'` (D-0.7.0-042/053); any other
 * pairing normalizes the ocean to null rather than storing a claim the
 * display cannot honor. Idempotent: a write that changes nothing emits
 * nothing, so a boot-time seed never triggers a redundant URL write.
 */
export function setHazardCluster(
  cluster: HazardClusterKey,
  ocean: OceanKey | null = null
): void {
  const nextOcean = cluster === 'enso' ? ocean : null;
  if (cluster === currentCluster && nextOcean === currentOcean) return;
  currentCluster = cluster;
  currentOcean = nextOcean;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[cluster-store] listener threw:', err);
    }
  }
}

/**
 * Clear the ocean framing while keeping the cluster. Used when an
 * explicit camera gesture (a legacy region click) moves the camera away
 * from the ocean fit: the ENSO display persists, but the URL must stop
 * claiming a camera the view no longer shows (D-0.7.0-053: display
 * state never moves the camera; only boot gestures and explicit clicks
 * do, and the URL mirrors the last explicit gesture).
 */
export function clearOceanFraming(): void {
  if (currentOcean === null) return;
  currentOcean = null;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[cluster-store] listener threw:', err);
    }
  }
}

/** Subscribe to cluster/ocean changes. Returns an unsubscribe function. */
export function onHazardClusterChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Parse a raw `cluster=` parameter value against the ruled one-word
 * tokens (wildfire | heat | enso, D-0.7.0-044). Anything else (absent,
 * empty, unknown, or the never-emitted 'drought' spelled out) reads as
 * 'drought', the default display whose URL truth is absence.
 */
export function parseClusterParam(raw: string | null): HazardClusterKey {
  if (raw === null) return 'drought';
  for (const key of Object.keys(HAZARD_CLUSTERS) as HazardClusterKey[]) {
    if (HAZARD_CLUSTERS[key].urlToken === raw) return key;
  }
  return 'drought';
}

/**
 * Parse a raw `ocean=` parameter value. Only the three OceanKey tokens
 * select an ocean; anything else reads as null. Callers gate the result
 * on `cluster === 'enso'` (the D-0.7.0-042/053 validity rule); the
 * parser itself is kind-blind.
 */
export function parseOceanParam(raw: string | null): OceanKey | null {
  if (raw !== null && Object.prototype.hasOwnProperty.call(OCEANS, raw)) {
    return raw as OceanKey;
  }
  return null;
}
