import { expect, test, type Page } from '@playwright/test';

import {
  gotoApp,
  layerCheckbox,
  layerPill
} from './helpers';

const NADM_URL =
  'https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson';
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function feature(category: string, yearMonth = '202606') {
  return {
    type: 'Feature',
    properties: {
      DROUGHTCAT: category,
      YEAR_MONTH: yearMonth,
      POPULATION: 12,
      POP_PCT: 1.2,
      AREA_SQMI: 34,
      AREA_PCT: 2.3
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-139, 48],
        [-114, 48],
        [-114, 60],
        [-139, 60],
        [-139, 48]
      ]]
    }
  };
}

function fixture(features = [feature('d0'), feature('d3')]) {
  return {
    type: 'FeatureCollection',
    features
  };
}

async function routeBasemap(page: Page): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TRANSPARENT_PNG
    })
  );
}

async function routeNadm(
  page: Page,
  body: unknown,
  requests: string[],
  status = 200
): Promise<void> {
  await page.route(NADM_URL, (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status,
      contentType: status === 200 ? 'application/geo+json' : 'text/plain',
      body: status === 200 ? JSON.stringify(body) : 'synthetic source failure'
    });
  });
}

test.describe('North American Drought Monitor continental context', () => {
  test('fetches only the direct .geojson and surfaces consensus month and lag', async ({
    page
  }) => {
    const requests: string[] = [];
    await routeBasemap(page);
    await routeNadm(page, fixture(), requests);

    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );
    await expect(layerPill(page, 'nadm-drought')).toHaveText('live');

    expect(requests).toEqual([NADM_URL]);
    expect(new URL(requests[0]!).pathname).toBe(
      '/pub/data/nidis/geojson/na/nadm/NADM-current.geojson'
    );
    const legend = page.locator(
      '#legend-panel [data-legend="nadm-drought"]'
    );
    await expect(legend).toContainText(
      'North American Drought Monitor · June 2026'
    );
    await expect(legend.locator('.legend-note')).toHaveCount(0);
    const caveat = legend.locator('.sr-only');
    await expect(caveat).toContainText('Tri-national monthly consensus');
    await expect(caveat).toContainText(
      'published 2 to 3 weeks after month-end'
    );
    await expect(caveat).toContainText(
      'no polygon means no coverage from this source, not class zero'
    );
    await expect(caveat).not.toBeInViewport();
    await expect(page.locator('#time-bar')).toContainText(
      'Consensus month June 2026'
    );
    await expect(page.locator('#map-key')).toBeHidden();

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#time-bar')).toContainText(
      'Consensus month June 2026'
    );
    await expect(caveat).toContainText('Tri-national monthly consensus');
  });

  test('popup names the consensus product and never infers a polygon issuer', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeNadm(page, fixture([feature('d3')]), []);
    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );
    await expect(layerPill(page, 'nadm-drought')).toHaveText('live');

    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup).toContainText('D3 · Extreme drought');
    await expect(popup).toContainText(
      'North American Drought Monitor · tri-national consensus product'
    );
    await expect(popup).toContainText('Consensus month: June 2026');
    await expect(popup).toContainText(
      'source publishes no country or issuing-agency attribute'
    );
    await expect(popup).toContainText('No issuer is inferred from its location');
    await expect(popup).not.toContainText('Province of British Columbia');
    await expect(popup).not.toContainText('Agriculture and Agri-Food Canada');
  });

  test('does not require every class to be occupied in a valid published response', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeNadm(page, fixture([feature('d2')]), []);
    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );

    await expect(layerPill(page, 'nadm-drought')).toHaveText('live');
    await expect(
      page.locator('#legend-panel [data-legend="nadm-drought"]')
    ).toContainText('June 2026');
    await expect(layerPill(page, 'nadm-drought')).not.toContainText('no data');
  });

  test('mixed or malformed consensus months fail unavailable, not no drought', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeNadm(
      page,
      fixture([feature('d0', '202606'), feature('d1', '202607')]),
      []
    );
    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );

    await expect(layerPill(page, 'nadm-drought')).toHaveText('unavailable');
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();
    await expect(
      page.locator('#legend-panel [data-legend="nadm-drought"]')
    ).toHaveCount(0);
    await expect(page.locator('#map-key')).toBeHidden();
  });

  test('an empty valid collection reports no data instead of unavailable', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeNadm(page, fixture([]), []);
    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );

    await expect(layerPill(page, 'nadm-drought')).toHaveText(
      'no continental polygons returned by the active source'
    );
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();
    await expect(
      page.locator('#legend-panel [data-legend="nadm-drought"]')
    ).toHaveCount(0);
  });

  test('malformed polygon coordinates leave no ready state and a later retry can recover', async ({
    page
  }) => {
    await routeBasemap(page);
    let requests = 0;
    await page.route(NADM_URL, (route) => {
      requests++;
      const body =
        requests === 1
          ? fixture([
              {
                ...feature('d2'),
                geometry: { type: 'Polygon', coordinates: [[[-120, 50]]] }
              }
            ])
          : fixture([feature('d2')]);
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(body)
      });
    });

    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );
    await expect(layerPill(page, 'nadm-drought')).toHaveText('unavailable');
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();

    await layerCheckbox(page, 'nadm-drought').click();
    // The manual retry re-runs fetchSharedJsonWithBudget with its own
    // 15_000ms ceiling (src/layers/nadm-drought.ts activate()), above the
    // global 10_000ms expect timeout (playwright.config.ts); a slow runner
    // can still be mid-fetch when the default budget samples. Give this
    // one assertion room above the runtime's own budget instead.
    await expect(layerPill(page, 'nadm-drought')).toHaveText('live', {
      timeout: 20_000
    });
    expect(requests).toBe(2);
  });

  test('fetch failure is unavailable and cannot serialize as a clean month', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeNadm(page, null, [], 503);
    await gotoApp(
      page,
      '?region=british_columbia&layers=nadm-drought&view=console'
    );

    await expect(layerPill(page, 'nadm-drought')).toHaveText('unavailable');
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();
    await expect(
      page.locator('#legend-panel [data-legend="nadm-drought"]')
    ).toHaveCount(0);
    await expect(page.locator('#time-bar')).toBeHidden();
  });
});
