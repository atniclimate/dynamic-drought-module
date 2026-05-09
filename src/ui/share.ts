import { copyToClipboard } from '../util/clipboard';
import { showToast } from './overlay';

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
 */
export function wireShareButton(buttonId: string): void {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const ok = await copyToClipboard(window.location.href);
    showToast(
      ok
        ? 'Link copied to clipboard'
        : 'Copy blocked. Use the address bar to copy this view.'
    );
  });
}
