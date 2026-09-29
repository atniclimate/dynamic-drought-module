/**
 * Veil the whole #app behind an open studio: inert and aria-hidden, at
 * every width (DR-169, ratified 2026-09-29, RATIFICATION-8, overriding
 * this module's 2026-09-13 desktop-dock design below).
 *
 * Before DR-169, a desktop studio (>= 721px) docked beside the nav
 * sidebar and left it live, so only #map-container and its siblings went
 * inert; below 721px, where the sidebar is a bottom sheet OVER the map
 * (mobile-sheet.ts), the whole #app went inert. The owner's read-back
 * ruling ("Desktop sidebar inert") keeps the desktop dock geometry
 * (src/styles/app.css, --studio-inset-start, now gated at 1025px) but
 * removes the live-sidebar carve-out everywhere: from 721 to 1024px and
 * below 721px a studio already covers the whole viewport, and at 1025px
 * and wider it covers only the map area while the sidebar stays VISUALLY
 * present beside it, no longer usable. Marking #app itself inert (rather
 * than #map-container alone) reaches the sidebar too, since inert and
 * aria-hidden both cascade to every descendant in the flat tree; the
 * sidebar is not additionally hidden or moved, so it stays on screen
 * exactly where the desktop dock geometry puts it (interface-chrome's
 * "inert on it or an ancestor" reading, D1 M17).
 *
 * Call once from a studio's mount effect; call the returned cleanup from
 * that effect's teardown.
 */
export function applyStudioInertScope(): () => void {
  const appEl = document.getElementById('app');

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

  function apply(): void {
    release();
    if (!appEl) return;
    current = [appEl];
    for (const el of current) {
      priorAriaHidden.set(el, el.getAttribute('aria-hidden'));
      el.inert = true;
      el.setAttribute('aria-hidden', 'true');
    }
  }

  apply();

  return () => {
    release();
  };
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab and Shift+Tab inside `root` (found-004): at the last focusable
 * descendant Tab wraps to the first, and at the first Shift+Tab wraps to
 * the last, so an open studio can never hand focus to the app behind it.
 * Since DR-169 the whole #app, sidebar included, is inert while a studio
 * is open (`applyStudioInertScope` above), so this trap is no longer the
 * sidebar's only defense against a leaked Tab; it stays regardless,
 * because the studio's own focusable descendants must still cycle among
 * themselves rather than reaching #app's DOM (inert or not) at all.
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
