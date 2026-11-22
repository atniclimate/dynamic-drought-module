/**
 * The About ATNI Climate card (`#about-atni`, a native popover) as a dialog.
 * Its doors are plain `popovertarget` buttons: the map's mark on a wide
 * screen and the last entry of the phone's Info sheet (the mark is not drawn
 * below 721px). The browser opens and closes the card; this module adds what
 * a dialog owes assistive technology: focus moves into the card when it
 * opens, the card's own Escape closes it without reaching a surface behind
 * it, and focus goes back to the door that opened it. Import-free, so a Node
 * test can drive it with a stand-in document.
 */

const ABOUT_ID = 'about-atni';
const DOOR_SELECTOR = `[popovertarget="${ABOUT_ID}"]`;

let disposeAboutCard: (() => void) | null = null;

export function initAboutCard(): void {
  disposeAboutCard?.();
  disposeAboutCard = null;

  const card = document.getElementById(ABOUT_ID);
  if (!card) return;

  // The door a click went through. A pointer does not focus a button in every
  // browser (Safari), so the click names the door before the card opens.
  let clickedDoor: HTMLElement | null = null;
  let opener: HTMLElement | null = null;

  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const door = target.closest<HTMLElement>(DOOR_SELECTOR);
    if (door) clickedDoor = door;
  };

  const onBeforeToggle = (event: Event): void => {
    if ((event as ToggleEvent).newState !== 'open') return;
    const active = document.activeElement as HTMLElement | null;
    opener = clickedDoor ?? (active && active !== document.body ? active : null);
    clickedDoor = null;
  };

  const onToggle = (event: Event): void => {
    if ((event as ToggleEvent).newState === 'open') {
      card.focus({ preventScroll: true });
      return;
    }
    const door = opener;
    opener = null;
    // Focus goes back only when it is lost (on the body or still in the
    // hidden card); a light dismiss onto another control keeps that control.
    const active = document.activeElement;
    const lost = active === null || active === document.body || card.contains(active);
    if (door?.isConnected && lost) door.focus({ preventScroll: true });
  };

  // The card owns its Escape: closed here and marked used, so a map popup or
  // drawer behind it does not close with it.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    card.hidePopover();
  };

  document.addEventListener('click', onClick, true);
  card.addEventListener('beforetoggle', onBeforeToggle);
  card.addEventListener('toggle', onToggle);
  card.addEventListener('keydown', onKeyDown);

  disposeAboutCard = () => {
    document.removeEventListener('click', onClick, true);
    card.removeEventListener('beforetoggle', onBeforeToggle);
    card.removeEventListener('toggle', onToggle);
    card.removeEventListener('keydown', onKeyDown);
  };
}
