import { expect, test, type Page } from './offline-test';
import { readdirSync } from 'node:fs';

import {
  gotoApp,
  layerCheckbox,
  layerPill,
  regionSelect,
  selectRegion
} from './helpers';

// DR-160 (2026-09-28): the Province of British Columbia basin drought
// edition is HELD until the Province's written permission or the owner's
// re-ruling. This file's BC_HOST/BC_PATH/BC_FIXTURE fixtures stay so the
// tests below can prove the held app never reaches that host; a ruling
// that releases the hold restores the basin-rendering cases this file
// used to carry (git history has them).

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

test.describe('U7 British Columbia basin drought display', () => {
  // DR-160 (2026-09-28): retired, held-module cases (one-line reason each;
  // never a silent delete):
  //   - 'uses only required fields and renders issuer, date, scale, and No
  //     update honestly' (formerly here): validated the bc-drought
  //     ArcGIS query's field allowlist and the basin swatches/date scale;
  //     that fetch never fires while held, so replaced below by 'British
  //     Columbia with the usdm layer makes no request to the Province's
  //     service and never shows the basin edition'.
  //   - 'a late British Columbia response cannot replace the region
  //     selected after it': guarded a stale-fetch race against
  //     ./bc-drought; that module is never activated while held, so the
  //     race cannot occur.
  //   - 'No update popup says not measured and never presents value 99 as
  //     severity': guarded the bc-drought popup's own wording; nothing
  //     renders that popup while held.
  //   - 'failed source is unavailable, not clean no-drought or class
  //     zero': guarded the bc-drought fetch's failure handling; no such
  //     fetch happens while held (British Columbia's ordinary usdm
  //     failure path is covered by the other usdm specs, unaffected by
  //     this hold).

  test("British Columbia with the usdm layer makes no request to the Province's service and never shows the basin edition", async ({
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

    const legend = page.locator('#legend-panel [data-legend="usdm"]');
    await expect(legend).toContainText('U.S. Drought Monitor');
    await expect(legend).not.toContainText('British Columbia');

    await expect(droughtRow(page)).not.toContainText(
      'British Columbia Basin Drought Levels'
    );
    await expect(page.locator('#map-key .map-key-chip-label')).not.toHaveText(
      'BC drought'
    );

    expect(bcRequests).toHaveLength(0);
  });

  test('switching United States to British Columbia and back never shows the basin edition', async ({
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
    await expect(legend).toContainText('U.S. Drought Monitor');
    await expect(legend).not.toContainText('Province of British Columbia');

    await selectRegion(page, 'washington_state');
    await expect(layerPill(page, 'usdm')).toHaveText('live');
    await expect(legend).toContainText('U.S. Drought Monitor');
    await expect(legend).not.toContainText('Province of British Columbia');
    await expect(page.locator('#map-key')).not.toContainText(
      'Province of British Columbia'
    );
    expect(bcRequests).toHaveLength(0);
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
    // DR-160 (2026-09-28): value-only migration. Before (basin edition):
    // time-bar 'Source date Jul 23, 2026', legend 'Province of British
    // Columbia'. After (held; British Columbia shows the US Drought
    // Monitor's own week, from USDM_FIXTURE's MapDate 2026-07-21): the
    // time-bar's 'Valid <date>' stamp and the ordinary USDM legend.
    await expect(page.locator('#time-bar')).toContainText(
      'Valid Jul 21, 2026'
    );
    await expect(
      page.locator('#legend-panel [data-legend="usdm"]')
    ).toContainText('U.S. Drought Monitor');
    await expect(page.locator('#map-key-content')).toBeHidden();
  });

  test('no British Columbia source geometry is committed under public data', () => {
    const names = readdirSync('public/data');
    expect(names.filter((name) => /(?:british.?columbia|bc-drought)/i.test(name)))
      .toEqual([]);
  });
});
