import { expect, test, type Page } from '@playwright/test';

import {
  HEATRISK_CATEGORIES,
  NWS_ALERT_COLORS
} from '../src/config/palette';
import { TEMPORAL_HORIZON_LABELS } from '../src/config/clusters';
import { fillHorizon } from '../src/impact/heat-horizon';
import type { Horizon } from '../src/impact/types';
import { createHeatRiskSequenceLoader } from '../src/ui/heatrisk-sequence-loader';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  search
} from './helpers';

const HEATRISK_PATH =
  '/experimental/rest/services/NWS_HeatRisk/ImageServer';
const WWA_PATH =
  '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';
const TIMES = [
  1785240000000,
  1785326400000,
  1785412800000,
  1785499200000,
  1785585600000,
  1785672000000,
  1785758400000
] as const;
const VALUES = [0, 1, 2, 3, 4, null, 2] as const;
const REACTIVATED_VALUES = [4, 4, 4, 4, 4, 4, 4] as const;
const WA_BBOX_CENTER = {
  x: -120.82089999999997,
  y: 47.273399999999995,
  spatialReference: { wkid: 4326 }
} as const;
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

interface IdentifyCall {
  readonly time: number;
  readonly geometry: {
    readonly x: number;
    readonly y: number;
    readonly spatialReference: { readonly wkid: number };
  };
}

interface HeatStubReceipt {
  readonly identifyCalls: IdentifyCall[];
  readonly exportedTimes: number[];
  readonly isNwsAlertsWaiting: () => boolean;
  readonly releaseNwsAlerts: () => void;
}

interface HeatStubOptions {
  readonly mismatchedCatalogTime?: number;
  readonly catalogTimes?: readonly number[];
  readonly metadataExtent?: readonly [number, number];
  readonly reactivatedValues?: readonly (number | null)[];
  readonly delayNwsAlerts?: boolean;
}

function emptyCollection(): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: []
  });
}

async function stubHeatH1(
  page: Page,
  options: HeatStubOptions = {}
): Promise<HeatStubReceipt> {
  const identifyCalls: IdentifyCall[] = [];
  const exportedTimes: number[] = [];
  let catalogReads = 0;
  let nwsAlertsWaiting = false;
  let releaseNwsAlerts: () => void = () => {};
  const nwsAlertsGate = new Promise<void>((resolve) => {
    releaseNwsAlerts = resolve;
  });
  const catalogTimes = options.catalogTimes ?? TIMES;
  const metadataExtent =
    options.metadataExtent ??
    ([catalogTimes[0]!, catalogTimes.at(-1)!] as const);

  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: ONE_PIXEL_PNG
    })
  );

  await page.route(
    (url) => url.pathname.startsWith(HEATRISK_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        catalogReads += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            features: catalogTimes.map((validTime, index) => ({
              attributes: {
                name: `HeatRisk_${index + 1}_Mercator`,
                idp_validtime: validTime
              }
            }))
          })
        });
        return;
      }
      if (url.pathname.endsWith('/identify')) {
        const time = Number(url.searchParams.get('time'));
        const geometry = JSON.parse(
          url.searchParams.get('geometry') ?? '{}'
        ) as IdentifyCall['geometry'];
        identifyCalls.push({ time, geometry });
        const index = TIMES.indexOf(time as (typeof TIMES)[number]);
        const activeValues =
          catalogReads > 1 && options.reactivatedValues
            ? options.reactivatedValues
            : VALUES;
        const value = index < 0 ? undefined : activeValues[index];
        if (value === undefined) {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'unknown time' } })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            value: value === null ? 'NoData' : String(value),
            catalogItems: {
              objectIdFieldName: 'objectid',
              features:
                value === null
                  ? []
                  : [
                      {
                        attributes: {
                          objectid: index + 1,
                          name: `HeatRisk_${index + 1}_Mercator`,
                          idp_validtime:
                            options.mismatchedCatalogTime === time
                              ? time + 1
                              : time
                        }
                      }
                    ]
            }
          })
        });
        return;
      }
      if (url.pathname.endsWith('/exportImage')) {
        exportedTimes.push(Number(url.searchParams.get('time')));
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: ONE_PIXEL_PNG
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeInfo: {
            timeExtent: metadataExtent
          }
        })
      });
    }
  );

  await page.route(
    (url) => url.pathname.endsWith(WWA_PATH),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          exceededTransferLimit: false,
          features: [
            {
              type: 'Feature',
              properties: {
                prod_type: 'Extreme Heat Warning',
                onset: Date.now() - 60_000,
                ends: Date.now() + 3_600_000,
                expiration: Date.now() + 3_600_000,
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
            }
          ]
        })
      })
  );

  await page.route('https://services5.arcgis.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: emptyCollection()
    })
  );
  await page.route('https://services3.arcgis.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: emptyCollection()
    })
  );
  await page.route('https://ddm-proxy.atniclimate.workers.dev/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]'
    })
  );
  await page.route('https://api.weather.gov/**', async (route) => {
    const url = new URL(route.request().url());
    if (options.delayNwsAlerts && url.pathname.includes('/alerts/')) {
      nwsAlertsWaiting = true;
      await nwsAlertsGate;
    }
    const body = url.pathname.includes('/alerts/')
      ? emptyCollection()
      : JSON.stringify({ properties: {} });
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body
    });
  });

  return {
    identifyCalls,
    exportedTimes,
    isNwsAlertsWaiting: () => nwsAlertsWaiting,
    releaseNwsAlerts
  };
}

