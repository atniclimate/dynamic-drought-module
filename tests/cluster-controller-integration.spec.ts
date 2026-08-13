import { test, expect, type Page, type Route } from '@playwright/test';

import { gotoApp, layerCheckbox, search } from './helpers';

/**
 * DG-080 r2 finding 4: the deferred REAL layer-controller integration.
 *
 * The Node spec in tests/cluster-service.spec.ts drives the cluster
 * service against a test-local deferred controller, which proves the
 * service's coherence ASSUMING the per-key generation guard works. This
 * spec exercises the guard itself: the production `createLayerController`
 * (bound by buildSidebar at boot), its per-key op chains, intent
 * generations, module cancellation, and registry/status writes, in the
 * built app, through the same shell buttons a user presses.
 *
 * The pressure pattern is the review's A -> B -> A: Wildfire (its pair's
 * fetches HELD at the network layer), Drought before anything settles,
 * Wildfire again (fresh fetches released normally). The held
 * first-generation responses are released only after the second
 * generation has settled, so any stale same-key write the production
 * guard failed to drop would corrupt the settled display and fail the
 * final assertions. Everything asserted is observable truth (checkbox
 * intent, status pills, the summary sentence, the URL claim); nothing
 * reimplements the guard.
 */

const NIFC_PATTERN = 'WFIGS_Interagency_Perimeters_Current';
const HMS_PATTERN = 'NOAA_Satellite_Smoke_Detection';

const NIFC_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        attr_IncidentName: 'Synthetic Integration Fire',
        attr_IncidentTypeCategory: 'WF',
        attr_IncidentSize: 1234,
        attr_FireDiscoveryDateTime: 1753300000000,
        attr_POOState: 'US-OR'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-121, 44],
            [-120.5, 44],
            [-120.5, 44.5],
            [-121, 44.5],
            [-121, 44]
          ]
        ]
      }
    }
  ]
};

const HMS_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        Satellite: 'GOES-WEST',
        Start: '2026206 0000',
        End_: '2026206 0600',
        Density: 'Light'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122, 45],
            [-121, 45],
            [-121, 46],
            [-122, 46],
            [-122, 45]
          ]
        ]
      }
    }
  ]
};

/** Pill raw-status class for a key ('' while off/cleared). */
async function pillStatusClasses(page: Page, key: string): Promise<string> {
  return (
    (await page
      .locator(`[data-layer-status="${key}"]`)
      .getAttribute('class')) ?? ''
  );
}

test.describe('real layer-controller integration (DG-080 r2 finding 4)', () => {
  test('rapid A -> B -> A through the shell: stale first-generation work never corrupts the settled display', async ({
    page
  }) => {
    // Held first-generation responses: fulfilled only after the fresh
    // generation settles. A fulfill against an already-aborted request
    // (the module cancellation contract, invariant 5) rejects; that is
    // the production abort path doing its job, so it is swallowed.
    let hold = true;
    const held: Array<() => void> = [];
    const fulfil = (route: Route, body: unknown): void => {
      void route
        .fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        })
        .catch(() => {
          /* aborted by the page: the production cancellation won */
        });
    };
    await page.route(
      (url) => url.href.includes(NIFC_PATTERN),
      (route) => {
        if (hold) held.push(() => fulfil(route, NIFC_FIXTURE));
        else fulfil(route, NIFC_FIXTURE);
      }
    );
    await page.route(
      (url) => url.href.includes(HMS_PATTERN),
      (route) => {
        if (hold) held.push(() => fulfil(route, HMS_FIXTURE));
        else fulfil(route, HMS_FIXTURE);
      }
    );

    await gotoApp(page);
    await expect(page.locator('.shell-cluster-btn')).toHaveCount(4);

    const wildfireBtn = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
    const droughtBtn = page.locator('.shell-cluster-btn[data-cluster="drought"]');

    // A: Wildfire. The pair's intent lands synchronously; the fetches
    // are held, so the committed button shows pending work, honestly.
    await wildfireBtn.click();
    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(wildfireBtn).toHaveAttribute('data-pending', 'true');

    // B: Drought, before anything wildfire settled. The production
    // controller must supersede the in-flight pair activations.
    await droughtBtn.click();
    await expect(droughtBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();

    // A again: fresh wildfire generation, released normally.
    hold = false;
    await wildfireBtn.click();
    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();

    // The fresh generation settles live through the real controller and
    // registry (module status writes included).
    await expect
      .poll(() => pillStatusClasses(page, 'nifc-fires'), { timeout: 45_000 })
      .toContain('ready');
    await expect
      .poll(() => pillStatusClasses(page, 'hms-smoke'), { timeout: 45_000 })
      .toContain('ready');
    await expect(wildfireBtn).toHaveAttribute('data-pending', 'false', {
      timeout: 45_000
    });
    await expect(page.locator('#shell-summary-primary')).toContainText(
      'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
    );

    // NOW release the stale first-generation responses (same keys,
    // intended again under a newer generation: the review's hardest
    // case). The production guard (module aborts + per-key intent
    // generations + op chains) must drop them without a flicker of
    // state.
    for (const release of held.splice(0, held.length)) release();
    // Give any stale settle a beat to (wrongly) land before asserting.
    await page.waitForTimeout(500);

    await expect(wildfireBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(wildfireBtn).toHaveAttribute('data-pending', 'false');
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    expect(await pillStatusClasses(page, 'nifc-fires')).toContain('ready');
    expect(await pillStatusClasses(page, 'hms-smoke')).toContain('ready');
    // The dropped surface makes no claim: its pill carries no stale
    // status class from the superseded generation.
    expect(await pillStatusClasses(page, 'usdm')).not.toContain('ready');
    await expect(page.locator('#shell-summary-primary')).toContainText(
      'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
    );
    // The URL claim is the clean cluster, not a stale granular residue.
    await page.waitForFunction(() =>
      window.location.search.includes('cluster=wildfire')
    );
    expect(await search(page)).not.toContain('layers=');
  });
});
