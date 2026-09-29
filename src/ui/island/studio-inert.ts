/**
 * Scope a screen-filling studio's inert / aria-hidden veil to what it
 * actually covers, instead of blanketing the whole #app.
 *
 * At desktop widths (>= 721px, the same breakpoint the studio's own CSS
 * geometry and src/ui/mobile-sheet.ts both key off) a studio slides out
 * BESIDE the nav sidebar rather than over it: the sidebar stays a live,
 * focusable, screen-reader-visible column, and the studio's box exactly
 * matches #map-container's. So everything in #app except the sidebar
 * itself goes inert there: #map-container (the map and its chrome) and
 * any sibling that can end up visually under the studio, such as the
 * #sidebar-expand corner button when the sidebar is collapsed or embed
 * (the studio then paints edge-to-edge and covers that corner too).
 *
 * Below 721px the sidebar is not a column at all: it becomes a bottom
 * sheet OVER the map (mobile-sheet.ts), and the same full-viewport
 * studio covers that sheet along with everything else. There the whole
 * #app must go inert, matching the behaviour shipped before this change
 * byte for byte.
 *
 * The breakpoint is re-checked live (a MediaQueryList change listener),
 * so a studio that stays open across a resize or orientation change
 * (desktop window resize, an embedding page reflowing its iframe) keeps
 * the correct element inert rather than the one true at mount time.
 *
 * Call once from a studio's mount effect; call the returned cleanup from
 * that effect's teardown.
 */
export function applyStudioInertScope(): () => void {
  const mql = window.matchMedia('(min-width: 721px)');
  const appEl = document.getElementById('app');
  const sidebarEl = document.getElementById('sidebar');

  let current: readonly HTMLElement[] = [];
  const priorAriaHidden = new Map<HTMLElement, string | null>();

  function release(): void {
    for (const el of current) {
      el.inert = false;
      const prior = priorAriaHidden.get(el) ?? null;
      if (prior === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', prior);
    }
    current = [];
    priorAriaHidden.clear();
  }

  function desiredTargets(): readonly HTMLElement[] {
    if (!appEl) return [];
    if (!mql.matches) return [appEl];
    // Desktop: the sidebar stays live; inert every other direct child of
    // #app (today that is #sidebar-expand and #map-container). Walking
    // the children rather than naming #map-container alone keeps any
    // future sibling of the sidebar correctly covered too.
    return Array.from(appEl.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== sidebarEl
    );
  }

  function apply(): void {
    release();
    current = desiredTargets();
    for (const el of current) {
      priorAriaHidden.set(el, el.getAttribute('aria-hidden'));
      el.inert = true;
      el.setAttribute('aria-hidden', 'true');
    }
  }

  apply();
  mql.addEventListener('change', apply);

  return () => {
    mql.removeEventListener('change', apply);
    release();
  };
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab and Shift+Tab inside `root` (found-004): at the last focusable
 * descendant Tab wraps to the first, and at the first Shift+Tab wraps to
 * the last, so an open studio can never hand focus to the live app behind
 * it (the sidebar stays live at desktop widths, `applyStudioInertScope`
 * above, so it is reachable only through this trap, never left implicitly).
 *
 * Bound on `document` in the CAPTURE phase rather than on `root` itself:
 * `root` is a plain DOM node this module's caller creates and removes
 * directly (view-shell.ts, sidebar.ts), outside the Preact tree that
 * later rehosts controls (the telemetry panel, the basemap switcher) into
 * it, so a listener attached once at mount time on `root` would still see
 * every later Tab whose target is a `root` descendant; capturing at the
 * document is only to run ahead of any other document-level key handling,
 * with no side effect on calls not inside `root`. Elements are re-queried on every Tab rather than
 * cached, so newly rehosted or removed controls are always current.
 */
export function trapStudioTabFocus(root: HTMLElement): () => void {
  function focusable(): readonly HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return;
    const items = focusable();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}

/**
 * Escape does exactly what "Back to map" does (found-004): close `root`'s
 * studio the same way its own rendered Back button would, so the Place
 * studio's pending-selection wait (`handleBack`) is honored identically
 * whether the user presses Escape or clicks the button by hand.
 *
 * Bound on `document` at ROOT-CREATION time (view-shell.ts, sidebar.ts),
 * in the SAME place and lifetime as `trapStudioTabFocus` above, rather
 * than inside the lazily loaded studio component's own effect: `root` is
 * a plain DOM node those callers create and append synchronously on the
 * press, well before the studio's chunk has loaded, mounted and painted a
 * component effect of its own. An Escape pressed in that window used to
 * meet no listener at all and was silently lost (found-012's held-chunk
 * race; the M15 repair round moved this handler here for exactly that
 * reason). `backSelector` names the studio's own rendered Back button
 * ('#place-studio-back', '.layers-studio-back'); while it has not yet
 * mounted (the chunk is still held, or failed and the failure panel's own
 * Back button has not painted either) `root.querySelector` finds nothing
 * and `fallback` runs instead, ending in the exact same route exit the
 * Back button (rendered or failure-panel) would have used.
 *
 * Bubble phase, NOT capture, and skipped whenever `event.defaultPrevented`
 * is already true: an Escape a control inside the studio has already
 * consumed for its own purpose (the shared Search component clears its
 * query on Escape rather than leaving the studio) must never ALSO close
 * the studio underneath it.
 */
export function bindStudioEscape(
  root: HTMLElement,
  backSelector: string,
  fallback: () => void
): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (event.defaultPrevented) return;
    event.preventDefault();
    const back = root.querySelector<HTMLButtonElement>(backSelector);
    if (back) back.click();
    else fallback();
  }

  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
