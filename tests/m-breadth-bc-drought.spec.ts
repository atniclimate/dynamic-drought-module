import { expect, test, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';

import {
  gotoApp,
  layerCheckbox,
  layerPill,
  regionSelect,
  selectRegion
} from './helpers';

const BC_HOST = 'services1.arcgis.com';
const BC_PATH =
  '/xeMpV7tU1t4KD3Ei/arcgis/rest/services/British_Columbia_Drought_Levels_(Edit)_view/FeatureServer/27/query';
const USDM_CURRENT_PATH = '/USDM_current/FeatureServer/0/query';
const SOURCE_DATE_MS = 1784822456530;

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const BC_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        OBJECTID: 1,
        BasinName: 'Interior Test Basin',
        DroughtLevel: 99,
        Date_Modified: SOURCE_DATE_MS
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-136, 49],
          [-116, 49],
          [-116, 59],
          [-136, 59],
          [-136, 49]
        ]]
      }
    },
    {
      type: 'Feature',
      properties: {
        OBJECTID: 2,
        BasinName: 'Level Zero Test Basin',
        DroughtLevel: 0,
        Date_Modified: SOURCE_DATE_MS
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-139, 48],
          [-138, 48],
          [-138, 49],
          [-139, 49],
          [-139, 48]
        ]]
      }
    },
    {
      type: 'Feature',
      properties: {
        OBJECTID: 3,
        BasinName: 'Level Five Test Basin',
        DroughtLevel: 5,
        Date_Modified: SOURCE_DATE_MS
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-116, 58],
          [-114, 58],
          [-114, 60],
          [-116, 60],
          [-116, 58]
        ]]
      }
    }
  ]
} as const;

const USDM_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        DM: 1,
        MapDate: 1784638800000,
        ValidStart: 1784638800000,
        ValidEnd: 1785243600000
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
} as const;

async function routeDroughtSources(
  page: Page,
  bcRequests: string[],
  bcStatus = 200,
  bcGate: Promise<void> | null = null
): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TRANSPARENT_PNG
    })
  );
  await page.route(
    (url) => url.host === BC_HOST && decodeURIComponent(url.pathname) === BC_PATH,
    async (route) => {
      bcRequests.push(route.request().url());
      if (bcGate) await bcGate;
      try {
        await route.fulfill({
          status: bcStatus,
          contentType: bcStatus === 200 ? 'application/geo+json' : 'text/plain',
          body: bcStatus === 200 ? JSON.stringify(BC_FIXTURE) : 'synthetic failure'
        });
      } catch {
        // A region change may cancel the routed request before release.
      }
    }
  );
  await page.route(
    (url) => url.pathname.endsWith(USDM_CURRENT_PATH),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(USDM_FIXTURE)
      })
  );
}

function droughtRow(page: Page) {
  return page
    .locator('.layer-toggle')
    .filter({ has: layerCheckbox(page, 'usdm') });
}

function conditionsGroup(page: Page) {
  return page
    .locator('.layer-group')
    .filter({ has: page.locator('.layer-group-title-text', { hasText: 'Conditions' }) });
}

