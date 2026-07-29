import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

import { HAZARD_CLUSTERS } from '../src/config/clusters';
import {
  MOBILE_HAZARD_PRESETS,
  VIEW_PRESETS
} from '../src/config/presets';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  search
} from './helpers';

const SERVICE_PATH = '/experimental/rest/services/NWS_HeatRisk/ImageServer';
const TIMES = [
  1785153600000,
  1785240000000,
  1785326400000,
  1785412800000,
  1785499200000,
  1785585600000,
  1785672000000
] as const;

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function solidPng(red: number, green: number, blue: number): Buffer {
  const png = new PNG({ width: 1, height: 1 });
  png.data[0] = red;
  png.data[1] = green;
  png.data[2] = blue;
  png.data[3] = 255;
  return PNG.sync.write(png);
}

const RED_PNG = solidPng(255, 0, 0);
const BLUE_PNG = solidPng(0, 0, 255);

interface HeatRouteOptions {
  readonly metadataTimeInfo?: unknown;
  readonly rasterResponse?: (
    time: number,
    route: import('@playwright/test').Route
  ) => Promise<void> | void;
}

async function routeHeatRisk(
  page: Page,
  exportedTimes: number[],
  options: HeatRouteOptions = {}
): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TRANSPARENT_PNG
    })
  );

  await page.route(
    (url) => url.pathname.startsWith(SERVICE_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            objectIdFieldName: 'objectid',
            fields: [
              {
                name: 'idp_validtime',
                type: 'esriFieldTypeDate',
                alias: 'Valid Date'
              }
            ],
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
        const time = Number(url.searchParams.get('time'));
        exportedTimes.push(time);
        if (options.rasterResponse) {
          await options.rasterResponse(time, route);
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: BLUE_PNG
          });
        }
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeInfo:
            options.metadataTimeInfo === undefined
              ? {
                  startTimeField: 'idp_validtime',
                  endTimeField: null,
                  timeExtent: [TIMES[0], TIMES.at(-1)],
                  timeReference: null
                }
              : options.metadataTimeInfo
        })
      });
    }
  );
}

function heatRow(page: Page) {
  return page
    .locator('.layer-toggle')
    .filter({ has: layerCheckbox(page, 'heatrisk') });
}

function heatDaySelect(page: Page) {
  return page.locator('#map-key select[data-heatrisk-day]');
}

async function visibleHeatRiskStrings(page: Page): Promise<readonly string[]> {
  return page.locator('body *').evaluateAll((elements) => {
    const strings = new Set<string>();
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
        continue;
      }

      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      for (const value of [
        directText,
        element.getAttribute('title') ?? '',
        element.getAttribute('aria-label') ?? ''
      ]) {
        if (/HeatRisk/i.test(value)) strings.add(value);
      }
    }
    return [...strings];
  });
}

async function canvasCenter(page: Page): Promise<readonly [number, number, number]> {
  const image = PNG.sync.read(
    await page.locator('#map canvas.maplibregl-canvas').screenshot()
  );
  const x = Math.floor(image.width / 2);
  const y = Math.floor(image.height / 2);
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset] ?? 0,
    image.data[offset + 1] ?? 0,
    image.data[offset + 2] ?? 0
  ];
}

