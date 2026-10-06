import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { awaitQuiescence, gotoApp, waitForLayerSettled } from './helpers';
import { BIA_ROUTE, routeBoundary, syntheticBiaBody } from './tribal-fixtures';
import { LEGACY_ALLOWANCE, eligibleBuilders, migratedBuilders } from './identify-paths-manifest';
import { TIER_FIXTURES, type TierFixture } from './frame-fixtures';
import {
  MIN_COMPACT_BODY_REGION_HEIGHT_PX,
  MIN_USABLE_REGION_HEIGHT_PX,
  MIN_USABLE_REGION_WIDTH_PX
} from '../src/ui/popup-viewport';

/**
 * U-UX-FIX-1 DEF-3 and DEF-4 (usability triage 2026-07-24): MapLibre
 * positions a popup at its geographic anchor with no viewport clamping,
 * so a tall or wide card can extend past the fold (DEF-3: the
 * coordinated response's agency caveat tail and both source links
 * unreachable) or past the right edge (DEF-4: the telemetry popup's
 * close control wholly off-screen at 390 px).
 *
 * The fix (src/ui/popup-viewport.ts plus the app.css scroll-containment
 * and compact-presentation sections, and the responsive telemetry
 * maxWidth) clamps every popup CARD toward its reachable region (the
 * visual viewport intersected with the map container, minus any active
 * bottom-docked chrome) under THE CANONICAL TIER TABLE beside
 * the boundary constants in popup-viewport.ts. That table is the one
 * authoritative statement of what each region size is and is not
 * promised; this header restates none of its limits, and on any
 * divergence the table wins (DG-080-REVIEW r2 finding 1, r3 finding 1).
 * As a reading aid only, the tiers the tests below exercise are: FULL
 * (containment, reachable close control, a genuinely overflowing
 * coordinated body whose caveat tail and source links are
 * scroll-reachable and clickable; head-content visibility is expressly
 * NOT claimed); COMPACT at or above the usable-body threshold (the
 * same, with the smaller compact body window); COMPACT below that
 * threshold (containment and the close control ONLY); SUB-CHROME (only
 * a pinned, dismissable close corner); EMPTY (the clamp stands down and
 * recovers when the region comes back).
 *
 * These specs pin those tiers with the deterministic offline fixtures:
 * the synthetic Tribal-geography routes for the coordinated popup, the
 * curated telemetry seed markers (no network needed to render), and
 * aborted telemetry data routes so hydration settles on its honest
 * fallback. Coverage per the DG-080-REVIEW r1, r2, and r3 findings: the
 * favorable geometries, including the mobile side panel, a
 * small embed iframe, both size floors WITH body-scroll and link
 * assertions, the compact usable-body and containment-only bands (the
 * latter once per threshold axis), the sub-chrome tier, empty-region
 * recovery, a visual viewport diverging from the layout viewport, resize during
 * hydration, map reposition, and reachability proven by hit testing
 * (elementFromPoint) or real clicks rather than bounding boxes alone;
 * touch scrolling via the Chrome DevTools Protocol (CDP), which this
 * chromium-only suite allows.
 */

/**
 * Assert an element is genuinely hit-testable at its center: the element
 * under that point (elementFromPoint) is the element itself or shares its
 * subtree. A bounding box inside the viewport can still sit BEHIND the
 * fixed occluding chrome (the finding-2 gap); this cannot.
 */
async function expectHitTestReachable(
  target: ReturnType<Page['locator']>,
  label: string
): Promise<void> {
  // Polled: the box and the probe are two round trips, and a map still
  // settling (drag inertia, an easing camera) can move the popup between
  // them; a genuinely occluded element stays occluded and still fails.
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        if (!box) return 'no box';
        return target.evaluate(
          (el, pt) => {
            const found = document.elementFromPoint(pt.x, pt.y);
            return found && (found === el || el.contains(found) || found.contains(el))
              ? 'ok'
              : 'occluded';
          },
          { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        );
      },
      {
        message: `${label} is not hit-testable at its center (occluded or off-screen)`,
        timeout: 7_000
      }
    )
    .toBe('ok');
}

/**
 * The top edge (viewport y) of bottom-docked occluding chrome. Side rails
 * and side panels do not reduce the usable vertical map region. Infinity
 * when no candidate touches the viewport bottom.
 */
async function bottomChromeTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewportBottom = window.visualViewport
      ? window.visualViewport.offsetTop + window.visualViewport.height
      : document.documentElement.clientHeight;
    let bottom = viewportBottom;
    const footer = document.getElementById('mobile-footer-nav');
    const sheetActive = document.getElementById('app')?.hasAttribute('data-sheet-detent');
    const rects = [footer, sheetActive ? document.getElementById('sidebar') : null]
      .filter((el): el is HTMLElement => el !== null)
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => b.top - a.top);
    for (const rect of rects) {
      if (rect.top < bottom && rect.bottom >= bottom - 1) bottom = rect.top;
    }
    return bottom === viewportBottom ? Infinity : bottom;
  });
}

/** Assert a bounding box sits fully inside the viewport (1px tolerance). */
function expectWithinViewport(
  box: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
  label: string
): void {
  expect(box, `${label} has no bounding box`).not.toBeNull();
  expect(box!.y, `${label} extends above the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.x, `${label} extends left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(
    box!.y + box!.height,
    `${label} extends below the viewport fold`
  ).toBeLessThanOrEqual(viewport.height + 1);
  expect(
    box!.x + box!.width,
    `${label} extends past the right viewport edge`
  ).toBeLessThanOrEqual(viewport.width + 1);
}

test.describe('DEF-3: the coordinated popup is contained and its tail reachable (390x600)', () => {
  // A short phone viewport: the pre-fix 70vh card anchored mid-map always
  // crosses the fold here, which is exactly the triage geometry.
  test.use({ viewport: { width: 390, height: 600 } });

  test('the box stays inside the viewport, the body scrolls, and both source links are reachable', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    // Click the map center until the fixture fill has painted and the
    // coordinated response is up (the established retry pattern from
    // tests/interaction-coordinator.spec.ts).
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const content = page.locator('.maplibregl-popup-content');
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    const viewport = page.viewportSize()!;
    const popup = page.locator('.maplibregl-popup');

    // THE DEF-3 CONTAINMENT CONTRACT: the whole popup box (tip included)
    // sits inside the visible viewport. Pre-fix the 70vh card anchored at
    // the map center crossed the fold by more than 100 px.
    expectWithinViewport(await popup.boundingBox(), viewport, 'coordinated popup');

    // The body is the one genuine scroll region: the caveat plus links
    // exceed the clamped box, so it must really overflow.
    const body = popup.locator('.coordinated-response-body');
    const scrollable = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrollable, 'the coordinated body does not overflow (nothing to scroll)').toBeGreaterThan(0);

    // Wheel input over the body scrolls the BODY, not the map: scrollTop
    // moves and the popup box (anchored to a lngLat, so any map pan or
    // zoom would displace it) stays put. The wheel lands near the body's
    // top-left: the map's compact attribution control can sit expanded
    // over the bottom-right of a short viewport, and a wheel over IT is
    // a different (cosmetic z-order) question than this contract.
    const bodyBox = await body.boundingBox();
    expect(bodyBox).not.toBeNull();
    const before = await popup.boundingBox();
    await page.mouse.move(bodyBox!.x + 24, bodyBox!.y + 12);
    await page.mouse.wheel(0, 240);
    await expect
      .poll(async () => body.evaluate((el) => el.scrollTop), {
        message: 'wheel over the body never scrolled it'
      })
      .toBeGreaterThan(0);
    const after = await popup.boundingBox();
    expect(Math.abs(after!.x - before!.x), 'the map moved under the wheel').toBeLessThanOrEqual(2);
    expect(Math.abs(after!.y - before!.y), 'the map moved under the wheel').toBeLessThanOrEqual(2);

    // The full agency caveat plus BOTH source links are reachable: scroll
    // the body to its end and the links land inside the viewport. Pre-fix
    // the trailing caveat and links sat past the fold at any scrollTop.
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // The body's source links (D1 M24: the framed BIA body carries the more
    // link and the primary source again, PF3).
    const links = popup.locator('.coordinated-response-body a[href]');
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      expectWithinViewport(await link.boundingBox(), viewport, 'popup source link');
    }
    // The caveat's end is directly above the links, so links-in-viewport
    // plus a genuinely scrolled body proves the caveat tail is readable.
    const atEnd = await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    expect(atEnd, 'the body could not be scrolled to its end').toBe(true);

    // Finding-2 hardening: boxes-in-viewport is not reachability. Both
    // source links and the close control must be the element actually
    // under their own center (nothing, footer included, on top of them).
    for (const link of await links.all()) {
      await expectHitTestReachable(link, 'popup source link');
    }
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control'
    );

    // Map reposition: drag the map (from a corner point outside the card)
    // and the re-clamp keeps the card inside the reachable region at its
    // new anchor position.
    const dragX = mapBox!.x + 18;
    const dragY = mapBox!.y + mapBox!.height - 90;
    await page.mouse.move(dragX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragX + 90, dragY - 60, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(
        async () => {
          const cbox = await content.boundingBox();
          if (!cbox) return false;
          const chromeTop = await bottomChromeTop(page);
          const bottomEdge = Math.min(viewport.height, chromeTop);
          return (
            cbox.y >= -1 &&
            cbox.x >= -1 &&
            cbox.y + cbox.height <= bottomEdge + 1 &&
            cbox.x + cbox.width <= viewport.width + 1
          );
        },
        { message: 'the card left the reachable region after a map drag', timeout: 10_000 }
      )
      .toBe(true);
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control after the drag'
    );
  });
});

