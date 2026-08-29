import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import {
  MIN_COMPACT_BODY_REGION_HEIGHT_PX,
  MIN_USABLE_REGION_HEIGHT_PX,
  MIN_USABLE_REGION_WIDTH_PX
} from '../src/ui/popup-viewport';
import { SHEET_DETENT_SIZE } from '../src/ui/mobile-sheet';

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
 * visual viewport intersected with the map container, minus the active
 * mobile sheet and footer rects) under THE CANONICAL TIER TABLE beside
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
 * favorable sheetless geometries, an open half sheet plus footer, a
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
 * fixed mobile footer or sheet (the finding-2 gap); this cannot.
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
 * The top edge (viewport y) of the app's bottom-docked occluding chrome:
 * the persistent mobile footer, and the mobile sheet exactly while the
 * shell attribute is active. Infinity when neither is laid out (desktop,
 * embed), so callers can Math.min it against the viewport bottom.
 */
async function bottomChromeTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    let top = Infinity;
    const footer = document.getElementById('mobile-footer-nav');
    const sheetActive = document.getElementById('app')?.hasAttribute('data-sheet-detent');
    const els = [footer, sheetActive ? document.getElementById('sidebar') : null];
    for (const el of els) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) top = Math.min(top, r.top);
    }
    return top;
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
    await gotoApp(page, '?view=console&layers=bia-reservations');
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
    const links = popup.locator('.popup-links a');
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

