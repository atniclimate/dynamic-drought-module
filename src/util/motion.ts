/**
 * Shared reduced-motion check.
 *
 * Honors the user's `prefers-reduced-motion: reduce` setting (WCAG 2.3.3).
 * Callers that would otherwise run a camera animation (fly-to, fit-bounds
 * sweep) pass `animate: false` / `duration: 0` when this returns true, so the
 * view jumps instead of moving. The CSS reduced-motion block covers declarative
 * transitions; this covers the imperative MapLibre camera calls.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Run a DOM update as a view transition where the browser offers one, so a
 * surface can grow out of the control that opened it (owner direction
 * 2026-11-09 (sprint), DR-pending). Progressive enhancement only: without
 * the API, or when the reader asks for reduced motion, the update runs at
 * once and lands on the same end state. The update must be synchronous.
 */
export function withViewTransition(update: () => void): void {
  const doc =
    typeof document !== 'undefined'
      ? (document as Document & { startViewTransition?: (callback: () => void) => unknown })
      : null;
  if (!doc || prefersReducedMotion() || typeof doc.startViewTransition !== 'function') {
    update();
    return;
  }
  doc.startViewTransition(update);
}
