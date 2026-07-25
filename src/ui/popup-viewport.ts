/**
 * Popup viewport containment (U-UX-FIX-1 DEF-3 and DEF-4, usability
 * triage 2026-07-24; bounds model rebuilt 2026-07-24 for finding 1 of the
 * DG-080-REVIEW r1, which caught the first cut modeling the layout
 * viewport and ignoring the app's own occluding chrome; the guarantee
 * made TIERED with an explicit minimum-usable-region boundary for
 * finding 1 of the r2 review, which caught the rebuilt comment promising
 * unconditional containment that the stylesheet's minimum box chrome
 * cannot deliver in very small regions).
 *
 * MapLibre GL positions a popup at its geographic anchor with NO viewport
 * clamping: the auto-anchor flip only reacts near the map edges, so a
 * mid-viewport anchor with a tall or wide card can push the box past the
 * fold (DEF-3: the coordinated response's agency caveat tail and both
 * source links unreachable) or past the right edge (DEF-4: the telemetry
 * popup's close control wholly off-screen at 390 px).
 *
 * This module watches the document for `.maplibregl-popup` insertions and
 * clamps each popup's CONTENT box toward the REACHABLE REGION, keeping it
 * inside whenever the region can hold a rendered card (THE CANONICAL TIER
 * TABLE beside the boundary constants below is the one authoritative
 * statement of what each region size is and is not promised; every other
 * authored surface cites that table). The region is defined as:
 * the visual viewport (`window.visualViewport` offset and size when the
 * browser exposes it, since mobile browser chrome, pinch zoom, and the
 * on-screen keyboard move it without any layout resize; the layout
 * viewport as the fallback), intersected with the map container rect,
 * minus the app's own occluding chrome, inset by a small margin. The
 * modeled occluders are exactly two, both read from their LIVE bounding
 * rects at every clamp: the active mobile sheet (the `#sidebar` element
 * exactly while the `#app[data-sheet-detent]` shell attribute is present;
 * on desktop the same element is a grid column beside the map and
 * occludes nothing) and the persistent mobile footer
 * (`#mobile-footer-nav`). Both are fixed, full-width, bottom-docked
 * surfaces, so occlusion is modeled as raising the region's bottom edge
 * to the topmost occluding edge; an occluder that is not bottom-docked
 * would need a richer model than this.
 *
 * Three mechanisms compose to keep the card inside the region:
 *
 *   1. SIZE: shrink the content's `max-height`/`max-width` (anchor-family
 *      aware, then a hard cap at the region's own size) so the card is
 *      no larger than the region wherever the stylesheet's minimum
 *      chrome allows it (the tier table names the exception: below the
 *      compact chrome minimum the rendered box refuses the cap and
 *      containment ends). The size floors below are preferences, each
 *      itself capped at the region size, so a small region clamps the
 *      card all the way down instead of accepting overflow.
 *   2. COMPACT: below the FULL boundary (the canonical tier table below)
 *      the content element gets the `ddm-popup-compact` class, whose
 *      app.css rules cut the card chrome from 30 by 34 px down to 14 by
 *      18 px and the coordinated body's minimum scroll window from 44 px
 *      down to 24 px, so the rendered card can physically follow the
 *      hard cap much further down than the normal chrome allows.
 *   3. SLIDE: when the anchor sits so close to a region edge that the
 *      sized card still crosses it, the content box is translated the
 *      remaining distance into the region. The tip stays at the anchor
 *      (and may then sit outside the region); the card does not. On an
 *      axis where the rendered card is LARGER than the region (only
 *      possible below the compact chrome minimum), the slide instead
 *      pins the close control's corner: top edge in-region, and right
 *      edge in-region when the card is wider than the region.
 *
 * WHAT THIS MODULE GUARANTEES: exactly what THE CANONICAL TIER TABLE
 * beside the boundary constants below states, tier by tier, and nothing
 * more. That table is the ONE authoritative statement of this contract's
 * limits (DG-080-REVIEW r3 finding 1); the installation comment in
 * src/ui/sidebar.ts, the U-UX-FIX-1 sections in src/styles/app.css, and
 * the spec prose in tests/popup-viewport.spec.ts cite it rather than
 * restating limits of their own, and on any divergence the table wins.
 *
 * Overlap by chrome OTHER than the two modeled occluders is not detected
 * here. The body scroll window itself is CSS-side (the coordinated
 * head/body flex rules and the U-UX-FIX-1 section in app.css); the tier
 * table states exactly when that CSS can and cannot deliver it.
 *
 * Re-clamp triggers: popup insertion; MapLibre rewriting the container's
 * inline transform (map move or anchor flip; this also covers a sheet
 * detent change, whose settle re-pads the camera and so rewrites every
 * popup transform); content mutations (hydration); content box resizes
 * (font, image, or stylesheet reflow, via ResizeObserver); window resize;
 * visual-viewport resize and scroll.
 *
 * LAYOUT ONLY: no popup content is read, written, or reordered here (the
 * compact class is presentation; it changes chrome, never content).
 */

