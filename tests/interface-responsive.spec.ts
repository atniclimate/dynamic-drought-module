import { expect, test, type Locator, type Page } from '@playwright/test';

import { SST_ANOMALY_SCALE } from '../src/config/palette';
import { gotoApp } from './helpers';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return !(
    a.right <= b.left ||
    b.right <= a.left ||
    a.bottom <= b.top ||
    b.bottom <= a.top
  );
}

async function rect(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height
    };
  });
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth
      }))
    )
    .toEqual({ client: width, document: width, body: width });
}

const FIRE_PRODUCT_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        attr_UniqueFireIdentifier: 'responsive-fire-1',
        attr_IncidentName: 'Responsive Fixture',
        attr_IncidentTypeCategory: 'WF',
        Density: 'Light',
        dn: 5
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-121, 44],
            [-120, 44],
            [-120, 45],
            [-121, 44]
          ]
        ]
      }
    }
  ]
};

async function stubWildfireMapProducts(page: Page): Promise<void> {
  await page.route(
    (url) =>
      url.href.includes('WFIGS_Interagency_Perimeters_Current') ||
      url.href.includes('NOAA_Satellite_Smoke_Detection') ||
      url.href.includes('/SPC_firewx/MapServer/1/query'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(FIRE_PRODUCT_FIXTURE)
      })
  );
}

async function expectMobileKeyClearance(
  page: Page,
  contentSelector: string
): Promise<void> {
  const key = page.locator('#map-key');
  const controls = page.locator('.map-overlay-controls');
  await expect(key).toBeVisible();
  await expect(key.locator(contentSelector).first()).toBeVisible();
  await expect(controls).toBeVisible();

  // Utilities now own an independent right column at the same safe-area top.
  // The key reserves that column horizontally instead of pushing it down.
  await expect
    .poll(async () => {
      const [keyBox, controlsBox] = await Promise.all([rect(key), rect(controls)]);
      return controlsBox.left - keyBox.right;
    })
    .toBeGreaterThanOrEqual(7);

  await expect
    .poll(async () => {
      const keyBox = await rect(key);
      const measured = await page.locator('#app').evaluate((element) =>
        Number.parseFloat(
          element.style.getPropertyValue('--mobile-map-key-height')
        )
      );
      return Number.isFinite(measured)
        ? Math.abs(measured - keyBox.height)
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);

  const loadingTop = await page.locator('#loading-indicator').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).top)
  );
  const controlsBox = await rect(controls);
  const keyBox = await rect(key);
  expect(Math.abs(controlsBox.top - keyBox.top)).toBeLessThanOrEqual(1);
  expect(loadingTop - keyBox.bottom).toBeGreaterThanOrEqual(7);
  expect(intersects(keyBox, controlsBox)).toBe(false);
  expect(keyBox.left).toBeGreaterThanOrEqual(0);
  expect(keyBox.right).toBeLessThanOrEqual(390);
  expect(controlsBox.left).toBeGreaterThanOrEqual(0);
  expect(controlsBox.right).toBeLessThanOrEqual(390);
  await expectNoHorizontalOverflow(page, 390);
}

