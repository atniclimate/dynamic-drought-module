import { expect, test, type Page } from '@playwright/test';

import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } from '../src/config/clusters';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  PILL,
  search,
  stubHeatRiskCatalog,
  urlLayers,
  waitForLayerSettled
} from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

const PLACE_ROOT = '#place-studio-root';
const NIFC_ROUTE = '**/WFIGS_Interagency_Perimeters_Current/**';
const HMS_ROUTE = '**/NOAA_Satellite_Smoke_Detection*/**';

const OREGON_COLLECTION = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { STUSPS: 'OR', STATEFP: '41', NAME: 'Oregon' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-124, 42],
          [-117, 42],
          [-117, 46],
          [-124, 46],
          [-124, 42]
        ]]
      }
    }
  ]
};

interface RestoreGate {
  readonly restoreStarted: Promise<void>;
  readonly releaseRestore: () => void;
  readonly smokeRequests: () => number;
}

async function stubRestoreDependencies(page: Page): Promise<RestoreGate> {
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(OREGON_COLLECTION)
    })
  );
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 44 }] })
    })
  );

  let markRestoreStarted!: () => void;
  const restoreStarted = new Promise<void>((resolve) => {
    markRestoreStarted = resolve;
  });
  let releaseRestore!: () => void;
  const restoreRelease = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  let wildfireRequests = 0;
  await page.route(NIFC_ROUTE, async (route) => {
    wildfireRequests += 1;
    if (wildfireRequests > 1) {
      markRestoreStarted();
      await restoreRelease;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(emptyCollectionBody())
    });
  });

  let smokeRequestCount = 0;
  await page.route(HMS_ROUTE, async (route) => {
    smokeRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(emptyCollectionBody())
    });
  });

  return {
    restoreStarted,
    releaseRestore,
    smokeRequests: () => smokeRequestCount
  };
}

