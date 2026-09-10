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