test.describe('the exact desktop and mobile boundary', () => {
  test('721 and 720 use one Share node, preserve its focus, and clean the measured key state', async ({
    page
  }) => {
    await page.setViewportSize({ width: 721, height: 844 });
    await gotoApp(page);

    const app = page.locator('#app');
    const share = page.locator('#share-btn');
    const shareHandle = await share.elementHandle();
    expect(shareHandle).not.toBeNull();
    await expect(page.locator('#shell-panel')).toBeVisible();
    await expect(page.locator('#shell-share-host > #share-btn')).toHaveCount(1);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect
      .poll(() =>
        app.evaluate((element) =>
          element.style.getPropertyValue('--mobile-map-key-height')
        )
      )
      .toBe('');

    await share.focus();
    await expect(share).toBeFocused();
    await page.setViewportSize({ width: 720, height: 844 });

    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#shell-panel')).toBeHidden();
    await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
    await expect(share).toBeFocused();
    expect(
      await shareHandle!.evaluate(
        (element) => element === document.getElementById('share-btn')
      )
    ).toBe(true);
    // The 720px shell now carries the drought key (W2-D2), so the measured
    // key height is SET here and must be cleaned on the way back up.
    await expect
      .poll(() =>
        app.evaluate((element) =>
          element.style.getPropertyValue('--mobile-map-key-height')
        )
      )
      .toMatch(/^\d+(\.\d+)?px$/);

    await page.setViewportSize({ width: 721, height: 844 });
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(page.locator('#shell-share-host > #share-btn')).toHaveCount(1);
    await expect(share).toBeFocused();
    expect(
      await shareHandle!.evaluate(
        (element) => element === document.getElementById('share-btn')
      )
    ).toBe(true);
    await expect
      .poll(() =>
        app.evaluate((element) =>
          element.style.getPropertyValue('--mobile-map-key-height')
        )
      )
      .toBe('');
  });

  test('Place Studio takes the full mobile surface at exactly 720 pixels', async ({
    page
  }) => {
    await page.setViewportSize({ width: 720, height: 844 });
    await gotoApp(page);
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');

    const entry = page.locator('#sheet-place-studio-entry');
    await entry.scrollIntoViewIfNeeded();
    await entry.click();
    const studio = page.locator('#place-studio-root');
    await expect(studio).toBeVisible();

    const studioBox = await rect(studio);
    expect(studioBox.left).toBeGreaterThanOrEqual(0);
    expect(studioBox.right).toBeLessThanOrEqual(720);
    expect(studioBox.width).toBeGreaterThanOrEqual(719);
    await expectNoHorizontalOverflow(page, 720);
  });
});

