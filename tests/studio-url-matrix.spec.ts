import { expect, test, type Page } from '@playwright/test';

import { FRAMINGS, type FramingKey } from '../src/config/framings';
import { parseShellParams, parseStudioParam } from '../src/state/url';
import { gotoApp, waitForLayerSettled } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';
import { AIANNH_ROUTE, BIA_ROUTE, emptyCollectionBody, routeGeojson } from './tribal-fixtures';

const FRAMING = Object.keys(FRAMINGS)[0] as FramingKey;
const TERMINAL_CLASSES = ['ready', 'degraded', 'error', 'no-data', 'zoom-in'] as const;

interface MatrixCase {
  readonly name: string;
  readonly studio: 'layers' | 'place';
  readonly query: string;
  readonly settleKey: string;
  readonly expected: Readonly<Record<string, string | null>>;
}

const MATRIX: readonly MatrixCase[] = [
  {
    name: 'PLACE composes with Console view',
    studio: 'place',
    query: '?layers=places&view=console&studio=place',
    settleKey: 'places',
    expected: { studio: 'place', view: 'console' }
  },
  {
    name: 'LAYERS composes with framing',
    studio: 'layers',
    query: `?framing=${encodeURIComponent(FRAMING)}&layers=places&view=brief&studio=layers`,
    settleKey: 'places',
    expected: { studio: 'layers', view: 'brief', framing: FRAMING }
  },
  {
    name: 'LAYERS composes with a surviving Wildfire cluster',
    studio: 'layers',
    query: '?cluster=wildfire&view=brief&studio=layers',
    settleKey: 'nifc-fires',
    expected: { studio: 'layers', cluster: 'wildfire', layers: null }
  },
  {
    name: 'LAYERS composes with ENSO and ocean',
    studio: 'layers',
    query: '?cluster=enso&ocean=pacific&view=brief&studio=layers',
    settleKey: 'sst-anomaly',
    expected: { studio: 'layers', cluster: 'enso', ocean: 'pacific', layers: null }
  },
  {
    name: 'granular layers outrank a cluster without suppressing LAYERS',
    studio: 'layers',
    query: '?layers=places&cluster=wildfire&view=brief&studio=layers',
    settleKey: 'places',
    expected: { studio: 'layers', layers: 'places', cluster: null }
  },
  {
    name: 'LAYERS composes with temporal and basemap tokens',
    studio: 'layers',
    query:
      '?layers=places&view=brief&week=20240702&dmode=chg1&sst=2024-07-01' +
      '&outlook=monthly&basemap=satellite&studio=layers',
    settleKey: 'places',
    expected: {
      studio: 'layers',
      week: '20240702',
      dmode: 'chg1',
      sst: '2024-07-01',
      outlook: 'monthly',
      basemap: 'satellite'
    }
  }
];

async function stubMatrixDependencies(page: Page): Promise<void> {
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 44 }] })
    })
  );
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  for (const pattern of [
    '**/WFIGS_Interagency_Perimeters_Current/**',
    '**/NOAA_Satellite_Smoke_Detection*/**',
    '**/SPC*Fire*Weather*/**'
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(emptyCollectionBody())
      })
    );
  }
  await stubRecentSatellite(page);
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

async function waitForScopedLayerSettled(
  page: Page,
  studio: MatrixCase['studio'],
  key: string
): Promise<void> {
  if (studio === 'place') {
    await waitForLayerSettled(page, key);
    return;
  }
  const pill = page.locator(`#layers-studio-root [data-layer-status="${key}"]`);
  await expect.poll(async () => {
    const classes = ((await pill.getAttribute('class')) ?? '').split(/\s+/);
    return TERMINAL_CLASSES.some((terminal) => classes.includes(terminal));
  }).toBe(true);
}

function expectParams(url: URL, expected: Readonly<Record<string, string | null>>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value === null) expect(url.searchParams.has(key), `${key} should be absent`).toBe(false);
    else expect(url.searchParams.get(key), `${key} should survive`).toBe(value);
  }
}

test.describe('studio URL precedence matrix', () => {
  test('pure parsing keeps studio additive and shell precedence unchanged', () => {
    expect(parseStudioParam('layers')).toBe('layers');
    expect(parseStudioParam('place')).toBe('place');
    expect(parseStudioParam('invalid')).toBeNull();

    const granular = parseShellParams(
      new URLSearchParams(`framing=${encodeURIComponent(FRAMING)}&layers=places&cluster=enso&ocean=pacific`)
    );
    expect(granular.framing).toBe(FRAMING);
    expect(granular.cluster).toBe('drought');
    expect(granular.ocean).toBeNull();

    const enso = parseShellParams(new URLSearchParams('cluster=enso&ocean=pacific'));
    expect(enso.cluster).toBe('enso');
    expect(enso.ocean).toBe('pacific');
  });

  for (const scenario of MATRIX) {
    test(`${scenario.name}: canonical write, reload, and Back`, async ({ page }) => {
      await stubMatrixDependencies(page);
      await gotoApp(page, scenario.query);
      const root = page.locator(`#${scenario.studio}-studio-root`);
      await expect(root).toBeVisible();
      await waitForScopedLayerSettled(page, scenario.studio, scenario.settleKey);

      const canonicalStudioUrl = new URL(page.url());
      expectParams(canonicalStudioUrl, scenario.expected);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(root).toBeVisible();
      await waitForScopedLayerSettled(page, scenario.studio, scenario.settleKey);
      expect(page.url()).toBe(canonicalStudioUrl.href);

      const mapUrl = new URL(canonicalStudioUrl);
      mapUrl.searchParams.delete('studio');
      await root.getByRole('button', { name: 'Back to map' }).click();
      await expect(root).toHaveCount(0);
      await expect.poll(() => page.url()).toBe(mapUrl.href);
    });
  }

  for (const malformed of [
    {
      name: 'duplicate studio parameters',
      query: '?layers=places&view=brief&studio=layers&studio=place'
    },
    {
      name: 'an invalid studio parameter',
      query: '?layers=places&view=brief&studio=invalid'
    }
  ] as const) {
    test(`${malformed.name} canonicalizes to the map route`, async ({ page }) => {
      await stubMatrixDependencies(page);
      await gotoApp(page, malformed.query);
      await waitForLayerSettled(page, 'places');
      await expect(page.locator('#layers-studio-root')).toHaveCount(0);
      await expect(page.locator('#place-studio-root')).toHaveCount(0);
      const canonical = new URL(page.url());
      expect(canonical.searchParams.has('studio')).toBe(false);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForLayerSettled(page, 'places');
      expect(page.url()).toBe(canonical.href);
    });
  }

  test('embed plus studio preserves the link-out token without mounting', async ({ page }) => {
    await stubMatrixDependencies(page);
    await gotoApp(page, '?embed=true&layers=places&view=brief&studio=place');
    await expect(page.locator('#place-studio-root')).toHaveCount(0);
    await expect(page.locator('#layers-studio-root')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('studio')).toBe('place');

    const link = page
      .locator('#studio-linkout-pair')
      .getByRole('link', { name: 'Open place selection on the full site' });
    const href = new URL((await link.getAttribute('href')) ?? '');
    expect(href.searchParams.get('studio')).toBe('place');
    expect(href.searchParams.has('embed')).toBe(false);

    const canonical = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#place-studio-root')).toHaveCount(0);
    expect(page.url()).toBe(canonical);
  });
});
