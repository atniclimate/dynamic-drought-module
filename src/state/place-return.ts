/**
 * The PLACE studio's exit hand-off: what runs on the map once the studio
 * has unmounted and `restoreDisplaySnapshot()` has put the captured display
 * back.
 *
 * Two callers queue work here and they do not know about each other:
 *
 * - The studio itself queues the BRIEFING of the explicitly selected place
 *   (place-studio.tsx). It re-registers on every selection change and clears
 *   when the selection changes, so "newest selection wins" is the rule for
 *   that slot.
 * - The main-screen shell queues a DISPLAY COMMAND (a cluster or horizon
 *   chosen from the sidebar while the studio was open; shell.tsx
 *   `runDisplayCommand`). The studio would strip that command while open
 *   and overwrite it on exit, so it is deferred behind the exit instead.
 *   "Newest command wins" is the rule for that slot.
 *
 * They used to share ONE slot, so a cluster click after a selection silently
 * dropped the promised briefing (the /code-review regression of 2026-09-10).
 * Two slots, composed at the moment the island takes them, let each keep its
 * own replace rule without either wiping the other. The composed order is
 * display command FIRST, then briefing: the user's last act was the hazard
 * choice, the map should land on it, and the briefing then opens against
 * the display that stands rather than being re-read under it.
 *
 * This module has no imports on purpose: it runs under `node --test`
 * (tests/place-return.test.mjs) with nothing stubbed.
 */

export type PlaceReturnAction = () => void;

let briefing: PlaceReturnAction | null = null;
let displayCommand: PlaceReturnAction | null = null;

/** Queue (or clear) the selected-exit briefing. Newest registration wins. */
export function setPlaceReturnBriefing(action: PlaceReturnAction | null): void {
  briefing = action;
}

/** Queue (or clear) the deferred sidebar display command. Newest wins. */
export function setPlaceReturnDisplayCommand(
  action: PlaceReturnAction | null
): void {
  displayCommand = action;
}

/** Drop both hand-offs: the studio exit that voids them (exit into the other studio). */
export function clearPlaceReturn(): void {
  briefing = null;
  displayCommand = null;
}

/**
 * Take (and clear) the composed hand-off, or null when nothing is queued.
 * The display command runs before the briefing (see the module comment).
 */
export function takePlaceReturn(): PlaceReturnAction | null {
  const command = displayCommand;
  const brief = briefing;
  displayCommand = null;
  briefing = null;
  if (command && brief) {
    return () => {
      command();
      brief();
    };
  }
  return command ?? brief;
}
