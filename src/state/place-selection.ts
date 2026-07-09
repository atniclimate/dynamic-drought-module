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

import type { BoundarySelectionContext } from '../impact/types';

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
