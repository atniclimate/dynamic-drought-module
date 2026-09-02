import { expect, test, type Page } from '@playwright/test';

import {
  gotoApp,
  layerCheckbox,
  layerPill,
  selectRegion
} from './helpers';

const HEATRISK_PATH =
  '/experimental/rest/services/NWS_HeatRisk/ImageServer';
const WWA_PATH =
  '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';
const TIMES = [
  1785153600000,
  1785240000000,
  1785326400000,
  1785412800000,
  1785499200000,
  1785585600000,
  1785672000000
] as const;
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

interface WindowWithMap extends Window {
  __advanceClock?: (milliseconds: number) => void;
}

function collection(
  features: unknown[],
  exceededTransferLimit = false
): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features,
    exceededTransferLimit
  });
}

function rectangleFeature(
  product: string,
  expiration: number
): Record<string, unknown> {
  return {
    type: 'Feature',
    properties: {
      prod_type: product,
      onset: expiration - 3_600_000,
      ends: expiration,
      expiration,
      wfo: 'SEW'
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-125, 45],
        [-116, 45],
        [-116, 50],
        [-125, 50],
        [-125, 45]
      ]]
    }
  };
}

async function stubBasemap(page: Page): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: ONE_PIXEL_PNG
    })
  );
}

async function stubHeatRisk(
  page: Page,
  tileMode: 'success' | 'missing' | 'mixed' = 'success'
): Promise<void> {
  await stubBasemap(page);
  let tileRequestCount = 0;
  await page.route(
    (url) => url.pathname.startsWith(HEATRISK_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            features: TIMES.map((validTime, index) => ({
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
        tileRequestCount += 1;
        const missing =
          tileMode === 'missing' ||
          (tileMode === 'mixed' && tileRequestCount > 1);
        await route.fulfill({
          status: missing ? 404 : 200,
          contentType: 'image/png',
          body: missing ? Buffer.from('missing') : ONE_PIXEL_PNG
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeInfo: {
            timeExtent: [TIMES[0], TIMES.at(-1)]
          }
        })
      });
    }
  );
}

async function stubNwsSnapshot(
  page: Page,
  truncated: boolean
): Promise<void> {
  await stubBasemap(page);
  await page.route(
    (url) => url.pathname.endsWith(WWA_PATH),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: collection(
          [
            rectangleFeature(
              'Extreme Heat Warning',
              Date.now() + 3_600_000
            )
          ],
          truncated
        )
      })
  );
}

async function expectCompactEmbedKey(page: Page): Promise<void> {
  const key = page.locator('#map-key');
  await expect(key).toBeVisible();
  const metrics = await key.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? Number.POSITIVE_INFINITY
  );
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

test('HeatRisk is live only at a contiguous United States map center', async ({
  page
}) => {
  await stubHeatRisk(page);
  await gotoApp(
    page,
    '?region=washington_state&layers=heatrisk&view=console'
  );

  await expect(layerPill(page, 'heatrisk')).toHaveText('live');
  await expect(
    page.locator('.legend-section[data-legend="heatrisk"]')
  ).toContainText(
    'National Weather Service HeatRisk covers the contiguous United States only.'
  );

  for (const region of ['alaska', 'hawaii'] as const) {
    await selectRegion(page, region);
    await expect(layerPill(page, 'heatrisk'), region).toContainText(
      'no data'
    );
    await expect(
      page.locator('.legend-section[data-legend="heatrisk"]')
    ).toContainText('No HeatRisk data at the map center.');
  }

  await selectRegion(page, 'washington_state');
  await expect(layerPill(page, 'heatrisk')).toHaveText('live');
});

test('an all-404 HeatRisk selected frame becomes unavailable', async ({
  page
}) => {
  await stubHeatRisk(page, 'missing');
  await gotoApp(
    page,
    '?region=washington_state&layers=heatrisk&view=console'
  );

  await expect(layerPill(page, 'heatrisk')).toHaveText('unavailable', {
    timeout: 15_000
  });
});