async function currentRepresentation(page: Page): Promise<string> {
  return page.evaluate(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
}

async function assertExactRestoredIntent(page: Page, priorUrl: string): Promise<void> {
  await waitForLayerSettled(page, 'states');
  await waitForLayerSettled(page, 'nifc-fires');
  await expect(page.locator('#layer-toggles .layer-toggle-status.loading')).toHaveCount(0);

  expect(await currentRepresentation(page)).toBe(priorUrl);
  await expect(page.locator('#layer-toggle-states')).toBeChecked();
  await expect(page.locator('#layer-toggle-nifc-fires')).toBeChecked();
  await expect(page.locator('#layer-toggle-hms-smoke')).not.toBeChecked();
  const checkedKeys = await page
    .locator('#layer-toggles input[data-layer-key]:checked')
    .evaluateAll((inputs) =>
      inputs
        .map((input) => input.getAttribute('data-layer-key'))
        .filter((key): key is string => key !== null)
        .sort()
    );
  expect(checkedKeys).toEqual(['nifc-fires', 'states']);
}

for (const selected of [false, true] as const) {
  for (const exit of ['button', 'browser'] as const) {
    test(`${selected ? 'selected' : 'unselected'} snapshot restores through ${exit} Back`, async ({
      page
    }) => {
      const gate = await stubRestoreDependencies(page);
      await gotoApp(page, '?layers=nifc-fires,states&view=brief');
      await waitForLayerSettled(page, 'states');
      await waitForLayerSettled(page, 'nifc-fires');
      await expect(page.locator('#layer-toggle-hms-smoke')).not.toBeChecked();
      const priorUrl = await currentRepresentation(page);

      await page.locator('#studio-entry-pair #place-studio-entry').click();
      const studio = page.locator(PLACE_ROOT);
      await expect(studio).toBeVisible();

      if (selected) {
        await studio.getByRole('button', { name: 'States', exact: true }).click();
        await studio.locator('#place-studio-search').fill('Oregon');
        await studio.locator('[data-place-kind="state"][data-place-id="OR"]').click();
        await expect(studio.locator('#place-selection-title')).toHaveText('Oregon');
      }

      if (exit === 'button') {
        await studio.getByRole('button', { name: 'Back to map' }).click();
      } else {
        await page.goBack();
      }

      // The unselected browser-Back popstate finds the prior layer set
      // still live (the studio never tore it down), so the exact
      // representation is already in place and NO refetch occurs. The
      // deferred-release gate therefore applies only to the three
      // refetching paths (conductor adjudication at the F7 gate).
      const expectsRefetch = selected || exit === 'button';
      if (expectsRefetch) {
        await gate.restoreStarted;
        await expect(studio).toHaveCount(0);
        await expect(page.locator('#layer-toggles [data-layer-status="nifc-fires"]'))
          .toHaveClass(/\bloading\b/);
        // The panel element persists in the DOM once created (close removes
        // the `open` class, not the node). On the SELECTED path the briefing
        // was open before the studio was entered and legitimately stays open
        // beneath it, so the no-briefing-mid-restore assertion applies only
        // to the unselected path (conductor adjudication at the F7 gate).
        if (!selected) {
          await expect(page.locator('#impact-panel.open')).toHaveCount(0);
        }
      } else {
        await expect(studio).toHaveCount(0);
      }

      gate.releaseRestore();
      await assertExactRestoredIntent(page, priorUrl);
      expect(gate.smokeRequests()).toBe(0);

      if (selected) {
        // Layer-settled (assertExactRestoredIntent, above) is the map's own
        // signal, not the briefing's: the studio's registered return action
        // chases resolvePlaceSelection and calls openImpactPanel on its own
        // clock (src/ui/island/place-studio.tsx), so it can still be
        // pending once the layers settle. Poll for the panel's own
        // appearance with the same generous budget already used for other
        // deferred-briefing restores (tests/s2-url-migration.spec.ts:427,
        // tests/umbrella.spec.ts:375/500) instead of a one-shot check
        // (measured report, 2026-08-29: 11 events here, 8 retry-green and
        // 3 that failed all three attempts, always "element(s) not found",
        // never a hidden panel). The wider in-attempt budget addresses the
        // eight retry-green events; the three that failed every attempt
        // may be a product restore-ordering bug rather than a test race,
        // which the flake report left open and this change does not
        // settle.
        const panel = page.locator('#impact-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
      } else {
        await expect(page.locator('#impact-panel.open')).toHaveCount(0);
      }
    });
  }
}

test('an immediate browser Back still delivers the promised briefing (wave A finding 2)', async ({
  page
}) => {
  // The studio's own selection resolution is held open across the Back so
  // the hand-off must chase the pending resolution (or re-resolve
  // independently after the unmount abort) rather than assuming it
  // settled. State geometry is now a shared page-lifetime read, so this
  // exercises the same contract through a watershed's per-selection WBD
  // request, which can still be held independently of its catalog request.
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await page.route(NIFC_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(emptyCollectionBody())
    })
  );
  await page.route(HMS_ROUTE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(emptyCollectionBody())
    })
  );
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(OREGON_COLLECTION)
    })
  );

  let gateEngaged = false;
  let selectionGeometryRequests = 0;
  let releaseGeometry!: () => void;
  const geometryGate = new Promise<void>((resolve) => {
    releaseGeometry = resolve;
  });
  await page.route('**/wbd/MapServer/*/query?*', async (route) => {
    const url = new URL(route.request().url());
    const layer = url.pathname.split('/').at(-2) ?? '';
    const params = url.searchParams;

    if (params.get('returnGeometry') === 'false') {
      const features =
        layer === '1'
          ? [{ attributes: { huc2: '17', name: 'Pacific Northwest' } }]
          : [{ attributes: { huc4: '1703', name: 'Yakima' } }];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ features })
      });
      return;
    }

    if (params.get('where') === "huc4='1703'") {
      selectionGeometryRequests += 1;
      gateEngaged = true;
      await geometryGate;
    }

    const features =
      params.get('where') === "huc4='1703'"
        ? [{
            type: 'Feature',
            properties: { huc4: '1703', name: 'Yakima' },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-121, 46],
                [-120, 46],
                [-120, 47],
                [-121, 47],
                [-121, 46]
              ]]
            }
          }]
        : [];
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features })
      });
    } catch {
      // Browser Back aborts the studio-owned request while it is held. The
      // return action issues the independent replacement under test.
    }
  });

  await gotoApp(page, '?layers=states&view=brief');
  await waitForLayerSettled(page, 'states');
  const priorUrl = await currentRepresentation(page);

  await page.locator('#studio-entry-pair #place-studio-entry').click();
  const studio = page.locator(PLACE_ROOT);
  await expect(studio).toBeVisible();
  await studio.locator('#place-type-watershed').click();
  await expect(studio.locator('#place-list .place-studio-option')).toHaveCount(2);
  await studio.locator('#place-studio-search').fill('Yakima');
  await studio.locator('#place-list-panel .place-studio-option').click();
  await expect(studio.locator('#place-selection-title')).toHaveText('Yakima (HUC 1703)');
  await expect.poll(() => gateEngaged).toBe(true);

  // Browser Back IMMEDIATELY, with the geometry resolution still pending.
  await page.goBack();
  await expect(studio).toHaveCount(0);
  expect(await currentRepresentation(page)).toBe(priorUrl);

  releaseGeometry();
  // Same race as the parameterized restore above (:180): the return
  // action's promise chase is the only gate on the briefing's creation, so
  // give its appearance the same generous, retrying budget rather than one
  // shot at the default expect timeout. The measured report's own count
  // for this test is 1 flaky event (a 60s click timeout, not this exact
  // read); the fuller 11-event record above (8 retry-green, 3 that failed
  // every attempt and may be a product restore-ordering bug the flake
  // report left open) belongs to studio-restore:124, not this test.
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('.impact-panel-title')).toHaveText('Yakima (HUC 1703)');
  await expect(panel.locator('.impact-panel-kind')).toHaveText(
    'Watershed (USGS Watershed Boundary Dataset)'
  );
  expect(selectionGeometryRequests).toBeGreaterThanOrEqual(2);
});

