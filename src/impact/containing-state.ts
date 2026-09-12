/**
 * Containing-state enrichment for a boundary-selection context that arrived
 * without one (`containing.basis === 'none'`: a direct AIANNH, BIA-reservation
 * or ecoregion click). This is briefing-cluster code (it reaches
 * `resolveContainingState`, which pulls in `location-identity.ts` and its
 * point-in-polygon fallback) and lives in this module, rather than in the
 * eager facade (`src/ui/impact-panel.ts`), so the activation gate's declared
 * eager set (DR-085 budgets; `scripts/check-activation-budget.mjs`) still
 * excludes it: the facade calls `enrichContainingState` through a dynamic
 * import, exactly as it already lazy-loads the panel runtime through
 * `loadRuntime()`.
 *
 * The enrichment itself lives at the one function every briefing door
 * composes through (`openImpactPanel`), rather than in the four layer
 * modules (AIANNH, BIA-reservation, ecoregion, and any future kind), because
 * their click handler (`registerClickTarget`'s `respond` callback, see
 * src/map/interaction-coordinator.ts) is synchronous and the reliable
 * resolver (`resolveContainingState`, backed by the same point-in-polygon
 * fallback `resolveLocationIdentity` uses) is not; filling `containing` inside
 * a synchronous callback could only ever answer when the `states` layer
 * happened to be on, which would make the fix silently conditional on an
 * unrelated layer.
 */

import { isStateCode } from './resources';
import type { BoundarySelectionContext } from './types';
import { getMap } from '../state/map-store';
import { resolveContainingState } from '../state/location-identity';

/**
 * Resolve `context`'s containing state from the clicked point. A context that
 * already knows its state is returned unchanged and pays nothing for this
 * call. The invariant from `ContainingPlaces` stands here too: on no map, no
 * result, or any failure or cancellation (including the caller's own
 * supersede-and-abort), this degrades to the original (still `'none'`)
 * context, never to a camera-region guess.
 */
export async function enrichContainingState(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<BoundarySelectionContext> {
  const map = getMap();
  if (!map) return context;
  try {
    const state = await resolveContainingState(map, context.lngLat, signal);
    if (signal.aborted || state === null || !isStateCode(state.code)) {
      return context;
    }
    return {
      ...context,
      containing: { state: state.code, basis: 'point-in-polygon' }
    };
  } catch {
    return context;
  }
}