test.describe('DEF-3 finding 1: mobile side panel geometry (390x844, touch)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the side panel does not create a bottom inset and the popup remains touch-scrollable', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    // The Layers door opens beside the map. It must not be treated as a
    // bottom drawer by popup viewport calculations.
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const sidebar = page.locator('#sidebar');
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.y).toBeGreaterThan(0);
    expect(sidebarBox!.y + sidebarBox!.height).toBeLessThan(viewportHeight);
    expect(await bottomChromeTop(page)).toBe(Number.POSITIVE_INFINITY);

    // Close the Layers panel before opening the coordinated response. The
    // popup now receives the map's full vertical region, with no stale
    // drawer inset left behind.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(sidebar).toBeHidden();

    async function targetPoint(): Promise<{ cx: number; cy: number }> {
      const liveMapBox = await page.locator('#map').boundingBox();
      expect(liveMapBox, 'the map lost its bounding box').not.toBeNull();
      return {
        cx: liveMapBox!.x + liveMapBox!.width / 2,
        cy: liveMapBox!.y + liveMapBox!.height / 2
      };
    }

    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    await expect(async () => {
      // Skip the click when the PREVIOUS attempt's card is already up: a
      // click always lands on either the fixture polygon (rebuilding the
      // response) or empty ground (closing it), so re-clicking a
      // genuinely open card is exactly what kills it before this poll can
      // observe it, turning a slow build into an unwinnable retry loop.
      if (!(await content.isVisible().catch(() => false))) {
        const { cx, cy } = await targetPoint();
        await page.mouse.click(cx, cy);
      }
      await expect(content).toBeVisible({ timeout: 6_000 });
    }).toPass({ timeout: 20_000 });

    // The card remains inside the viewport with the clamp's 12px margin.
    await expect
      .poll(
        async () => {
          const cbox = await content.boundingBox();
          return cbox ? cbox.y + cbox.height : Number.POSITIVE_INFINITY;
        },
        { message: 'the card never came back inside the viewport', timeout: 10_000 }
      )
      .toBeLessThanOrEqual(viewportHeight - 12 + 1);

    // The body really scrolls, and the caveat tail's links plus the close
    // control are hit-testable.
    const body = popup.locator('.coordinated-response-body');
    const scrollable = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrollable, 'the clamped body does not overflow (nothing to scroll)').toBeGreaterThan(0);
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const links = popup.locator('.coordinated-response-body a[href]');
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await link.evaluate((element) =>
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      );
      await expectHitTestReachable(link, 'popup source link inside the viewport');
    }
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control inside the viewport'
    );

    // Genuine TOUCH scrolling (recommendation 3; the runner allows it via
    // CDP): a swipe up over the body scrolls the BODY, and the card stays
    // put (no map pan under the touch).
    await body.evaluate((el) => {
      el.scrollTop = 0;
    });
    const bodyBox = await body.boundingBox();
    expect(bodyBox).not.toBeNull();
    // Raw CDP touch events, spaced a frame apart, drive the browser's
    // real touch-scroll path (Input.synthesizeScrollGesture proved inert
    // against this scroller on this runner). The whole swipe retries
    // because the software-rendered runner under parallel load can
    // starve a single gesture below the scroll slop threshold; the
    // scrolled-not-panned pair is asserted WITHIN one attempt, so a
    // systematic touch-pans-the-map regression fails every attempt.
    const client = await page.context().newCDPSession(page);
    await expect(async () => {
      await body.evaluate((el) => {
        el.scrollTop = 0;
      });
      const bb = await body.boundingBox();
      expect(bb, 'the body lost its box before the swipe').not.toBeNull();
      const beforeBox = await content.boundingBox();
      const sx = Math.round(bb!.x + 30);
      const sy = Math.round(bb!.y + Math.min(bb!.height, 60) - 8);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: sx, y: sy }]
      });
      for (let i = 1; i <= 10; i++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: sx, y: sy - i * 12 }]
        });
        await page.waitForTimeout(30);
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect
        .poll(async () => body.evaluate((el) => el.scrollTop), {
          message: 'the touch swipe over the body never scrolled it',
          timeout: 2_500
        })
        .toBeGreaterThan(0);
      const afterBox = await content.boundingBox();
      expect(
        Math.abs(afterBox!.x - beforeBox!.x),
        'the card moved under the touch'
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(afterBox!.y - beforeBox!.y),
        'the card moved under the touch'
      ).toBeLessThanOrEqual(2);
    }).toPass({ timeout: 30_000 });
  });
});

test.describe('DEF-3 finding 1: a small embed iframe and both size floors', () => {
  test.use({ viewport: { width: 360, height: 300 } });

  test('the card follows an embed viewport down through the width and height floors', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&embed=true&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // Containment inside the reachable region: viewport (no sheet or
    // footer in an embed) intersected with the map, inset by the clamp's
    // 12px margin (1px tolerance throughout).
    async function expectContained(maxWidth: number | null, maxHeight: number | null): Promise<void> {
      await expect
        .poll(
          async () => {
            const cbox = await content.boundingBox();
            const map = await page.locator('#map').boundingBox();
            const vp = page.viewportSize()!;
            if (!cbox || !map) return 'no box';
            const top = Math.max(0, map.y) + 12;
            const left = Math.max(0, map.x) + 12;
            const bottom = Math.min(vp.height, map.y + map.height) - 12;
            const right = Math.min(vp.width, map.x + map.width) - 12;
            const inside =
              cbox.y >= top - 1 &&
              cbox.x >= left - 1 &&
              cbox.y + cbox.height <= bottom + 1 &&
              cbox.x + cbox.width <= right + 1;
            const widthOk = maxWidth === null || cbox.width <= maxWidth + 1;
            const heightOk = maxHeight === null || cbox.height <= maxHeight + 1;
            return inside && widthOk && heightOk ? 'ok' : JSON.stringify(cbox);
          },
          { message: 'the card is not contained in the reachable region', timeout: 10_000 }
        )
        .toBe('ok');
    }

    await expectContained(null, null);
    const body = popup.locator('.coordinated-response-body');
    expect(
      await body.evaluate((el) => el.scrollHeight - el.clientHeight),
      'the clamped body does not overflow (nothing to scroll)'
    ).toBeGreaterThan(0);
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // Counted first, so an unmatched selector cannot pass the loop vacuously.
    await expect(popup.locator('.coordinated-response-body a[href]')).toHaveCount(2);
    for (const link of await popup.locator('.coordinated-response-body a[href]').all()) {
      await expectHitTestReachable(link, 'popup source link in the small embed');
    }
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control in the small embed'
    );

    // WIDTH FLOOR: at 200px wide the region allows 176px, UNDER the 180px
    // floor. The floor caps at the region (pre-fix: the 180px floor stood
    // and the residual overflow was accepted).
    await page.setViewportSize({ width: 200, height: 300 });
    await expectContained(176, null);
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control at the width floor'
    );

    // HEIGHT FLOOR: at 110px tall the region allows 86px, UNDER the 96px
    // floor (pre-fix: the clamp returned without doing anything at all
    // below the height floor, leaving the card across the fold).
    await page.setViewportSize({ width: 200, height: 110 });
    await expectContained(176, 86);
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control at the height floor'
    );

    // r2 finding 2: the height-floor assertion extends beyond the close
    // control. An 86px-tall region at this width sits in the canonical
    // tier table's COMPACT usable-body row (under
    // MIN_USABLE_REGION_HEIGHT_PX, at or above
    // MIN_COMPACT_BODY_REGION_HEIGHT_PX, wider than
    // MIN_USABLE_REGION_WIDTH_PX), so the compact presentation is on,
    // the body still keeps a genuine scroll window of at least 24px, it
    // scrolls to its end, and EACH source link can be brought into the
    // window and hit. Both links no longer fit the window at once;
    // reachable-by-scrolling is exactly what that row promises.
    await expect(content).toHaveClass(/\bddm-popup-compact\b/);
    expect(
      await body.evaluate((el) => el.scrollHeight - el.clientHeight),
      'the compact body does not overflow (nothing to scroll)'
    ).toBeGreaterThan(0);
    expect(
      await body.evaluate((el) => el.clientHeight),
      'the compact body window collapsed below its 24px minimum'
    ).toBeGreaterThanOrEqual(23);
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(
      await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1),
      'the compact body could not be scrolled to its end'
    ).toBe(true);
    await expect(popup.locator('.coordinated-response-body a[href]')).toHaveCount(2);
    for (const link of await popup.locator('.coordinated-response-body a[href]').all()) {
      await link.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
      await expectHitTestReachable(link, 'popup source link at the height floor');
    }
  });
});

