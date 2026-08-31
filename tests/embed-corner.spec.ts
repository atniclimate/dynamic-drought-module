import { expect, test, type Locator, type Page } from '@playwright/test';

import { gotoApp } from './helpers';
import { stubWildfireFeeds } from './wildfire-fixtures';

/**
 * FE-18 (2026-08-28): the embed corner.
 *
 * Embeds keep the seats that predate the 2026-08-19 desktop chrome moves:
 * the preview badge in the top-right overlay stack, the satellite control
 * above MapLibre's compact attribution in the bottom-right, the key and the
 * brand pill in the shared bottom dock, and no app map-information button.
 * Measured on the live build 2026-08-28, the desktop corner rules leaked
 * into wide embeds (fixed badge, absolute information button, shifted
 * attribution) and the dock's brand pill sat on the satellite control at
 * every width, including the 200px floor. This spec holds the corner by
 * hit-testing the two controls a person must be able to reach (satellite
 * and attribution) and by pairwise non-overlap of everything that shares
 * the bottom edge, at the widths the roadmap names.
 */

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

async function rect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

/** The element under a locator's center, identified by a stable ancestor selector. */
async function hitAt(page: Page, locator: Locator, ancestor: string): Promise<boolean> {
  const box = await locator.boundingBox();
  if (!box) return false;
  return page.evaluate(
    ([x, y, selector]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return !!el && !!el.closest(selector as string);
    },
    [box.x + box.width / 2, box.y + box.height / 2, ancestor]
  );
}

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [1280, 800],
  [800, 600],
  [400, 600],
  [390, 844],
  [200, 600]
];

for (const [width, height] of SIZES) {
  test(`the ${width}x${height} embed keeps its corner reachable and unstacked`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height });
    await stubWildfireFeeds(page);
    await gotoApp(page, '?embed=true&cluster=wildfire');

    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);

    // The embed seats the credits disclosure (owner direction 2026-08-31:
    // the question-mark panel carries the license credits in every shell),
    // and the preview badge rides the top-right overlay stack.
    await expect(page.locator('.map-info-btn')).toBeVisible();
    const badge = page.locator('.test-preview-badge');
    await expect(badge).toBeVisible();
    const overlay = await rect(page.locator('.map-overlay-controls'));
    const badgeBox = await rect(badge);
    expect(badgeBox.top, 'the preview badge left the top-right stack').toBeLessThan(overlay.bottom);
    expect(badgeBox.bottom).toBeLessThan(height / 2);

    // The two controls a person must reach, hit-tested at their centers.
    const satellite = page.locator('.maplibregl-ctrl-bottom-right .basemap-switcher-btn');
    const credits = page.locator('#map-info-btn');
    await expect(satellite).toBeVisible();
    await expect(credits).toBeVisible();
    expect(await hitAt(page, satellite, '.basemap-switcher-control'), 'the satellite control is covered').toBe(true);
    expect(await hitAt(page, credits, '.map-info-btn'), 'the credits button is covered').toBe(true);

    // Everything that shares the bottom edge stays apart.
    const named: Array<[string, Rect]> = [];
    for (const [name, selector] of [
      ['satellite', '.maplibregl-ctrl-bottom-right .basemap-switcher-control'],
      ['credits', '.map-info-btn'],
      ['brand', '.embed-brand'],
      ['key', '#map-key'],
      ['scale', '.maplibregl-ctrl-scale']
    ] as const) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0 || !(await locator.isVisible())) continue;
      named.push([name, await rect(locator)]);
    }
    for (let i = 0; i < named.length; i += 1) {
      for (let j = i + 1; j < named.length; j += 1) {
        const [a, ra] = named[i]!;
        const [b, rb] = named[j]!;
        expect(intersects(ra, rb), `${a} overlaps ${b}`).toBe(false);
      }
    }
    for (const [name, box] of named) {
      expect(box.left, `${name} crosses the left edge`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${name} crosses the right edge`).toBeLessThanOrEqual(width + 0.5);
      expect(box.bottom, `${name} crosses the bottom edge`).toBeLessThanOrEqual(height + 0.5);
    }

    // The credits disclosure still opens and still names the base map.
    await credits.click();
    await expect(page.locator('#map-info-attribution')).toContainText('OpenStreetMap');
  });

  test(`the ${width}x${height} embed loading pulse leaves Share and Reset alone`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height });
    await stubWildfireFeeds(page);
    // Hold the perimeters response open so the pulse is genuinely visible.
    await page.route(
      (url) => url.href.includes('WFIGS_Interagency_Perimeters_Current'),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await route.fallback();
      }
    );
    await gotoApp(page, '?embed=true&cluster=wildfire');

    const loading = page.locator('.loading-indicator');
    await expect(loading).toBeVisible();
    const loadingBox = await rect(loading);
    for (const selector of ['#share-btn', '#reset-btn']) {
      const control = page.locator(selector);
      if (!(await control.isVisible())) continue;
      const box = await rect(control);
      expect(intersects(loadingBox, box), `the loading pulse covers ${selector}`).toBe(false);
    }
    expect(loadingBox.left).toBeGreaterThanOrEqual(0);
    expect(loadingBox.right).toBeLessThanOrEqual(width + 0.5);
  });
}