test.describe('mobile key growth at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the phone shell keeps the drought key; the desktop shell defers to the sidebar legend (W2-D2)', async ({
    page
  }) => {
    await gotoApp(page);
    // The 390px shell has no visible sidebar legend, so the default NADM
    // surface earns its on-map key exactly like Fire and Heat, seated by
    // the same measured-height machinery.
    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute('data-key-family', 'drought');
    await expect(key.locator('.map-key-label')).toHaveText('North America drought');
    await expectMobileKeyClearance(page, '.map-key-item');

    // The desktop shell keeps the established suppression: the sidebar
    // legend is the drought reference there and the on-map key would
    // restate it.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(key).toBeHidden();
    await expect
      .poll(() =>
        page
          .locator('#app')
          .evaluate((element) =>
            element.style.getPropertyValue('--mobile-map-key-height')
          )
      )
      .toBe('');
  });

  test('the Fire card reserves the utility spine and stacks both key sections', async ({
    page
  }) => {
    await stubWildfireMapProducts(page);
    await gotoApp(page, '?cluster=wildfire&horizon=weeks-ahead');
    const key = page.locator('#map-key');
    await expect(key.locator('[data-spc-fire-weather-key]')).toBeVisible();
    await expect(key.locator('[data-nifc-perimeter-key]')).toBeVisible();
    await expect(key).toHaveAttribute('data-key-family', 'fire');
    await expectMobileKeyClearance(page, '[data-nifc-perimeter-key]');

    const keyBox = await rect(key);
    expect(keyBox.width).toBeGreaterThanOrEqual(300);
    expect(keyBox.height).toBeGreaterThanOrEqual(180);
    const chrome = await key.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue('-webkit-backdrop-filter'),
        background: style.backgroundColor,
        radius: style.borderRadius
      };
    });
    expect(chrome.radius).toBe('4px');
    expect(chrome.background).toBe('rgba(0, 64, 64, 0.3)');
    expect(chrome.backdrop).toContain('blur(15px)');

    for (const section of [
      '[data-spc-fire-weather-key]',
      '[data-nifc-perimeter-key]'
    ]) {
      const itemBoxes = await key.locator(`${section} .map-key-item`).evaluateAll(
        (items) =>
          items.map((item) => {
            const box = item.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom };
          })
      );
      expect(itemBoxes).toHaveLength(3);
      for (let index = 1; index < itemBoxes.length; index += 1) {
        expect(itemBoxes[index]!.top).toBeGreaterThanOrEqual(
          itemBoxes[index - 1]!.bottom
        );
      }
    }
    await expect(page.locator('#map-key-expand')).toBeHidden();
  });

  test('both source-calculated scale controls render as transparent dynamic rulers', async ({
    page
  }) => {
    await gotoApp(page);
    const scales = page.locator('.maplibregl-ctrl-scale');
    await expect(scales).toHaveCount(2);

    const before = await scales.evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent?.trim() ?? '',
        width: element.getBoundingClientRect().width
      }))
    );
    const rulerStyles = await scales.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const startTick = getComputedStyle(element, '::before');
        const endTick = getComputedStyle(element, '::after');
        return {
          background: style.backgroundColor,
          bottomRule: style.borderBottomStyle,
          startTick: startTick.content,
          endTick: endTick.content
        };
      })
    );
    for (const style of rulerStyles) {
      expect(style.background).toBe('rgba(0, 0, 0, 0)');
      expect(style.bottomRule).not.toBe('none');
      expect(style.startTick).not.toBe('none');
      expect(style.endTick).not.toBe('none');
    }

    const canvas = page.locator('.maplibregl-canvas');
    await canvas.focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await page.keyboard.press('+');

    await expect
      .poll(() =>
        scales.evaluateAll((elements) =>
          elements.map((element) => ({
            text: element.textContent?.trim() ?? '',
            width: element.getBoundingClientRect().width
          }))
        )
      )
      .not.toEqual(before);
  });

  test('the Fire disclosure appears only for real overflow and expands within the map stage', async ({
    page
  }) => {
    await stubWildfireMapProducts(page);
    await gotoApp(page, '?cluster=wildfire&horizon=weeks-ahead');
    const key = page.locator('#map-key');
    const expander = page.locator('#map-key-expand');
    await expect(key.locator('[data-nifc-perimeter-key]')).toBeVisible();
    // Wait for the READY key: during activation the sections render W2-D6
    // loading placeholders, and the ready re-render replaces the content
    // (which would wipe the synthetic rows appended below).
    await expect(key.locator('[data-key-loading]')).toHaveCount(0);
    await expect(
      key.locator('[data-nifc-perimeter-key] .map-key-item')
    ).toHaveCount(3);
    await expect(expander).toBeHidden();

    await key.locator('[data-nifc-perimeter-key]').evaluate((section) => {
      for (let index = 0; index < 12; index += 1) {
        const item = document.createElement('span');
        item.className = 'map-key-item';
        item.textContent = `Additional governed key item ${index + 1}`;
        section.append(item);
      }
    });

    await expect(expander).toBeVisible();
    await expect(expander).toHaveAttribute('aria-expanded', 'false');
    await expect(key).toHaveAttribute('role', 'group');
    await expander.focus();
    await expander.press('Enter');
    await expect(expander).toHaveAttribute('aria-expanded', 'true');
    await expect(key).toHaveAttribute('data-key-expanded', 'true');

    const [keyBox, footerBox] = await Promise.all([
      rect(key),
      rect(page.locator('#mobile-footer-nav'))
    ]);
    expect(keyBox.bottom).toBeLessThanOrEqual(footerBox.top);

    await page.locator('#hazard-rail button[data-preset="hazard-drought"]').click();
    await expect(key).toBeVisible();
    await expect(key.locator('.map-key-label')).toHaveText(
      'North America drought'
    );
    await expect(key).toHaveAttribute('data-key-family', 'drought');
    await expect(expander).toHaveAttribute('aria-expanded', 'false');
    await expect(expander).toBeHidden();
  });
});

const SST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** Deterministic GIBS stubs: a one-week P1D window and transparent tiles
 * (the tests/temporal-axis.spec.ts idiom). */
async function stubSstAnomaly(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.includes('DescribeDomains'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/xml',
        body:
          "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
          '<ows:Identifier>time</ows:Identifier>' +
          '<Domain>2026-07-01/2026-07-07/P1D</Domain>' +
          '<Size>1</Size></DimensionDomain></Domains>'
      })
  );
  await page.route(
    (url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: SST_PNG })
  );
}