test.describe('DEF-3 r2 finding 1: compact tier, empty-region recovery, sub-chrome close pin', () => {
  test.use({ viewport: { width: 360, height: 300 } });

  /**
   * The reachable region in an embed (no sheet, no footer): the viewport
   * intersected with the map rect, inset by the clamp's 12px margin.
   */
  async function embedRegion(
    page: Page
  ): Promise<{ top: number; left: number; bottom: number; right: number; h: number; w: number }> {
    const map = await page.locator('#map').boundingBox();
    expect(map, 'the map has no bounding box').not.toBeNull();
    const vp = page.viewportSize()!;
    const top = Math.max(0, map!.y) + 12;
    const left = Math.max(0, map!.x) + 12;
    const bottom = Math.min(vp.height, map!.y + map!.height) - 12;
    const right = Math.min(vp.width, map!.x + map!.width) - 12;
    return { top, left, bottom, right, h: bottom - top, w: right - left };
  }

  test('the tiered contract holds through compact, empty, recovery, and sub-chrome regions', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&embed=true&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    const body = popup.locator('.coordinated-response-body');
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const mapTop = Math.max(0, mapBox!.y);
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    const expectInRegion = async (label: string): Promise<void> => {
      await expect
        .poll(
          async () => {
            const r = await embedRegion(page);
            const cbox = await content.boundingBox();
            if (!cbox) return 'no box';
            return cbox.y >= r.top - 1 &&
              cbox.x >= r.left - 1 &&
              cbox.y + cbox.height <= r.bottom + 1 &&
              cbox.x + cbox.width <= r.right + 1
              ? 'ok'
              : JSON.stringify(cbox);
          },
          { message: `${label}: the card is not contained in the region`, timeout: 10_000 }
        )
        .toBe('ok');
    };

    // COMPACT usable-body row of the canonical tier table: a region in
    // the MIN_COMPACT_BODY_REGION_HEIGHT_PX..66px band, at full width.
    // The compact presentation must keep the caveat and links reachable
    // BY SCROLLING: this is the accessible degraded presentation for
    // regions the normal chrome cannot serve (r2 recommendation 1),
    // pinned at a size where the pre-r2 CSS admitted the body would clip
    // at the card edge.
    await page.setViewportSize({ width: 360, height: Math.round(mapTop + 71) });
    let r = await embedRegion(page);
    expect(
      r.h,
      'premise: the region must land in the compact 24px-window band'
    ).toBeGreaterThanOrEqual(MIN_COMPACT_BODY_REGION_HEIGHT_PX);
    expect(r.h).toBeLessThan(67);
    expect(r.w).toBeGreaterThanOrEqual(MIN_USABLE_REGION_WIDTH_PX);
    await expectInRegion('compact band');
    await expect(content).toHaveClass(/\bddm-popup-compact\b/);
    expect(
      await body.evaluate((el) => el.scrollHeight - el.clientHeight),
      'the compact body does not overflow (nothing to scroll)'
    ).toBeGreaterThan(0);
    expect(
      await body.evaluate((el) => el.clientHeight),
      'the compact body window collapsed below its 24px minimum'
    ).toBeGreaterThanOrEqual(23);
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(
      await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1),
      'the compact body could not be scrolled to its end'
    ).toBe(true);
    await expect(popup.locator('.coordinated-response-body a[href]')).toHaveCount(2);
    for (const link of await popup.locator('.coordinated-response-body a[href]').all()) {
      await link.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
      await expectHitTestReachable(link, 'popup source link in the compact band');
    }
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control in the compact band'
    );

    // EMPTY region (r2 recommendation 3, the recovery regression's first
    // half): the clamp stands down entirely; no inline caps, no
    // translation, no compact class.
    await page.setViewportSize({ width: 360, height: Math.max(1, Math.round(mapTop + 20)) });
    r = await embedRegion(page);
    expect(r.h, 'premise: the region must be empty').toBeLessThan(1);
    await expect
      .poll(
        async () =>
          content.evaluate(
            (el) =>
              `${el.style.maxHeight}|${el.style.maxWidth}|${el.style.transform}|` +
              `${el.classList.contains('ddm-popup-compact')}`
          ),
        { message: 'the clamp did not stand down in the empty region', timeout: 10_000 }
      )
      .toBe('|||false');

    // RECOVERY (the regression's second half): the region comes back at
    // full size and the SAME popup is re-clamped into the full contract:
    // contained, normal presentation, overflowing body, reachable close.
    await page.setViewportSize({ width: 360, height: 300 });
    r = await embedRegion(page);
    expect(
      r.h,
      'premise: the recovered region must clear the minimum usable region'
    ).toBeGreaterThanOrEqual(MIN_USABLE_REGION_HEIGHT_PX);
    await expectInRegion('recovered region');
    await expect(content).not.toHaveClass(/\bddm-popup-compact\b/);
    expect(
      await body.evaluate((el) => el.scrollHeight - el.clientHeight),
      'the recovered body does not overflow (nothing to scroll)'
    ).toBeGreaterThan(0);
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control after recovery'
    );

    // COMPACT containment-only row (r3): BELOW the usable-body
    // threshold, the canonical tier table claims containment and the
    // close control and NOTHING MORE. These two segments assert exactly
    // that reduced claim, once per threshold axis, and deliberately
    // assert nothing about the body, the caveat, or the links: the
    // table makes no such claim here, so neither does this spec.

    // Below the threshold's height component: a short region at or
    // above the 15px containment minimum.
    await page.setViewportSize({ width: 360, height: Math.round(mapTop + 55) });
    r = await embedRegion(page);
    expect(
      r.h,
      'premise: the region must land below the usable-body height threshold'
    ).toBeLessThan(MIN_COMPACT_BODY_REGION_HEIGHT_PX);
    expect(
      r.h,
      'premise: the region must stay at or above the containment minimum'
    ).toBeGreaterThanOrEqual(15);
    await expectInRegion('containment-only band (short)');
    await expect(content).toHaveClass(/\bddm-popup-compact\b/);
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control in the short containment-only band'
    );

    // Below the threshold's width component (the r3 width residue): a
    // region narrower than MIN_USABLE_REGION_WIDTH_PX, at or above the
    // 19px containment minimum. No usable text column is claimed at any
    // width in this row, so none is asserted.
    await page.setViewportSize({ width: 100, height: 300 });
    r = await embedRegion(page);
    expect(
      r.w,
      'premise: the region must land below the usable-body width threshold'
    ).toBeLessThan(MIN_USABLE_REGION_WIDTH_PX);
    expect(
      r.w,
      'premise: the region must stay at or above the containment minimum'
    ).toBeGreaterThanOrEqual(19);
    await expectInRegion('containment-only band (narrow)');
    await expect(content).toHaveClass(/\bddm-popup-compact\b/);
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control in the narrow containment-only band'
    );

    // SUB-CHROME tier: a nonempty region shorter than the 14px compact
    // chrome minimum. Containment is physically impossible (stated, not
    // hidden); the promise narrows to the close control's corner: the
    // card's top edge is pinned at the region top and the popup can be
    // DISMISSED from inside the region strip.
    await page.setViewportSize({ width: 360, height: Math.round(mapTop + 30) });
    r = await embedRegion(page);
    expect(r.h, 'premise: the region must be nonempty').toBeGreaterThanOrEqual(1);
    expect(r.h, 'premise: the region must sit under the compact chrome minimum').toBeLessThan(14);
    await expect
      .poll(
        async () => {
          const rr = await embedRegion(page);
          const cbox = await content.boundingBox();
          return cbox ? Math.abs(cbox.y - rr.top) : 999;
        },
        { message: 'the card top edge is not pinned at the region top', timeout: 10_000 }
      )
      .toBeLessThanOrEqual(1.5);
    // Dismissal receipt, in two parts.
    //
    // PART 1, the probe (it only PICKS the point; it proves nothing about
    // reachability at click time). One Locator.evaluate on THIS popup's
    // close control reads, in a single synchronous browser turn, the
    // region rectangle (viewport intersected with #map, inset 12px, the
    // same rule as embedRegion), the close control's box, and then scans
    // elementFromPoint along one row for a pixel whose topmost element is
    // inside that control (unmodeled chrome, which the module explicitly
    // does not dodge, may cover part of the strip). The row and the scan
    // span are the intersection of the close control's box with the
    // region, so the picked point lies inside the region on BOTH bounds
    // of each axis, never just below its bottom edge. expect.poll re-runs
    // the whole read until a point exists or the timeout proves none ever
    // does.
    type SubChromeRegion = { top: number; bottom: number; left: number; right: number };
    type SubChromeProbe =
      | { kind: 'point'; x: number; y: number; region: SubChromeRegion }
      | { kind: 'none'; why: string };
    const closeButton = popup.locator('.maplibregl-popup-close-button');
    const readSubChromeProbe = async (): Promise<SubChromeProbe> => {
      try {
        return await closeButton.evaluate(
          (closeEl): SubChromeProbe => {
            const mapEl = document.getElementById('map');
            if (!mapEl) return { kind: 'none', why: 'no #map' };
            const m = mapEl.getBoundingClientRect();
            const region = {
              top: Math.max(0, m.top) + 12,
              bottom: Math.min(window.innerHeight, m.bottom) - 12,
              left: Math.max(0, m.left) + 12,
              right: Math.min(window.innerWidth, m.right) - 12
            };
            const c = closeEl.getBoundingClientRect();
            const yLo = Math.max(region.top, c.top);
            const yHi = Math.min(region.bottom, c.bottom);
            const xLo = Math.max(region.left, c.left);
            const xHi = Math.min(region.right, c.right);
            if (yHi - yLo < 1 || xHi - xLo < 1) {
              return { kind: 'none', why: 'the close control does not overlap the region' };
            }
            const y = (yLo + yHi) / 2;
            for (let x = xLo + 0.5; x <= xHi - 0.5; x += 2) {
              const hit = document.elementFromPoint(x, y);
              if (hit && closeEl.contains(hit)) return { kind: 'point', x, y, region };
            }
            return { kind: 'none', why: 'every scanned pixel is covered' };
          },
          undefined,
          { timeout: 1_000 }
        );
      } catch {
        return { kind: 'none', why: 'the popup close control did not resolve' };
      }
    };

    // Declared through a cast so control flow does not narrow it to the
    // initializer: the poll callback below reassigns it.
    let lastProbe = { kind: 'none', why: 'not read' } as SubChromeProbe;
    await expect
      .poll(
        async () => {
          lastProbe = await readSubChromeProbe();
          return lastProbe.kind === 'point' ? 'ok' : lastProbe.why;
        },
        {
          message: 'probe: no reachable pixel found on the close control inside the region strip',
          timeout: 10_000
        }
      )
      .toBe('ok');
    const probe = lastProbe;
    if (probe.kind !== 'point') throw new Error('unreachable: the poll above only passes on a point');

    // PART 2, the reachability proof. A capture-phase pointerdown listener
    // on document, attached through the same popup-scoped locator before
    // any input, records AT THE MOMENT the real pointerdown fires: its
    // client coordinates, whether it is trusted input, whether its target
    // (or an ancestor of it) is this popup's close control, and the region
    // rectangle measured in that same turn. page.mouse.click then sends
    // real input at the probe pixel. The page can still move between the
    // probe and that dispatch; the record, not the probe, says what the
    // click actually hit and where the region was when it did.
    type PointerdownRecord = {
      clientX: number;
      clientY: number;
      isTrusted: boolean;
      hitClose: boolean;
      targetDesc: string;
      region: SubChromeRegion;
    };
    type RecordHost = { __ddmSubChromePointerdown?: PointerdownRecord | null };
    await closeButton.evaluate((closeEl) => {
      const host = window as unknown as RecordHost;
      host.__ddmSubChromePointerdown = null;
      document.addEventListener(
        'pointerdown',
        (event: PointerEvent) => {
          const mapEl = document.getElementById('map');
          const m = mapEl
            ? mapEl.getBoundingClientRect()
            : { top: NaN, bottom: NaN, left: NaN, right: NaN };
          const target = event.target instanceof Element ? event.target : null;
          host.__ddmSubChromePointerdown = {
            clientX: event.clientX,
            clientY: event.clientY,
            isTrusted: event.isTrusted,
            hitClose:
              target !== null &&
              closeEl.isConnected &&
              target.closest('.maplibregl-popup-close-button') === closeEl,
            targetDesc: target
              ? `${target.tagName.toLowerCase()}.${String(target.className)}`
              : String(event.target),
            region: {
              top: Math.max(0, m.top) + 12,
              bottom: Math.min(window.innerHeight, m.bottom) - 12,
              left: Math.max(0, m.left) + 12,
              right: Math.min(window.innerWidth, m.right) - 12
            }
          };
        },
        { capture: true, once: true }
      );
    });
    await page.mouse.click(probe.x, probe.y);
    const pd = await page.evaluate(
      () => (window as unknown as RecordHost).__ddmSubChromePointerdown ?? null
    );
    expect(pd, 'click: no pointerdown reached document after the real click').not.toBeNull();
    expect(pd!.isTrusted, 'click: the recorded pointerdown was not real (trusted) input').toBe(
      true
    );
    expect(
      pd!.hitClose,
      `click: the real pointerdown hit ${pd!.targetDesc}, not the popup close control`
    ).toBe(true);
    const inRegion =
      pd!.clientY >= pd!.region.top &&
      pd!.clientY <= pd!.region.bottom &&
      pd!.clientX >= pd!.region.left &&
      pd!.clientX <= pd!.region.right;
    expect(
      inRegion,
      `click: the pointerdown at (${pd!.clientX}, ${pd!.clientY}) lies outside the region ` +
        `measured at that moment ${JSON.stringify(pd!.region)}`
    ).toBe(true);
    await expect(
      popup,
      'post-click: the close control received the real pointerdown but the popup did not close'
    ).toHaveCount(0);
  });
});