/**
 * A sidebar display command taken from inside the Place studio survives
 * (Codex adversarial review 2026-09-10, finding 6).
 *
 * The sidebar became reachable from inside a studio on 2026-09-10, a real
 * accessibility fix: a keyboard or screen-reader user can now reach these
 * controls while a studio is open. But focusable is not the same as
 * operative. Place studio captures the display on entry, reasserts that
 * capture on every intent change (`enforceCleanIntent`), and restores it
 * again on exit, so a cluster requested from the newly-live sidebar was
 * stripped within a microtask and then overwritten a second time on the way
 * out. The control looked like it worked and did not.
 *
 * The fix sequences the command behind the studio's own exit rather than
 * suppressing it, so the assertion is on the OUTCOME a user would expect:
 * click Wildfire, end up on Wildfire, with the studio closed.
 */
test.describe('the exposed sidebar commands survive the Place studio', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('choosing a hazard from inside Place studio leaves the studio and lands on that hazard', async ({
    page
  }) => {
    await gotoApp(page, '?layers=states&view=brief');
    await waitForLayerSettled(page, 'states');

    const wildfire = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
    await expect(wildfire).toHaveAttribute('aria-pressed', 'false');

    await page.locator('#studio-entry-pair #place-studio-entry').click();
    const studio = page.locator(PLACE_ROOT);
    await expect(studio).toBeVisible();

    // The control is genuinely reachable, which is the 2026-09-10 a11y win
    // this test must not undo: the fix is allowed to change what the click
    // DOES, never to put the control back behind an inert scope.
    await expect(wildfire).toBeVisible();
    await expect(wildfire).toBeEnabled();

    await wildfire.click();

    // The studio yields, rather than silently reverting the choice.
    await expect(studio).toHaveCount(0);
    // And the choice is the one that stands, after the exit restore rather
    // than in a race with it.
    await expect(wildfire).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(page).toHaveURL(/cluster=wildfire/);
    // The studio really is gone from the URL too, not merely unmounted.
    await expect(page).not.toHaveURL(/studio=place/);
  });

  test('the same command outside any studio is unchanged', async ({ page }) => {
    // The control: the deferral must apply ONLY inside Place studio, or the
    // fix would have made every hazard click depend on a history pop.
    await gotoApp(page, '?layers=states&view=brief');
    await waitForLayerSettled(page, 'states');
    const wildfire = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
    await wildfire.click();
    await expect(wildfire).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    await expect(page).toHaveURL(/cluster=wildfire/);
  });
});