test.describe('U-HEATRISK-DAYS multi-day read', () => {
  test('HeatRisk preset and cluster descriptions state published dated impact levels', () => {
    const presetDescriptions = [
      ...MOBILE_HAZARD_PRESETS,
      ...VIEW_PRESETS
    ]
      .filter((preset) => preset.layers.includes('heatrisk'))
      .map((preset) => preset.description);
    const descriptions = [
      ...presetDescriptions,
      HAZARD_CLUSTERS.heat.description
    ];

    expect(presetDescriptions).toHaveLength(2);
    expect(descriptions).toHaveLength(3);
    for (const description of descriptions) {
      expect(description).toMatch(
        /published National Weather Service HeatRisk heat-impact levels/i
      );
      expect(description).not.toMatch(/\b(?:forecast|today)\b/i);
    }
  });

  test('catalog granules become dated choices and legacy links open the first exact frame', async ({
    page
  }) => {
    const exportedTimes: number[] = [];
    await routeHeatRisk(page, exportedTimes);

    await gotoApp(page, '?layers=heatrisk&view=console');

    await expect(layerCheckbox(page, 'heatrisk')).toBeChecked();
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect(heatRow(page)).toContainText('HeatRisk (Experimental)');
    await expect(heatRow(page)).not.toContainText('Today');

    const select = heatDaySelect(page);
    await expect(select).toHaveValue('1');
    await expect(select.locator('option')).toHaveCount(TIMES.length);
    await expect(select.locator('option').first()).toHaveText(
      'Day 1 · Jul 27, 2026'
    );
    await expect(select.locator('option').last()).toHaveText(
      'Day 7 · Aug 2, 2026'
    );

    await expect
      .poll(() => exportedTimes.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(new Set(exportedTimes)).toEqual(new Set([TIMES[0]]));
    expect(new URLSearchParams(await search(page)).has('heatday')).toBe(false);

    await select.selectOption('4');
    await expect(select.locator('option:checked')).toHaveText(
      'Day 4 · Jul 30, 2026'
    );
    const visibleCopy = await visibleHeatRiskStrings(page);
    expect(visibleCopy.length).toBeGreaterThan(0);
    for (const value of visibleCopy) {
      expect(value).not.toMatch(/\b(?:forecast|today)\b/i);
    }
  });

  test('a shared day restores, changes, and survives ordinary URL sync in embed mode', async ({
    page
  }) => {
    const exportedTimes: number[] = [];
    await routeHeatRisk(page, exportedTimes);

    await gotoApp(
      page,
      '?layers=heatrisk&heatday=4&embed=true&view=console'
    );

    const select = heatDaySelect(page);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('4');
    await expect(select.locator('option:checked')).toHaveText(
      'Day 4 · Jul 30, 2026'
    );
    await expect(page.locator('#map-key')).toHaveAttribute(
      'aria-label',
      /Valid Jul 30, 2026/
    );
    expect(new URLSearchParams(await search(page)).get('embed')).toBe('true');

    await select.selectOption('7');
    await expect(select).toHaveValue('7');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('heatday'))
      .toBe('7');
    expect(new URLSearchParams(await search(page)).get('embed')).toBe('true');

    // Trigger an unrelated ordinary region write from the hidden embed
    // chrome. Its syncUrl call must preserve both the selected HeatRisk day
    // and the embed flag.
    await page
      .locator('.region-btn[data-region-key="central_oregon"]')
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('region'))
      .toBe('central_oregon');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('heatday'))
      .toBe('7');
    expect(new URLSearchParams(await search(page)).get('embed')).toBe('true');

    await expect
      .poll(() => exportedTimes.includes(TIMES[6]), { timeout: 15_000 })
      .toBe(true);
    const advertisedTimes: readonly number[] = TIMES;
    expect(exportedTimes.every((time) => advertisedTimes.includes(time))).toBe(
      true
    );
  });

  test('switching days removes the superseded source before a late raster can paint', async ({
    page
  }) => {
    const exportedTimes: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await routeHeatRisk(page, exportedTimes, {
      rasterResponse: async (time, route) => {
        if (time === TIMES[0]) {
          await firstGate;
          try {
            await route.fulfill({
              status: 200,
              contentType: 'image/png',
              body: RED_PNG
            });
          } catch {
            // Source removal can cancel the routed request before release.
          }
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: BLUE_PNG
        });
      }
    });

    await gotoApp(page, '?layers=heatrisk&view=console');
    await expect
      .poll(() => exportedTimes.includes(TIMES[0]), { timeout: 15_000 })
      .toBe(true);

    const select = heatDaySelect(page);
    await select.selectOption('2');
    await expect(select).toHaveValue('2');
    await expect
      .poll(() => exportedTimes.includes(TIMES[1]), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(async () => {
        const [red, , blue] = await canvasCenter(page);
        return blue - red;
      })
      .toBeGreaterThan(80);

    releaseFirst();
    await page.waitForTimeout(750);
    const [redAfter, , blueAfter] = await canvasCenter(page);
    expect(blueAfter - redAfter).toBeGreaterThan(80);
    await expect(select).toHaveValue('2');
    expect(new URLSearchParams(await search(page)).get('heatday')).toBe('2');
  });

  test('missing time metadata fails honestly without querying or drawing a frame', async ({
    page
  }) => {
    const exportedTimes: number[] = [];
    await routeHeatRisk(page, exportedTimes, { metadataTimeInfo: null });

    await gotoApp(page, '?layers=heatrisk&view=console');

    await expect(layerPill(page, 'heatrisk')).toHaveText('unavailable');
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
    await expect(heatDaySelect(page)).toHaveCount(0);
    expect(exportedTimes).toEqual([]);
  });

  test('a selected frame raster failure stays on that dated frame and reports unavailable', async ({
    page
  }) => {
    const exportedTimes: number[] = [];
    await routeHeatRisk(page, exportedTimes, {
      rasterResponse: async (time, route) => {
        if (time === TIMES[1]) {
          await route.fulfill({
            status: 503,
            contentType: 'text/plain',
            body: 'synthetic frame failure'
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: BLUE_PNG
        });
      }
    });

    await gotoApp(page, '?layers=heatrisk&view=console');
    const select = heatDaySelect(page);
    await expect(select).toHaveValue('1');
    await expect
      .poll(() => exportedTimes.includes(TIMES[0]), { timeout: 15_000 })
      .toBe(true);
    // The cutoff must follow the complete initial-frame tile fan-out.
    // Under a loaded serial suite, MapLibre can schedule additional Day 1
    // tiles after the first request appears in exportedTimes.
    await page.waitForLoadState('networkidle');
    const requestCutoff = exportedTimes.length;

    await select.selectOption('2');
    await expect(layerPill(page, 'heatrisk')).toHaveText('unavailable', {
      timeout: 15_000
    });
    await expect(layerCheckbox(page, 'heatrisk')).toBeChecked();
    await expect(select).toHaveValue('2');
    await expect(select.locator('option:checked')).toHaveText(
      'Day 2 · Jul 28, 2026'
    );
    expect(exportedTimes.slice(requestCutoff).every((time) => time === TIMES[1]))
      .toBe(true);
    expect(new URLSearchParams(await search(page)).get('heatday')).toBe('2');
  });
});