test.describe('r2 finding 2: a visual viewport diverging from the layout viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the clamp follows an offset visual-viewport band, not the layout viewport', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&embed=true&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // Premise: before the divergence the card does NOT already sit inside
    // the band the fake visual viewport will define, so the assertion
    // below can only pass if the clamp really reads the visual viewport.
    const before = await content.boundingBox();
    expect(before).not.toBeNull();
    expect(
      before!.y >= 511 && before!.y + before!.height <= 689,
      'premise: the card must start outside the 512..688 band'
    ).toBe(false);

    // The seam: containingBounds reads `window.visualViewport` fresh at
    // every clamp, so an instance-level override diverging from the
    // layout viewport (Playwright's setViewportSize always moves both
    // together) takes effect at the next re-clamp trigger. This models
    // mobile browser chrome or the on-screen keyboard shrinking the
    // visual viewport with no layout resize.
    await page.evaluate(() => {
      const fake = { offsetTop: 500, offsetLeft: 0, width: 390, height: 200 };
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        get: () => fake
      });
      window.dispatchEvent(new Event('resize'));
    });
    // The layout viewport is untouched: only the visual viewport moved.
    expect(await page.evaluate(() => document.documentElement.clientHeight)).toBe(844);
    // The card lands inside the visual-viewport band (500..700 inset by
    // the 12px margin), which the layout viewport alone would never force.
    await expect
      .poll(
        async () => {
          const cbox = await content.boundingBox();
          if (!cbox) return 'no box';
          return cbox.y >= 511 && cbox.y + cbox.height <= 689 ? 'ok' : JSON.stringify(cbox);
        },
        { message: 'the card never followed the visual viewport band', timeout: 10_000 }
      )
      .toBe('ok');
  });
});

test.describe('DEF-4 finding 1: viewport resize while telemetry hydration is in flight (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the popup is re-clamped when hydration content lands after a resize', async ({ page }) => {
    // Delay, then abort, the live data routes: hydration is still pending
    // when the viewport shrinks, and it settles on the honest fallback
    // (content growth) afterward, so the growth re-clamp runs against the
    // NEW bounds.
    const delayedAbort = async (route: import('@playwright/test').Route): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.abort('failed');
    };
    await page.route('**/ddm-proxy.atniclimate.workers.dev/**', delayedAbort);
    await page.route('**/waterservices.usgs.gov/**', delayedAbort);
    // The 'ihr' station hydrates through the direct USACE CWMS Data API
    // (wildcard CORS), not the proxy; without this route the popup would
    // hydrate LIVE and the honest fallback would never render.
    await page.route('**/cwms-data.usace.army.mil/**', delayedAbort);

    // `region=washington_state` pins the camera this case was measured under
    // (DR-109): the 'ihr' station sits in Washington, and its popup geometry
    // at 390x844 and after the resize assumes the Washington framing, not
    // the national one. `layers=` already routes this boot to the console,
    // so the raw region= changes no door.
    await gotoApp(page, '?region=washington_state&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');

    const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
    await expect(marker).toHaveCount(1);
    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    await expect(async () => {
      await marker.click();
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });

    // Shrink the viewport while the data slot is still fetching.
    await page.setViewportSize({ width: 320, height: 560 });

    // The resize's moveend re-runs the debounced station discovery, which
    // can rebuild the markers and destroy the open popup with them; when
    // that happens the retry below re-opens it (its hydration then runs
    // wholly at the new viewport, which still exercises growth-after-
    // resize). Either way the popup we assert on carries the honest
    // fallback, which arrived AFTER the clamp bounds changed (since D1 M26c
    // the framed card's unavailable state, which repaints the frame whole).
    await expect(async () => {
      if ((await popup.count()) === 0) {
        await marker.click();
      }
      await expect(popup.locator('[data-popup-frame] [data-popup-slot="value"] [data-state]')).toHaveText('unavailable', { timeout: 4000 });
    }).toPass({ timeout: 30_000 });

    const vp = page.viewportSize()!;
    const chromeTop = await bottomChromeTop(page);
    const cbox = await content.boundingBox();
    expect(cbox).not.toBeNull();
    expect(cbox!.y, 'the card extends above the viewport').toBeGreaterThanOrEqual(-1);
    expect(cbox!.x, 'the card extends left of the viewport').toBeGreaterThanOrEqual(-1);
    expect(
      cbox!.y + cbox!.height,
      'the card extends below the reachable region'
    ).toBeLessThanOrEqual(Math.min(vp.height, chromeTop) + 1);
    expect(
      cbox!.x + cbox!.width,
      'the card extends past the right viewport edge'
    ).toBeLessThanOrEqual(vp.width + 1);

    // Reachability receipt: the close control is hit-testable and really
    // dismisses at the post-resize geometry.
    const closeButton = popup.locator('.maplibregl-popup-close-button');
    await expectHitTestReachable(closeButton, 'popup close control after the resize');
    await closeButton.click();
    await expect(popup).toHaveCount(0);
  });
});

test.describe('DEF-4: the telemetry popup fits a 390px viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * Wait until the marker's rendered position is STABLE: two consecutive
   * samples a beat apart that agree within 1px. Condition-based on the
   * marker's own box (which also re-resolves across the debounced
   * station-discovery rebuild that destroys and re-creates markers), so a
   * slow software-rendered runner waits exactly as long as it needs
   * instead of racing a fixed sleep. Times out HONESTLY: never settles,
   * the assertion fails.
   */
  async function waitForStableMarker(
    page: Page,
    marker: ReturnType<Page['locator']>,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let prev: { x: number; y: number } | null = null;
    while (Date.now() < deadline) {
      const box = await marker.boundingBox();
      if (
        box &&
        prev &&
        Math.abs(box.x - prev.x) <= 1 &&
        Math.abs(box.y - prev.y) <= 1
      ) {
        return;
      }
      prev = box ? { x: box.x, y: box.y } : null;
      await page.waitForTimeout(250);
    }
    expect(false, 'the marker never settled to a stable position').toBe(true);
  }

  /**
   * Drag the map until the marker's center sits near the target point.
   * The drag starts well away from the marker path so no marker swallows
   * the mousedown, and each step waits for the marker to settle (inertia
   * plus any rebuild) rather than sleeping a fixed interval.
   */
  async function dragMarkerNear(
    page: Page,
    marker: ReturnType<Page['locator']>,
    target: { x: number; y: number }
  ): Promise<void> {
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    for (let i = 0; i < 8; i++) {
      const box = await marker.boundingBox();
      expect(box, 'the seed marker left the viewport during positioning').not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      let dx = target.x - cx;
      let dy = target.y - cy;
      if (Math.abs(dx) <= 25 && Math.abs(dy) <= 60) return;
      dx = Math.max(-140, Math.min(140, dx));
      dy = Math.max(-140, Math.min(140, dy));
      const sx = mapBox!.x + mapBox!.width / 2 + 60;
      const sy = mapBox!.y + 220;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + dx, sy + dy, { steps: 10 });
      await page.mouse.up();
      await waitForStableMarker(page, marker, 4_000);
    }
    const settled = await marker.boundingBox();
    expect(
      settled && Math.abs(settled.x + settled.width / 2 - target.x) <= 30,
      'could not position the marker near the target x'
    ).toBeTruthy();
  }

  test('a marker popup near the left edge keeps its box and close control on-screen', async ({
    page
  }) => {
    // Deterministic backbone: abort the live telemetry data routes so the
    // popup settles on its honest fallback instead of racing an upstream.
    await page.route('**/ddm-proxy.atniclimate.workers.dev/**', (route) => route.abort('failed'));
    await page.route('**/waterservices.usgs.gov/**', (route) => route.abort('failed'));
    // The 'ihr' station hydrates through the direct USACE CWMS Data API
    // (wildcard CORS), not the proxy; without this route the popup would
    // hydrate LIVE and the honest fallback would never render.
    await page.route('**/cwms-data.usace.army.mil/**', (route) => route.abort('failed'));

    // `region=washington_state` pins the camera this case was measured
    // under (DR-109): the 'ihr' station sits in Washington, and the drag
    // target below assumes the Washington framing, not the national one.
    // `layers=` already routes this boot to the console, so the raw
    // region= changes no door.
    await gotoApp(page, '?region=washington_state&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');

    // The curated seed markers render without any network (the
    // tests/telemetry-discovery.spec.ts contract). Put one at the
    // geometry the triage measured: a marker in the left third, where
    // MapLibre anchors the card to extend RIGHT and a 320 px box crosses
    // the 390 px edge (measured 89 px past it, close control off-screen).
    const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
    await expect(marker).toHaveCount(1);
    await dragMarkerNear(page, marker, { x: 120, y: 430 });

    // Each drag's moveend re-runs the debounced station discovery, which
    // REBUILDS every marker (and destroys any open popup with it). Wait
    // for the layer to settle and the marker's position to hold still
    // (condition-based; the locator re-resolves across a rebuild) before
    // opening the popup we assert on. A straggling rebuild after this
    // window is absorbed by the toPass retry around the click below.
    await waitForLayerSettled(page, 'telemetry');
    await waitForStableMarker(page, marker, 8_000);

    const popup = page.locator('.maplibregl-popup');
    await expect(async () => {
      await marker.click();
      await expect(popup.locator('.maplibregl-popup-content')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });

    // THE DEF-4 CONTRACT: the whole popup box fits the viewport, and the
    // close control is genuinely on-screen and usable.
    const viewport = page.viewportSize()!;
    expectWithinViewport(await popup.boundingBox(), viewport, 'telemetry popup');

    const closeButton = popup.locator('.maplibregl-popup-close-button');
    expectWithinViewport(await closeButton.boundingBox(), viewport, 'popup close control');

    // Reachability receipt: the close control actually dismisses.
    await closeButton.click();
    await expect(popup).toHaveCount(0);
  });
});