/** Breathing room between a clamped popup edge and the region edge. */
const EDGE_MARGIN_PX = 12;

/**
 * THE CANONICAL TIER TABLE (DG-080-REVIEW r3 finding 1): the ONE
 * authoritative statement of what this module promises at each region
 * size. Every other authored surface (the module comment above, the
 * installation comment in src/ui/sidebar.ts, the U-UX-FIX-1 sections in
 * src/styles/app.css, the spec prose in tests/popup-viewport.spec.ts)
 * cites this table; none of them states a limit of its own, and on any
 * divergence this table wins. H and W are the region's height and width
 * in CSS px after the margin inset; each boundary constant is exported
 * directly below this table with its app.css derivation.
 *
 * FULL: H >= MIN_USABLE_REGION_HEIGHT_PX (91) and
 * W >= MIN_USABLE_REGION_WIDTH_PX (88).
 *   Claims: the content box lies inside the region (to within one pixel
 *   of rounding; the slide is applied in whole pixels); the close
 *   control (rendered inside the content box's top-right) is reachable;
 *   a coordinated card keeps a body scroll window of at least 44 px, so
 *   the agency caveat tail and each source link can be scrolled into
 *   the window and clicked.
 *   NOT claimed: head-content visibility. The head (title, briefing
 *   door, overlap switcher) sits outside the body's scroll flow, but
 *   under squeeze it cedes its height to the body's window, and near
 *   the FULL height boundary it can shrink to zero; no tier promises
 *   that the head's actions stay visible. Also NOT claimed: that every
 *   label renders free of horizontal overflow. The width boundary buys
 *   a text column (derivation below); the link claim is
 *   scroll-reachability and clickability, not full-width rendering of
 *   the longest label.
 *
 * COMPACT with a usable body: below the FULL boundary, but at or above
 * the usable-body threshold, MIN_COMPACT_BODY_REGION_HEIGHT_PX (47)
 * tall and MIN_USABLE_REGION_WIDTH_PX (88) wide. (Reachable only by
 * height: a compact region with W >= 88 means H fell below 91.)
 *   Claims: containment and the close control exactly as in FULL, plus
 *   a 24 px coordinated body scroll window with the caveat tail and
 *   each source link scroll-reachable and clickable.
 *
 * COMPACT, containment only: H >= 15 and W >= 19, but below the
 * usable-body threshold on either axis (H < 47 or W < 88).
 *   Claims: containment and the close control, and NOTHING MORE; this
 *   tier says so plainly. Below 47 px of height the card edge clips the
 *   body window. Below 88 px of width the 18 px compact chrome leaves a
 *   content column too narrow for a dependable text line (at the 19 px
 *   containment minimum the column is 1 px), so no body, caveat, or
 *   link claim is made on the width axis either. The popup can always
 *   be dismissed and its card stays in reachable pixels; reading its
 *   body requires a larger region.
 *
 * SUB-CHROME: nonempty, but H < 15 or W < 19.
 *   The stylesheet's minimum compact card (14 by 18 px, contracted
 *   conservatively at 15 by 19) cannot fit, so containment is NOT
 *   possible. Claim: the slide pins the card's top edge (and right edge
 *   when the card is wider than the region) inside the region, so the
 *   close control's corner stays in reachable pixels and the popup can
 *   always be dismissed. Nothing else is promised in this tier; the
 *   stated limit is the honest one.
 *
 * EMPTY: H < 1 or W < 1 (the map wholly covered or zero-sized).
 *   No claim: no card geometry could be reachable, so the clamp removes
 *   its own writes (inline caps, translation, the compact class) and
 *   leaves the stylesheet geometry alone until the region comes back.
 */

