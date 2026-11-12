/**
 * Seats for map chrome that lives in different places on different shells.
 *
 * Owner direction 2026-08-19 moved two pieces of chrome into the top-right
 * control column on the desktop shell: the satellite toggle (so the three
 * map buttons finally read as the one family the E2 ruling describes) and
 * the on-map key. Neither move is right inside an embed, which stacks the
 * key full width in the bottom dock and keeps the satellite button in
 * MapLibre's corner.
 *
 * Owner direction 2026-11-09 (sprint), DR-pending, adds a third seat: while
 * the phone shell is active every right-edge control sits in the ONE column
 * src/ui/edge-column.ts owns, so two independently anchored stacks can no
 * longer meet on a short screen. A seat that names a `phone` place rides
 * that column there and returns to its desktop or home seat everywhere
 * else.
 *
 * The SAME node moves; nothing is cloned or rebuilt, so live content,
 * listeners, control state, and focus survive the move. This is the idiom
 * the desktop Brief shell already uses for the legend
 * (src/ui/island/shell.tsx), narrowed to one node and one condition.
 *
 * COOPERATION IS THE HARD PART. The LAYERS studio also rehosts the
 * satellite control, into its own header, and restores it on close
 * (src/ui/island/layers-studio.tsx). Two watchers pulling one node in
 * opposite directions is a fight neither wins: the first version of this
 * helper moved the control out of the studio header the moment the studio
 * opened, and the studio's own specs caught it. So this watcher claims
 * ownership only while the node sits in one of the seats it manages.
 * Anything else holding the node is left alone, and the node returns to
 * this watcher's care when that owner puts it back.
 */

import type { EdgeGroupId } from '../config/edge-column';

/** Mirrors DESKTOP_SHELL_QUERY and the stylesheet's desktop breakpoint. */
const DESKTOP_MAP_SEAT_QUERY = '(min-width: 721px)';

/** A place in the phone shell's right-edge column. */
export interface PhoneSeat {
  /** The group the control belongs to. */
  readonly group: EdgeGroupId;
  /** Position inside the group, ascending from the top. */
  readonly order: number;
  /** The short word shown under the glyph. Must appear in the control's accessible name (WCAG 2.5.3). */
  readonly word?: string;
}

/**
 * What the phone column offers the seat watchers. The column registers
 * itself; this module never imports it, so the dependency runs one way.
 */
export interface PhoneSeatProvider {
  /** The element that holds a group's controls, or null while the column is not mounted. */
  hostFor(group: EdgeGroupId): HTMLElement | null;
  /** Put `node` in its place inside the group, in order. */
  place(node: HTMLElement, seat: PhoneSeat): void;
  /** Remove what `place` stamped, just before the node leaves the column. */
  release(node: HTMLElement): void;
}

let phoneSeatProvider: PhoneSeatProvider | null = null;
const phoneSeatWatchers = new Set<() => void>();

/** Register the phone column. Every live watcher re-evaluates at once. */
export function setPhoneSeatProvider(provider: PhoneSeatProvider | null): void {
  phoneSeatProvider = provider;
  notifyPhoneSeats();
}

/** The column mounted, unmounted, or changed its hosts: re-evaluate every seat. */
export function notifyPhoneSeats(): void {
  for (const sync of [...phoneSeatWatchers]) sync();
}

export interface DesktopMapSeat {
  /** The chrome node that moves. */
  readonly node: HTMLElement;
  /** Where it sits on the desktop shell. */
  readonly host: HTMLElement;
  /** The container it belongs to everywhere else. */
  readonly home: HTMLElement;
  /** Idempotent placement inside `home`; runs whenever no other seat applies. */
  readonly placeHome: () => void;
  /** Its place in the phone column, when it has one. */
  readonly phone?: PhoneSeat;
}

export interface PhoneOnlySeat {
  /** The chrome node that moves. */
  readonly node: HTMLElement;
  /** The container it belongs to outside the phone shell. */
  readonly home: HTMLElement;
  /** Idempotent placement inside `home`. */
  readonly placeHome: () => void;
  /** Its place in the phone column. */
  readonly phone: PhoneSeat;
}

interface SeatCore {
  readonly node: HTMLElement;
  readonly host: HTMLElement | null;
  readonly home: HTMLElement;
  readonly placeHome: () => void;
  readonly phone?: PhoneSeat;
}

