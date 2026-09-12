import { test, expect, type Page, type Response } from '@playwright/test';

import { placeRefFromBoundary } from '../src/config/entities';
import { parseStudioParam } from '../src/state/url';
import { gotoApp, search, waitForLayerSettled } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeBoundary,
  routeGeojson
} from './tribal-fixtures';

/**
 * Capture the WA feature's own properties from the bundled
 * `us-states.geojson` response a door's own fetch retrieves (never a
 * separate fetch of this test's own making), so the computed reference
 * reflects exactly what that door read.
 */
async function captureWaProperties(
  page: Page,
  action: () => Promise<void>
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  const listener = async (response: Response): Promise<void> => {
    if (!response.url().includes('/data/us-states.geojson')) return;
    try {
      const body = (await response.json()) as {
        features?: Array<{ properties?: Record<string, unknown> }>;
      };
      const match = body.features?.find((f) => f.properties?.['STUSPS'] === 'WA');
      if (match?.properties) captured = match.properties;
    } catch {
      // A held or aborted response has no body; not this capture's concern.
    }
  };
  page.on('response', listener);
  try {
    await action();
  } finally {
    page.off('response', listener);
  }
  return captured;
}

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

test.describe('DDM-P2-T09: one canonical place reference', () => {
  test('selecting Washington in the studio resolves the state:WA reference, and the full briefing opens on return to the map', async ({
    page
  }) => {
    const waProperties = await captureWaProperties(page, async () => {
      await gotoApp(page, '?view=brief&layers=places&studio=place');
      await page.locator('#place-type-state').click();
      await page.locator('#place-studio-search').fill('Washington');
      await page.locator('#place-option-state-0').click();
      await expect(page.locator('#place-selection-title')).toHaveText('Washington');
      await page.locator('#place-studio-back').click();
      await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
      await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    });

    expect(waProperties).not.toBeNull();
    expect(placeRefFromBoundary('state', waProperties)).toEqual({ scheme: 'state', code: 'WA' });
  });

  /**
   * Same feature ids (acceptance clause): a map click on Washington resolves
   * the identical `state:WA` reference the studio door above resolves, read
   * from the SAME bundled us-states.geojson feature's own STUSPS (the
   * property every door reads, src/config/entities.ts placeRefFromBoundary).
   * The click door does not refetch that file at click time (the `states`
   * layer already holds it from its own activation), so this case captures
   * THAT activation fetch instead of a selection-time fetch.
   *
   * This case proves the REFERENCE is the same. The feature-id half of the
   * clause (the studio door and the click door emphasize the SAME MapLibre
   * feature id through `feature-state`) is proven by the next case, through
   * the production-observable `data-ddm-emphasis` stamp place-emphasis.ts
   * writes, because the dev-only `window.__ddmMap` handle is
   * dead-code-eliminated from the production build this spec's `webServer`
   * serves (src/main.ts:267-277; tests/u3i.spec.ts:35-40 documents the gap).
   */
  test('a map click on Washington resolves the same state:WA reference as the studio door', async ({
    page
  }) => {
    const waProperties = await captureWaProperties(page, async () => {
      await gotoApp(page, '?layers=states');
      await waitForLayerSettled(page, 'states');

      const box = await page.locator('#map').boundingBox();
      if (!box) throw new Error('map container has no box');
      const trigger = page.locator('[data-ddm-impact-trigger]');
      // DEFAULT_REGION is washington_state (src/config/regions.ts), so the
      // default camera frames Washington under the viewport center.
      await expect(async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(trigger).toBeVisible({ timeout: 1500 });
      }).toPass({ timeout: 20_000 });
      await trigger.click();
      await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    });

    expect(waProperties).not.toBeNull();
    expect(placeRefFromBoundary('state', waProperties)).toEqual({ scheme: 'state', code: 'WA' });
  });

  /**
   * Same feature ids, the literal clause: the studio door (which resolves a
   * state by array index into us-states.geojson, src/state/display-snapshot.ts)
   * and the click door (which passes the rendered feature's own generated
   * id, src/layers/states.ts) must light the SAME us-states feature id. Read
   * from the `data-ddm-emphasis` truth stamp on the document root, written
   * by place-emphasis.ts from what the map was told, in ONE page so the
   * generated ids are comparable. The studio stamp is read before the studio
   * closes, because closing the briefing clears the popup-scoped selection
   * and with it the emphasis.
   */
  test('the studio door and the click door emphasize the same us-states feature id', async ({
    page
  }) => {
    const stamp = (): Promise<string> =>
      page.evaluate(() => document.documentElement.dataset['ddmEmphasis'] ?? '');

    // `states` is in the boot set on purpose: the studio's display snapshot
    // turns the reference layer on for its own emphasis and its restore on
    // close turns it back off, so the click door below needs the layer to be
    // the user's own, not the studio's.
    await gotoApp(page, '?view=brief&layers=places,states&studio=place');
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Washington');
    await page.locator('#place-option-state-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Washington');
    await expect.poll(stamp, { timeout: 15_000 }).toMatch(/^us-states:\d+$/);
    const studioStamp = await stamp();

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    await page.locator('#impact-panel .impact-panel-close').click();
    await expect(page.locator('#impact-panel')).toBeHidden();

    await waitForLayerSettled(page, 'states');
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map container has no box');
    const trigger = page.locator('[data-ddm-impact-trigger]');
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(trigger).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    await expect.poll(stamp, { timeout: 15_000 }).toMatch(/^us-states:\d+$/);
    const clickStamp = await stamp();

    expect(clickStamp).toBe(studioStamp);
  });
});

