/**
 * The renderer notice (DR-035a).
 *
 * One small element that says, honestly and briefly, that the map view is
 * not showing anything. It exists because the failure it names is the one
 * the honesty doctrine cannot tolerate: an interface that looks complete
 * while rendering nothing, indistinguishable from a broken deploy.
 *
 * Copy discipline. Each reason states only what was OBSERVED. The bounded
 * wait expiring is not evidence of a cause, so it says "not rendering yet"
 * and nothing more; a failed WebGL 2 probe or MapLibre's own
 * `GPUInitializationError` is evidence about the browser, so that one may
 * name WebGL 2. Neither claims a fix, a retry, or a diagnosis.
 */

/** What was observed. Nothing here is a guess at a cause. */
export type RendererNoticeReason = 'no-webgl2' | 'not-rendering';

const NOTICE_ID = 'renderer-notice';

const NOTICE_TEXT: Readonly<Record<RendererNoticeReason, string>> = {
  'no-webgl2': 'This browser has no WebGL 2, which the map needs.',
  'not-rendering': 'The map is not rendering yet.'
};

/**
 * Show the notice, or update it in place when one is already shown. Seats
 * itself in the map container so it reads as a statement about the map view
 * rather than about the whole page; falls back to the body when a host page
 * has trimmed the overlay markup, and no-ops without a document.
 */
export function showRendererNotice(reason: RendererNoticeReason): void {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('map-container') ?? document.body;
  if (!host) return;

  const existing = document.getElementById(NOTICE_ID);
  const notice = existing ?? document.createElement('p');
  notice.id = NOTICE_ID;
  notice.className = 'renderer-notice';
  notice.dataset.reason = reason;
  // A live region, not an alert: the state is durable and non-urgent, and
  // an assertive interruption would talk over the boot announcements.
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.textContent = NOTICE_TEXT[reason];
  if (!existing) host.appendChild(notice);
}

/**
 * Remove the notice. Called when a slow but healthy boot finally paints, so
 * the interface stops saying something that has stopped being true.
 */
export function hideRendererNotice(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(NOTICE_ID)?.remove();
}

/** The notice text for a reason; exported so a spec asserts the one copy. */
export function rendererNoticeText(reason: RendererNoticeReason): string {
  return NOTICE_TEXT[reason];
}