function watchSeat(seat: SeatCore): () => void {
  const app = document.getElementById('app');
  if (!app) return () => {};

  const widthQuery = window.matchMedia(DESKTOP_MAP_SEAT_QUERY);
  /** The phone host this watcher last placed the node in. */
  let phoneHost: HTMLElement | null = null;

  /**
   * True only while this watcher is the node's current custodian. A
   * detached node (or one another surface has borrowed) is not ours to
   * move.
   */
  const ours = (): boolean => {
    const parent = seat.node.parentElement;
    return (
      parent !== null &&
      (parent === seat.host || parent === seat.home || parent === phoneHost)
    );
  };

  /**
   * The control inside the node that holds focus, kept while the browser's
   * focus fixup drops it. The width flips the stylesheet (the phone column is
   * display:none above 720px) a task before the shell attribute moves the
   * node, so by the time this watcher runs focus may already sit on the body.
   */
  let held: HTMLElement | null = null;
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    held = target instanceof HTMLElement && seat.node.contains(target) ? target : null;
  };
  const onFocusOut = (event: FocusEvent): void => {
    // Leaving a control that is still rendered is the user's choice; only a
    // control the stylesheet hid keeps its claim.
    if (event.target instanceof HTMLElement && event.target.getClientRects().length > 0) {
      held = null;
    }
  };
  document.addEventListener('focusin', onFocusIn);
  seat.node.addEventListener('focusout', onFocusOut);

  /** Moving a focused node drops focus to the body; hand it back. */
  const keepFocus = (move: () => void): void => {
    const active = document.activeElement;
    const onBody = active === null || active === document.body;
    const focused =
      active instanceof HTMLElement && seat.node.contains(active)
        ? active
        : onBody && held !== null && seat.node.contains(held)
          ? held
          : null;
    move();
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  };

  const sync = (): void => {
    if (!seat.home.isConnected || (seat.host !== null && !seat.host.isConnected)) return;
    if (!ours()) return;
    const embed = app.classList.contains('embed');
    const target =
      seat.phone && !embed ? (phoneSeatProvider?.hostFor(seat.phone.group) ?? null) : null;
    if (target && seat.phone) {
      const place = seat.phone;
      if (seat.node.parentElement !== target) {
        keepFocus(() => phoneSeatProvider?.place(seat.node, place));
      }
      phoneHost = target;
      return;
    }
    const leaving = seat.node.parentElement === phoneHost && phoneHost !== null;
    const move = (): void => {
      if (leaving) phoneSeatProvider?.release(seat.node);
      if (seat.host !== null && widthQuery.matches && !embed) {
        if (seat.node.parentElement !== seat.host) seat.host.appendChild(seat.node);
      } else {
        seat.placeHome();
      }
    };
    if (leaving) keepFocus(move);
    else move();
    if (seat.node.parentElement !== phoneHost) phoneHost = null;
  };

  // The embed class is stamped on #app during boot and can land after this
  // watcher starts, so the seat follows the class rather than reading it
  // once. The same observer re-evaluates when a full-screen route releases
  // the chrome it borrowed.
  const observer = new MutationObserver(sync);
  observer.observe(app, { attributes: true, attributeFilter: ['class'] });
  widthQuery.addEventListener('change', sync);
  phoneSeatWatchers.add(sync);
  sync();

  return () => {
    observer.disconnect();
    widthQuery.removeEventListener('change', sync);
    phoneSeatWatchers.delete(sync);
    document.removeEventListener('focusin', onFocusIn);
    seat.node.removeEventListener('focusout', onFocusOut);
    if (ours()) {
      if (seat.node.parentElement === phoneHost && phoneHost !== null) {
        phoneSeatProvider?.release(seat.node);
      }
      seat.placeHome();
    }
  };
}

/**
 * Keep one node in its desktop seat while the desktop shell applies, in the
 * phone column while the phone shell applies and the seat names a place
 * there, and in its home seat otherwise. Returns a dispose function that
 * stops watching and returns the node home.
 */
export function watchDesktopMapSeat(seat: DesktopMapSeat): () => void {
  return watchSeat(seat);
}

/**
 * Keep one node in the phone column while the phone shell applies and at
 * home otherwise. For chrome with no separate desktop seat (Share, Reset,
 * the panel doors, the hazard views).
 */
export function watchPhoneSeat(seat: PhoneOnlySeat): () => void {
  return watchSeat({ ...seat, host: null });
}