/** Assert the one shared SST scale renders in the on-map key (W2-D1). */
async function expectSstKeyContent(
  page: Page,
  root: ReturnType<Page['locator']>
): Promise<void> {
  await expect(root.locator('.map-key-label')).toHaveText('Ocean temperature');
  const swatches = root.locator('[data-sst-anomaly-key] .map-key-item');
  await expect(swatches).toHaveCount(SST_ANOMALY_SCALE.length);
  for (let index = 0; index < SST_ANOMALY_SCALE.length; index += 1) {
    const entry = SST_ANOMALY_SCALE[index]!;
    await expect(swatches.nth(index)).toContainText(entry.label);
    const rendered = await swatches
      .nth(index)
      .locator('.map-key-swatch')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const hex = entry.color.replace('#', '');
    const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(
      hex.slice(2, 4),
      16
    )}, ${parseInt(hex.slice(4, 6), 16)})`;
    expect(rendered, `${entry.label} swatch color`).toBe(rgb);
  }
  await expect(root.locator('[data-sst-attribution]')).toHaveText(
    'NASA GIBS GHRSST MUR'
  );
  await expect(root.locator('[data-sst-observed]')).toHaveText(
    'Observed Jul 7, 2026'
  );
  const aria = (await root.getAttribute('aria-label')) ?? '';
  expect(aria).toContain('NASA GIBS GHRSST MUR');
  expect(aria).toContain('Observed Jul 7, 2026');
}

test.describe('the ENSO ocean key reaches every surface (W2-D1)', () => {
  test('the phone quick view renders the SST anomaly key like Fire and Heat', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubSstAnomaly(page);
    await gotoApp(page, '?layers=sst-anomaly,aiannh');

    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expectSstKeyContent(page, key);
    await expectMobileKeyClearance(page, '[data-sst-anomaly-key]');
  });

  test('the 200x600 embed renders a reachable SST anomaly scale', async ({
    page
  }) => {
    await page.setViewportSize({ width: 200, height: 600 });
    await stubSstAnomaly(page);
    await gotoApp(page, '?embed=true&layers=sst-anomaly');

    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expectSstKeyContent(page, key);
    const keyBox = await rect(key);
    expect(keyBox.left).toBeGreaterThanOrEqual(0);
    expect(keyBox.right).toBeLessThanOrEqual(200);
    await expectNoHorizontalOverflow(page, 200);
    // The embed date stamp still carries the observed date; the key states
    // the same date rather than a second, different one.
    await expect(page.locator('#embed-date-stamp')).toContainText(
      'Observed Jul 7, 2026'
    );
  });

  test('the 400x600 embed renders the SST anomaly key', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await stubSstAnomaly(page);
    await gotoApp(page, '?embed=true&layers=sst-anomaly');
    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expectSstKeyContent(page, key);
  });

  test('the desktop shell renders the SST anomaly key in the control column', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubSstAnomaly(page);
    await gotoApp(page, '?layers=sst-anomaly,aiannh');
    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expectSstKeyContent(page, key);
  });
});

/**
 * Owner direction 2026-08-19 moved four pieces of chrome. Three joined the
 * desktop control column (Share and Reset were already there, the satellite
 * toggle and the on-map key moved in), and the pre-1.0 preview badge moved
 * out of that column into the bottom-right corner beside the round buttons.
 *
 * The contract these cases hold is not "the pixels look right"; it is that
 * the move is DESKTOP ONLY, that the attribution stays reachable, and that
 * the preview badge never covers either round control. The phone shell and
 * the embed were designed around the old seats and keep them.
 */
test.describe('the 2026-08-19 map chrome seats', () => {
  test('the desktop column holds the satellite control and the key, and the corner reads badge, attribution, question mark', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoApp(page, '?view=console');

    await expect(
      page.locator('#basemap-switcher-overlay-host > .basemap-switcher-control')
    ).toHaveCount(1);
    await expect(page.locator('#map-key-overlay-host > #map-key')).toHaveCount(1);

    // The satellite control seats BELOW Reset, which is what makes the three
    // buttons one family rather than two conventions in one corner.
    const reset = await rect(page.locator('#reset-btn'));
    const satellite = await rect(page.locator('.basemap-switcher-control'));
    expect(satellite.top).toBeGreaterThanOrEqual(reset.bottom - 1);
    expect(Math.abs(satellite.right - reset.right)).toBeLessThanOrEqual(2);

    // The corner holds the question mark alone (owner direction
    // 2026-08-31: the attribution circle is gone and its credits render
    // inside the question-mark panel); the preview badge sits bottom
    // center. No overlap.
    const info = await rect(page.locator('.map-info-btn'));
    const badge = await rect(page.locator('.test-preview-badge'));
    await expect(page.locator('.map-info-btn')).toBeVisible();
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('viewport size is unavailable');
    const badgeCenter = (badge.left + badge.right) / 2;
    expect(Math.abs(badgeCenter - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(badge.right).toBeLessThanOrEqual(info.left);
    expect(intersects(badge, info)).toBe(false);
    expect(info.bottom).toBeLessThanOrEqual(800);

    // The license disclosure is still one click away and still says who
    // owns the base map. Burying it to make room for app chrome would be a
    // license problem, not a layout preference.
    await page.locator('#map-info-btn').click();
    await expect(page.locator('#map-info-attribution')).toContainText(
      'OpenStreetMap'
    );
    await page.keyboard.press('Escape');
  });

  test('a phone keeps the dock key seat and the thumb-zone satellite control', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '');

    await expect(page.locator('.map-dock-foot > #map-key')).toHaveCount(1);
    await expect(
      page.locator('.maplibregl-ctrl-bottom-right .basemap-switcher-control')
    ).toHaveCount(1);
    await expect(page.locator('#map-key-overlay-host > #map-key')).toHaveCount(0);
  });

  test('an embed keeps the dock key seat and MapLibre\'s satellite corner', async ({
    page
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await gotoApp(page, '?cluster=wildfire&embed=true');

    await expect(page.locator('.map-dock-foot > #map-key')).toHaveCount(1);
    await expect(
      page.locator('.maplibregl-ctrl-bottom-right .basemap-switcher-control')
    ).toHaveCount(1);
  });
});

test.describe('short landscape coarse-pointer shell', () => {
  test.use({
    viewport: { width: 844, height: 390 },
    hasTouch: true
  });

  test('new shell controls keep 44 pixel targets and reduce presentational motion', async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoApp(page);

    expect(
      await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
    ).toBe(true);
    await expect(page.locator('#shell-panel')).toBeVisible();
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
    await expect(page.locator('.shell-minimap-map')).toBeHidden();

    for (const selector of [
      '.shell-cluster-btn',
      '.shell-horizon-btn',
      '#shell-minimap-door',
      '#shell-share-host > #share-btn'
    ]) {
      const target = page.locator(selector).first();
      const targetBox = await rect(target);
      expect(targetBox.height, `${selector} is below the touch floor`).toBeGreaterThanOrEqual(44);
    }

    const minimapDoor = page.locator('#shell-minimap-door');
    await minimapDoor.scrollIntoViewIfNeeded();
    await minimapDoor.click();
    const allAreas = page.locator('#shell-minimap-popover .shell-minimap-all');
    await expect(allAreas).toBeVisible();
    const allAreasBox = await rect(allAreas);
    expect(allAreasBox.width).toBeGreaterThanOrEqual(44);
    expect(allAreasBox.height).toBeGreaterThanOrEqual(44);

    for (const selector of [
      '.shell-cluster-btn',
      '#shell-share-host > #share-btn',
      '#shell-minimap-popover .shell-minimap-mainland'
    ]) {
      const duration = await page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration);
      expect(duration, `${selector} still transitions under reduced motion`).toBe('0s');
    }

    await expectNoHorizontalOverflow(page, 844);
  });
});

for (const width of [400, 200]) {
  test(`the ${width}x600 embed contains dense Wildfire chrome and compact attribution`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await stubWildfireMapProducts(page);
    await gotoApp(page, '?embed=true&cluster=wildfire&horizon=weeks-ahead');

    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
    await expect(page.locator('#map-key [data-spc-fire-weather-key]')).toBeVisible();
    await expect(page.locator('#map-key [data-nifc-perimeter-key]')).toBeVisible();

    await expect(page.locator('#ground-vintage')).toHaveCount(0);
    const infoButton = page.locator('#map-info-btn');
    await expect(infoButton).toBeVisible();
    await infoButton.click({ trial: true });

    const overlayBox = await rect(page.locator('.map-overlay-controls'));
    const dockBox = await rect(page.locator('#map-bottom-dock'));
    expect(intersects(overlayBox, dockBox), 'top controls overlap the bottom dock').toBe(false);

    const infoBox = await rect(infoButton);
    for (const selector of ['#map-key', '.embed-brand']) {
      const itemBox = await rect(page.locator(selector));
      expect(
        intersects(infoBox, itemBox),
        `credits button overlaps ${selector}`
      ).toBe(false);
      expect(itemBox.left, `${selector} crosses the left edge`).toBeGreaterThanOrEqual(0);
      expect(itemBox.right, `${selector} crosses the right edge`).toBeLessThanOrEqual(width);
    }

    await expectNoHorizontalOverflow(page, width);
  });
}

/**
 * THE TABLET BAND, 721 to 1024 pixels (DDM-P10-T01; ROADMAP gate DDM-D02;
 * owner ruling DR-036 a, 2026-09-02: "Real third band 721 to 1024 px, fluid
 * sidebar, 44 px touch floor. Tablet is touch-first").
 *
 * The task's acceptance sentence is asserted literally: "At 721, 768, 820,
 * 900, and 1024 pixels in both orientations no control overlaps another, the
 * dock keeps a usable width, and every interactive target meets the
 * coarse-pointer minimum." Five widths times two orientations is ten
 * viewports and three conditions each.
 *
 * Orientation is read as the aspect of the viewport at that width, because
 * the acceptance fixes the WIDTH and asks for both orientations: portrait is
 * 4:3 taller than wide, landscape is 3:4 wider than tall. The landscape rows
 * are the harder half (721x541 sits under the 600px height that keeps the
 * inline minimap, and 768x576 is a real small-tablet frame).
 *
 * "Usable width" carries no number in the acceptance, so the two concrete
 * failures named in DR-036's own question are what it means here:
 *
 *   "the bottom dock computes to zero width between 721 and 804px with the
 *    briefing open, and the impact panel overlaps the sidebar below 780px"
 *
 * Both are pinned below, together with the case the first fix left behind:
 * the dock's `--dock-min-w` floor kept its box alive but parked all 180px of
 * it UNDERNEATH the open panel, where the panel's z-index hides it. A dock
 * that is present and invisible is not a dock with a usable width.
 *
 * WHAT COUNTS AS AN INTERACTIVE TARGET. A tap at the element's own centre
 * has to land on the element. That excludes three classes of node that are
 * in the DOM but are not targets: the sidebar's controls inside an embed
 * (the column is zero wide and clips them), anything under the open briefing
 * (it is `aria-modal`, so its cover is correct modal behavior and not a
 * collision), and anything scrolled out of the viewport. Two exemptions
 * follow WCAG 2.5.5 and 2.5.8 rather than waiving them: a link whose
 * computed display is `inline` keeps the line box of the sentence it sits
 * in, and a layer checkbox is measured at its `label` row, which is its real
 * activation target.
 */
const TABLET_BAND_WIDTHS = [721, 768, 820, 900, 1024] as const;
const TOUCH_FLOOR = 44;

interface Target extends Rect {
  readonly sel: string;
  readonly label: string;
  /** The pressable area, which is the box unless a rule widened it. */
  readonly hitWidth: number;
  readonly hitHeight: number;
}

/**
 * Every interactive element a finger can actually reach, with its measured
 * box. Runs entirely in the page so one round trip covers a whole survey.
 */
async function reachableTargets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    const selector =
      'button, a[href], input, select, summary, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const found: {
      sel: string;
      label: string;
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
      hitWidth: number;
      hitHeight: number;
    }[] = [];
    for (const node of Array.from(document.querySelectorAll(selector))) {
      let element = node as HTMLElement;
      const initial = getComputedStyle(element);
      if (element.tagName === 'A' && initial.display === 'inline') continue;
      if (element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'checkbox') {
        const label = element.closest('label');
        if (label) element = label as HTMLElement;
      }
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const centreX = box.left + box.width / 2;
      const centreY = box.top + box.height / 2;
      if (
        centreX < 0 ||
        centreY < 0 ||
        centreX >= window.innerWidth ||
        centreY >= window.innerHeight
      ) {
        continue;
      }
      const atCentre = document.elementFromPoint(centreX, centreY);
      if (!atCentre) continue;
      if (!(atCentre === element || element.contains(atCentre) || atCentre.contains(element))) {
        continue;
      }
      const id = element.id ? `#${element.id}` : '';
      const classes =
        typeof element.className === 'string' && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      // A minimap ocean door is the one control in this application whose
      // hit area is deliberately larger than its box: EF-5 / MM-08 gave it
      // a transparent 44px `::before` band so the 8px label could stay
      // exactly where the minimap's authored geometry puts it. Measure the
      // band, which is what a finger presses.
      const band = element.classList.contains('shell-minimap-ocean-door')
        ? getComputedStyle(element, '::before')
        : null;
      const hitWidth = Math.max(box.width, band ? Number.parseFloat(band.width) || 0 : 0);
      const hitHeight = Math.max(box.height, band ? Number.parseFloat(band.height) || 0 : 0);
      found.push({
        sel: `${element.tagName.toLowerCase()}${id}${classes}`,
        label: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40),
        left: Number(box.left.toFixed(1)),
        top: Number(box.top.toFixed(1)),
        right: Number(box.right.toFixed(1)),
        bottom: Number(box.bottom.toFixed(1)),
        width: Number(box.width.toFixed(1)),
        height: Number(box.height.toFixed(1)),
        hitWidth: Number(hitWidth.toFixed(1)),
        hitHeight: Number(hitHeight.toFixed(1))
      });
    }
    return found;
  });
}