/**
 * DDM-P11-T02 acceptance (ROADMAP.yaml, verbatim): "A tap within the pointer
 * tolerance opens the popup it aimed at, the popup can be dismissed and
 * traversed from the keyboard, and the briefing door is labeled for the
 * briefing it opens." Clauses below map 1:1 onto that sentence; DR-042
 * (session-ruled 2026-09-09) is cited where it bears on a clause.
 *
 * Clause 1 (pointer tolerance) is proved with a hand-authored perimeter
 * fixture placed well inside the pinned Washington State region fit
 * (src/config/regions.ts `washington_state`), so the polygon's on-screen
 * position never depends on the raw boot camera constants (which a region
 * fit moves away from) or on guessing MapLibre's Web Mercator math: the
 * true edge is found EMPIRICALLY, by clicking and reading which title (if
 * any) painted, exactly the black-box technique the rest of this suite
 * already uses for canvas-rendered features (interaction-coordinator.spec.ts
 * `clickCenterUntilPrimary`; the production build strips the dev map
 * handle, so no spec can query the render set directly).
 */
const TOLERANCE_FIXTURE_NAME = 'Pointer Tolerance Test Fire';
const TOLERANCE_FIXTURE_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        attr_IncidentTypeCategory: 'WF',
        poly_IncidentName: TOLERANCE_FIXTURE_NAME
      },
      // Large on purpose: the `nifc-fires`-only boot's camera fit zooms out
      // far enough (measured: about 1200km of visible width at a 390px
      // phone viewport) that a realistic incident-sized polygon renders as
      // a ~20px sliver, too small for a reliable coarse grid scan or a
      // meaningful "8px off the edge" test. This fixture trades realism
      // for a comfortably large, reliably discoverable on-screen target.
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-123.0, 45.6],
            [-119.0, 45.6],
            [-119.0, 48.8],
            [-123.0, 48.8],
            [-123.0, 45.6]
          ]
        ]
      }
    }
  ]
};

/** Route the one NIFC WFIGS perimeters query to the tolerance fixture above. */
async function stubToleranceFixture(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.includes('WFIGS_Interagency_Perimeters_Current'),
    (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(TOLERANCE_FIXTURE_FC)
      })
  );
}

async function bootToleranceFixture(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  await stubToleranceFixture(page);
  await gotoApp(page, '?region=washington_state&view=console&layers=nifc-fires');
  await waitForLayerSettled(page, 'nifc-fires');
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  return box;
}

/**
 * Read the coordinated response's title after a click, WITHOUT paying a
 * full auto-wait timeout on a miss: the coordinator paints (or tears down)
 * a popup synchronously on the MapLibre `click` handler, so a short fixed
 * settle is enough, and a plain `count()` after it distinguishes hit from
 * miss in one round trip instead of waiting out a locator timeout on every
 * miss (which a grid scan or a binary search produces many of).
 */
async function titleAfterClick(page: Page, x: number, y: number): Promise<string | null> {
  await page.mouse.click(Math.round(x), Math.round(y));
  await page.waitForTimeout(150);
  const title = page.locator('.maplibregl-popup-content .popup-title').first();
  if ((await title.count()) === 0) return null;
  return ((await title.textContent()) ?? '').trim();
}

/**
 * Find a pixel on the tolerance fixture's RIGHT edge, under FINE (mouse)
 * tolerance: a coarse grid scan locates any point inside the polygon, then
 * a rightward binary search converges on the largest x that still returns
 * the fixture's title. That x is the fine-tolerance clickable boundary
 * (CLICK_BOX_FINE_PX past the true geometric edge; the true edge itself is
 * never needed, only this empirically observed, deterministic boundary,
 * reused verbatim by every context that boots the same fixture at the same
 * viewport size).
 */
async function findFineToleranceBoundary(
  page: Page,
  box: { x: number; y: number; width: number; height: number }
): Promise<{ x: number; y: number }> {
  let insideX: number | null = null;
  let insideY: number | null = null;
  outer: for (let gy = 1; gy < 5; gy++) {
    const y = box.y + (box.height * gy) / 5;
    for (let gx = 2; gx <= 8; gx++) {
      const x = box.x + (box.width * gx) / 10;
      const t = await titleAfterClick(page, x, y);
      if (t === TOLERANCE_FIXTURE_NAME) {
        insideX = x;
        insideY = y;
        break outer;
      }
    }
  }
  if (insideX === null || insideY === null) {
    throw new Error(
      `the "${TOLERANCE_FIXTURE_NAME}" fixture was never found in the coarse grid scan`
    );
  }

  let lo = insideX;
  let hi = box.x + box.width - 4;
  const hiTitle = await titleAfterClick(page, hi, insideY);
  if (hiTitle === TOLERANCE_FIXTURE_NAME) {
    throw new Error('the right map edge is still inside the fixture; it does not fit this viewport');
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2;
    const t = await titleAfterClick(page, mid, insideY);
    if (t === TOLERANCE_FIXTURE_NAME) lo = mid;
    else hi = mid;
  }
  return { x: lo, y: insideY };
}

for (const [label, viewport] of [
  ['phone (390x844)', { width: 390, height: 844 }],
  ['tablet (820x1180)', { width: 820, height: 1180 }]
] as const) {
  // One page per test (the ordinary Playwright fixture), never a second
  // Page or context: tests/boundary-boot-inventory.test.mjs requires any
  // second Page in this suite to be recorded, with its own stub story, in
  // `SECOND_PAGE_REASONS`, and the two pointer profiles below do not need
  // one. `.serial` threads the fine-tolerance boundary (a closure
  // variable) from the first test into the second instead: the SAME
  // deterministic boot (same URL, same viewport, same fixture) reproduces
  // the SAME projection on a fresh page, so the measured pixel transfers.
  test.describe.serial(`DDM-P11-T02 clause 1: pointer tolerance at ${label}`, () => {
    let boundary: { x: number; y: number } | null = null;

    test.describe('fine pointer (mouse-like, pointer: fine)', () => {
      test.use({ viewport });

      test(`locates the fine-tolerance boundary; 1px beyond it misses (${label})`, async ({
        page
      }) => {
        // `CLICK_BOX_FINE_PX = 6` (src/map/interaction-coordinator.ts), so
        // the located boundary is empirically the true edge plus about 6px.
        const box = await bootToleranceFixture(page);
        boundary = await findFineToleranceBoundary(page, box);

        const missTitle = await titleAfterClick(page, boundary.x + 1, boundary.y);
        expect(
          missTitle,
          'one pixel past the fine-tolerance boundary must miss (outside the 6px fine box)'
        ).not.toBe(TOLERANCE_FIXTURE_NAME);
      });
    });

    test.describe('coarse pointer (touch, pointer: coarse)', () => {
      test.use({ viewport, hasTouch: true });

      test(`a point about 8px past the true edge hits under the coarse box (${label})`, async ({
        page
      }) => {
        expect(boundary, 'the fine-tolerance boundary was not measured by the prior test').not.toBeNull();
        await bootToleranceFixture(page);

        // 2px past the fine boundary (itself the true edge plus about 6px)
        // is about 8px past the true edge: `CLICK_BOX_COARSE_PX = 12` must
        // reach it and open the fixture's OWN popup, not a neighbor (there
        // is no other feature anywhere near this fixture).
        const testX = boundary!.x + 2;
        const hitTitle = await titleAfterClick(page, testX, boundary!.y);
        expect(
          hitTitle,
          'a touch tap about 8px outside the fixture edge must hit it (inside the 12px coarse box) and open ITS OWN popup'
        ).toBe(TOLERANCE_FIXTURE_NAME);
      });
    });
  });
}

/**
 * Clause 2: the popup can be dismissed and traversed from the keyboard.
 * MapLibre's own Popup focuses its content on open (`focusAfterOpen`,
 * default true) and this project adds no separate focus manager (the
 * brief: "do not invent a new focus manager"), so this proves the NATIVE
 * behavior on the coordinator's own head/body layout: focus lands inside
 * the popup, Tab reaches the briefing door and then the body's source
 * links in DOM order, Escape dismisses, and focus is not left dangling
 * inside the now-removed popup afterward.
 */
test.describe('DDM-P11-T02 clause 2: the popup is dismissable and keyboard-traversable', () => {
  test('Tab reaches the door and the body links; Escape dismisses; focus does not stay in the removed popup', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // Focus lands inside the popup on open (MapLibre's native
    // `focusAfterOpen`); no collision fixture is active, so the head
    // carries no "Other map features here" disclosure and Tab order is
    // exactly: (close button or door, in DOM order) then the body links.
    await expect
      .poll(async () => content.evaluate((el) => el.contains(document.activeElement)), {
        message: 'focus never landed inside the popup on open'
      })
      .toBe(true);

    const door = popup.locator('[data-ddm-impact-trigger]');
    await expect(door).toBeVisible();
    let reachedDoor = false;
    let reachedLink = false;
    for (let i = 0; i < 8; i++) {
      const isDoor = await door.evaluate((el) => el === document.activeElement).catch(() => false);
      if (isDoor) reachedDoor = true;
      const isLink = await page.evaluate(
        () => document.activeElement?.closest('.coordinated-response-body a[href]') !== null
      );
      if (isLink) reachedLink = true;
      if (reachedDoor && reachedLink) break;
      await page.keyboard.press('Tab');
    }
    expect(reachedDoor, 'Tab never reached the briefing door').toBe(true);
    expect(reachedLink, 'Tab never reached a body source link').toBe(true);

    // Escape dismisses, and focus is not left inside the (now-removed)
    // popup: it returns to the document (map or trigger), per the brief.
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    const strandedInPopup = await page.evaluate(
      () => document.activeElement?.closest('.maplibregl-popup') !== null
    );
    expect(strandedInPopup, 'focus was left inside the removed popup after Escape').toBe(false);
    const focusIsLive = await page.evaluate(
      () => document.activeElement !== null && document.body.contains(document.activeElement)
    );
    expect(focusIsLive, 'focus fell off the document entirely after Escape').toBe(true);
  });
});