/**
 * The FULL boundary (DG-080-REVIEW r2 finding 1): the smallest region in
 * which the NORMAL card chrome can deliver the tier table's FULL row.
 * Derived from app.css:
 *
 *   height 91 = 30 px card chrome (14 px top and bottom padding plus
 *   1 px borders) + 17 px head divider chrome (8 px padding, 8 px
 *   margin, 1 px border) + the 44 px coordinated body scroll window;
 *
 *   width 88 = 34 px card chrome (16 px left and right padding plus 1 px
 *   borders) + a 54 px text column beside the 24 px close target inset
 *   in the top-right padding. The column is the basis for the FULL
 *   row's scroll-reachable link claim; it is not a promise that every
 *   label fits it without horizontal overflow (the tier table says so).
 *
 * Below either boundary the clamp swaps to the compact presentation
 * (`ddm-popup-compact` in app.css: 6 px by 8 px padding, so 14 by 18 px
 * card chrome; 9 px compact head divider; a 24 px body window).
 */
export const MIN_USABLE_REGION_HEIGHT_PX = 91;
export const MIN_USABLE_REGION_WIDTH_PX = 88;

/**
 * The usable-body threshold's HEIGHT component (DG-080-REVIEW r3): the
 * smallest region height at which the COMPACT presentation can still
 * deliver its 24 px body scroll window. Derived from the
 * `ddm-popup-compact` rules in app.css: 14 px compact card chrome (6 px
 * top and bottom padding plus 1 px borders) + 9 px compact head divider
 * (4 px padding, 4 px margin, 1 px border) + the 24 px window.
 *
 * The threshold's WIDTH component is MIN_USABLE_REGION_WIDTH_PX itself:
 * compact chrome saves only 16 px of width, not enough to underwrite a
 * text column narrower than the FULL boundary's. At or above BOTH
 * components (with the region still under the FULL boundary) the
 * COMPACT tier claims a scrollable body with reachable links; below
 * either component it claims only containment and the close control
 * (the tier table's "containment only" row).
 */
export const MIN_COMPACT_BODY_REGION_HEIGHT_PX = 47;

/** The compact-presentation class the clamp toggles on the content box. */
const COMPACT_CLASS = 'ddm-popup-compact';

/**
 * Preferred size floors: near an extreme anchor the shrink loop stops
 * here so a popup with room does not collapse into a sliver (the SLIDE
 * step finishes the containment instead). Each floor is capped at the
 * region's own size before use, so a floor never holds the card larger
 * than the region.
 */
const MIN_CONTENT_HEIGHT_PX = 96;
const MIN_CONTENT_WIDTH_PX = 180;

/** Shrink passes per clamp; each pass is exact for its anchor family. */
const MAX_PASSES = 4;

let installed = false;

/** Popups already wired with their own reposition observers. */
const wired = new WeakSet<HTMLElement>();

/**
 * Install the document-level watcher. Idempotent; called once at boot
 * from `buildSidebar` so every popup path (coordinated responses,
 * telemetry markers) is covered regardless of which layer produced it.
 */
export function installPopupViewportContainment(): void {
  if (installed) return;
  installed = true;

  const watcher = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList.contains('maplibregl-popup')) {
          wirePopup(node);
        } else if (typeof node.querySelectorAll === 'function') {
          for (const popup of node.querySelectorAll<HTMLElement>('.maplibregl-popup')) {
            wirePopup(popup);
          }
        }
      }
    }
  });
  watcher.observe(document.body, { childList: true, subtree: true });

  const reclampAll = (): void => {
    for (const popup of document.querySelectorAll<HTMLElement>('.maplibregl-popup')) {
      clampPopupToViewport(popup);
    }
  };
  window.addEventListener('resize', reclampAll);
  // The visual viewport moves without any window resize (pinch zoom, the
  // on-screen keyboard, mobile browser chrome collapsing); both of its
  // events re-clamp against the fresh bounds.
  window.visualViewport?.addEventListener('resize', reclampAll);
  window.visualViewport?.addEventListener('scroll', reclampAll);
}

/**
 * Clamp one popup now and keep it clamped: MapLibre rewrites the
 * container's inline transform on every map move, async hydration (the
 * telemetry data slot) can grow the content after open, and size-only
 * reflow (fonts arriving, an image, a stylesheet change) can change the
 * box with no mutation at all; all three trigger a re-clamp (throttled
 * to one per animation frame).
 */