test('a mixed-success HeatRisk selected frame is live partial', async ({
  page
}) => {
  await stubHeatRisk(page, 'mixed');
  await gotoApp(
    page,
    '?region=washington_state&layers=heatrisk&view=console'
  );

  await expect(layerPill(page, 'heatrisk')).toHaveText('live (partial)', {
    timeout: 15_000
  });
});

for (const embedViewport of [
  { name: 'standard embed', width: 1280, height: 720 },
  { name: '400 by 600 embed', width: 400, height: 600 }
] as const) {
  test.describe(embedViewport.name, () => {
    test.use({
      viewport: {
        width: embedViewport.width,
        height: embedViewport.height
      }
    });

    test('shows outside-coverage HeatRisk no data and qualification', async ({
      page
    }) => {
      await stubHeatRisk(page);
      await gotoApp(
        page,
        '?region=alaska&layers=heatrisk&embed=true&view=console'
      );

      const qualification = page.locator(
        '#map-key [data-heatrisk-coverage]'
      );
      await expect(qualification).toContainText('no data');
      await expect(qualification).toContainText(
        'National Weather Service HeatRisk covers the contiguous United States only.'
      );
      await expectCompactEmbedKey(page);
    });

    test('shows the National Weather Service snapshot age', async ({
      page
    }) => {
      await stubNwsSnapshot(page, false);
      await gotoApp(
        page,
        '?layers=nws-alerts&embed=true&view=console'
      );

      await expect(
        page.locator('#map-key [data-nws-snapshot]')
      ).toContainText('National Weather Service snapshot as of');
      await expectCompactEmbedKey(page);
    });

    test('shows the partial snapshot status and transfer-limit reason', async ({
      page
    }) => {
      await stubNwsSnapshot(page, true);
      await gotoApp(
        page,
        '?layers=nws-alerts&embed=true&view=console'
      );

      const snapshot = page.locator('#map-key [data-nws-snapshot]');
      await expect(snapshot).toContainText('live (partial)');
      await expect(snapshot).toContainText('transfer limit reached');
      await expectCompactEmbedKey(page);
    });
  });
}

test('the National Weather Service snapshot prunes expired products and exposes truncation and as-of time', async ({
  page
}) => {
  await stubBasemap(page);
  const now = Date.now();
  await page.route(
    (url) => url.pathname.endsWith(WWA_PATH),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: collection(
          [
            rectangleFeature('Heat Advisory', now - 60_000),
            rectangleFeature('Extreme Heat Warning', now + 3_600_000)
          ],
          true
        )
      })
  );

  await gotoApp(page, '?layers=nws-alerts&view=console');

  await expect(layerPill(page, 'nws-alerts')).toHaveText('live (partial)');
  const note = page.locator(
    '.legend-section[data-legend="nws-alerts"] .legend-note'
  );
  await expect(note).toContainText(
    'response reached its transfer limit'
  );
  await expect(note).toContainText('Snapshot as of');
  await expect(note).toHaveAttribute('data-snapshot-as-of', /T/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mobile-footer-nav button[data-tab="alerts"]').click();
  const sheet = page.locator('#sheet-alerts-body');
  await expect(sheet).toContainText('Extreme Heat Warning');
  await expect(sheet).not.toContainText('Heat Advisory');
});

