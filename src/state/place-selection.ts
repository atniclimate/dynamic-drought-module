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
import { getTypedPlace, setTypedPlace } from './typed-place';
import type { TypedPlaceRef } from './typed-place';

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

/** A string property, or a finite number as its decimal string; blank is null. */
function codeProperty(context: BoundarySelectionContext, key: string): string | null {
  const value = context.properties?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * A watershed's HUC4 else HUC2 code, zero-padded to its level as the studio
 * catalog pads it (src/config/place-catalog.ts); null unless it is that many digits.
 */
function hucCode(context: BoundarySelectionContext): string | null {
  for (const [key, digits] of [['huc4', 4], ['huc2', 2]] as const) {
    const code = codeProperty(context, key)?.padStart(digits, '0');
    if (code !== undefined) return new RegExp(`^\\d{${digits}}$`).test(code) ? code : null;
  }
  return null;
}

/**
 * The Place studio catalog entry a selected boundary names, read from the
 * feature's own code exactly as `placeRefFromBoundary` (src/config/entities.ts,
 * kept out of this eager module) reads it: STUSPS for a state, US_L4CODE else
 * US_L3CODE for an ecoregion, huc4 else huc2 for a watershed. Null for the
 * other kinds: a BIA or AIANNH area reaches a Tribal Nation only through the
 * lazily loaded roster crosswalk, and one land area can represent more than
 * one Nation.
 */
function typedPlaceFor(context: BoundarySelectionContext): TypedPlaceRef | null {
  const id =
    context.kind === 'state'
      ? codeProperty(context, 'STUSPS')
      : context.kind === 'ecoregion'
        ? (codeProperty(context, 'US_L4CODE') ?? codeProperty(context, 'US_L3CODE'))
        : context.kind === 'watershed'
          ? hucCode(context)
          : null;
  return id ? { kind: context.kind as 'state' | 'ecoregion' | 'watershed', id, label: context.title } : null;
}

/**
 * Set (or clear, with null) the current place selection and notify listeners.
 * A listener that throws does not stop the others.
 *
 * DR-099 (DDM-P2-T13): a selected state, ecoregion or watershed also replaces
 * the durable typed place, newest intent wins, so the Place studio reopens on
 * the place last picked on the map. Clearing (a popup closing) leaves the
 * durable place; a hazard-surface tap never reaches this setter.
 */
export function setPlaceSelection(selection: PlaceSelection | null): void {
  current = selection;
  const typed = selection ? typedPlaceFor(selection.context) : null;
  const durable = getTypedPlace();
  if (typed && (durable?.kind !== typed.kind || durable.id !== typed.id)) setTypedPlace(typed);
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