function wirePopup(popup: HTMLElement): void {
  if (wired.has(popup)) return;
  wired.add(popup);

  // Touch input over the card belongs to the card, and it already does
  // by DOM structure: MapLibre binds its gesture handlers on the map's
  // CANVAS CONTAINER, which is a SIBLING of the popup container, so a
  // touch that begins on the popup never bubbles through those handlers
  // (DG-080-REVIEW r2 corrected the earlier comment here, which credited
  // these listeners with blocking them). What keeps the map still under
  // a card touch is the browser's native pan-y scroll on the card's
  // scroll regions plus the CSS overscroll containment that stops
  // scroll chaining out of the card. The listeners below are defensive
  // hygiene only: they keep card touches out of any FUTURE listener
  // installed above the popup (the outer map container, the document).
  // Passive: this module never calls preventDefault.
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    popup.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
  }

  clampPopupToViewport(popup);

  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (popup.isConnected) clampPopupToViewport(popup);
    });
  };

  // Reposition: attribute-only on the container, so this module's own
  // writes to the content element never feed back into the observer.
  const repositionObserver = new MutationObserver(schedule);
  repositionObserver.observe(popup, { attributes: true, attributeFilter: ['style', 'class'] });

  // Content growth (hydration replacing the skeleton slot).
  const content = popup.querySelector<HTMLElement>('.maplibregl-popup-content');
  if (content) {
    const growthObserver = new MutationObserver(schedule);
    growthObserver.observe(content, { childList: true, subtree: true, characterData: true });

    // Size-only reflow (DG-080-REVIEW recommendation 4). No feedback
    // loop: ResizeObserver delivers from the layout state at frame end,
    // so the clamp's own clear-measure-reapply flutter inside one frame
    // is invisible to it, and a re-clamp that lands the same final size
    // produces no further entries.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(schedule).observe(content);
    }
  }
}

interface Bounds {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * The reachable region for a popup: visual viewport intersected with the
 * map container rect, minus the two modeled bottom-docked occluders (the
 * module comment defines all four terms), inset by the edge margin. May
 * be empty; `clampPopupToViewport` checks.
 */
function containingBounds(popup: HTMLElement): Bounds {
  const vv = window.visualViewport;
  let top = vv ? vv.offsetTop : 0;
  let left = vv ? vv.offsetLeft : 0;
  let bottom = vv ? vv.offsetTop + vv.height : document.documentElement.clientHeight;
  let right = vv ? vv.offsetLeft + vv.width : document.documentElement.clientWidth;

  const mapEl = popup.closest<HTMLElement>('.maplibregl-map');
  if (mapEl) {
    const rect = mapEl.getBoundingClientRect();
    top = Math.max(top, rect.top);
    left = Math.max(left, rect.left);
    bottom = Math.min(bottom, rect.bottom);
    right = Math.min(right, rect.right);
  }

  // The occluding chrome, live rects only. The sheet qualifies exactly
  // while the mobile shell attribute is present (on desktop the same
  // element is the sidebar column beside the map); a hidden footer
  // (desktop, embed) drops out via its zero-size rect. Occluders are
  // processed bottom-most first so a stack (sheet riding above the
  // footer) raises the region edge step by step.
  const occluders: HTMLElement[] = [];
  const footer = document.getElementById('mobile-footer-nav');
  if (footer) occluders.push(footer);
  if (document.getElementById('app')?.hasAttribute('data-sheet-detent')) {
    const sheet = document.getElementById('sidebar');
    if (sheet) occluders.push(sheet);
  }
  const rects = occluders
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .sort((a, b) => b.top - a.top);
  for (const r of rects) {
    if (r.top < bottom && r.bottom >= bottom - 1) {
      bottom = r.top;
    }
  }

  return {
    top: top + EDGE_MARGIN_PX,
    left: left + EDGE_MARGIN_PX,
    bottom: bottom - EDGE_MARGIN_PX,
    right: right - EDGE_MARGIN_PX
  };
}

/**
 * Clamp one popup to its reachable region: the compact-presentation
 * decision first, then size (anchor-family shrink, then the hard region
 * cap), then the residual slide. The canonical tier table beside the
 * boundary constants states the exact guarantee. The anchor class decides the
 * shrink factor per axis: an axis the popup is CENTERED on (a pure
 * `left`/`right`/`center` anchor vertically, a pure `top`/`bottom`/
 * `center` anchor horizontally) redistributes a size cut half to each
 * side, so the cut is doubled; an edge-fixed axis maps the cut
 * one-to-one.
 */
export function clampPopupToViewport(popup: HTMLElement): void {
  const content = popup.querySelector<HTMLElement>('.maplibregl-popup-content');
  if (!content) return;

  // Reset this module's writes first so a popup that regained room (the
  // map panned it back toward center) grows back instead of staying
  // stuck at its smallest historical clamp.
  content.style.maxHeight = '';
  content.style.maxWidth = '';
  content.style.transform = '';

  const bounds = containingBounds(popup);
  const regionHeight = Math.floor(bounds.bottom - bounds.top);
  const regionWidth = Math.floor(bounds.right - bounds.left);
  // EMPTY tier: the map is wholly covered or zero-sized, so no card
  // geometry could be reachable; remove this module's writes (the inline
  // caps and translation were cleared above, the compact class here) and
  // leave the stylesheet geometry alone.
  if (regionHeight < 1 || regionWidth < 1) {
    content.classList.remove(COMPACT_CLASS);
    return;
  }

  // COMPACT tier decision, before any measurement: below the FULL
  // boundary the normal chrome cannot deliver the tier table's FULL row,
  // so the compact presentation applies (and comes back off the moment
  // the region recovers). Guarded so a steady-state re-clamp writes
  // nothing.
  const compact =
    regionHeight < MIN_USABLE_REGION_HEIGHT_PX || regionWidth < MIN_USABLE_REGION_WIDTH_PX;
  if (content.classList.contains(COMPACT_CLASS) !== compact) {
    content.classList.toggle(COMPACT_CLASS, compact);
  }

  const floorHeight = Math.min(MIN_CONTENT_HEIGHT_PX, regionHeight);
  const floorWidth = Math.min(MIN_CONTENT_WIDTH_PX, regionWidth);

  const cl = popup.classList;
  const verticallyCentered =
    cl.contains('maplibregl-popup-anchor-left') ||
    cl.contains('maplibregl-popup-anchor-right') ||
    cl.contains('maplibregl-popup-anchor-center');
  const horizontallyCentered =
    cl.contains('maplibregl-popup-anchor-top') ||
    cl.contains('maplibregl-popup-anchor-bottom') ||
    cl.contains('maplibregl-popup-anchor-center');

  // SIZE, pass 1: anchor-family shrink against the whole container (tip
  // included), so the tip also lands inside the region whenever the
  // anchor allows it.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const rect = popup.getBoundingClientRect();
    const overTop = Math.max(0, bounds.top - rect.top);
    const overBottom = Math.max(0, rect.bottom - bounds.bottom);
    const overLeft = Math.max(0, bounds.left - rect.left);
    const overRight = Math.max(0, rect.right - bounds.right);
    if (overTop + overBottom + overLeft + overRight < 1) break;

    let progressed = false;
    if (overTop + overBottom >= 1) {
      const cut = (verticallyCentered ? 2 : 1) * (overTop + overBottom);
      const height = content.getBoundingClientRect().height;
      const next = Math.max(floorHeight, Math.floor(height - cut));
      if (next < height) {
        content.style.maxHeight = `${next}px`;
        progressed = true;
      }
    }
    if (overLeft + overRight >= 1) {
      const cut = (horizontallyCentered ? 2 : 1) * (overLeft + overRight);
      const width = content.getBoundingClientRect().width;
      const next = Math.max(floorWidth, Math.floor(width - cut));
      if (next < width) {
        content.style.maxWidth = `${next}px`;
        progressed = true;
      }
    }
    // A floor bound (or nothing shrank): stop shrinking. The hard cap
    // and the slide below finish the containment.
    if (!progressed) break;
  }