test('the NWS expiry timer removes a product before the next network refresh', async ({
  page
}) => {
  await stubBasemap(page);
  let requestCount = 0;
  // scheduleExpiryPrune (src/layers/nws-alerts.ts) schedules its setTimeout
  // from `nextExpiry - Date.now()` the moment this fetch response is
  // parsed, near the start of boot. A 1s deadline left almost no margin
  // for the boot settle, viewport resize, and tab click below, so the
  // product could already be pruned before the "still present" read on
  // line ~367 below, an intrinsically sensitive near-immediate race
  // (Codex review, 2026-08-29, on the 56dd46a deploy's retry-only green).
  // Widen it well clear of that work; REFRESH_INTERVAL_MS is 5 minutes, so
  // 8s stays far short of triggering the periodic re-fetch this test
  // deliberately excludes (requestCount stays 1).
  const EXPIRY_OFFSET_MS = 8_000;
  await page.route(
    (url) => url.pathname.endsWith(WWA_PATH),
    (route) => {
      requestCount += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: collection([
          rectangleFeature('Heat Advisory', Date.now() + EXPIRY_OFFSET_MS)
        ])
      });
    }
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoApp(page, '?layers=nws-alerts&view=console');
  await expect(layerPill(page, 'nws-alerts')).toHaveText('live');
  await page.locator('#mobile-footer-nav button[data-tab="alerts"]').click();
  const sheet = page.locator('#sheet-alerts-body');
  await expect(sheet).toContainText('Heat Advisory');

  // The local timer, not a re-fetch, removes it. scheduleExpiryPrune's own
  // ceiling is EXPIRY_OFFSET_MS + 25ms (its scheduling buffer); this read's
  // 13_000ms is a bounded budget roughly 5s above that 8_025ms ceiling,
  // for event-loop jitter and the pill's own DOM update, rather than the
  // global expect timeout.
  await expect(layerPill(page, 'nws-alerts')).toContainText('no features', {
    timeout: EXPIRY_OFFSET_MS + 5_000
  });
  await expect(sheet).toContainText(
    'No active heat or fire-weather alerts in the current map view.'
  );
  expect(requestCount).toBe(1);
});

test('the NWS layer pauses while hidden and refreshes one stale snapshot on return', async ({
  page
}) => {
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    Date.now = () => realNow() + offset;
    (window as WindowWithMap).__advanceClock = (milliseconds: number) => {
      offset += milliseconds;
    };
  });
  await stubBasemap(page);
  let requestCount = 0;
  await page.route(
    (url) => url.pathname.endsWith(WWA_PATH),
    (route) => {
      requestCount += 1;
      const product =
        requestCount === 1 ? 'Extreme Heat Warning' : 'Red Flag Warning';
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: collection([
          rectangleFeature(product, Date.now() + 3_600_000)
        ])
      });
    }
  );

  await gotoApp(page, '?layers=nws-alerts&view=console');
  await expect(layerPill(page, 'nws-alerts')).toHaveText('live');
  expect(requestCount).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mobile-footer-nav button[data-tab="alerts"]').click();
  const sheet = page.locator('#sheet-alerts-body');
  await expect(sheet).toContainText('Extreme Heat Warning');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true
    });
    document.dispatchEvent(new Event('visibilitychange'));
    (window as WindowWithMap).__advanceClock?.(5 * 60 * 1000 + 1);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  expect(requestCount).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requestCount).toBe(2);
  await expect(sheet).toContainText('Red Flag Warning');

  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange'))
  );
  await page.waitForTimeout(150);
  expect(requestCount).toBe(2);
});

test('an invalid NWS MapServer body stays unavailable through activation cleanup', async ({
  page
}) => {
  await stubBasemap(page);
  await page.route(
    (url) => url.pathname.endsWith(WWA_PATH),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ features: [] })
      })
  );

  await gotoApp(page, '?layers=nws-alerts&view=console');

  await expect(layerPill(page, 'nws-alerts')).toHaveText('unavailable');
  await expect(layerCheckbox(page, 'nws-alerts')).not.toBeChecked();
});

test('an invalid NWS active-products body is unavailable, never an all-clear', async ({
  page
}) => {
  await stubBasemap(page);
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
    })
  );
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
    })
  );
  await page.route('https://api.weather.gov/alerts/active?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [] })
    })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]'
    })
  );

  await gotoApp(
    page,
    '?view=brief&layers=places&select=state:WA'
  );

  const current = page.locator(
    '.impact-horizon[aria-labelledby="impact-horizon-title-current"]'
  );
  await expect(current.locator('.impact-horizon-note')).toContainText(
    'The NWS alerts service did not respond.'
  );
  await expect(current).not.toContainText(
    'No active red-flag fire-weather or extreme-heat alerts'
  );
});
