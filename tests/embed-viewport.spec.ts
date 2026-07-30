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

test.describe('Embed at 200x600 (minimum-width iframe floor)', () => {
  test.use({ viewport: { width: 200, height: 600 } });

  test('opens inside an iframe with contained map chrome and no mobile navigation', async ({
    page
  }) => {
    await page.route('**/embed-width-floor-host.html', async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: [
          '<!doctype html>',
          '<html><head><meta charset="utf-8">',
          '<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}',
          'iframe{display:block;width:200px;height:600px;border:0}</style>',
          '</head><body>',
          '<iframe title="Dynamic Drought Module embed" src="/?embed=true"></iframe>',
          '</body></html>'
        ].join('')
      });
    });
    await page.goto('/embed-width-floor-host.html', { waitUntil: 'domcontentloaded' });

    const embedded = page.frameLocator('iframe');
    const app = embedded.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(embedded.locator('#map canvas')).toBeVisible();

    // The app stays in the child browsing context. An embed boot must not
    // redirect or replace the partner page that owns the iframe.
    expect(new URL(page.url()).pathname).toBe('/embed-width-floor-host.html');
    const childFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
    expect(childFrame).toBeDefined();
    expect(new URL(childFrame!.url()).searchParams.get('embed')).toBe('true');

    // Embed mode remains sheetless even though 200px is below the mobile
    // breakpoint. None of the mobile navigation surfaces may leak in.
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(embedded.locator('#mobile-footer-nav')).toBeHidden();
    await expect(embedded.locator('#hazard-rail')).toBeHidden();
    await expect(embedded.locator('.sheet-grabber-row')).toBeHidden();

    const geometry = await embedded.locator('html').evaluate(() => {
      const required = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`${selector} is missing`);
        return element;
      };
      const dimensions = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      };
      return {
        viewport: {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth
        },
        app: dimensions(required('#app')),
        mapContainer: dimensions(required('#map-container')),
        map: dimensions(required('#map'))
      };
    });

    expect(geometry.viewport).toEqual({
      width: 200,
      height: 600,
      scrollWidth: 200,
      bodyScrollWidth: 200
    });
    for (const [name, box] of Object.entries({
      app: geometry.app,
      mapContainer: geometry.mapContainer,
      map: geometry.map
    })) {
      expect(box.left, `${name} crosses the iframe's left edge`).toBeGreaterThanOrEqual(0);
      expect(box.top, `${name} crosses the iframe's top edge`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${name} crosses the iframe's right edge`).toBeLessThanOrEqual(200);
      expect(box.bottom, `${name} crosses the iframe's bottom edge`).toBeLessThanOrEqual(600);
      expect(box.width, `${name} does not fill the iframe width`).toBeGreaterThanOrEqual(199);
      expect(box.height, `${name} does not fill the iframe height`).toBeGreaterThanOrEqual(599);
    }

    // The compact attribution is a critical disclosure at this width. Its
    // toggle must pass real hit-testing, and its source links must remain in
    // the disclosure DOM. MapLibre auto-minimizes the expanded state whenever
    // the map moves, so the transient expansion class is not a stable signal.
    const attribution = embedded.locator('.maplibregl-ctrl-attrib');
    const attributionToggle = embedded.locator('.maplibregl-ctrl-attrib-button');
    await expect(attribution).toHaveClass(/maplibregl-compact/);
    await expect(attributionToggle).toBeVisible();
    await attributionToggle.click({ trial: true });
    expect(await attribution.locator('a').count()).toBeGreaterThan(0);

    for (const selector of [
      '#sidebar-expand',
      '.map-overlay-controls',
      '.embed-brand',
      '.maplibregl-ctrl-attrib'
    ]) {
      const containment = await embedded.locator(selector).evaluate((element) => {
        const control = element.getBoundingClientRect();
        const map = document.querySelector<HTMLElement>('#map')!.getBoundingClientRect();
        return {
          left: control.left - map.left,
          top: control.top - map.top,
          right: map.right - control.right,
          bottom: map.bottom - control.bottom
        };
      });
      for (const [edge, clearance] of Object.entries(containment)) {
        expect(clearance, `${selector} is clipped past the map's ${edge} edge`).toBeGreaterThanOrEqual(
          0
        );
      }
    }
  });

  test('keeps a selected-place briefing understandable and contained', async ({ page }) => {
    await gotoApp(page, '?embed=true&view=brief&layers=&select=state:WA');

    const panel = page.locator('#impact-panel');
    const body = panel.locator('.impact-panel-body');
    const close = panel.locator('.impact-panel-close');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(body).toBeVisible();
    await expect(close).toBeVisible();

    const geometry = await panel.evaluate((element) => {
      const report = element.querySelector<HTMLElement>('.impact-panel-body');
      const closeControl = element.querySelector<HTMLElement>('.impact-panel-close');
      if (!report || !closeControl) throw new Error('briefing geometry targets are missing');
      const dimensions = (target: Element) => {
        const rect = target.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      };
      return {
        viewport: {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth
        },
        panel: dimensions(element),
        report: {
          ...dimensions(report),
          clientWidth: report.clientWidth,
          scrollWidth: report.scrollWidth
        },
        close: dimensions(closeControl)
      };
    });

    expect(geometry.viewport).toEqual({
      clientWidth: 200,
      scrollWidth: 200,
      bodyScrollWidth: 200
    });
    expect(geometry.report.scrollWidth).toBeLessThanOrEqual(geometry.report.clientWidth);
    for (const [name, box] of Object.entries({
      panel: geometry.panel,
      report: geometry.report,
      close: geometry.close
    })) {
      expect(box.left, `${name} crosses the embed's left edge`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${name} crosses the embed's right edge`).toBeLessThanOrEqual(200);
    }

    expect(new URL(page.url()).searchParams.get('embed')).toBe('true');
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