test.describe('C3 housekeeping: newest intent wins the emphasis', () => {
  // The same synthetic Nation the DDM-P2-T10 one-request fixture in
  // tribal-live-layers.spec.ts uses (its NATION_NAME / LAR_NAME_ONE), so this
  // case is recognizably the same fixture shape, not a new one. No real
  // Nation's name ever touches a fabricated rectangle (the NO-REDISTRIBUTION
  // guard tribal-fixtures.ts documents).
  const NATION_NAME = 'Synthetic One-Request Fixture Nation';
  const LAR_NAME = 'Synthetic One-Request Fixture Area One';
  const LAR_ID = 88001;

  function stamp(page: Page): Promise<string> {
    return page.evaluate(() => document.documentElement.dataset['ddmEmphasis'] ?? '');
  }

  /**
   * Stubs the roster/crosswalk so the studio's tribe catalog resolves the
   * one synthetic Nation above, plus the AIAN-LAR (BIA_ROUTE) response for
   * it. The BIA_ROUTE handler holds any LARNAME-scoped query open on
   * `gate` while `armed` is true, so a spec can select the Nation, then flip
   * a newer selection in before releasing the held response, isolating
   * exactly the race the newest-intent check guards.
   */
  async function stubHeldTribeFixture(
    page: Page,
    gate: Promise<void>,
    armed: () => boolean
  ): Promise<void> {
    await page.route('**/data/tribal-roster.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          areas: [
            { larName: LAR_NAME, displayName: NATION_NAME, provenance: 'bia-authoritative' }
          ]
        })
      })
    );
    await page.route('**/data/tribal-larname-crosswalk.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          meta: {
            rosterSource: 'Synthetic fixture roster',
            landAreaSource: 'Synthetic fixture land areas'
          },
          matched: [{ tribe: NATION_NAME, larName: LAR_NAME }],
          rosterNoLar: []
        })
      })
    );
    await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
    await routeBoundary(page, BIA_ROUTE, async (route) => {
      const where = new URL(route.request().url()).searchParams.get('where') ?? '';
      if (where.includes('LARNAME') && armed()) await gate;
      try {
        await route.fulfill({
          contentType: 'application/geo+json',
          body: JSON.stringify({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: LAR_ID,
                properties: {
                  LARID: LAR_ID,
                  LARNAME: LAR_NAME,
                  CLASSIFICATION: 'Fixture Classification',
                  GISACRES: 500,
                  REGION: 'Fixture Region'
                },
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [-123.4, 46.1],
                      [-123.0, 46.1],
                      [-123.0, 46.4],
                      [-123.4, 46.4],
                      [-123.4, 46.1]
                    ]
                  ]
                }
              }
            ]
          })
        });
      } catch {
        // By the time the held gate above releases, the Washington
        // selection's own effect cleanup has ordinarily already aborted this
        // request client-side (masterAbort.abort() cancels the
        // AbortController fetchJson was given); fulfilling a request the
        // page itself already cancelled throws, and that throw is not this
        // fixture's concern.
      }
    });
  }

  /**
   * S30R errata I6: the geometry-resolution effect's emphasis continuation
   * checked only the abort flag, not whether the durable typed place still
   * matched what it was about to emphasize. A Tribal Nation selection whose
   * AIAN-LAR response is still in flight when the user selects a DIFFERENT
   * place must not have that late response's emphasis land over the newer
   * selection's own. Proven on the production-observable `data-ddm-emphasis`
   * stamp (place-emphasis.ts), the same idiom the DDM-P2-T09 cases above use.
   */
  test('a Nation selection whose AIAN-LAR response lands after a newer State selection never overwrites that State\'s emphasis', async ({
    page
  }) => {
    let releaseBia!: () => void;
    const biaGate = new Promise<void>((resolve) => {
      releaseBia = resolve;
    });
    let biaGateArmed = false;
    await stubHeldTribeFixture(page, biaGate, () => biaGateArmed);

    await gotoApp(page, '?view=brief&layers=places,states&studio=place');
    await page.locator('#place-type-tribe').click();
    await page.locator('#place-studio-search').fill(NATION_NAME);
    await expect(page.locator('#place-list .place-studio-option')).toHaveCount(1);

    biaGateArmed = true;
    await page.locator('#place-option-tribe-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText(NATION_NAME);

    // The Nation's own AIAN-LAR resolution is now held open. Select
    // Washington under States before releasing it: the newest intent is now
    // Washington, not the Nation.
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Washington');
    await page.locator('#place-option-state-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Washington');
    await expect.poll(() => stamp(page), { timeout: 15_000 }).toMatch(/^us-states:\d+$/);
    const washingtonStamp = await stamp(page);

    // Releasing does not guarantee the held request still has anywhere to
    // land: the Washington selection's own effect cleanup ordinarily aborts
    // the Nation's in-flight fetch (masterAbort.abort() cancels the
    // AbortController fetchJson was given), so `page.waitForResponse` on
    // this request would hang, not fail honestly. Release and give whatever
    // continuation CAN still run (the `.then`, if the abort truly lost the
    // race; the `.catch`, if it won) a bounded beat to settle instead. The
    // beat is a fixed wait on purpose: a poll that already matches returns
    // at once and would prove nothing about a response released after it.
    // What this proves is bounded (nothing landed within the beat), not
    // that nothing could ever land later; the director's break-the-fix
    // record in the run log carries the reachability finding.
    releaseBia();
    await page.waitForTimeout(1_000);
    expect(await stamp(page)).toBe(washingtonStamp);
    expect(await stamp(page)).not.toContain('bia-reservations');
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
