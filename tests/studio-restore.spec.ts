import { expect, test, type Page } from '@playwright/test';

import { gotoApp, waitForLayerSettled } from './helpers';
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
        // (measured report, 2026-08-29: 3/3 hard failures here, always
        // "element(s) not found", never a hidden panel).
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
  // settled. The FIRST us-states.geojson request is the boot layer; the
  // gate holds every subsequent request until released.
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
  let stateRequests = 0;
  let gateEngaged = false;
  let releaseGeometry!: () => void;
  const geometryGate = new Promise<void>((resolve) => {
    releaseGeometry = resolve;
  });
  // The boot layer and any studio list enrichment flow freely; only the
  // request that arrives AFTER the explicit option click (armed below) is
  // held, so exactly the selection resolution rides the gate.
  let armGate = false;
  await page.route('**/data/us-states.geojson', async (route) => {
    stateRequests += 1;
    if (armGate) {
      gateEngaged = true;
      await geometryGate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(OREGON_COLLECTION)
    });
  });

  await gotoApp(page, '?layers=states&view=brief');
  await waitForLayerSettled(page, 'states');

  await page.locator('#studio-entry-pair #place-studio-entry').click();
  const studio = page.locator(PLACE_ROOT);
  await expect(studio).toBeVisible();
  await studio.getByRole('button', { name: 'States', exact: true }).click();
  await studio.locator('#place-studio-search').fill('Oregon');
  armGate = true;
  await studio.locator('[data-place-kind="state"][data-place-id="OR"]').click();
  await expect(studio.locator('#place-selection-title')).toHaveText('Oregon');
  await expect.poll(() => gateEngaged).toBe(true);

  // Browser Back IMMEDIATELY, with the geometry resolution still pending.
  await page.goBack();
  await expect(studio).toHaveCount(0);

  releaseGeometry();
  // Same race as the parameterized restore above (:180): the return
  // action's promise chase is the only gate on the briefing's creation, so
  // give its appearance the same generous, retrying budget rather than one
  // shot at the default expect timeout.
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
});