/**
 * found-076 (register; CODEMAP:1749, "1d buttons has two inferred defects";
 * D1 M16). The clean-display failure ledger (`failedKeys`,
 * src/state/display-snapshot.ts `enforceCleanIntent`) only ever recorded a
 * failure when the controller UNCHECKED the layer. found-073 (commit
 * 4aabfec) now keeps a failed COMMITTED COMPOSITION member checked, recipe
 * or reference, so the ledger's `!isChecked` guard can never see one, and
 * the register asks whether the omission is harmful or harmless. Read
 * (traced for the report): harmless by construction for both kinds it
 * names.
 *
 *   - A recipe layer (surface/event role, e.g. nadm-drought) is excluded
 *     from the studio's own "wanted" set by ROLE alone
 *     (`cleanIntent`'s SET_ASIDE_ROLES filter), checked, unchecked,
 *     working or failed: the ledger loop never evaluates it. Its
 *     set-aside uncheck on studio entry and its syncIntent recheck on
 *     restore run through the ordinary controller path (M5/found-073),
 *     never this ledger, and a still-failing layer simply fails again on
 *     that recheck, exactly like any other activation-failure case.
 *   - A composition reference layer (e.g. states, which the register
 *     names and which overlaps `REFERENCE_KEYS.state`) DOES enter
 *     "wanted", but stays checked throughout (found-073), so
 *     `syncIntent`'s own `if (!isChecked(key)) requestLayerOnExact(key)`
 *     guard alone already prevents any re-request while it stays
 *     checked: the ledger's miss changes nothing observable. Proof note
 *     (M16 repair round, 2026-09-28): flipping the ledger's own guard
 *     (`enforceCleanIntent`'s `if (!isChecked(key) && ...)`) does NOT red
 *     this case, because `states` never gets unchecked either way, so the
 *     guard's body never runs for it; that mutation is base code the
 *     ledger's own omission is being read against, not a fix under test.
 *     The case is proved instead by making the round trip actually drop
 *     `states` from the checked set, independent of the ledger: after
 *     `const wanted = new Set(cleanIntent(activeSnapshot, activeKind));`
 *     in `enforceCleanIntent`, adding `wanted.delete('states');` forces a
 *     real uncheck on studio entry (the same `syncIntent` path a set-aside
 *     recipe layer already takes) and reds this case's own
 *     "stays checked" assertion right after the place type is selected,
 *     not found-011's cluster-pressed assertion.
 *
 * Both cases below are coverage tests (their red-first proof is
 * break-to-prove, the `tests/studio-options.spec.ts` M18 precedent). The
 * reference case is green as written. The recipe case's original assertion
 * (a second network request on restore) was FALSE, proved red on the fixed
 * tree with no break applied (the M16 repair round's director gate, CMD9,
 * 2026-09-28): `loadLayerModule` (src/config/layers.ts:422) does call
 * `def.load()` again once `moduleInFlight` clears after the first failure
 * (src/config/layers.ts:433-434), but that second `import()` names the
 * exact same built chunk URL as the first, and Chromium caches a failed
 * dynamic import per URL, rejecting the repeat with no new network request
 * (the measured fact `src/util/chunk-retry.ts:4-9` records and that
 * `createChunkLoader` exists to work around, but only for three UI chunks:
 * search, the Place studio route entry, and island/layers-studio;
 * `loadLayerModule`'s per-layer `def.load()` is a bare `import()`, not
 * wrapped in it). REGISTER found-087 then routed every layer chunk through
 * createChunkLoader, so the recipe case below asserts the second request
 * (under `?retry=1`) and an honest unavailable read when it fails again.
 */
