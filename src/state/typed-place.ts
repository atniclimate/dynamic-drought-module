/**
 * Durable typed-place store (S1; plan 9.11's ONE selection
 * architecture; D-0.7.0-035 ruling 2, D-0.7.0-046).
 *
 * The typed briefing place is the second named axis of the selection
 * architecture (the first is the camera-only framing context). It is
 * DURABLE APPLICATION STATE: it survives panel close, screen changes,
 * and studio round trips, unlike the existing popup-scoped
 * `PlaceSelection` (src/state/place-selection.ts), which clears when
 * its popup closes. The two stores coexist until a later unit
 * reconciles the boundary-click path onto this one.
 *
 * NEVER URL STATE: there is no typed-place URL parameter and no
 * coordinate parameter in any form (D-0.7.0-035 ruling 2, D-0.7.0-046;
 * a shared link must never disclose a person's location). The one-shot
 * `select=` boot command remains the only shareable place mechanism.
 * Clearing is an explicit user control; the ALL reset does not touch
 * the selected place (D-0.7.0-041).
 *
 * Same observable-singleton pattern as place-selection.ts: synchronous
 * setter, snapshot getter, unsubscribe-returning listener registration,
 * and listener isolation (one throwing listener does not stop the
 * others).
 */

/**
 * The four place types of the studio catalogs (plan 9.11). For
 * 'tribe', the subject is the TRIBAL NATION from the Federal Register
 * roster, never a polygon (roster-first, D-0.7.0-047); the id is the
 * roster identity and the boundary representation, when one safely
 * crosswalks, stays a representation with its caveat.
 */
export type TypedPlaceKind = 'tribe' | 'state' | 'ecoregion' | 'watershed';

export interface TypedPlaceRef {
  readonly kind: TypedPlaceKind;
  /** Stable identifier within the kind's catalog (roster identity,
   * state postal code, ecoregion code, hydrologic unit code). */
  readonly id: string;
  /** Display label; for a Tribal Nation, the full formal name. */
  readonly label: string;
}

let current: TypedPlaceRef | null = null;
const listeners = new Set<(place: TypedPlaceRef | null) => void>();

/** The durable typed place, or null when none is selected. */
export function getTypedPlace(): TypedPlaceRef | null {
  return current;
}

/**
 * Set (or clear, with null) the durable typed place and notify
 * listeners. A listener that throws does not stop the others.
 */
export function setTypedPlace(place: TypedPlaceRef | null): void {
  current = place;
  for (const listener of listeners) {
    try {
      listener(place);
    } catch (err) {
      console.error('[typed-place] listener threw:', err);
    }
  }
}

/** Subscribe to typed-place changes. Returns an unsubscribe function. */
export function onTypedPlaceChange(
  listener: (place: TypedPlaceRef | null) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
