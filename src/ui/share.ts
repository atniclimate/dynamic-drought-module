import { copyToClipboard } from '../util/clipboard';
import { showToast } from './overlay';
import type { SelectParam } from '../state/url';
import { isPhysicallyFramed } from '../state/studio-route';

/**
 * Build the shareable link for the current view: `window.location.href`,
 * optionally carrying the one-shot `select=<kind>:<id>` deep-link parameter
 * (`SelectParam`, src/state/url.ts). The only kind ever passed is 'state':
 * the typed briefing place is never durable URL state (src/state/typed-place.ts),
 * so a state's `select=` token is the sole shareable place. The Share button
 * below and the Impact Briefing's Email control (D1 M21) both build their
 * link here, so there is one URL builder, not two.
 */
export function buildShareLink(selectParam?: SelectParam): string {
  if (!selectParam) return window.location.href;
  const url = new URL(window.location.href);
  url.searchParams.set('select', `${selectParam.kind}:${selectParam.id}`);
  return url.toString();
}

/**
 * Wire the "Share view" button to copy the current location URL to the
 * clipboard and surface a toast indicating success or failure. The
 * caller passes the DOM `id` of the button (the vanilla baseline used
 * `share-btn`).
 *
 * Behavior matches the vanilla baseline: the button copies
 * `window.location.href` (so any current URL parameter state, including
 * the embed flag, travels with the link) and shows a toast with one of
 * two messages depending on whether the copy succeeded. The fallback
 * message guides the user to the address bar when both clipboard paths
 * in `copyToClipboard` are blocked.
 *
 * If the button id is not present in the DOM the function silently
 * no-ops; this lets `wireShareButton` be called unconditionally during
 * boot without needing the caller to reach into the DOM.
 *
 * S30D D1 M13 (register found-010, found-017; precedence.md row H4): the
 * copied link carries every durable URL key (region or framing, layers,
 * mode, horizon and the rest of RECOGNIZED_URL_KEYS) and never the panned
 * camera or the open briefing place, because neither is ever URL state
 * (src/state/typed-place.ts). The success toast says so, plainly, so the
 * confirmation states the same contract as the button's own name and
 * title in index.html.
 */
/**
 * What the copied or shared link restores, stated once so the copy toast and
 * the share toast cannot drift apart (S30D D1 M13; precedence.md row H4).
 */
const LINK_RESTORES =
  'It restores region or framing, layers, mode and horizon, not the map position or an open briefing.';

/**
 * Hand the link to the device's own share sheet (Web Share), on phones only
 * (owner direction 2026-11-09 (sprint), DR-pending). A person in the field
 * sends a view by message far more often than they paste it, and the sheet
 * is where their messaging lives. The payload is the same link the copy path
 * writes and nothing else: no position, no place the URL does not already
 * carry. Returns `shared` when the sheet completed, `dismissed` when the
 * person closed it (which needs no toast and no fallback), and `unavailable`
 * when the browser has no sheet or refused the payload, so the caller falls
 * back to the clipboard. Must be called inside the press that asked for it.
 */
async function shareThroughSystemSheet(
  url: string
): Promise<'shared' | 'dismissed' | 'unavailable'> {
  // The phone shell stamps this attribute; desktop and embeds keep the copy path.
  if (!document.getElementById('app')?.hasAttribute('data-sheet-detent')) return 'unavailable';
  if (typeof navigator.share !== 'function') return 'unavailable';
  const data: ShareData = { title: document.title, url };
  if (typeof navigator.canShare === 'function' && !navigator.canShare(data)) return 'unavailable';
  try {
    await navigator.share(data);
    return 'shared';
  } catch (err) {
    return err instanceof DOMException && err.name === 'AbortError' ? 'dismissed' : 'unavailable';
  }
}

export function wireShareButton(buttonId: string): void {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const link = buildShareLink();
    const sheet = await shareThroughSystemSheet(link);
    if (sheet === 'dismissed') return;
    if (sheet === 'shared') {
      showToast(`Link shared. ${LINK_RESTORES}`);
      return;
    }
    const ok = await copyToClipboard(link);
    showToast(
      ok
        ? `Link copied. ${LINK_RESTORES}`
        : isPhysicallyFramed()
          // In a frame the address bar belongs to the host page and carries none of this view's state.
          ? 'Copy blocked here. Open this map in its own browser tab to copy this view.'
          : 'Copy blocked. Use the address bar to copy this view.'
    );
  });
}
