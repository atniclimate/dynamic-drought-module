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
 */

/** Mirrors DESKTOP_SHELL_QUERY and the stylesheet's desktop breakpoint. */
const DESKTOP_MAP_SEAT_QUERY = '(min-width: 721px)';

/**
 * Move `node` into `host` while the desktop seat applies, and call
 * `restore` otherwise. `restore` must be idempotent: it runs on every
 * evaluation, including the first.
 *
 * Returns a dispose function that stops watching and restores the node.
 */
export function watchDesktopMapSeat(
  node: HTMLElement,
  host: HTMLElement,
  restore: () => void
): () => void {
  const app = document.getElementById('app');
  if (!app) return () => {};

  const widthQuery = window.matchMedia(DESKTOP_MAP_SEAT_QUERY);

  const sync = (): void => {
    const useHost =
      widthQuery.matches &&
      !app.classList.contains('embed') &&
      node.isConnected &&
      host.isConnected;
    if (useHost) {
      if (node.parentElement !== host) host.appendChild(node);
      return;
    }
    restore();
  };

  // The embed class is stamped on #app during boot and can land after this
  // watcher starts, so the seat follows the class rather than reading it
  // once.
  const observer = new MutationObserver(sync);
  observer.observe(app, { attributes: true, attributeFilter: ['class'] });
  widthQuery.addEventListener('change', sync);
  sync();

  return () => {
    observer.disconnect();
    widthQuery.removeEventListener('change', sync);
    restore();
  };
}
