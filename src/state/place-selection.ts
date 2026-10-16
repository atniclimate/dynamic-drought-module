/**
 * Current place-selection store (0.6.0 unit R1; pathway appendix D).
 *
 * A tiny observable store, in the spirit of `src/state/region-store.ts`, that
 * holds the place the user has most recently selected on the map (a boundary
 * click, or later a "my place" pin). The front-door briefing (F3) reads it so a
 * selected place can drive the "See what this means" trigger; clearing it on
 * popup close keeps a stale place from lingering.
 *
 * It carries the full `BoundarySelectionContext` (not just a label) so the
 * front door can open the same briefing a boundary click would build, including
 * the resolved location identity once R1 wiring sets it.
 */

import { REGIONS } from '../config/regions';
import type { BoundarySelectionContext } from '../impact/types';
import type { RegionBriefingAnchor } from '../types/region';
import { getCurrentRegion } from './region-store';

export interface PlaceSelection {
  /** Short label for the selection, for example the boundary title. */
  readonly label: string;
  /** The selection context the briefing opens from. */
  readonly context: BoundarySelectionContext;
}

let current: PlaceSelection | null = null;
const listeners = new Set<(selection: PlaceSelection | null) => void>();

/** The current place selection, or null if none is active. */
export function getPlaceSelection(): PlaceSelection | null {
  return current;
}

/**
 * What a briefing door opens on a popup that is not about a place (the Nino
 * 3.4 box, a tropical storm): the selected place, else the boundary the
 * current region's briefing describes (the sidebar's region-briefing trigger),
 * else null. Both carry the `label` the door names.
 */
export function standingBriefing(): PlaceSelection | RegionBriefingAnchor | null {
  if (current) return current;
  const region = getCurrentRegion();
  return (region ? REGIONS[region]?.briefing : undefined) ?? null;
}

/**
 * That door for a popup model's `actions`: always one. With nothing to brief
 * (no place selected, no region briefing), the one door opens the briefing
 * panel at Technical information.
 */
export function standingBriefingDoor(): readonly (
  | { readonly kind: 'briefing'; readonly place: string }
  | { readonly kind: 'technical' }
)[] {
  const briefing = standingBriefing();
  return [briefing ? { kind: 'briefing', place: briefing.label } : { kind: 'technical' }];
}

/**
 * Set (or clear, with null) the current place selection and notify listeners.
 * A listener that throws does not stop the others.
 */
export function setPlaceSelection(selection: PlaceSelection | null): void {
  current = selection;
  for (const listener of listeners) {
    try {
      listener(selection);
    } catch (err) {
      console.error('[place-selection] listener threw:', err);
    }
  }
}

/**
 * Subscribe to place-selection changes. Returns an unsubscribe function.
 */
export function onPlaceSelectionChange(
  listener: (selection: PlaceSelection | null) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
