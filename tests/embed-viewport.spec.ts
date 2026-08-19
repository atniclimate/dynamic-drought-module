import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const HEAT_SERVICE_PATH = '/experimental/rest/services/NWS_HeatRisk/ImageServer';
const HEAT_TIMES = [
  1785153600000, 1785240000000, 1785326400000, 1785412800000,
  1785499200000, 1785585600000, 1785672000000
] as const;

/** Deterministic HeatRisk ImageServer stub (the m-breadth-heatrisk-days
 * idiom, trimmed to what the key needs: metadata, granule query, frames). */
async function stubHeatRiskService(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith(HEAT_SERVICE_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            objectIdFieldName: 'objectid',
            fields: [
              { name: 'idp_validtime', type: 'esriFieldTypeDate', alias: 'Valid Date' }
            ],
            features: HEAT_TIMES.map((validTime, index) => ({
              attributes: {
                name: `HeatRisk_${index + 1}_Mercator`,
                idp_validtime: validTime
              }
            }))
          })
        });
        return;
      }
      if (url.pathname.endsWith('/exportImage')) {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: TRANSPARENT_PNG
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeInfo: {
            startTimeField: 'idp_validtime',
            endTimeField: null,
            timeExtent: [HEAT_TIMES[0], HEAT_TIMES.at(-1)],
            timeReference: null
          }
        })
      });
    }
  );
}

