import { test, expect, type Page } from '@playwright/test';
import { stubHistoricalGround, urlLayers } from './helpers';

/**
 * Pre-mount door regression (ADR 0002 condition 6).
 *
 * The catalog checkboxes are rendered by a lazily-mounted Preact island
 * (ADR 0002, D-0.7.0-021), so boot has a window in which no checkbox
 * DOM exists. Three doors historically treated that DOM as the
 * activation door and silently no-op in that window (the spike's Codex
 * adversarial majors): the usdm outlook jump (`switchToOutlook`), the
 * drought observed jump (`switchToObserved`), and the ENSO driver's
 * "View the Pacific". The shared toggle command
 * (`src/ui/layer-toggle-command.ts`, D-0.7.0-008) closes all three
 * structurally: checkbox intent is recorded in the eager bridge and the
 * activation routes through the layer controller, DOM-free.
 *
 * Each test ABORTS the island chunk outright, so the island never
 * mounts and the whole session is the pre-mount window. A mount failure
 * degrades to a map without a catalog by design, so the app stays
 * drivable, and the assertions read layer state through the URL
 * (`layers=`), which needs no catalog DOM.
 *
 * RED-STATE PROOF (condition 6): this spec was demonstrated to FAIL at
 * `spike/preact-island` 333a864 (the parked tip) before counting green
 * on main: the usdm and drought instrument-switch legs time out there
 * because their pre-mount requests become silent no-ops.
 */

// --- deterministic upstream stubs (the temporal-axis spec's pattern) ---

const LATEST_MS = Date.UTC(2026, 5, 30); // 2026-06-30

const PNW_RING = [
  [-125, 42],
  [-116, 42],
  [-116, 49],
  [-125, 49],
  [-125, 42]
];

/** Stub the USDM current + archive services with a single D2 week. */
async function stubUsdm(page: Page): Promise<void> {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { DM: 2, MapDate: LATEST_MS },
        geometry: { type: 'Polygon', coordinates: [PNW_RING] }
      }
    ]
  };
  const fulfill = (route: Parameters<Parameters<Page['route']>[1]>[0]): Promise<void> =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fc)
    });
  await page.route('**/USDM_current/**', fulfill);
  await page.route('**/USDM_archive/**', fulfill);
}

/** Stub both CPC drought outlook vector layers (monthly /1, seasonal /4). */
async function stubOutlook(page: Page): Promise<void> {
  const fc = (target: string): unknown => ({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { outlook: 'Persistence', fcst_date: '06/30/2026', target },
        geometry: { type: 'Polygon', coordinates: [PNW_RING] }
      }
    ]
  });
  await page.route(
    (url) => url.href.includes('cpc_drought_outlk/MapServer/1/query'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(fc('Jul 2026'))
      })
  );
  await page.route(
    (url) => url.href.includes('cpc_drought_outlk/MapServer/4/query'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(fc('September 30'))
      })
  );
}

/** Stub the GIBS SST anomaly upstreams so the ENSO leg is deterministic. */
async function stubSst(page: Page): Promise<void> {
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
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
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX })
  );
}

/**
 * Boot with the island chunk aborted: the whole session is the
 * pre-mount window. The boot signal is the region radiogroup, which
 * `buildSidebar` renders synchronously without the island; the count-0
 * checkbox assertion proves the window actually holds.
 */
async function gotoWithoutIsland(page: Page, query: string): Promise<void> {
  await stubHistoricalGround(page);
  await page.route(/island-[^/]*\.js$/, (route) => route.abort());
  await page.goto(query, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#region-select option')).not.toHaveCount(0);
  await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
  await expect(page.locator('#shell-panel')).toBeHidden();
  await expect(page.locator('#conditions-strip-home + #conditions-strip')).toHaveCount(1);
  await expect(page.locator('#brief-head-home + #brief-head')).toHaveCount(1);
  await expect(page.locator('#panel-region-home + #panel-region')).toHaveCount(1);
  await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
}

test.describe('pre-mount doors (ADR 0002 condition 6)', () => {
  test('the outlook jump switches the surface with no checkbox DOM (usdm door)', async ({
    page
  }) => {
    await stubUsdm(page);
    await stubOutlook(page);
    await gotoWithoutIsland(page, '?region=washington_state&layers=usdm');

    // The time bar arrives with the usdm activation (which itself must
    // work pre-mount: the boot path records intent through the bridge).
    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible({ timeout: 25_000 });

    await bar.locator('[data-jump="monthly"]').click();

    // The REAL surface switch: drought (the outlook layer) enters the
    // URL and usdm leaves it via the exclusivity rule. Poll for the
    // settled set (the transition writes the URL over a few ticks).
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('drought') && !layers.has('usdm');
        },
        { message: 'the outlook jump never switched the surface', timeout: 25_000 }
      )
      .toBe(true);

    // Still pre-mount: the door was the shared command, not a
    // late-arriving checkbox.
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
  });

  test('the observed jump switches back with no checkbox DOM (drought door)', async ({
    page
  }) => {
    await stubUsdm(page);
    await stubOutlook(page);
    await gotoWithoutIsland(page, '?region=washington_state&layers=drought');

    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible({ timeout: 25_000 });

    await bar.locator('[data-jump="observed"]').click();

    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('usdm') && !layers.has('drought');
        },
        { message: 'the observed jump never restored the USDM surface', timeout: 25_000 }
      )
      .toBe(true);

    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
  });

  test('the retired ENSO driver stays absent with no checkbox DOM', async ({
    page
  }) => {
    await stubSst(page);
    // Explicit empty layer set: the ENSO leg needs no other surface, and
    // an unstubbed default-on activation would add live-network noise.
    await gotoWithoutIsland(page, '?view=brief&layers=');

    await expect(page.locator('#enso-driver')).toHaveCount(0);
    await expect.poll(async () => (await urlLayers(page)).has('sst-anomaly')).toBe(false);
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
  });
});