function undersizedTargets(targets: readonly Target[]): string[] {
  return targets
    .filter((target) => target.hitWidth < TOUCH_FLOOR || target.hitHeight < TOUCH_FLOOR)
    .map((target) => `${target.sel} ${target.hitWidth}x${target.hitHeight} "${target.label}"`);
}

/** Pairs of reachable targets whose boxes cross, ignoring nesting. */
function collidingTargets(targets: readonly Target[]): string[] {
  const clashes: string[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      const a = targets[i] as Target;
      const b = targets[j] as Target;
      if (!intersects(a, b)) continue;
      const nested =
        (a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom) ||
        (b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom);
      if (nested) continue;
      clashes.push(`${a.sel} over ${b.sel}`);
    }
  }
  return clashes;
}

/** Settle the briefing's slide-in before any geometry is read. */
async function settledBriefing(page: Page): Promise<void> {
  await expect(page.locator('#impact-panel')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      page.locator('#impact-panel').evaluate((element) => getComputedStyle(element).transform)
    )
    .toBe('matrix(1, 0, 0, 1, 0, 0)');
}

for (const bandWidth of TABLET_BAND_WIDTHS) {
  for (const orientation of ['portrait', 'landscape'] as const) {
    const bandHeight = Math.round(
      orientation === 'portrait' ? (bandWidth * 4) / 3 : (bandWidth * 3) / 4
    );

    test.describe(`tablet band ${bandWidth}x${bandHeight} ${orientation}`, () => {
      test.use({ viewport: { width: bandWidth, height: bandHeight }, hasTouch: true });

      test('keeps the dock clear of the briefing and every target at the touch floor', async ({
        page
      }) => {
        await gotoApp(page, '?select=state:WA');
        expect(
          await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
          'the band is verified with a coarse pointer'
        ).toBe(true);
        await settledBriefing(page);

        const panel = await rect(page.locator('#impact-panel'));
        const sidebar = await rect(page.locator('.sidebar'));
        const dock = await rect(page.locator('#map-bottom-dock'));

        // DR-036 failure B: the panel covered the sidebar's right edge below
        // 780px (12px at 768, 59px at 721), taking the sidebar's scrollbar
        // and the right end of every control row with it.
        expect(sidebar.width, 'the sidebar is a real column in this shell').toBeGreaterThan(0);
        expect(intersects(panel, sidebar), 'the open briefing overlaps the sidebar').toBe(false);
        expect(
          panel.left - sidebar.right,
          'the briefing keeps its gap off the sidebar'
        ).toBeGreaterThanOrEqual(0);

        // DR-036 failure A: the dock computed to zero width between 721 and
        // 804px with the briefing open. Its declared floor is the bar.
        const dockFloor = await page.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--dock-min-w')
          )
        );
        expect(dockFloor, 'the dock floor token is still a real floor').toBeGreaterThanOrEqual(180);
        expect(
          dock.width,
          'the bottom dock lost its width under the briefing'
        ).toBeGreaterThanOrEqual(dockFloor);
        // That width has to be width a user can see: a dock parked under the
        // panel is present and invisible.
        expect(dock.right, 'the bottom dock runs underneath the open briefing').toBeLessThanOrEqual(
          panel.left
        );

        expect(
          undersizedTargets(await reachableTargets(page)),
          'targets below the touch floor with the briefing open'
        ).toEqual([]);
        await expectNoHorizontalOverflow(page, bandWidth);

        // The same conditions with the briefing closed, where nothing is
        // modal and every control on the shell is reachable at once.
        await page.keyboard.press('Escape');
        await expect(page.locator('#impact-panel')).toBeHidden({ timeout: 5_000 });

        const shellTargets = await reachableTargets(page);
        expect(
          undersizedTargets(shellTargets),
          'targets below the touch floor with no briefing open'
        ).toEqual([]);
        expect(collidingTargets(shellTargets), 'two reachable controls overlap').toEqual([]);
        await expectNoHorizontalOverflow(page, bandWidth);
      });
    });
  }
}

