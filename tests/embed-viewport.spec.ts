import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * The small-viewport embed contract (H1, 0.6.2; CLAUDE.md section 4 rule 8).
 *
 * A 400px iframe is the FIRST-CLASS embed case, and it sits under the 720px
 * responsive breakpoint, where the app shell switches from side-by-side
 * columns to stacked rows. Embed mode must collapse the sidebar ROW there
 * exactly as `.sidebar-collapsed` does; the v0.6.1 regression left the map
 * in the auto-sized first row, showing a strip of map above dead space in
 * every narrow partner iframe.
 *
 * The H2 companion assertions pin the shared bottom dock. Since E2
 * (D-0.7.0-058 ruling 1) the time bar lives in the sidebar beside the
 * legend; the dock carries the notices, the corner chips, and the minimal
 * embed valid-date stamp, still inside one stacking container so nothing
 * can cover anything else.
 */

test.describe('Embed at 400x600 (below the responsive breakpoint)', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('the map fills the viewport instead of a strip over dead space', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);

    // The map container gets effectively the whole iframe: full width, and
    // all the height except (at most) rounding slack. The v0.6.1 bug left
    // it around 170px tall on this exact viewport.
    const map = await page.locator('#map').boundingBox();
    expect(map).not.toBeNull();
    expect(map!.width).toBeGreaterThanOrEqual(398);
    expect(map!.height).toBeGreaterThanOrEqual(560);

    // The WebGL canvas paints that container, not a sliver.
    const canvas = await page.locator('#map canvas').boundingBox();
    expect(canvas).not.toBeNull();
    expect(canvas!.height).toBeGreaterThanOrEqual(540);
  });

  test('the sidebar row is collapsed, not merely narrowed', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    const sidebar = await page.locator('#sidebar').boundingBox();
    // A collapsed grid row clips the sidebar to zero height (boundingBox
    // returns null for a fully clipped element in some engines; accept both).
    if (sidebar !== null) {
      expect(sidebar.height).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('The shared bottom overlay dock (H2; rehost E2, D-0.7.0-058)', () => {
  test('the dock holds the notices, the map key, and the embed date stamp; the time bar lives in the sidebar', async ({ page }) => {
    await gotoApp(page);

    // E2 (D-0.7.0-058 ruling 1): the time bar rehosted into the sidebar
    // scroll beside the legend; the floating map-bottom bar is retired.
    // The structural pin moves with it.
    const timeBarParent = await page
      .locator('#time-bar')
      .evaluate((el) => el.parentElement?.className ?? '');
    expect(timeBarParent).toContain('sidebar-scroll');

    // What remains in the dock: the notices, the corner chips, and the
    // minimal embed valid-date stamp (hidden outside embed mode).
    await expect(page.locator('#map-bottom-dock #map-notices')).toHaveCount(1);
    await expect(page.locator('#map-bottom-dock #embed-date-stamp')).toHaveCount(1);
    await expect(page.locator('#map-bottom-dock .map-dock-foot #map-key')).toHaveCount(1);
    await expect(page.locator('#embed-date-stamp')).toBeHidden();
  });
});