/**
 * The small-viewport embed contract (H1, 0.6.2; a project hard rule: the
 * 400px iframe embed is first-class).
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
    await stubRecentSatellite(page);
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

  test('an oversized Heat key collapses to its scale essentials behind the chevron (W2-D4)', async ({
    page
  }) => {
    await stubHeatRiskService(page);
    // The audited geometry: the Heat quick view's full composition
    // (HeatRisk plus the NWS products key) at the embed floor.
    await page.route('**/WWA/watch_warn_adv/MapServer/1/query**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                prod_type: 'Heat Advisory',
                onset: '2026-08-18T08:00:00-07:00',
                ends: '2026-08-19T20:00:00-07:00',
                expiration: Date.now() + 86_400_000,
                wfo: 'KPDT'
              },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]
                ]
              }
            }
          ]
        })
      })
    );
    await gotoApp(page, '?embed=true&view=console&layers=heatrisk,nws-alerts');

    const key = page.locator('#map-key');
    const content = page.locator('#map-key-content');
    const expander = page.locator('#map-key-expand');
    await expect(key).toBeVisible();
    await expect(key.locator('[data-heatrisk-scale]')).toBeVisible();
    await expect(key.locator('[data-nws-products-key]')).toBeVisible();

    // The measured overflow collapses the key to the shared collapsed
    // capacity (190px at this short viewport) instead of letting it
    // consume half the iframe, and the chevron discloses the rest.
    await expect(expander).toBeVisible();
    await expect(expander).toHaveAttribute('aria-expanded', 'false');
    const collapsed = await content.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(collapsed).toBeLessThanOrEqual(195);
    const collapsedKey = await key.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    });
    expect(collapsedKey.bottom - collapsedKey.top).toBeLessThanOrEqual(600 * 0.45);

    // The collapsed key no longer runs underneath the SAT control.
    const sat = await page
      .locator('.basemap-switcher-control')
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      });
    const intersects =
      collapsedKey.left < sat.right &&
      sat.left < collapsedKey.right &&
      collapsedKey.top < sat.bottom &&
      sat.top < collapsedKey.bottom;
    expect(intersects, 'the collapsed key overlaps the SAT control').toBe(false);

    // Bounded expansion: the expanded content grows but stays inside the
    // viewport, and the chevron reports its state.
    await expander.click();
    await expect(expander).toHaveAttribute('aria-expanded', 'true');
    await expect(key).toHaveAttribute('data-key-expanded', 'true');
    await expect
      .poll(() =>
        content.evaluate((element) => element.getBoundingClientRect().height)
      )
      .toBeGreaterThan(collapsed);
    const expandedKey = await key.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    });
    expect(expandedKey.top).toBeGreaterThanOrEqual(0);
    expect(expandedKey.bottom).toBeLessThanOrEqual(600);

    await expander.click();
    await expect(expander).toHaveAttribute('aria-expanded', 'false');
  });

  test('an NWS alert popup fits the 200px embed with its agency and vintage legible', async ({
    page
  }) => {
    // The audit's one unverified gap: the alert popup at the embed width
    // floor. Deterministic fixture (the tests/popup-viewport.spec.ts DEF-3
    // idioms): one continental Heat Advisory polygon so a center click
    // always lands on the feature.
    const alertFixture = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            prod_type: 'Heat Advisory',
            onset: '2026-08-18T08:00:00-07:00',
            ends: '2026-08-19T20:00:00-07:00',
            expiration: Date.now() + 86_400_000,
            wfo: 'KPDT'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-170, 5],
                [-50, 5],
                [-50, 75],
                [-170, 75],
                [-170, 5]
              ]
            ]
          }
        }
      ]
    };
    await page.route('**/WWA/watch_warn_adv/MapServer/1/query**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(alertFixture)
      })
    );

    await gotoApp(page, '?embed=true&view=console&layers=nws-alerts');

    const popup = page.locator('.maplibregl-popup');
    const content = popup.locator('.maplibregl-popup-content');
    const mapBox = await page.locator('#map').boundingBox();
    expect(mapBox).not.toBeNull();
    // Click the map center until the fixture fill has painted and the
    // popup is up (the established DEF-3 retry pattern).
    await expect(async () => {
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await expect(content).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // Containment: the alert CARD sits inside the 200x600 viewport. The
    // clamp sizes and slides the content box (the tip legitimately stays
    // at the anchor), so the DEF-3 floor idiom asserts the content rect,
    // polled because the clamp re-runs after open.
    await expect
      .poll(
        async () => {
          const box = await content.boundingBox();
          if (!box) return 'no box';
          return box.x >= -1 &&
            box.y >= -1 &&
            box.x + box.width <= 201 &&
            box.y + box.height <= 601
            ? 'ok'
            : JSON.stringify(box);
        },
        { message: 'the alert card is not contained in the 200x600 viewport', timeout: 10_000 }
      )
      .toBe('ok');

    // The agency line and the product vintage (From / Until) are rendered,
    // inside the viewport, and legible (a real text size, not clipped).
    await expect(content.locator('.popup-title')).toHaveText('Heat Advisory');
    const agency = content.locator('.popup-agency');
    await expect(agency).toBeVisible();
    await expect(agency).toHaveText('NOAA NWS · Active Alert');
    const vintageRows = content.locator('.popup-treaty-meta');
    await expect(vintageRows.nth(0)).toContainText('From:');
    await expect(vintageRows.nth(1)).toContainText('Until:');
    for (const row of [agency, vintageRows.nth(0), vintageRows.nth(1)]) {
      const rowBox = await row.boundingBox();
      expect(rowBox).not.toBeNull();
      expect(rowBox!.x).toBeGreaterThanOrEqual(-1);
      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(201);
      const fontSize = await row.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize)
      );
      expect(fontSize).toBeGreaterThanOrEqual(9);
      const clipped = await row.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1
      );
      expect(clipped, 'a vintage row is horizontally clipped').toBe(false);
    }

    // The close control is genuinely reachable at this floor (hit-tested,
    // not merely boxed) and dismisses the popup.
    const close = popup.locator('.maplibregl-popup-close-button');
    await expect
      .poll(async () => {
        const closeBox = await close.boundingBox();
        if (!closeBox) return 'no box';
        return close.evaluate(
          (el, pt) => {
            const found = document.elementFromPoint(pt.x, pt.y);
            return found && (found === el || el.contains(found) || found.contains(el))
              ? 'ok'
              : 'occluded';
          },
          {
            x: closeBox.x + closeBox.width / 2,
            y: closeBox.y + closeBox.height / 2
          }
        );
      })
      .toBe('ok');
    await close.click();
    await expect(popup).toHaveCount(0);
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
