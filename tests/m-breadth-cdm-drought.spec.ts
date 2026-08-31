import { expect, test, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';

import {
  gotoApp,
  layerCheckbox,
  layerPill
} from './helpers';

const ARTIFACT_PATH = 'public/data/cdm-drought-areas.json';
const ARTIFACT_ROUTE = '**/data/cdm-drought-areas.json';
const LICENSE_TITLE = 'Open Government Licence - Canada';
const LICENSE_URL =
  'https://open.canada.ca/en/open-government-licence-canada';
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function classRows(present: readonly number[]) {
  return [0, 1, 2, 3, 4].map((dm) => ({
    class: `D${dm}`,
    state: present.includes(dm) ? 'present' : 'absent-no-occupied-area',
    member: present.includes(dm) ? `CDM_2606_D${dm}_LR.geojson` : null,
    featureCount: present.includes(dm) ? 1 : 0,
    componentCount: present.includes(dm) ? 1 : 0
  }));
}

function componentCountsByClass(collection: {
  features: readonly {
    properties: { dm: number };
    geometry: { type: string; coordinates: readonly unknown[] };
  }[];
}) {
  const counts: Record<string, number> = {
    D0: 0,
    D1: 0,
    D2: 0,
    D3: 0,
    D4: 0
  };
  for (const feature of collection.features) {
    const code = `D${feature.properties.dm}`;
    counts[code] =
      (counts[code] ?? 0) +
      (feature.geometry.type === 'Polygon'
        ? 1
        : feature.geometry.coordinates.length);
  }
  return counts;
}

function artifactFixture(present: readonly number[] = [2]) {
  const classes = classRows(present);
  return {
    schemaVersion: 1,
    product: 'Canadian Drought Monitor',
    month: '2026-06',
    monthState: 'published',
    attribution: 'Agriculture and Agri-Food Canada',
    license: {
      title: LICENSE_TITLE,
      url: LICENSE_URL,
      datasetUrl:
        'https://open.canada.ca/data/en/dataset/292646cd-619f-4200-afb1-8b2c52f984a2'
    },
    provenance: {
      sourceUrl:
        'https://agriculture.canada.ca/atlas/data_donnees/canadianDroughtMonitor/data_donnees/geoJSON/areasofDrought/2026/cdm_2606_drought_areas_json.zip',
      retrieved: '2026-07-27',
      archiveBytes: 3_682_468,
      classesPresent: classes
        .filter((entry) => entry.state === 'present')
        .map((entry) => entry.class),
      classesAbsent: classes
        .filter((entry) => entry.state === 'absent-no-occupied-area')
        .map((entry) => entry.class),
      stewardshipCheck: {
        result:
          'PASS: no First Nations, Metis, Métis, Inuit, reserve, or Treaty terms found in 4 archive member names or decoded contents.'
      },
      componentPreservation:
        'PASS: shipped component count equals source component count for every class.'
    },
    classes,
    data: {
      type: 'FeatureCollection',
      features: present.map((dm) => ({
        type: 'Feature',
        properties: { dm },
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
      }))
    }
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

async function routeArtifact(
  page: Page,
  body: unknown,
  status = 200
): Promise<void> {
  await page.route(ARTIFACT_ROUTE, (route) =>
    route.fulfill({
      status,
      contentType: status === 200 ? 'application/json' : 'text/plain',
      body: status === 200 ? JSON.stringify(body) : 'synthetic missing artifact'
    })
  );
}

test.describe('Canadian Drought Monitor committed monthly snapshot', () => {
  test('committed artifact records publication, class occupancy, provenance, and stewardship', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
    expect(statSync(ARTIFACT_PATH).size).toBeLessThanOrEqual(1_000_000);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.product).toBe('Canadian Drought Monitor');
    expect(artifact.month).toBe('2026-06');
    expect(artifact.monthState).toBe('published');
    expect(artifact.license.title).toBe(LICENSE_TITLE);
    expect(artifact.license.url).toBe(LICENSE_URL);
    expect(artifact.provenance.sourceUrl).toBe(
      'https://agriculture.canada.ca/atlas/data_donnees/canadianDroughtMonitor/data_donnees/geoJSON/areasofDrought/2026/cdm_2606_drought_areas_json.zip'
    );
    expect(artifact.provenance.retrieved).toBe('2026-07-28');
    expect(artifact.provenance.archiveBytes).toBe(3_682_468);
    expect(artifact.provenance.classesPresent).toEqual([
      'D0',
      'D1',
      'D2',
      'D3'
    ]);
    expect(artifact.provenance.classesAbsent).toEqual(['D4']);
    expect(artifact.classes.find((entry: { class: string }) => entry.class === 'D4'))
      .toMatchObject({
        state: 'absent-no-occupied-area',
        featureCount: 0,
        componentCount: 0
      });
    expect(artifact.provenance.stewardshipCheck.result).toBe(
      'PASS: no First Nations, Metis, Métis, Inuit, reserve, or Treaty terms found in 4 archive member names or decoded contents.'
    );
    expect(artifact.provenance.componentPreservation).toBe(
      'PASS: shipped component count equals source component count for every class.'
    );
    const expectedComponentCounts = {
      D0: 967,
      D1: 759,
      D2: 478,
      D3: 7,
      D4: 0
    };
    expect(
      Object.fromEntries(
        artifact.classes.map(
          (entry: { class: string; componentCount: number }) => [
            entry.class,
            entry.componentCount
          ]
        )
      )
    ).toEqual(expectedComponentCounts);
    expect(componentCountsByClass(artifact.data)).toEqual(
      expectedComponentCounts
    );
    expect(
      artifact.data.features.every(
        (feature: { properties: Record<string, unknown> }) =>
          Object.keys(feature.properties).join(',') === 'dm'
      )
    ).toBe(true);
    expect(artifact.bounds[0]).toBeGreaterThanOrEqual(-180);
    expect(artifact.bounds[1]).toBeGreaterThanOrEqual(-90);
    expect(artifact.bounds[2]).toBeLessThanOrEqual(180);
    expect(artifact.bounds[3]).toBeLessThanOrEqual(90);
  });

  test('runtime reads only the committed artifact and always shows its month', async ({
    page
  }) => {
    const upstreamRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('agriculture.canada.ca') || /\.zip(?:$|\?)/i.test(url)) {
        upstreamRequests.push(url);
      }
    });
    await routeBasemap(page);

    await gotoApp(
      page,
      '?region=british_columbia&layers=cdm-drought&view=console'
    );
    await expect(layerPill(page, 'cdm-drought')).toHaveText('live');

    const legend = page.locator(
      '#legend-panel [data-legend="cdm-drought"]'
    );
    await expect(legend).toContainText(
      'Canadian Drought Monitor · June 2026'
    );
    await expect(legend).toContainText('D4 · no area in this class this month');
    await expect(legend).toContainText(
      'bare map means no polygon coverage in this artifact, not class zero'
    );
    await expect(page.locator('#time-bar')).toContainText('Month June 2026');
    await expect(page.locator('#map-key')).toBeHidden();
    const legendLicense = legend.getByRole('link', { name: LICENSE_TITLE });
    await expect(legendLicense).toHaveAttribute('href', LICENSE_URL);
    await page.locator('#map-info-btn').click();
    const attributionLicense = page
      .locator('#map-info-attribution')
      .getByRole('link', { name: LICENSE_TITLE });
    await expect(attributionLicense).toHaveAttribute('href', LICENSE_URL);
    await page.keyboard.press('Escape');
    expect(upstreamRequests).toEqual([]);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#time-bar')).toContainText('Month June 2026');
    await expect(legend).toContainText('Agriculture and Agri-Food Canada');
    await expect(legendLicense).toBeVisible();
    await expect(legendLicense).toHaveText(LICENSE_TITLE);
    await expect(legendLicense).toHaveAttribute('href', LICENSE_URL);
    await expect(page.locator('#map-key')).toBeHidden();
  });

  test('embed on-map key renders the exact licence title and link', async ({
    page
  }) => {
    await routeBasemap(page);
    await gotoApp(
      page,
      '?embed=true&region=british_columbia&layers=cdm-drought&view=console'
    );
    await expect(layerPill(page, 'cdm-drought')).toHaveText('live');

    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    const keyLicense = key.getByRole('link', { name: LICENSE_TITLE });
    await expect(keyLicense).toBeVisible();
    await expect(keyLicense).toHaveText(LICENSE_TITLE);
    await expect(keyLicense).toHaveAttribute('href', LICENSE_URL);
  });

  test('a polygon popup names the Canadian product, issuer, and month without blending', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeArtifact(page, artifactFixture([2]));
    await gotoApp(
      page,
      '?region=british_columbia&layers=cdm-drought&view=console'
    );
    await expect(layerPill(page, 'cdm-drought')).toHaveText('live');

    const map = page.locator('#map');
    const box = await map.boundingBox();
    if (!box) throw new Error('map has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup).toContainText('D2');
    await expect(popup).toContainText(
      'Canadian Drought Monitor · Agriculture and Agri-Food Canada'
    );
    await expect(popup).toContainText('Month: June 2026');
    await expect(popup).toContainText(
      'not blended with a United States or provincial product'
    );
    const popupLicense = popup.getByRole('link', { name: LICENSE_TITLE });
    await expect(popupLicense).toHaveText(LICENSE_TITLE);
    await expect(popupLicense).toHaveAttribute('href', LICENSE_URL);
    await expect(popup).not.toContainText('Province of British Columbia');
  });

  test('a published month with no occupied classes is live, not missing data', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeArtifact(page, artifactFixture([]));
    await gotoApp(
      page,
      '?region=british_columbia&layers=cdm-drought&view=console'
    );

    await expect(layerPill(page, 'cdm-drought')).toHaveText('live');
    const legend = page.locator(
      '#legend-panel [data-legend="cdm-drought"]'
    );
    for (const code of ['D0', 'D1', 'D2', 'D3', 'D4']) {
      await expect(legend).toContainText(
        `${code} · no area in this class this month`
      );
    }
    await expect(layerPill(page, 'cdm-drought')).not.toContainText('no data');
    await expect(page.locator('#time-bar')).toContainText('Month June 2026');
  });

  test('a missing monthly artifact is unavailable and cannot read as no drought', async ({
    page
  }) => {
    await routeBasemap(page);
    await routeArtifact(page, null, 404);
    await gotoApp(
      page,
      '?region=british_columbia&layers=cdm-drought&view=console'
    );

    await expect(layerPill(page, 'cdm-drought')).toHaveText('unavailable');
    await expect(layerCheckbox(page, 'cdm-drought')).not.toBeChecked();
    await expect(
      page.locator('#legend-panel [data-legend="cdm-drought"]')
    ).toHaveCount(0);
    await expect(page.locator('#map-key')).toBeHidden();
  });
});