/**
 * Clause 3: the briefing door is labeled for the briefing it opens. Proved
 * on a place-bearing (boundary) popup outside the mobile Brief sheet's U2
 * route (the shipped route stays: interaction-coordinator.ts:376-385
 * sends a place-bearing tap in the active mobile Brief sheet straight to
 * the half detent with no popup; this is `?view=console`, not that
 * surface).
 */
test.describe('DDM-P11-T02 clause 3: the door names the place it opens a briefing for', () => {
  test('the door sits after the title in the frozen head, names the place, and opens its own briefing', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const popup = page.locator('.maplibregl-popup-content');
    const head = popup.locator('.coordinated-response-head');
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(popup).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    const title = (await head.locator('.popup-title').textContent())?.trim();
    expect(title, 'the boundary popup carries no title to compare the door against').toBeTruthy();

    const door = head.locator('[data-ddm-impact-trigger]');
    await expect(door).toBeVisible();
    // Head order: title, then the door (this fixture has no collision, so
    // no "Other map features here" disclosure follows). Since D1 M24 the
    // door sits in the frame's actions slot, a head child after the title.
    const order = await head.evaluate((el) =>
      [...el.children].map((c) =>
        c.matches('.popup-title')
          ? 'title'
          : c.matches('[data-ddm-impact-trigger]') ||
              (c.matches('[data-popup-slot="actions"]') && c.querySelector(':scope > [data-ddm-impact-trigger]'))
            ? 'door'
            : 'other'
      )
    );
    expect(order.indexOf('door')).toBeGreaterThan(order.indexOf('title'));

    // Visible text and accessible name are the SAME string (no separate
    // `aria-label`), and both name the place.
    const doorText = (await door.textContent())?.trim() ?? '';
    const doorAccessibleName = await door.evaluate((el) => el.getAttribute('aria-label'));
    expect(doorAccessibleName, 'the door must not carry a diverging aria-label').toBeNull();
    expect(doorText).toContain(title!);
    expect(doorText.toLowerCase()).toContain('impact briefing');

    await door.click();
    const panelTitle = page.locator('#impact-panel-title');
    await expect(page.locator('#impact-panel')).toBeVisible();
    await expect(panelTitle).toHaveText(title!);
  });
});

/**
 * Clause 3 continued, DR-042 option a (session-ruled 2026-09-09): a
 * condition-surface tap (the map feature itself is the subject, not a
 * place) that resolves a place through `resolveLocationIdentity` gains
 * the SAME place-specific door in its already-painted head; one that
 * resolves nothing gets none. The default NADM drought polygon
 * (tests/helpers.ts `installDefaultNadmStub`) is replaced here by an equally
 * broad hand-authored polygon so `nadm-drought` can be the ONLY active
 * layer (no `states` boundary competing for the same click, which would
 * out-rank the condition surface under the precedence table and defeat
 * the point of this case): `region=` alone then decides whether the
 * click resolves a US state (`washington_state`, the default region) or
 * nothing (`british_columbia`, entirely outside every US state and with
 * no Tribal boundary layer active).
 */
const BROAD_CONDITION_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { DROUGHTCAT: 'd2', YEAR_MONTH: '202606' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]]
      }
    }
  ]
};

async function stubBroadCondition(page: Page): Promise<void> {
  await page.route('**/NADM-current.geojson', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(BROAD_CONDITION_FC)
    })
  );
}

test.describe('DDM-P11-T02 clause 3, DR-042 option a: the condition-surface door', () => {
  test('a condition tap that resolves a place gains a place-specific door', async ({ page }) => {
    await stubBroadCondition(page);
    // region=washington_state is pinned (src/config/regions.ts's
    // DEFAULT_REGION). Only `nadm-drought` is active, so `states` never
    // competes for the click.
    await gotoApp(page, '?region=washington_state&view=console&layers=nadm-drought');
    await waitForLayerSettled(page, 'nadm-drought');

    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const popup = page.locator('.maplibregl-popup-content');
    const head = popup.locator('.coordinated-response-head');
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(popup).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // The popup painted FIRST with no door (the condition tap's own
    // response carries no `selection`): true right after open, and the
    // door appears only once identity resolution settles.
    const door = head.locator('[data-ddm-impact-trigger]');
    await expect(door).toBeVisible({ timeout: 10_000 });
    await expect(door).toContainText('Washington');

    await door.click();
    await expect(page.locator('#impact-panel')).toBeVisible();
    await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
  });

  test('a condition tap that resolves nothing gets no door', async ({ page }) => {
    await stubBroadCondition(page);
    await gotoApp(page, '?view=console&layers=nadm-drought&region=british_columbia');
    await waitForLayerSettled(page, 'nadm-drought');
    // Registered after the boot and before the click: nothing else in this
    // test reads the bundled states file (no `states` layer, no `select=`, no
    // Place studio), so the click's state fallback is this request's only
    // trigger.
    const usStatesRequested = page.waitForRequest('**/us-states.geojson');

    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const popup = page.locator('.maplibregl-popup-content');
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(popup).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // No `states` layer is active, so `resolveLocationIdentity`'s state
    // fallback always issues the shared `us-states-geojson` fetch
    // (US_STATES_SHARED_KEY, src/util/fetch.ts) for this click; wait for the
    // seam to prove that fetch (and everything else pending) has settled,
    // then assert the door never arrived: British Columbia is outside every
    // US state and no Tribal boundary layer is active. The wait starts only
    // once that fetch has left the page: the J7 receipt
    // (I:/claude-temp/ddm-s30d/gates/j7.log, at 7a2b48d) showed the bare
    // wait passing in 1.1 s with the request held, before the fetch began.
    await usStatesRequested;
    await awaitQuiescence(page);
    await expect(popup.locator('[data-ddm-impact-trigger]')).toHaveCount(0);
  });
});

/**
 * found-099 (Codex landed-diff F4): the open Key drawer's left-edge
 * exclusion (src/ui/popup-viewport.ts's containingBounds, "the drawer
 * block") is the desktop shell's own rule (the Key's isDesktopChip
 * predicate, src/ui/map-key.ts near :1239); `#map-key-content` is also
 * visible on phone and in an embed (map-key.ts near :1143-1145,
 * :1187-1221), where the plain rule never applies. Before the fix, a
 * popup near the map's left edge on phone or in an embed with the Key
 * open either slid to the drawer's right edge plus 8px (a bound with no
 * meaning off the desktop shell) or, when that bound left no usable
 * width, had its clamp abandoned outright (containingBounds's EMPTY
 * tier, popup-viewport.ts near :447).
 *
 * Each case commits a synthetic MapLibre-shaped popup (no live geometry
 * or hydration needed) with a raw anchor placed well left of the map's
 * own left edge, so the SLIDE mechanism (popup-viewport.ts's `dx`) is
 * exercised either way: fixed, it pulls the content in to the plain
 * 12px edge margin; unfixed, it either stops short (still left of the
 * map, the EMPTY-tier abandonment) or overshoots well past the margin
 * toward the drawer's own right edge.
 */
test.describe('found-099: the Key drawer exclusion applies only on the desktop non-embed shell', () => {
  async function openKeyDrawer(page: Page): Promise<void> {
    const toggle = page.locator('#map-key-details-toggle');
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await expect(page.locator('#map-key-content')).toBeVisible();
  }

  /** The same synthetic MapLibre-shaped popup probe map-drawers.spec.ts
   * uses for this drawer's own clamp cases, with the raw anchor placed
   * left of the map so an unfixed clamp's SLIDE (or its EMPTY-tier
   * abandonment) is visible in the settled position. */
  async function commitLeftProbePopup(page: Page, topPx: number): Promise<void> {
    await page.evaluate((topPxArg) => {
      const mapEl = document.querySelector('.maplibregl-map');
      if (!mapEl) throw new Error('no .maplibregl-map to host the probe popup');
      const popup = document.createElement('div');
      popup.className = 'maplibregl-popup maplibregl-popup-anchor-bottom';
      popup.style.position = 'absolute';
      popup.style.top = '0';
      popup.style.left = '0';
      popup.style.transform = `translate(-100px, ${topPxArg}px)`;
      popup.style.zIndex = '10';
      const tip = document.createElement('div');
      tip.className = 'maplibregl-popup-tip';
      const content = document.createElement('div');
      content.className = 'maplibregl-popup-content';
      content.style.width = '220px';
      content.textContent =
        'found-099 drawer-guard probe: content long enough to carry a real width and height.';
      popup.append(tip, content);
      mapEl.appendChild(popup);
    }, topPx);
  }

  async function proveMarginNotDrawer(page: Page): Promise<void> {
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox, 'the map lost its bounding box').not.toBeNull();
    await commitLeftProbePopup(page, mapBox!.height / 2);

    const content = page.locator('.maplibregl-popup-content');
    await expect(content).toBeVisible();
    await expect
      .poll(() => content.evaluate((el) => el.getBoundingClientRect().width > 0))
      .toBe(true);
    const cbox = await content.boundingBox();
    expect(cbox, 'the probe popup content has no box').not.toBeNull();
    // THE FIX (found-099): the drawer clause never runs off the desktop
    // non-embed shell, so the SLIDE pulls the raw off-map anchor in to
    // the plain 12px edge margin only (popup-viewport.ts's EDGE_MARGIN_PX),
    // never the drawer's own right edge plus 8px, and the clamp is never
    // abandoned. Predicted red at 531ab66: cbox!.x sits well past this
    // window (pushed toward the drawer's right edge) or well short of it
    // (still at the raw -100px anchor, the EMPTY-tier abandonment).
    expect(
      cbox!.x,
      `the popup (left ${cbox!.x}, map left ${mapBox!.x}) is not held at the plain 12px edge margin`
    ).toBeGreaterThanOrEqual(mapBox!.x + 12 - 2);
    expect(
      cbox!.x,
      `the popup (left ${cbox!.x}, map left ${mapBox!.x}) sits well past the plain edge margin, as if the drawer's own clearance (or an abandoned clamp) still applied`
    ).toBeLessThanOrEqual(mapBox!.x + 12 + 2);
  }

  test('at 390x844 (phone, non-embed) with the Key open, a popup near the map left edge keeps the plain margin, not the Key drawer clearance', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await openKeyDrawer(page);
    await proveMarginNotDrawer(page);
  });

  test('in an embed at 390x844 with the Key open, a popup near the map left edge keeps the plain margin, not the Key drawer clearance', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?embed=true');
    await openKeyDrawer(page);
    await proveMarginNotDrawer(page);
  });
});