async function setLayerChecked(
  page: Page,
  key: string,
  checked: boolean
): Promise<void> {
  await layerCheckbox(page, key).evaluate((element, next) => {
    element.checked = next;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

test('the issuer HeatRisk table and next-seven-days label are exact and centralized', () => {
  expect(HEATRISK_CATEGORIES).toEqual([
    {
      value: 0,
      label: 'Little to no risk',
      color: '#E8F9E7',
      meaning: 'Little to no risk from expected heat.'
    },
    {
      value: 1,
      label: 'Minor',
      color: '#F4F257',
      meaning:
        'This level of heat affects primarily those individuals extremely sensitive to heat, especially when outdoors without effective cooling and/or adequate hydration.'
    },
    {
      value: 2,
      label: 'Moderate',
      color: '#F69632',
      meaning:
        'This level of heat affects most individuals sensitive to heat, especially those without effective cooling and/or adequate hydration. Impacts possible in some health systems and in heat-sensitive industries.'
    },
    {
      value: 3,
      label: 'Major',
      color: '#E22F33',
      meaning:
        'This level of heat affects anyone without effective cooling and/or adequate hydration. Impacts likely in some health systems, heat-sensitive industries and infrastructure.'
    },
    {
      value: 4,
      label: 'Extreme',
      color: '#7A0E7F',
      meaning:
        'This level of rare and/or long-duration extreme heat with little to no overnight relief affects anyone without effective cooling and/or adequate hydration. Impacts likely in most health systems, heat-sensitive industries and infrastructure.'
    }
  ]);
  expect(TEMPORAL_HORIZON_LABELS['weeks-ahead']).toBe('next seven days');
});

test.describe('selected-place HeatRisk sequence and briefing', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('uses exact-time identify, redundant values, keyboard selection, and a classified claim', async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const receipt = await stubHeatH1(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk,nws-alerts&heatday=3&select=state:WA'
    );

    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    const sequence = page.locator('#heatrisk-sequence');
    await expect(sequence).toBeVisible();
    const cells = sequence.locator('[data-heatrisk-sequence-day]');
    await expect(cells).toHaveCount(7);
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(7);

    expect(
      new Set(receipt.identifyCalls.map((call) => call.time))
    ).toEqual(new Set(TIMES));
    for (const call of receipt.identifyCalls) {
      expect(TIMES).toContain(call.time);
      expect(call.geometry.spatialReference.wkid).toBe(4326);
      expect(Number.isFinite(call.geometry.x)).toBe(true);
      expect(Number.isFinite(call.geometry.y)).toBe(true);
    }

    await expect(cells.nth(0)).toContainText('0');
    await expect(cells.nth(1)).toContainText('1');
    await expect(cells.nth(2)).toContainText('2');
    await expect(cells.nth(3)).toContainText('3');
    await expect(cells.nth(4)).toContainText('4');
    await expect(cells.nth(5)).toContainText('ND');
    await expect(cells.nth(5)).toHaveAttribute('data-value', 'no-data');
    await expect(cells.nth(2)).toHaveAttribute('aria-pressed', 'true');

    const selectedRead = sequence.locator('[data-heatrisk-selected-read]');
    await expect(selectedRead).toContainText('2 · Moderate');
    await expect(selectedRead).toContainText('Experimental');
    await expect(selectedRead).toContainText(
      'Jul 30, 2026, 12:00 UTC to Jul 31, 2026, 12:00 UTC'
    );
    await expect(selectedRead).toContainText(
      'This level of heat affects most individuals sensitive to heat'
    );
    await expect(sequence.locator('#heatrisk-sequence-alt')).toContainText(
      'Aug 2, 2026: no data'
    );
    await expect(sequence.locator('.heatrisk-sequence-source')).toContainText(
      'National Weather Service HeatRisk'
    );
    await expect(sequence.locator('.heatrisk-sequence-source')).toContainText(
      'Retrieved'
    );

    const keyRows = page.locator(
      '#map-key [data-heatrisk-scale] .map-key-item'
    );
    await expect(keyRows).toHaveCount(5);
    for (let index = 0; index < HEATRISK_CATEGORIES.length; index += 1) {
      const category = HEATRISK_CATEGORIES[index]!;
      const row = keyRows.nth(index);
      await expect(row).toContainText(
        `${category.value} ${category.label}`
      );
      await expect(row.locator('.map-key-swatch')).toHaveAttribute(
        'style',
        `background:${category.color}`
      );
    }

    const productKey = page.locator('#map-key [data-nws-products-key]');
    await expect(productKey).toBeVisible();
    for (const product of Object.keys(NWS_ALERT_COLORS)) {
      await expect(productKey).toContainText(product);
    }

    const selectedCell = cells.nth(2);
    await selectedCell.focus();
    await page.keyboard.press('ArrowRight');
    await expect(cells.nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.locator('#map-key select[data-heatrisk-day]')
    ).toHaveValue('4');
    await expect(selectedRead).toContainText('3 · Major');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('heatday'))
      .toBe('4');
    await expect
      .poll(() => receipt.exportedTimes.includes(TIMES[3]))
      .toBe(true);

    expect(
      await selectedCell.evaluate(
        (element) => getComputedStyle(element).transitionDuration
      )
    ).toBe('0s');

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText('value 3, Major');
    await expect(heatClaim).toContainText(
      'Valid Jul 31, 2026, 12:00 UTC to Aug 1, 2026, 12:00 UTC'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    await expect(heatClaim.locator('.impact-claim-date')).toContainText(
      'Valid 2026-07-31'
    );

    const selector = page.locator(
      '#map-key select[data-heatrisk-day]'
    );
    await selector.focus();
    await page.keyboard.press('End');
    await expect(selector).toHaveValue('7');
    await selector.focus();
    await page.keyboard.press('ArrowUp');
    await expect(selector).toHaveValue('6');
    await expect(selectedRead).toContainText('no data');
    await expect(selectedRead).toContainText(
      'The National Weather Service returned no HeatRisk value'
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for the selected frame'
    );
    expect(receipt.identifyCalls).toHaveLength(7);
  });

  test('rejects a non-null identify value whose returned catalog time differs', async ({
    page
  }) => {
    await stubHeatH1(page, {
      mismatchedCatalogTime: TIMES[2]
    });
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=3&select=state:WA'
    );

    const sequence = page.locator('#heatrisk-sequence');
    await expect(sequence).toBeVisible();
    await expect(sequence.locator('.heatrisk-sequence-state')).toHaveText(
      'unavailable'
    );
    await expect(
      sequence.locator('[data-heatrisk-selected-read]')
    ).toHaveCount(0);
    await expect(
      page.locator('#impact-panel .impact-claim-classified', {
        hasText: 'HeatRisk (Experimental)'
      })
    ).toHaveCount(0);
  });
});

