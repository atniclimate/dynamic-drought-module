/**
 * Shared discipline for the shell's compact "Map areas" minimap popover
 * (the S4c focus-restoration contract):
 *
 *   - FOCUS: opening moves focus to the first operable control inside
 *     the card; closing restores focus to the door that opened it, or to
 *     the given fallback when the door has unmounted (a spec teardown
 *     can re-render the compact row without its button; focus must never
 *     silently drop to the document body).
 *
 *   - LIGHT DISMISS IS ONE GESTURE: a pointer press outside an open
 *     popover closes it AND is consumed, so the same press can never
 *     simultaneously click through to the MapLibre canvas and open a
 *     response or move a selection the user never meant to make. The
 *     press on the door itself is left alone (the native popovertarget
 *     toggling owns it).
 */

/** Wire the discipline onto a popover element. Returns a disposer. */
export function wireShellPopover(
  pop: HTMLElement,
  getDoor: () => HTMLElement | null,
  getFallbackFocus?: () => HTMLElement | null
): () => void {
  let swallowNextClick = false;
  let swallowTimer: ReturnType<typeof setTimeout> | undefined;
  // A dismissing press that becomes a pan fires no click: the flag must not
  // outlive the gesture and cancel the next real tap.
  const clearSwallow = (): void => {
    swallowNextClick = false;
    clearTimeout(swallowTimer);
  };

  const onToggle = (event: Event): void => {
    const state = (event as ToggleEvent).newState;
    // The door is a disclosure: reflect the popover's open state on it
    // (W2-D9) so it matches the app's other aria-expanded disclosures.
    getDoor()?.setAttribute('aria-expanded', String(state === 'open'));
    if (state === 'open') {
      pop
        .querySelector<HTMLElement>('button:not([disabled]), input, [tabindex="0"]')
        ?.focus();
    } else {
      const door = getDoor();
      if (door && door.isConnected) {
        door.focus();
      } else {
        getFallbackFocus?.()?.focus();
      }
    }
  };

  const onPointerDown = (event: Event): void => {
    clearSwallow();
    if (!pop.matches(':popover-open')) return;
    const target = event.target instanceof Node ? event.target : null;
    const door = getDoor();
    if (target && (pop.contains(target) || (door?.contains(target) ?? false))) {
      return;
    }
    // Close and consume: the dismissal is the whole gesture.
    event.preventDefault();
    event.stopPropagation();
    swallowNextClick = true;
    swallowTimer = setTimeout(clearSwallow, 400);
    pop.hidePopover();
  };

  const onClick = (event: Event): void => {
    if (!swallowNextClick) return;
    clearSwallow();
    event.preventDefault();
    event.stopPropagation();
  };

  pop.addEventListener('toggle', onToggle);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointercancel', clearSwallow, true);
  document.addEventListener('click', onClick, true);
  return () => {
    clearSwallow();
    pop.removeEventListener('toggle', onToggle);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointercancel', clearSwallow, true);
    document.removeEventListener('click', onClick, true);
  };
}