  // SIZE, pass 2: the hard region cap. MAX_PASSES is a convergence
  // budget, not the guarantee; whatever the loop left, the content box
  // is capped at the region's own size here (box-sizing is border-box
  // app-wide, so the cap and the measured rect agree).
  let crect = content.getBoundingClientRect();
  if (crect.height > regionHeight) content.style.maxHeight = `${regionHeight}px`;
  if (crect.width > regionWidth) content.style.maxWidth = `${regionWidth}px`;

  // SLIDE: on an axis where the content box fits the region, translating
  // it by the remaining crossing puts it entirely inside. On an axis
  // where the rendered box is LARGER than the region (the SUB-CHROME
  // tier: the CSS minimum chrome refused the cap), containment is
  // impossible, so the slide pins the close control's corner instead:
  // the top edge in-region, and the right edge in-region when the card
  // is wider than the region. The container box ignores a descendant
  // transform, and the tip legitimately stays at the anchor, so the
  // slide is measured and applied on the content box alone. Zero on both
  // axes whenever the sized card already sits inside (every mid-map
  // anchor).
  crect = content.getBoundingClientRect();
  const dx =
    crect.width > regionWidth + 1
      ? bounds.right - crect.right
      : crect.left < bounds.left
        ? bounds.left - crect.left
        : crect.right > bounds.right
          ? bounds.right - crect.right
          : 0;
  const dy =
    crect.height > regionHeight + 1
      ? bounds.top - crect.top
      : crect.top < bounds.top
        ? bounds.top - crect.top
        : crect.bottom > bounds.bottom
          ? bounds.bottom - crect.bottom
          : 0;
  if (dx !== 0 || dy !== 0) {
    content.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
  }
}
