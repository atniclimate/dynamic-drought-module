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
