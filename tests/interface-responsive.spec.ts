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

  test('the desktop shell renders the SST anomaly key in the map dock', async ({
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
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    const attributionToggle = page.locator('.maplibregl-ctrl-attrib-button');
    await expect(attribution).toHaveClass(/maplibregl-compact/);
    await expect(attributionToggle).toBeVisible();
    await attributionToggle.click({ trial: true });

    const overlayBox = await rect(page.locator('.map-overlay-controls'));
    const dockBox = await rect(page.locator('#map-bottom-dock'));
    expect(intersects(overlayBox, dockBox), 'top controls overlap the bottom dock').toBe(false);

    const attributionBox = await rect(attributionToggle);
    for (const selector of ['#map-key', '.embed-brand']) {
      const itemBox = await rect(page.locator(selector));
      expect(
        intersects(attributionBox, itemBox),
        `attribution toggle overlaps ${selector}`
      ).toBe(false);
      expect(itemBox.left, `${selector} crosses the left edge`).toBeGreaterThanOrEqual(0);
      expect(itemBox.right, `${selector} crosses the right edge`).toBeLessThanOrEqual(width);
    }

    await expectNoHorizontalOverflow(page, width);
  });
}