/**
 * S30D D1 M23, DDM-P17-T11 (DR-149): the close control owns its own seat
 * in every coordinated map popup head, at DDM-P17-T07's 24px floor on a
 * fine pointer and the 44px touch floor on a coarse one, and no head
 * content (the title's lines, and every later head row) ever sits under
 * it, at every desktop size the fit specs cover. Measured rectangles, one
 * read, not asserted from CSS. The long title fills the control's band
 * with title lines; the one-word title leaves the band to the rows beneath
 * it, which is what a title-margin-only seat would fail at the coarse
 * size. The phone size waits for the mobile pass (DR-149, recorded
 * 2026-09-30): no phone viewport is asserted here, and the phone rules are
 * unchanged.
 *
 * Predicted red at cb836fe (no seat): at the fine size the title block and
 * its first line reach 8px under the 24px control (the card's 16px right
 * padding covers only part of it); at the coarse size 28px, and the
 * one-word title's agency line beneath it intersects the 44px control too.
 */
const SEAT_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;
const SEAT_LONG_TITLE =
  'Synthetic Reservation Fixture With A Deliberately Long Name That Wraps Across Several Head Lines';
const SEAT_SHORT_TITLE = 'Fixture';

/** The synthetic BIA fixture (tests/tribal-fixtures.ts) under another name. */
function biaBodyNamed(name: string): unknown {
  const body = syntheticBiaBody();
  return {
    ...body,
    features: body.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, LARNAME: name }
    }))
  };
}

interface SeatBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface SeatRead {
  readonly close: SeatBox & { readonly width: number; readonly height: number };
  readonly closeHit: boolean;
  readonly boxes: ReadonlyArray<SeatBox & { readonly what: string; readonly title: boolean }>;
}

/** One read of the close control and every head element and text line box. */
async function readSeat(page: Page): Promise<SeatRead> {
  return page.evaluate(() => {
    const content = document.querySelector('.ddm-coordinated-popup .maplibregl-popup-content');
    const close = content?.querySelector(':scope > .maplibregl-popup-close-button');
    const head = content?.querySelector('.coordinated-response-head');
    if (!content || !close || !head) throw new Error('no coordinated popup with a close control and a head');
    const title = head.querySelector('.popup-title');
    const box = (r: DOMRect): SeatBox => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const boxes: Array<SeatBox & { what: string; title: boolean }> = [];
    for (const el of Array.from(head.querySelectorAll('*'))) {
      for (const r of Array.from(el.getClientRects())) {
        if (r.width > 0 && r.height > 0) {
          boxes.push({ ...box(r), what: `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`, title: title?.contains(el) ?? false });
        }
      }
    }
    const walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      if (text === '') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0 && r.height > 0) {
          boxes.push({ ...box(r), what: `text "${text.slice(0, 32)}"`, title: title?.contains(node) ?? false });
        }
      }
    }
    const c = close.getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    return {
      close: { ...box(c), width: c.width, height: c.height },
      closeHit: hit !== null && (hit === close || close.contains(hit)),
      boxes
    };
  });
}

for (const viewport of SEAT_VIEWPORTS) {
  for (const coarse of [false, true]) {
    test.describe(`DDM-P17-T11: the close seat at ${viewport.width}x${viewport.height}, ${coarse ? 'coarse' : 'fine'} pointer`, () => {
      test.use({ viewport, hasTouch: coarse });

      test('the close control owns its seat: no head content intersects it, long title and one-word title', async ({
        page
      }) => {
        const floor = coarse ? 44 : 24;
        let larName: string = SEAT_LONG_TITLE;
        await routeBoundary(page, BIA_ROUTE, (route: Route) =>
          route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(biaBodyNamed(larName)) })
        );
        for (const name of [SEAT_LONG_TITLE, SEAT_SHORT_TITLE]) {
          larName = name;
          await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
          await waitForLayerSettled(page, 'bia-reservations');
          const mapBox = await page.locator('#map').boundingBox();
          expect(mapBox).not.toBeNull();
          const title = page.locator('.ddm-coordinated-popup .coordinated-response-head .popup-title');
          await expect(async () => {
            await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
            await expect(title).toHaveText(name, { timeout: 1500 });
          }).toPass({ timeout: 20_000 });

          const seat = await readSeat(page);
          const c = seat.close;
          expect(c.width, `the close control is under the ${floor}px floor`).toBeGreaterThanOrEqual(floor - 0.5);
          expect(c.height, `the close control is under the ${floor}px floor`).toBeGreaterThanOrEqual(floor - 0.5);
          expect(seat.closeHit, 'the close control is not the element under its own center').toBe(true);
          const under = seat.boxes
            .filter(
              (b) =>
                Math.min(b.right, c.right) - Math.max(b.left, c.left) > 0.5 &&
                Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top) > 0.5
            )
            .map((b) => b.what);
          expect(under, `head content under the close control ("${name}")`).toEqual([]);
          // Not vacuous: the measured content really shares the control's band.
          if (name === SEAT_LONG_TITLE) {
            expect(seat.boxes.some((b) => b.title && b.top < c.bottom), 'the title never reached the control band').toBe(true);
          } else if (coarse) {
            expect(
              seat.boxes.some((b) => !b.title && b.top < c.bottom),
              'no head row below the one-word title reached the 44px control band'
            ).toBe(true);
          }
        }
      });
    });
  }
}

/**
 * S30D D1 M23, the N2 brief correction C1: one usable close control per
 * sink. The place-label target asks for `closeButton: false`
 * (src/layers/places.ts), and the coordinator used to spread that over its
 * own `closeButton: true`; it now forces the close control after the
 * response's options. A synthetic one-place bundle (a long name, so the
 * wrapped label covers the map centre and a small probe pattern around
 * it) stands in for the bundled Natural Earth labels.
 *
 * Predicted red at cb836fe: the place popup opens with no close control
 * (count 0).
 */
const PLACE_FIXTURE_NAME =
  'Fixture Place Label With A Name Long Enough To Wrap Over Several Lines';

test.describe('D1 M23 C1: the place-label popup keeps one usable close control', () => {
  test('a place-label popup opens with exactly one usable close control', async ({ page }) => {
    await page.route('**/data/us-places.json', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meta: { count: 1 },
          places: [{ name: PLACE_FIXTURE_NAME, lon: -120.84, lat: 47.29, rank: 0 }]
        })
      })
    );
    await gotoApp(page, '?region=washington_state&view=console&layers=places');
    await waitForLayerSettled(page, 'places');
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const cx = mapBox!.x + mapBox!.width / 2;
    const cy = mapBox!.y + mapBox!.height / 2;
    const probes: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [0, -24], [0, 24], [-40, 0], [40, 0], [-40, -24], [40, 24], [-40, 24], [40, -24]
    ];
    const popup = page.locator('.maplibregl-popup').filter({ has: page.locator('[data-ddm-response="us-places-labels"]') });
    let probe = 0;
    await expect(async () => {
      const [dx, dy] = probes[probe++ % probes.length]!;
      await page.mouse.click(cx + dx, cy + dy);
      await expect(popup).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(popup.locator('[data-popup-slot="title"]')).toHaveText(PLACE_FIXTURE_NAME);
    const close = popup.locator('.maplibregl-popup-close-button');
    await expect(close).toHaveCount(1);
    await expectHitTestReachable(close, 'the place-label popup close control');
    await close.click();
    await expect(popup).toHaveCount(0);
  });
});

/**
 * The Codex Tier 2 review's PF3 rows (2026-09-27_s30d-d1-tier2-designs.md
 * :219 and :221), generic over the builders that have left the legacy
 * allowance (tests/identify-paths-manifest.ts). Only a framed popup moves
 * the primary source into the head, so the rows bite per migrated builder;
 * at M23 none has migrated, and the count is asserted so the empty loop is
 * declared, not accidental. M24 to M26 add each migrated builder's
 * fixture boot here as they shrink the allowance.
 */