test.describe('review regressions for HeatRisk honesty and lifecycle', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('review regression: visibly qualifies the exact Washington point for values and no data', async ({
    page
  }) => {
    const receipt = await stubHeatH1(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=3&select=state:WA'
    );

    const sequence = page.locator('#heatrisk-sequence');
    await expect(sequence).toBeVisible();
    await expect(sequence.locator('.heatrisk-sequence-heading')).toContainText(
      'HeatRisk at the selected point for Washington'
    );
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(7);
    for (const call of receipt.identifyCalls) {
      expect(call.geometry).toEqual(WA_BBOX_CENTER);
    }

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'value 2, Moderate, at the selected point for Washington'
    );

    await page
      .locator('#map-key select[data-heatrisk-day]')
      .selectOption('6');
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for the selected frame'
    );
  });

  test('review regression: files the selected Day 7 classification under near-term', async ({
    page
  }) => {
    await stubHeatH1(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=7&select=state:WA'
    );

    const current = page.locator(
      '.impact-horizon[aria-label="Current conditions"]'
    );
    const nearTerm = page.locator(
      '.impact-horizon[aria-label="Near-term outlook"]'
    );
    await expect(nearTerm).toContainText(
      'HeatRisk (Experimental) value 2, Moderate'
    );
    await expect(nearTerm).toContainText('Valid Aug 3, 2026, 12:00 UTC');
    await expect(current).not.toContainText('HeatRisk (Experimental)');
  });

  test('review regression: discards an initial HeatRisk read superseded while current hydration waits', async ({
    page
  }) => {
    const receipt = await stubHeatH1(page, { delayNwsAlerts: true });
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=3&select=state:WA'
    );

    await expect
      .poll(receipt.isNwsAlertsWaiting)
      .toBe(true);
    const cells = page.locator(
      '#heatrisk-sequence [data-heatrisk-sequence-day]'
    );
    await expect(cells).toHaveCount(7);
    await cells.nth(3).evaluate((element) => element.click());
    await expect(cells.nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => receipt.exportedTimes.includes(TIMES[3]))
      .toBe(true);
    await page.waitForTimeout(500);
    receipt.releaseNwsAlerts();

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText('value 3, Major');
    await expect(heatClaim).toContainText(
      'Valid Jul 31, 2026, 12:00 UTC to Aug 1, 2026, 12:00 UTC'
    );
  });

  test('review regression: applies an inactive snapshot when the sequence chunk finishes late', async () => {
    let release: (module: {
      readonly mountHeatRiskSequence: (detail: {
        readonly status: string;
      }) => void;
    }) => void = () => {};
    const loaded = new Promise<{
      readonly mountHeatRiskSequence: (detail: {
        readonly status: string;
      }) => void;
    }>((resolve) => {
      release = resolve;
    });
    const mountedStatuses: string[] = [];
    const loader = createHeatRiskSequenceLoader(
      () => loaded,
      (err) => {
        throw err;
      }
    );

    loader.apply({
      status: 'ready',
      frames: [],
      selectedDay: 3,
      hasCoverage: true
    });
    loader.apply({
      status: 'inactive',
      frames: [],
      selectedDay: null,
      hasCoverage: null
    });
    release({
      mountHeatRiskSequence: (detail) => {
        mountedStatuses.push(detail.status);
      }
    });
    await loaded;
    await Promise.resolve();

    expect(mountedStatuses).toEqual(['inactive']);
  });

  test('review regression: reactivation rereads identical frame times from the new catalog generation', async ({
    page
  }) => {
    const receipt = await stubHeatH1(page, {
      reactivatedValues: REACTIVATED_VALUES
    });
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=3&select=state:WA'
    );

    const selectedRead = page.locator(
      '#heatrisk-sequence [data-heatrisk-selected-read]'
    );
    await expect(selectedRead).toContainText('2 · Moderate');
    await setLayerChecked(page, 'heatrisk', false);
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
    await setLayerChecked(page, 'heatrisk', true);
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');

    await expect(selectedRead).toContainText('4 · Extreme');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(14);
    await expect(
      page.locator('#impact-panel .impact-claim-classified', {
        hasText: 'HeatRisk (Experimental)'
      })
    ).toContainText('value 4, Extreme');
  });

  for (const catalogCase of [
    {
      name: 'six contiguous frames',
      catalogTimes: TIMES.slice(0, 6),
      metadataExtent: [TIMES[0], TIMES[5]] as const
    },
    {
      name: 'a missing middle day',
      catalogTimes: TIMES.filter((_, index) => index !== 3),
      metadataExtent: [TIMES[0], TIMES[6]] as const
    },
    {
      name: 'an irregular cadence',
      catalogTimes: [
        TIMES[0],
        TIMES[1],
        TIMES[2],
        TIMES[3] + 60 * 60 * 1000,
        TIMES[4],
        TIMES[5],
        TIMES[6]
      ],
      metadataExtent: [TIMES[0], TIMES[6]] as const
    }
  ] as const) {
    test(`review regression: rejects ${catalogCase.name} before seven-day wording`, async ({
      page
    }) => {
      const receipt = await stubHeatH1(page, catalogCase);
      await gotoApp(
        page,
        '?embed=true&view=console&layers=heatrisk&select=state:WA'
      );

      await expect(layerPill(page, 'heatrisk')).toHaveText('unavailable');
      await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
      await expect(page.locator('#heatrisk-sequence')).toBeHidden();
      expect(receipt.identifyCalls).toEqual([]);
    });
  }

  test('review regression: clears the prior source failure note after a successful recomputation', () => {
    const horizon: Horizon = {
      key: 'nearTerm',
      title: 'Near-term outlook',
      subtitle: 'days to a season',
      status: 'loading',
      claims: []
    };
    fillHorizon(horizon, [
      {
        ok: false,
        claims: [],
        note:
          'The National Weather Service HeatRisk classification did not respond.'
      }
    ]);
    expect(horizon.note).toBe(
      'The National Weather Service HeatRisk classification did not respond.'
    );

    fillHorizon(horizon, [{ ok: true, claims: [] }]);
    expect(horizon.note).toBeUndefined();
  });
});

