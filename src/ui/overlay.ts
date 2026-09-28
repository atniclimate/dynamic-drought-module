/**
 * Loading indicator and toast helpers for the Dynamic Drought Module (DDM).
 *
 * This module is a direct port of the vanilla `app.js` v0.1.2 token-based
 * loading helpers (~lines 1268-1304) and the `showToast` animation helper
 * (~lines 1346-1358). The token API exists so parallel layer activations can
 * complete out of order without one's `hideLoading` clobbering the indicator
 * text of another's still-pending load.
 *
 * Behavior contract (preserved from the v0.1.2 polish):
 *
 *   1. `showLoading(text)` returns an opaque numeric token. The token is
 *      added to a module-level `PENDING_LOADS` Map so the most-recent
 *      pending text can be surfaced.
 *   2. `hideLoading(token)` removes the entry. Null- and undefined-token
 *      safe (a caller that lost track of its token simply causes a no-op).
 *   3. `refreshLoadingIndicator()` reads the most-recent value from the
 *      Map (Map preserves insertion order; iterating `.values()` and
 *      keeping the last yields the most-recently-added text) and writes
 *      it to `#loading-text`. Hides `#loading-indicator` when the Map is
 *      empty.
 *   4. `showToast(message)` writes the text into `#copy-toast`, forces a
 *      reflow, animates in via `.visible` for 1700 ms, fades out for
 *      250 ms, then sets `el.hidden = true`.
 *
 * The indicator and toast DOM nodes (`#loading-indicator`, `#loading-text`,
 * `#copy-toast`) live in `index.html`; their styles live in
 * `src/styles/app.css`. This module owns only the show/hide state machine.
 *
 * The named exports are a frozen cross-module contract; do not rename them.
 */

import { watchDesktopMapSeat } from './map-control-seat';

/**
 * Map of in-flight load tokens to their text. Insertion order is preserved
 * by JavaScript Maps, so iterating `.values()` and keeping the final value
 * yields the most-recently-added pending text.
 */
const PENDING_LOADS = new Map<number, string>();

/**
 * The toast's seat (S30D D1 M10; register found-018; design record
 * interface-chrome-popups-text.md section 2.5's "found-018" note): on the
 * desktop shell, outside an embed, the copy toast moves into the bottom
 * dock as a notice, because the top-centre band belongs to the pill alone
 * (the pill yields to nothing) and today the toast's own top-centre
 * position competed with it and with the hover inspector at the same
 * spot. The SAME node moves (never rebuilt), watched lazily so a page
 * with no toast yet never touches the DOM for it, and it is a `let` the
 * module keeps rather than a static index.html marker: `#copy-toast`
 * already has exactly one home in the markup, so the watcher reads
 * that home once instead of asking index.html to declare a second one.
 */
let toastSeatWatched = false;
function watchToastSeat(): void {
  if (toastSeatWatched) return;
  toastSeatWatched = true;
  const toast = document.getElementById('copy-toast');
  const notices = document.getElementById('map-notices');
  const home = toast?.parentElement ?? null;
  if (!toast || !notices || !home) return;
  // Out-of-flow (position: absolute, an explicit z-index): where among its
  // siblings it sits does not change what is visible, so returning it home
  // is just "back in that parent" with no ordering to preserve.
  watchDesktopMapSeat({
    node: toast,
    host: notices,
    home,
    placeHome: () => {
      if (toast.parentElement !== home) home.appendChild(toast);
    }
  });
}

/**
 * Monotonic token counter. The first token returned is `1`; tokens are
 * never reused so a stale `hideLoading(oldToken)` after `showLoading` was
 * cleared is a safe no-op.
 */
let nextLoadToken = 0;

/**
 * Begin tracking a pending load. Adds the supplied text to the pending
 * map and refreshes the visible indicator. Returns a token the caller
 * passes to `hideLoading` once the load resolves (or rejects).
 *
 * The text is the user-facing label shown next to the spinner; pass a
 * specific phrase per the v0.1.2 polish convention (for example,
 * `Loading Hydrography...`).
 */
export function showLoading(text: string): number {
  const token = ++nextLoadToken;
  PENDING_LOADS.set(token, text);
  refreshLoadingIndicator();
  return token;
}

/**
 * Stop tracking a previously-started load. Idempotent and tolerant of
 * `null` (callers may have cleared the token reference). Refreshes the
 * indicator so a stack of parallel loads collapses cleanly when each
 * resolves.
 */
export function hideLoading(token: number | null | undefined): void {
  if (token === null || token === undefined) return;
  PENDING_LOADS.delete(token);
  refreshLoadingIndicator();
}

/**
 * Show the toast element with `message` for ~1700 ms, then fade out over
 * 250 ms and set `hidden = true`. Forces a reflow before adding the
 * `.visible` class so the CSS transition runs from the hidden state on
 * every call (matches the vanilla v0.1.2 behavior; if the element was
 * already visible, the timer cycle restarts).
 *
 * Silently no-ops when `#copy-toast` is missing from the DOM so the
 * helper can be called unconditionally during boot wiring.
 */
export function showToast(message: string): void {
  watchToastSeat();
  const el = document.getElementById('copy-toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  // Force reflow so the class transition runs from the hidden state.
  void el.offsetWidth;
  el.classList.add('visible');
  window.setTimeout(() => {
    el.classList.remove('visible');
    window.setTimeout(() => {
      el.hidden = true;
    }, 250);
  }, 1700);
}

/**
 * Reflect the current pending-loads state in the DOM. Hides the
 * indicator when no loads are pending; otherwise shows the
 * most-recently-added load's text.
 *
 * Internal helper; not exported. Both `showLoading` and `hideLoading`
 * call it after mutating `PENDING_LOADS`.
 */
function refreshLoadingIndicator(): void {
  const indicator = document.getElementById('loading-indicator');
  if (!indicator) return;

  if (PENDING_LOADS.size === 0) {
    indicator.hidden = true;
    return;
  }

  const textEl = document.getElementById('loading-text');
  if (textEl) {
    let lastText = 'Loading...';
    for (const value of PENDING_LOADS.values()) lastText = value;
    textEl.textContent = lastText;
  }
  indicator.hidden = false;
}