test.describe('DEF-3 finding 1: half sheet plus footer occlusion (390x844, touch)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the card stays inside the unobscured map strip above the sheet and touch scrolls the body', async ({
    page
  }) => {
    await gotoApp(page, '?layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    // Bare mobile boot: the shell is active at the map-first closed
    // detent. Raise the LAYERS door (console mode, where a boundary
    // click yields the coordinated popup; on the Brief door a map click
    // routes the briefing into the sheet instead) so the sheet sits at
    // half OVER the lower map: exactly the occlusion the pre-fix bounds
    // model ignored.
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    const sidebar = page.locator('#sidebar');
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const detentSetAt = Date.now();
    // The detent attribute changes synchronously, while the sheet height
    // transitions for 250 ms, and mobile-sheet.ts's settle() (map.resize()
    // then a 220 ms easeTo) does not even fire until its own ~320 ms
    // fallback timer runs after that. Wait for the sheet to reach its
    // half-detent height, then hold still across two reads 250 ms apart,
    // then wait out the trailing settle window: on a loaded CI runner
    // (FE-23) the camera can still be easing under an already-still sheet
    // edge, and cx/cy measured too early land on the pre-settle strip.
    await expect
      .poll(async () => sidebar.evaluate((el) => el.getBoundingClientRect().height), {
        message: 'the sheet never reached its half-detent height',
        timeout: 3_000
      })
      .toBeCloseTo(viewportHeight * SHEET_DETENT_SIZE.halfFraction, 0);
    let lastSheetRect: { top: number; height: number } | null = null;
    await expect
      .poll(
        async () => {
          const rect = await sidebar.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, height: r.height };
          });
          const stable =
            lastSheetRect !== null &&
            Math.abs(rect.top - lastSheetRect.top) < 0.5 &&
            Math.abs(rect.height - lastSheetRect.height) < 0.5;
          lastSheetRect = rect;
          return stable;
        },
        {
          message: 'the sheet rect never held still across two reads 250 ms apart',
          timeout: 5_000,
          intervals: [250]
        }
      )
      .toBe(true);
    const settleBudgetMs = 900;
    const sinceDetent = Date.now() - detentSetAt;
    if (sinceDetent < settleBudgetMs) {
      await page.waitForTimeout(settleBudgetMs - sinceDetent);
    }

    // Open the coordinated popup at the center of the UNOBSCURED strip.
    // Re-measured on every attempt below, never frozen: a stale cx/cy
    // taken once before the sheet and map finished settling is the
    // FE-23 livelock's root cause (a click that misses the fixture
    // polygon hits empty ground, and the coordinator's next click always
    // replaces or closes the current response, so a miss compounds).
    let sheetTop = await sidebar.evaluate((el) => el.getBoundingClientRect().top);
    async function targetPoint(): Promise<{ cx: number; cy: number }> {
      sheetTop = await sidebar.evaluate((el) => el.getBoundingClientRect().top);
      const liveMapBox = await page.locator('#map').boundingBox();
      expect(liveMapBox, 'the map lost its bounding box').not.toBeNull();
      return {
        cx: liveMapBox!.x + liveMapBox!.width / 2,
        cy:
          (Math.max(liveMapBox!.y, 0) + Math.min(sheetTop, liveMapBox!.y + liveMapBox!.height)) /
          2
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

    // THE FINDING-1 CONTRACT: the card ends above the sheet (with the
    // clamp's 12px margin), not merely above the layout-viewport fold.
    // Pre-fix the 70vh card anchored mid-strip ran on behind the sheet
    // and footer.
    await expect
      .poll(
        async () => {
          const cbox = await content.boundingBox();
          return cbox ? cbox.y + cbox.height : Number.POSITIVE_INFINITY;
        },
        { message: 'the card never came back inside the strip above the sheet', timeout: 10_000 }
      )
      .toBeLessThanOrEqual(sheetTop - 12 + 1);

    // The body really scrolls, and the caveat tail's links plus the close
    // control are hit-testable (not behind the sheet or footer).
    const body = popup.locator('.coordinated-response-body');
    const scrollable = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(scrollable, 'the clamped body does not overflow (nothing to scroll)').toBeGreaterThan(0);
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const links = popup.locator('.popup-links a');
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await link.evaluate((element) =>
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      );
      await expectHitTestReachable(link, 'popup source link above the sheet');
    }
    await expectHitTestReachable(
      popup.locator('.maplibregl-popup-close-button'),
      'popup close control above the sheet'
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
    await gotoApp(page, '?embed=true&view=console&layers=bia-reservations');
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
    for (const link of await popup.locator('.popup-links a').all()) {
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
    for (const link of await popup.locator('.popup-links a').all()) {
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
    await gotoApp(page, '?embed=true&view=console&layers=bia-reservations');
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
    for (const link of await popup.locator('.popup-links a').all()) {
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
    // Dismissal receipt: scan the intersection of the close control's box
    // and the region strip for a point where the close control is the
    // topmost element (unmodeled chrome, which the module explicitly does
    // not dodge, may cover part of the strip), then really click it.
    const rr = await embedRegion(page);
    const closeBox = await popup.locator('.maplibregl-popup-close-button').boundingBox();
    expect(closeBox).not.toBeNull();
    const probeY = Math.min(rr.top + Math.max(1, rr.h / 2), closeBox!.y + closeBox!.height - 1);
    const candidates: { x: number; y: number }[] = [];
    for (let x = closeBox!.x + 3; x <= closeBox!.x + closeBox!.width - 3; x += 4) {
      candidates.push({ x, y: probeY });
    }
    const probe = await page.evaluate((pts) => {
      for (const pt of pts) {
        const el = document.elementFromPoint(pt.x, pt.y);
        if (el && el.closest('.maplibregl-popup-close-button')) return pt;
      }
      return null;
    }, candidates);
    expect(probe, 'no reachable pixel found on the close control in the region strip').not.toBeNull();
    await page.mouse.click(probe!.x, probe!.y);
    await expect(popup).toHaveCount(0);
  });
});

test.describe('r2 finding 2: a visual viewport diverging from the layout viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the clamp follows an offset visual-viewport band, not the layout viewport', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&view=console&layers=bia-reservations');
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

    await gotoApp(page, '?layers=telemetry');
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
    // fallback, which arrived AFTER the clamp bounds changed.
    await expect(async () => {
      if ((await popup.count()) === 0) {
        await marker.click();
      }
      await expect(popup.locator('.popup-data-error')).toBeVisible({ timeout: 4000 });
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

    await gotoApp(page, '?layers=telemetry');
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
