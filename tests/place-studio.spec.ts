import { test, expect, type Page } from '@playwright/test';

import { parseStudioParam } from '../src/state/url';
import { gotoApp, search } from './helpers';

const PLACE_ROOT = '#place-studio-root';

interface CapturedWbdRequest {
  readonly layer: string;
  readonly params: URLSearchParams;
}

async function stubWbd(
  page: Page,
  captured: CapturedWbdRequest[]
): Promise<void> {
  await page.route('**/wbd/MapServer/*/query?*', async (route) => {
    const url = new URL(route.request().url());
    const layer = url.pathname.split('/').at(-2) ?? '';
    captured.push({ layer, params: url.searchParams });
    const features =
      layer === '1'
        ? [
            {
              attributes: {
                huc2: '17',
                name: 'Pacific Northwest',
                areasqkm: 714000,
                states: 'ID,MT,OR,WA,WY'
              }
            }
          ]
        : [
            {
              attributes: {
                huc4: '1703',
                name: 'Yakima',
                areasqkm: 15928,
                states: 'WA'
              }
            }
          ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features })
    });
  });
}

async function stubEmptyWbdGeometry(page: Page): Promise<void> {
  await page.route('**/wbd/MapServer/*/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
}

test.describe('PS-CORE PLACE studio', () => {
  test('the route vocabulary is exclusive and the PLACE and LAYERS entries are paired', async ({
    page
  }) => {
    expect(parseStudioParam('layers')).toBe('layers');
    expect(parseStudioParam('place')).toBe('place');
    expect(parseStudioParam('PLACE')).toBeNull();
    expect(parseStudioParam(null)).toBeNull();

    await gotoApp(page, '?view=brief&layers=places');
    const pair = page.locator('#studio-entry-pair');
    await expect(pair.locator('#place-studio-entry')).toHaveText('PLACE');
    await expect(pair.locator('#layers-studio-entry')).toHaveText('LAYERS');
    // W2-D7: the accessible name stands alone; no title duplicates it.
    await expect(pair.locator('#place-studio-entry')).toHaveAttribute(
      'aria-label',
      'Open the PLACE studio: choose a place for the briefing'
    );
    expect(
      await pair.locator('#place-studio-entry').getAttribute('title')
    ).toBeNull();

    const beforeLength = await page.evaluate(() => window.history.length);
    await pair.locator('#place-studio-entry').click();
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await expect(page.locator('#place-studio-heading')).toHaveText('Place studio');
    expect(await page.evaluate(() => window.history.length)).toBe(beforeLength + 1);
    expect(new URLSearchParams(await search(page)).get('studio')).toBe('place');

    await expect(page.locator('#place-type-tribe')).toHaveText('Tribal Nations');
    await expect(page.locator('#place-type-state')).toHaveText('States');
    await expect(page.locator('#place-type-ecoregion')).toHaveText('Ecoregions');
    await expect(page.locator('#place-type-watershed')).toHaveText('Watersheds');
    await expect(page.locator('#place-coverage-matrix dt')).toHaveText([
      'Selectable',
      'Briefing available',
      'Overlap listing'
    ]);
    await expect(page.locator('#place-selection-empty')).toHaveText(
      'No place selected. Choose a place type, then a place; the full briefing opens when you return to the map.'
    );
  });

  test('the roster-first Tribal Nations list includes geometry-less Nations honestly', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(573);
    await page.locator('#place-studio-search').fill(
      'Absentee-Shawnee Tribe of Indians of Oklahoma'
    );
    await page.locator('#place-option-tribe-0').click();

    await expect(page.locator('#place-selection-title')).toHaveText(
      'Absentee-Shawnee Tribe of Indians of Oklahoma'
    );
    await expect(page.locator('#place-capability-selectable')).toContainText('available');
    await expect(page.locator('#place-capability-briefable')).toContainText('unavailable');
    await expect(page.locator('#place-capability-overlap-computable')).toContainText(
      'unavailable'
    );
    const params = new URLSearchParams(await search(page));
    expect(params.has('place')).toBe(false);
    expect(params.has('typed-place')).toBe(false);
    expect(params.get('studio')).toBe('place');
  });

  test('the bundled States list uses the shared filter and writes durable selection only', async ({
    page
  }) => {
    await stubEmptyWbdGeometry(page);
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('#place-studio-entry').click();
    await page.locator('#place-type-state').click();
    await expect(page.locator('#place-type-availability')).toHaveText('AVAILABLE');
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(51);

    await page.locator('#place-studio-search').fill('Puerto Rico');
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(0);

    await page.locator('#place-studio-search').fill('Oregon');
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(1);
    await page.locator('#place-option-state-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Oregon');
    await expect(page.locator('#place-capability-selectable')).toContainText('available');
    await expect(page.locator('#place-capability-briefable')).toContainText('available');
    await expect(page.locator('#place-capability-overlap-computable')).toContainText(
      'available'
    );

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await page.locator('#place-studio-entry').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Oregon');
    expect(new URLSearchParams(await search(page)).has('place')).toBe(false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#place-selection-empty')).toHaveText(
      'No place selected. Choose a place type, then a place; the full briefing opens when you return to the map.'
    );
  });

  test('Ecoregions state their exact Pacific Northwest Level III and IV scope', async ({
    page
  }) => {
    await stubEmptyWbdGeometry(page);
    let epaRequestCount = 0;
    await page.route('**/USEPA_Ecoregions_Level_III_and_IV/MapServer/*/query?*', async (route) => {
      epaRequestCount += 1;
      await route.abort();
    });
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-ecoregion').click();

    await expect(page.locator('#place-type-availability')).toHaveText(
      'AVAILABLE WITH SCOPED COVERAGE'
    );
    await expect(page.locator('#place-type-coverage')).toHaveText(
      'Pacific Northwest (Level III and IV)'
    );
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(169);
    expect(epaRequestCount).toBe(0);
    await page.locator('#place-studio-search').fill('Western Cascades');
    await page.locator('#place-option-ecoregion-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText(
      'Western Cascades Lowlands and Valleys'
    );
  });

  test('Watersheds list HUC2 and HUC4 attributes only and declare landed geometry capabilities', async ({
    page
  }) => {
    const captured: CapturedWbdRequest[] = [];
    await stubWbd(page, captured);
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-watershed').click();

    await expect(page.locator('#place-type-availability')).toHaveText(
      'AVAILABLE, CONDITIONS BINDING'
    );
    await expect(page.locator('#place-type-coverage')).toHaveText('HUC2 and HUC4');
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(2);

    expect(captured.map((request) => request.layer).sort()).toEqual(['1', '2']);
    for (const request of captured) {
      expect(request.params.get('returnGeometry')).toBe('false');
      expect(request.params.has('maxAllowableOffset')).toBe(false);
    }

    await page.locator('#place-studio-search').fill('Yakima');
    await page.locator('#place-option-watershed-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Yakima (HUC 1703)');
    await expect(page.locator('#place-capability-selectable')).toContainText('available');
    await expect(page.locator('#place-capability-briefable')).toContainText('available');
    await expect(page.locator('#place-capability-overlap-computable')).toContainText(
      'available'
    );
  });

  test('list loading, empty, and zero-match states use the approved language', async ({
    page
  }) => {
    let release!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/wbd/MapServer/*/query?*', async (route) => {
      await catalogGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ features: [] })
      });
    });
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-watershed').click();

    const listPanel = page.locator('#place-list-panel');
    await expect(listPanel).toHaveAttribute('aria-busy', 'true');
    await expect(listPanel.locator('#place-list-status')).toHaveText('Loading places...');

    release();
    await expect(listPanel).toHaveAttribute('aria-busy', 'false');
    await expect(listPanel.locator('#place-list-status')).toHaveText(
      'No places are listed for this type yet.'
    );

    await listPanel.locator('#place-studio-search').fill('Yakima');
    await expect(listPanel.locator('#place-list-status')).toHaveText(
      'No places match this search.'
    );
  });

  test('catalog failure is explicit, disables geometry claims, and retries', async ({
    page
  }) => {
    let failCatalog = true;
    await page.route('**/wbd/MapServer/*/query?*', (route) =>
      failCatalog
        ? route.abort()
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ features: [] })
          })
    );
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-watershed').click();

    const listPanel = page.locator('#place-list-panel');
    await expect(listPanel.locator('#place-list-status')).toHaveText(
      'This list is not available right now.'
    );
    await expect(page.locator('#place-type-availability')).toHaveText('unavailable');
    await expect(page.locator('#place-capability-briefable')).toContainText('unavailable');
    await expect(page.locator('#place-capability-overlap-computable')).toContainText(
      'unavailable'
    );

    failCatalog = false;
    await listPanel.getByRole('button', { name: 'Try again' }).click();
    await expect(listPanel.locator('#place-list-status')).toHaveText(
      'No places are listed for this type yet.'
    );
    await expect(page.locator('#place-type-availability')).toHaveText(
      'AVAILABLE, CONDITIONS BINDING'
    );
  });

  test('embed mode exposes both full-site link-outs and mounts no studio in-frame', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&view=brief&layers=places&studio=place');
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page.locator('#layers-studio-root')).toHaveCount(0);

    const placeLink = page.locator('#studio-linkout-pair #place-studio-entry');
    const layersLink = page.locator('#studio-linkout-pair #layers-studio-entry');
    await expect(placeLink).toHaveText('Open place selection on the full site');
    await expect(layersLink).toHaveText('Open layer controls on the full site');
    await expect(placeLink).toHaveAttribute('target', '_blank');
    await expect(layersLink).toHaveAttribute('target', '_blank');

    const placeHref = new URL((await placeLink.getAttribute('href')) ?? '');
    const layersHref = new URL((await layersLink.getAttribute('href')) ?? '');
    expect(placeHref.searchParams.get('studio')).toBe('place');
    expect(layersHref.searchParams.get('studio')).toBe('layers');
    expect(placeHref.searchParams.has('embed')).toBe(false);
    expect(layersHref.searchParams.has('embed')).toBe(false);
  });
});

test.describe('PS-CORE mobile sheet entry', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the PLACE entry opens the full-screen studio and Back returns to the sheet', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-search [data-ddm-search]')).toBeVisible();

    // The sheet entry is the ONLY mobile door to the full PLACE studio:
    // the footer place tab opens the at-hand search, not the studio, so
    // this button must stay visible and functional (D-0.7.0-054).
    const entry = page.locator('#sheet-place-studio-entry');
    await entry.scrollIntoViewIfNeeded();
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await page.locator('#place-studio-back').click();

    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-search [data-ddm-search]')).toBeVisible();
  });
});