for (const viewport of [
  { name: '400 by 600', width: 400, height: 600 },
  { name: '200 pixel width floor', width: 200, height: 600 }
] as const) {
  test(`${viewport.name} embed fits the unified HeatRisk and NWS product key`, async ({
    page
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height
    });
    await stubHeatH1(page);
    await gotoApp(
      page,
      '?embed=true&view=console&region=washington_state&layers=heatrisk,nws-alerts'
    );

    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expect(key.locator('[data-heatrisk-scale]')).toBeVisible();
    await expect(key.locator('[data-nws-products-key]')).toBeVisible();
    const metrics = await key.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const itemBoxes = Array.from(
        element.querySelectorAll<HTMLElement>('.map-key-item')
      ).map((item) => {
        const itemBox = item.getBoundingClientRect();
        return {
          left: itemBox.left,
          right: itemBox.right,
          top: itemBox.top,
          bottom: itemBox.bottom,
          fontSize: Number.parseFloat(getComputedStyle(item).fontSize)
        };
      });
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        itemBoxes
      };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(viewport.width);
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(viewport.height);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
    for (const item of metrics.itemBoxes) {
      expect(item.left).toBeGreaterThanOrEqual(metrics.left - 1);
      expect(item.right).toBeLessThanOrEqual(metrics.right + 1);
      expect(item.top).toBeGreaterThanOrEqual(metrics.top - 1);
      expect(item.bottom).toBeLessThanOrEqual(metrics.bottom + 1);
      expect(item.fontSize).toBeGreaterThanOrEqual(9.5);
    }

    const keyBox = await key.boundingBox();
    const brandBox = await page.locator('.embed-brand').boundingBox();
    expect(keyBox).not.toBeNull();
    expect(brandBox).not.toBeNull();
    expect(boxesOverlap(keyBox!, brandBox!)).toBe(false);
  });
}