test.describe('D1 M23 PF3: framed heads keep the tier promises (generic over migrated builders)', () => {
  // Each migrated builder's fixture (tests/frame-fixtures.ts) runs on a fresh
  // page, so its routes and viewport never reach the next builder's.
  async function eachTierFixture(
    context: BrowserContext,
    missing: string,
    run: (fixture: TierFixture, page: Page) => Promise<void>
  ): Promise<void> {
    const migrated = migratedBuilders();
    expect(migrated.length).toBe(eligibleBuilders().length - LEGACY_ALLOWANCE.length);
    // Network-isolated (the Codex review of M24 round 1, finding 2): ONE
    // catch-all external-request backstop on the context, installed BEFORE
    // the first fresh page boots (the census installs the same 503 backstop
    // on its context before its first boot, tests/identify-paths.spec.ts
    // holdExternalNetwork, and its fixture pages share that context).
    // gotoApp's context stubs, registered later, are
    // checked first and keep their fixtures; each fixture's page routes are
    // checked before both. Any other external request (the OSM raster tiles,
    // an unstubbed service) is answered 503 with a synthetic text body, so no
    // live service decides a result, for M24's place fixtures and for every
    // batch module TIER_FIXTURES spreads.
    await context.route(
      (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
      (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
    );
    for (const builder of migrated) {
      const fixture = TIER_FIXTURES[builder.id];
      if (!fixture) throw new Error(`${builder.id} left LEGACY_ALLOWANCE without a ${missing} fixture here`);
      const page = await context.newPage();
      try {
        await run(fixture, page);
      } finally {
        await page.close();
      }
    }
  }

  test('sources and caveat remain clickable at FULL and usable-COMPACT boundaries', async ({ context }) => {
    test.setTimeout(60_000 + 60_000 * migratedBuilders().length);
    await eachTierFixture(context, 'FULL and usable-COMPACT source', (fixture, page) =>
      fixture.sourcesAtTierBoundaries(page)
    );
  });

  test('long desktop heads and panel responses preserve required scrolling and close access', async ({ context }) => {
    test.setTimeout(60_000 + 90_000 * migratedBuilders().length);
    await eachTierFixture(context, 'long-head and panel', (fixture, page) => fixture.longHeadAndPanel(page));
  });
});

// ---------------------------------------------------------------------------
// S30D D1 M26a (block 4; register owner-1k, DDM-P11-T04): the NIFC perimeter
// popup and the place-label popup through the frame. Imported here, beside
// the cases, so the block is an append.
// ---------------------------------------------------------------------------
import {
  FRAMED_LATE_DOOR,
  bootFireLabel,
  clickUntilFireLabelResponse,
  expectHeadVisibleBodyScrolls,
  readCard,
  settleCard
} from './frame-fixtures-fires-labels';

/**
 * D1.md 2.3 item 3 (r3-1:f3): at 2560x1440 the legacy NIFC popup was a
 * 240 x 998 card under MapLibre's 240 px cap, its agency line, sizes, fire
 * context and notes all in one column. Red on 4c2afb4: the card is 240 px
 * wide and is no frame.
 */
test.describe('D1 M26a: the NIFC popup at the widest desktop seat', () => {
  test.use({ viewport: { width: 2560, height: 1440 } });

  test('at 2560x1440 a NIFC popup keeps its head visible and scrolls only its body inside the tier', async ({ page }) => {
    await bootFireLabel(page, 'nifc', { variant: 'long' });
    await clickUntilFireLabelResponse(page, 'nifc');
    // The late door lands after the paint (DR-042 a) and grows the head:
    // read the card at its longest, held still across two frames.
    await expect(page.locator('.maplibregl-popup .maplibregl-popup-content [data-ddm-impact-trigger]')).toBeVisible({ timeout: 10_000 });
    await settleCard(page);
    const read = await readCard(page);
    expect(read, 'a NIFC response card').not.toBeNull();
    const size = `${Math.round(read!.card.width)} x ${Math.round(read!.card.height)}`;
    expect(read!.card.width, `the card keeps MapLibre's 240 px cap (${size})`).toBeGreaterThan(240);
    expect(read!.compact, `the FULL tier at 2560x1440 (${size})`).toBe(false);
    expectHeadVisibleBodyScrolls(read, `nifc at 2560x1440 (${size})`);
    await expect(page.locator(FRAMED_LATE_DOOR)).toHaveCount(1);
    // The whole card sits on screen: nothing scrolls but the body.
    expect(read!.card.top, `the card starts on screen (${size})`).toBeGreaterThanOrEqual(-1);
    expect(read!.card.bottom, `the card ends on screen (${size})`).toBeLessThanOrEqual(read!.viewport.h + 1);
  });
});

// ---------------------------------------------------------------------------
// S30D D1 M26b (block 5; register owner-1k, DDM-P11-T04): the NWS alert, SPC
// fire weather outlook, power plant and power line popups through the frame.
// Imported here, beside the cases, so the block is an append.
// ---------------------------------------------------------------------------
import {
  EVENT_STATION_TIER_FIXTURES,
  bootEventStation,
  clickUntilEventStationResponse,
  headSlotLines,
  type EventStationId
} from './frame-fixtures-events-stations';

const M26B_IDS: readonly EventStationId[] = ['nws', 'spc', 'power-plant', 'power-line'];

/**
 * ONE catch-all external-request backstop on the context, before the first
 * page boots (the PF3 rows' own isolation above): gotoApp's context stubs and
 * each fixture's page routes are checked first; anything else is answered 503.
 */
async function holdM26bNetwork(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

/**
 * The director's rule for M26's builders (DR-179's dated note on D1.md :142,
 * under DR-177): each head slot holds one line at the narrowest desktop
 * measure (the title two); anything longer moves to a named body slot. The
 * frame takes one 304px measure (--popup-measure) on every desktop seat, so
 * 1280x720 reads it. A head with no source link (the power line) has no
 * source slot; its stated source is in the body. Red on bd8c1aa: the legacy
 * cards are no frame, so there is no head slot to measure.
 */
test.describe('D1 M26b: the NWS, SPC and power heads hold one line per slot', () => {
  test('at 1280x720 each NWS, SPC and power head slot holds one line (the title two)', async ({ context }) => {
    test.setTimeout(60_000 + 60_000 * M26B_IDS.length);
    await holdM26bNetwork(context);
    for (const id of M26B_IDS) {
      const page = await context.newPage();
      try {
        await page.setViewportSize({ width: 1280, height: 720 });
        await bootEventStation(page, id);
        await clickUntilEventStationResponse(page, id);
        // The response is one framed card (so red on the legacy cards names the
        // missing frame, not the late door).
        await expect(page.locator('.maplibregl-popup [data-popup-frame]'), `${id}: the response is a framed card`).toHaveCount(1);
        // The late door lands after the paint and joins the head; the card is
        // read once it holds still.
        await expect(page.locator(FRAMED_LATE_DOOR), `${id}: the late door in the actions slot`).toBeVisible({ timeout: 10_000 });
        await settleCard(page);
        const lines = await headSlotLines(page);
        expect(lines, `${id}: the response is a framed card with a head`).not.toBeNull();
        expect(lines!['title'], `${id}: the title takes one or two lines`).toBeGreaterThanOrEqual(1);
        expect(lines!['title'], `${id}: the title takes one or two lines`).toBeLessThanOrEqual(2);
        for (const slot of ['issuer', 'value', 'clock'] as const) {
          expect(lines![slot], `${id}: the ${slot} slot holds one line`).toBe(1);
        }
        if (id === 'power-line') expect(lines!['source'], 'power-line: no head source (the stated source is in the body)').toBeUndefined();
        else expect(lines!['source'], `${id}: the source slot holds one line`).toBe(1);
      } finally {
        await page.close();
      }
    }
  });
});

/**
 * The PF3 tier rows above run every registered fixture; these two run only
 * the four M26b fixtures, so their verdict reads on its own (the M26a census
 * pattern). The tallest of the four cards (the power line: four detail rows,
 * its caveat and its stated source) is read at 1280x720 inside the long-head
 * row. Red on bd8c1aa: the legacy cards are no frame (no source-fallback
 * slot at the tier boundaries; "the card is a frame" at the desktop seats).
 */
test.describe('D1 M26b: the NWS, SPC and power fixtures keep the PF3 tier promises on their own', () => {
  async function eachM26bFixture(context: BrowserContext, run: (fixture: TierFixture, page: Page) => Promise<void>): Promise<void> {
    await holdM26bNetwork(context);
    for (const id of M26B_IDS) {
      expect(LEGACY_ALLOWANCE, `${id} has left LEGACY_ALLOWANCE`).not.toContain(id);
      const fixture = EVENT_STATION_TIER_FIXTURES[id];
      expect(fixture, `${id}: a tier fixture`).toBeDefined();
      expect(TIER_FIXTURES[id], `${id} is registered in tests/frame-fixtures.ts`).toBe(fixture);
      const page = await context.newPage();
      try {
        await run(fixture!, page);
      } finally {
        await page.close();
      }
    }
  }

  test('the NWS, SPC and power sources and caveats remain clickable at FULL and usable-COMPACT boundaries', async ({ context }) => {
    test.setTimeout(60_000 + 60_000 * M26B_IDS.length);
    await eachM26bFixture(context, (fixture, page) => fixture.sourcesAtTierBoundaries(page));
  });

  test('the NWS, SPC and power long desktop heads and panel responses keep their scrolling and close access', async ({ context }) => {
    test.setTimeout(60_000 + 90_000 * M26B_IDS.length);
    await eachM26bFixture(context, (fixture, page) => fixture.longHeadAndPanel(page));
  });
});

/**
 * found-139 (block 4 M26a, carried to M26c, the coordinator's unit): a place
 * label names a populated place, which is no briefing subject, and the
 * coordinator's late door (DR-042 option a) opens the briefing for the place
 * the tap resolves instead (the containing Tribal land or state), so a
 * Washington town's label offered "Open the Impact Briefing for Washington",
 * a door to a place the label does not name. The late door is skipped for a
 * label response. The case first lets the condition response at the same
 * point earn its late door (so the resolution path is warm and quick), then
 * switches to the label through "Other map features here", where an unfixed
 * coordinator appends the containing state's door within a few tasks.
 *
 * Red on 44fda65: the label popup's door reads "Open the Impact Briefing for
 * Washington".
 */
const LABEL_DOOR_PLACE = 'Fixture Label Town With A Name Long Enough To Wrap Over Several Lines';

test.describe('found-139: a place label popup offers no door to another place', () => {
  test("a place label popup's door names the place it opens", async ({ page }) => {
    test.setTimeout(90_000);
    await stubBroadCondition(page);
    await page.route('**/data/us-places.json', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ meta: { count: 1 }, places: [{ name: LABEL_DOOR_PLACE, lon: -120.84, lat: 47.29, rank: 0 }] })
      })
    );
    await gotoApp(page, '?region=washington_state&view=console&layers=places,nadm-drought');
    await waitForLayerSettled(page, 'places');
    await waitForLayerSettled(page, 'nadm-drought');

    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    const cx = mapBox!.x + mapBox!.width / 2;
    const cy = mapBox!.y + mapBox!.height / 2;
    const probes: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [0, -24], [0, 24], [-40, 0], [40, 0], [-40, -24], [40, 24], [-40, 24], [40, -24]
    ];
    const popup = page.locator('.maplibregl-popup-content');
    const label = popup.locator('[data-ddm-response="us-places-labels"]');
    const condition = popup.locator('[data-ddm-response="nadm-drought-fill"]');
    // The label (a point event) outranks the condition surface beneath it.
    let probe = 0;
    await expect(async () => {
      const [dx, dy] = probes[probe++ % probes.length]!;
      await page.mouse.click(cx + dx, cy + dy);
      await expect(label).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(label.locator('[data-popup-slot="title"]')).toHaveText(LABEL_DOOR_PLACE);

    // The condition at the same point earns its late door, naming the state.
    await popup.locator('.popup-other-features > summary').click();
    await popup.locator('.popup-other-item').first().click();
    await expect(condition).toBeVisible();
    await expect(condition.locator('[data-ddm-impact-trigger]')).toContainText('Washington', { timeout: 10_000 });

    // Back to the label, re-committed in place.
    await popup.locator('.popup-other-features > summary').click();
    await popup.locator('.popup-other-item', { hasText: LABEL_DOOR_PLACE }).click();
    await expect(label).toBeVisible();
    // Everything the door's resolution waits on is already loaded: let the
    // page settle, then two frames and a task, before reading the doors.
    await awaitQuiescence(page);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
    const doors = (await label.locator('[data-ddm-impact-trigger]').allTextContents()).map((t) => t.trim());
    expect(doors.filter((door) => !door.includes(LABEL_DOOR_PLACE)), 'a label popup door naming another place').toEqual([]);
    // The fix chosen: a label response is offered no late door at all.
    expect(doors).toEqual([]);
  });
});