test.describe('found-076: a failed checked composition member through the Place studio', () => {
  test('a composition reference layer already failed and checked before the studio opens is never re-requested through the round trip', async ({
    page
  }) => {
    let statesRequests = 0;
    await page.route(/\/states-[A-Za-z0-9_-]{8}\.js$/, (route) => {
      statesRequests += 1;
      void route.abort();
    });
    await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
    await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());

    await gotoApp(page, '?view=brief');
    await waitForLayerSettled(page, 'states');
    expect(statesRequests).toBe(1);
    await expect(layerCheckbox(page, 'states')).toBeChecked();
    await expect(layerPill(page, 'states')).toHaveText(PILL.unavailable);
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#studio-entry-pair #place-studio-entry').click();
    const studio = page.locator(PLACE_ROOT);
    await expect(studio).toBeVisible();
    await studio.locator('#place-type-state').click();
    await expect(studio.locator('#place-type-state')).toHaveAttribute('aria-pressed', 'true');
    // The rail's own reference key overlaps the failed layer directly
    // (REFERENCE_KEYS.state = ['states']); still checked, still no retry.
    expect(statesRequests).toBe(1);
    await expect(layerCheckbox(page, 'states')).toBeChecked();

    await studio.getByRole('button', { name: 'Back to map' }).click();
    await expect(studio).toHaveCount(0);
    expect(statesRequests).toBe(1);
    await expect(layerCheckbox(page, 'states')).toBeChecked();
    await expect(layerPill(page, 'states')).toHaveText(PILL.unavailable);
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');
    expect((await urlLayers(page)).has('states')).toBe(true);
  });

  test('a recipe layer already failed and checked before the studio opens is set aside like any other, and the restore re-checks it into one genuine retry of its chunk', async ({
    page
  }) => {
    let nadmRequests = 0;
    // The query allowance catches found-087's retry URL (`.js?retry=1`):
    // Playwright tests a RegExp route against the full URL, query included.
    await page.route(/\/nadm-drought-[A-Za-z0-9_-]{8}\.js(\?.*)?$/, (route) => {
      nadmRequests += 1;
      void route.abort();
    });
    await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
    await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());

    await gotoApp(page, '?view=brief');
    await waitForLayerSettled(page, 'nadm-drought');
    expect(nadmRequests).toBe(1);
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();
    await expect(layerPill(page, 'nadm-drought')).toHaveText(PILL.unavailable);

    await page.locator('#studio-entry-pair #place-studio-entry').click();
    const studio = page.locator(PLACE_ROOT);
    await expect(studio).toBeVisible();
    // The clean display sets a failed recipe layer aside exactly like a
    // working one, by role alone: no ledger entry needed.
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();
    expect(nadmRequests).toBe(1);

    await studio.getByRole('button', { name: 'Back to map' }).click();
    await expect(studio).toHaveCount(0);
    await waitForLayerSettled(page, 'nadm-drought');
    // The restore re-checks the captured intent, and the controller
    // re-attempts it once. Since found-087, loadLayerModule
    // (src/config/layers.ts) retries a failed chunk through
    // createChunkLoader (src/util/chunk-retry.ts) under a fresh `?retry=1`
    // URL the engine has never marked failed, so a second request is made.
    // This route aborts it too, so the layer honestly reads unavailable.
    expect(nadmRequests).toBe(2);
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();
    await expect(layerPill(page, 'nadm-drought')).toHaveText(PILL.unavailable);
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="drought"]')
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

/**
 * D1 M16, found-011: a direct `studio=place` boot exercises
 * `initializeStudioRoute`'s history synthesis rather than the button-click
 * `enterStudio` path the tests above cover, so it is proven separately, in
 * every HAZARD_CLUSTER_KEYS mode (DR-113).
 */
async function stubClusterBootDependencies(
  page: Page,
  cluster: (typeof HAZARD_CLUSTER_KEYS)[number]
): Promise<void> {
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  if (cluster === 'wildfire') {
    await page.route('**/NOAA_Satellite_Smoke_Detection*/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(emptyCollectionBody())
      })
    );
  }
  if (cluster === 'heat') {
    await stubHeatRiskCatalog(page);
  }
}

test.describe('a fresh studio=place URL then Back lands on its mode with its hazard surface (found-011)', () => {
  for (const cluster of HAZARD_CLUSTER_KEYS) {
    test(cluster, async ({ page }) => {
      await stubClusterBootDependencies(page, cluster);
      const token = HAZARD_CLUSTERS[cluster].urlToken;
      const query = token === null ? '?studio=place' : `?cluster=${token}&studio=place`;
      await gotoApp(page, query);
      const studio = page.locator(PLACE_ROOT);
      await expect(studio, `${cluster}: direct boot opens the studio`).toBeVisible();

      await studio.getByRole('button', { name: 'Back to map' }).click();
      await expect(studio, `${cluster}: Back closes the studio`).toHaveCount(0);

      const settleKey = HAZARD_CLUSTERS[cluster].recipes.current[0];
      if (settleKey) await waitForLayerSettled(page, settleKey);
      await expect(
        page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`),
        `${cluster}: pressed after Back`
      ).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
      const params = new URLSearchParams(await search(page));
      expect(params.has('studio'), `${cluster}: studio= dropped`).toBe(false);
      if (token !== null) {
        expect(params.get('cluster'), `${cluster}: cluster= after Back`).toBe(token);
      } else {
        expect(params.has('cluster'), `${cluster}: cluster= absent after Back`).toBe(false);
        if (settleKey) expect((await urlLayers(page)).has(settleKey)).toBe(true);
      }
    });
  }
});