test.describe('the tablet band inside an iframe', () => {
  test.use({ viewport: { width: 820, height: 615 }, hasTouch: true });

  test('an 820x615 embed keeps the touch floor with no sidebar to fall back on', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&cluster=wildfire');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    const targets = await reachableTargets(page);
    expect(undersizedTargets(targets), 'embed targets below the touch floor').toEqual([]);
    expect(collidingTargets(targets), 'two reachable embed controls overlap').toEqual([]);
    await expectNoHorizontalOverflow(page, 820);
  });
});

test.describe('the tablet band sidebar is fluid, not a 340px constant', () => {
  test('the column tracks the viewport across the band and desktop is unchanged', async ({
    page
  }) => {
    // One boot, resized: the sidebar width is pure CSS, so a re-boot per
    // width would buy nothing and cost five map builds.
    await gotoApp(page);
    const sidebarWidthAt = async (viewport: number): Promise<number> => {
      await page.setViewportSize({ width: viewport, height: 900 });
      return (await rect(page.locator('.sidebar'))).width;
    };

    const at721 = await sidebarWidthAt(721);
    const at820 = await sidebarWidthAt(820);
    const at1024 = await sidebarWidthAt(1024);
    const at1280 = await sidebarWidthAt(1280);

    // The floor the minimap's canvas needs to keep the Atlantic door clear
    // of ALL on a coarse pointer; see the band block in src/styles/app.css.
    expect(at721).toBeGreaterThanOrEqual(300);
    // Fluid: the column is strictly wider as the viewport grows inside the
    // band. This is the clause a fixed --sidebar-w fails.
    expect(at820).toBeGreaterThan(at721);
    expect(at1024).toBeGreaterThan(at820);
    // Never past the desktop constant, and desktop itself is untouched.
    expect(at1024).toBeLessThanOrEqual(340);
    expect(at1280).toBe(340);
    // At the bottom of the band the map is still the larger half.
    expect(721 - at721).toBeGreaterThan(at721);
  });
});
