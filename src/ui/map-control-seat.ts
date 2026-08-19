/**
 * Desktop seats for map chrome that lives elsewhere on phones and in embeds.
 *
 * Owner direction 2026-08-19 moved two pieces of chrome into the top-right
 * control column: the satellite toggle (so the three map buttons finally
 * read as the one family the E2 ruling describes) and the on-map key.
 * Neither move is right below 721px or inside an embed: the phone shell
 * reserves a fixed top bar for the key and a thumb-zone seat for the
 * satellite button, and the narrow embed stacks the key full width in the
 * bottom dock. Both layouts were designed around those seats and keep them.
 *
 * The SAME node moves; nothing is cloned or rebuilt, so live content,
 * listeners, control state, and focus survive the move. This is the idiom
 * the desktop Brief shell already uses for the Share button and the legend
 * (src/ui/island/shell.tsx), narrowed to one node and one condition.
 *
 * COOPERATION IS THE HARD PART. The LAYERS studio also rehosts the
 * satellite control, into its own header, and restores it on close
 * (src/ui/island/layers-studio.tsx). Two watchers pulling one node in
 * opposite directions is a fight neither wins: the first version of this
 * helper moved the control out of the studio header the moment the studio
 * opened, and the studio's own specs caught it. So this watcher claims
 * ownership only while the node sits in one of the two seats it manages.
 * Anything else holding the node is left alone, and the node returns to
 * this watcher's care when that owner puts it back.
 */

/** Mirrors DESKTOP_SHELL_QUERY and the stylesheet's desktop breakpoint. */
const DESKTOP_MAP_SEAT_QUERY = '(min-width: 721px)';

export interface DesktopMapSeat {
  /** The chrome node that moves. */
  readonly node: HTMLElement;
  /** Where it sits on the desktop shell. */
  readonly host: HTMLElement;
  /** The container it belongs to everywhere else. */
  readonly home: HTMLElement;
  /** Idempotent placement inside `home`; runs whenever the seat does not apply. */
  readonly placeHome: () => void;
}

/**
 * Keep one node in its desktop seat while the desktop shell applies, and in
 * its home seat otherwise. Returns a dispose function that stops watching
 * and returns the node home.
 */
export function watchDesktopMapSeat(seat: DesktopMapSeat): () => void {
  const app = document.getElementById('app');
  if (!app) return () => {};

  const widthQuery = window.matchMedia(DESKTOP_MAP_SEAT_QUERY);

  /**
   * True only while this watcher is the node's current custodian. A
   * detached node (or one another surface has borrowed) is not ours to
   * move.
   */
  const ours = (): boolean => {
    const parent = seat.node.parentElement;
    return parent === seat.host || parent === seat.home;
  };

  const sync = (): void => {
    if (!seat.host.isConnected || !seat.home.isConnected) return;
    if (!ours()) return;
    const useHost = widthQuery.matches && !app.classList.contains('embed');
    if (useHost) {
      if (seat.node.parentElement !== seat.host) seat.host.appendChild(seat.node);
      return;
    }
    seat.placeHome();
  };

  // The embed class is stamped on #app during boot and can land after this
  // watcher starts, so the seat follows the class rather than reading it
  // once. The same observer re-evaluates when a full-screen route releases
  // the chrome it borrowed.
  const observer = new MutationObserver(sync);
  observer.observe(app, { attributes: true, attributeFilter: ['class'] });
  widthQuery.addEventListener('change', sync);
  sync();

  return () => {
    observer.disconnect();
    widthQuery.removeEventListener('change', sync);
    if (ours()) seat.placeHome();
  };
}