test.describe('U7 British Columbia basin drought display', () => {
  test('uses only required fields and renders issuer, date, scale, and No update honestly', async ({
    page
  }) => {
    const bcRequests: string[] = [];
    await routeDroughtSources(page, bcRequests);

    await gotoApp(
      page,
      '?region=british_columbia&layers=usdm&view=console'
    );

    await expect(regionSelect(page)).toHaveValue('region:british_columbia');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await expect(droughtRow(page)).toContainText(
      'British Columbia Basin Drought Levels'
    );

    await conditionsGroup(page)
      .locator('.layer-group-sources-toggle')
      .click();
    await expect(droughtRow(page)).toContainText(
      'Province of British Columbia · source date 2026-07-23'
    );

    const legend = page.locator(
      '#legend-panel [data-legend="usdm"]'
    );
    await expect(legend).toContainText('British Columbia basin drought levels');
    await expect(legend).toContainText('No update · Not measured right now');
    await expect(legend).toContainText('source date 2026-07-23');
    await expect(legend).not.toContainText('U.S. Drought Monitor');

    await expect(page.locator('#time-bar')).toContainText(
      'Source date 2026-07-23'
    );
    await expect(page.locator('#time-bar')).toContainText(
      'No update means not measured right now'
    );
    await expect(page.locator('#map-key')).toBeHidden();
    await page.locator('#map-info-btn').click();
    await expect(page.locator('#map-info-attribution')).toContainText(
      'Province of British Columbia'
    );
    await page.keyboard.press('Escape');

    expect(bcRequests).toHaveLength(1);
    const query = new URL(bcRequests[0]!);
    expect(query.searchParams.get('outFields')).toBe(
      'OBJECTID,BasinName,DroughtLevel,Date_Modified'
    );
    expect(query.searchParams.get('outSR')).toBe('4326');
    expect(query.searchParams.get('f')).toBe('geojson');
    expect(query.searchParams.has('Comments')).toBe(false);
    expect(query.searchParams.has('Shape__Area')).toBe(false);
  });

  test('switches United States to British Columbia and back with one issuer visible at a time', async ({
    page
  }) => {
    const bcRequests: string[] = [];
    await routeDroughtSources(page, bcRequests);

    await gotoApp(page, '?region=washington_state&layers=usdm&view=console');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    const legend = page.locator('#legend-panel [data-legend="usdm"]');
    await expect(legend).toContainText('U.S. Drought Monitor');

    await selectRegion(page, 'british_columbia');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await expect(legend).toContainText('Province of British Columbia');
    await expect(legend).not.toContainText('U.S. Drought Monitor');
    await expect(page.locator('#time-bar')).not.toContainText(
      'US Drought Monitor week'
    );

    await selectRegion(page, 'washington_state');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await expect(legend).toContainText('U.S. Drought Monitor');
    await expect(legend).not.toContainText('Province of British Columbia');
    await expect(page.locator('#map-key')).not.toContainText(
      'Province of British Columbia'
    );
    expect(bcRequests).toHaveLength(1);
  });

  test('a late British Columbia response cannot replace the region selected after it', async ({
    page
  }) => {
    const bcRequests: string[] = [];
    let releaseBc!: () => void;
    const bcGate = new Promise<void>((resolve) => {
      releaseBc = resolve;
    });
    await routeDroughtSources(page, bcRequests, 200, bcGate);

    await gotoApp(page, '?region=washington_state&layers=usdm&view=console');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    const legend = page.locator('#legend-panel [data-legend="usdm"]');

    await selectRegion(page, 'british_columbia');
    await expect.poll(() => bcRequests.length).toBe(1);
    await selectRegion(page, 'washington_state');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await expect(legend).toContainText('U.S. Drought Monitor');

    releaseBc();
    await page.waitForTimeout(500);
    await expect(regionSelect(page)).toHaveValue('region:washington_state');
    await expect(legend).toContainText('U.S. Drought Monitor');
    await expect(legend).not.toContainText('Province of British Columbia');
    await expect(page.locator('#map-key')).not.toContainText(
      'Province of British Columbia'
    );
  });

  test('No update popup says not measured and never presents value 99 as severity', async ({
    page
  }) => {
    const bcRequests: string[] = [];
    await routeDroughtSources(page, bcRequests);
    await gotoApp(
      page,
      '?region=british_columbia&layers=usdm&view=console'
    );
    await expect(layerPill(page, 'usdm')).toHaveText('live');

    const map = page.locator('#map');
    const box = await map.boundingBox();
    if (!box) throw new Error('map has no bounding box');
    const popup = page.locator('.maplibregl-popup-content');
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    await expect
      .poll(
        async () => {
          await page.mouse.click(centerX, centerY);
          await page.waitForTimeout(120);
          return popup.isVisible();
        },
        {
          timeout: 8000,
          message: 'British Columbia drought popup never appeared over the basin fill'
        }
      )
      .toBe(true);

    await expect(popup).toContainText('Interior Test Basin: No update');
    await expect(popup).toContainText('Province of British Columbia');
    await expect(popup).toContainText('Source date: 2026-07-23');
    await expect(popup).toContainText('not measured right now');
    await expect(popup).toContainText('not a drought severity');
    await expect(popup).not.toContainText('Level 99');
  });

  test('failed source is unavailable, not clean no-drought or class zero', async ({
    page
  }) => {
    const bcRequests: string[] = [];
    await routeDroughtSources(page, bcRequests, 503);

    await gotoApp(
      page,
      '?region=british_columbia&layers=usdm&view=console'
    );
    await expect(layerPill(page, 'usdm')).toHaveText('unavailable');
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(
      page.locator('#legend-panel [data-legend="usdm"]')
    ).toHaveCount(0);
    await expect(page.locator('#map-key')).toBeHidden();
    expect(bcRequests).toHaveLength(1);
  });

  test('switching an open United States briefing into British Columbia closes it before print', async ({
    page
  }) => {
    const bcRequests: string[] = [];
    const briefingResourceRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (
        url.includes('/data/resources/') ||
        url.includes('/states/washington') ||
        url.includes('/StateStatistics/')
      ) {
        briefingResourceRequests.push(url);
      }
    });
    await routeDroughtSources(page, bcRequests);

    await gotoApp(
      page,
      '?region=washington_state&layers=usdm&view=console'
    );
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await page.locator('#region-briefing-btn').click();
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Washington');

    await page.waitForTimeout(250);
    const resourceRequestsBeforeSwitch = briefingResourceRequests.length;
    await selectRegion(page, 'british_columbia');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await expect(panel).toBeHidden();
    await expect(page.locator('#region-briefing-btn')).toBeHidden();
    await page.waitForTimeout(500);
    expect(briefingResourceRequests).toHaveLength(resourceRequestsBeforeSwitch);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#app')).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(page.locator('#time-bar')).toContainText(
      'Source date 2026-07-23'
    );
    await expect(
      page.locator('#legend-panel [data-legend="usdm"]')
    ).toContainText('Province of British Columbia');
    await expect(page.locator('#map-key')).toBeHidden();
  });

  test('no British Columbia source geometry is committed under public data', () => {
    const names = readdirSync('public/data');
    expect(names.filter((name) => /(?:british.?columbia|bc-drought)/i.test(name)))
      .toEqual([]);
  });
});
