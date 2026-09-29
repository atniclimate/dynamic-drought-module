import { copyToClipboard } from '../util/clipboard';
import { showToast } from './overlay';
import type { SelectParam } from '../state/url';

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
export function wireShareButton(buttonId: string): void {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const ok = await copyToClipboard(buildShareLink());
    showToast(
      ok
        ? 'Link copied. It restores region or framing, layers, mode and horizon, not the map position or an open briefing.'
        : 'Copy blocked. Use the address bar to copy this view.'
    );
  });
}
