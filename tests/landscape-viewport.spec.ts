import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * U-UX-FIX-1 DEF-1 (usability triage 2026-07-24): the short-landscape
 * viewport (a phone rotated, 844x390) sits above the 720px mobile
 * breakpoint, so the desktop sidebar-beside-map grid applies. The grid
 * must cap itself to the viewport: no page-level scroll, the sidebar
 * header on screen, the sidebar's stacked panels scrolling INTERNALLY,
 * and the map filling its column. Pre-fix, the sidebar's intrinsic
 * stacked-panel height (610 to 762px per the triage) forced document
 * scrollHeight past innerHeight and scrolling settled on a void.
 */

test.describe('DEF-1 short landscape viewport (844x390)', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('the layout caps to the viewport: no page scroll, header and map reachable', async ({
    page
  }) => {
    await gotoApp(page);

    // Diagnostic snapshot (kept cheap; printed for the fail-then-pass
    // receipt so the scroll container is named, not guessed).
    const geo = await page.evaluate(() => {
      const se = document.scrollingElement!;
      const app = document.getElementById('app');
      const sidebar = document.getElementById('sidebar');
      return {
        innerHeight: window.innerHeight,
        docScrollHeight: se.scrollHeight,
        appHeight: app?.getBoundingClientRect().height ?? -1,
        appScrollHeight: app?.scrollHeight ?? -1,
        sidebarHeight: sidebar?.getBoundingClientRect().height ?? -1,
        sidebarScrollHeight: sidebar?.scrollHeight ?? -1
      };
    });
    console.log('[DEF-1 geometry]', JSON.stringify(geo));

    // The core DEF-1 assertion: the document does not scroll. The whole
    // page is exactly one viewport tall.
    expect(geo.docScrollHeight).toBe(geo.innerHeight);

    // A scroll attempt goes nowhere at the page level (the void repro:
    // pre-fix, scrolling settled on a nearly blank screen).
    await page.evaluate(() => window.scrollTo(0, 99999));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Nor does any ancestor between the shell and the document scroll the
    // chrome away: the app shell itself stays viewport-sized.
    expect(Math.round(geo.appHeight)).toBeLessThanOrEqual(geo.innerHeight);
    expect(geo.appScrollHeight).toBeLessThanOrEqual(geo.innerHeight + 1);

    // The sidebar header (brand plus collapse control) stays on screen...
    const header = page.locator('.sidebar-header');
    await expect(header).toBeVisible();
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.y).toBeGreaterThanOrEqual(0);
    expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(390);

    // ...the map fills its column inside the viewport...
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    expect(mapBox!.y + mapBox!.height).toBeLessThanOrEqual(390 + 1);
    expect(mapBox!.height).toBeGreaterThanOrEqual(300);

    // ...and the sidebar's stacked panels scroll INTERNALLY (the content
    // genuinely exceeds 390px; the scroll region owns it, not the page).
    const scrollRegion = page.locator('.sidebar-scroll');
    const scrolls = await scrollRegion.evaluate(
      (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible'
    );
    expect(scrolls).toBe(true);
  });

  test('rotation from portrait keeps the capped layout (the triage repro path)', async ({
    page
  }) => {
    // Load portrait (the mobile sheet shell), then rotate to landscape:
    // the breakpoint crossing must land on a viewport-capped layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');

    await page.setViewportSize({ width: 844, height: 390 });
    // The sheet deactivates above 720px; the desktop grid takes over.
    await expect(page.locator('#app')).not.toHaveAttribute('data-sheet-detent', /.+/);

    const geo = await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      docScrollHeight: document.scrollingElement!.scrollHeight
    }));
    expect(geo.docScrollHeight).toBe(geo.innerHeight);
    await page.evaluate(() => window.scrollTo(0, 99999));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // The header and the map remain reachable without any page scroll.
    await expect(page.locator('.sidebar-header')).toBeVisible();
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    expect(mapBox!.y).toBeLessThan(390);
    expect(mapBox!.height).toBeGreaterThanOrEqual(300);
  });
});
