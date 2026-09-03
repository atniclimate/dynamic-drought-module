/**
 * Shared map handle (0.6.0 F3).
 *
 * A tiny process-wide store, in the spirit of `src/state/region-store.ts`, that
 * holds the single MapLibre instance. It exists so a UI-service facade whose
 * signature is frozen (for example `openImpactPanel(context): number`) can reach
 * the map for a map-dependent operation (resolving the location identity of a
 * selection) without taking a `map` parameter, and without the impact panel
 * importing the sidebar (which would form a cycle:
 * sidebar -> deep-link -> impact-panel -> sidebar).
 *
 * The orchestrator (`src/main.ts`) sets the map once at boot; consumers read it
 * on demand. Null before boot completes.
 */

import type * as maplibregl from 'maplibre-gl';

let mapRef: maplibregl.Map | null = null;

/** Record the map instance. Called once from boot. */
export function setMap(map: maplibregl.Map): void {
  mapRef = map;
}

/** The map instance, or null before boot has set it. */
export function getMap(): maplibregl.Map | null {
  return mapRef;
}
