import { test, expect } from './offline-test';
import { stubUsdmWeeks } from './usdm-fixtures';

import {
  gotoApp,
  layerCheckbox,
  regionSelect,
  selectRegion,
  search,
  urlLayers,
  waitForLayerSettled
} from './helpers';
import { DEFAULT_ON } from './defaults';

/**
 * S2: the region-shell URL migration (D-0.7.0-039/041/042/044/046/053;
 * this suite pins the region-shell precedence table in full).
 *
 * Two halves, matching the suite's established shapes:
 *
 *   - Pure Node assertions (the u4-opening-map / s1-substrate pattern)
 *     pin the parse grammar and EVERY precedence pair, because the
 *     parsers are deliberately pure over URLSearchParams (the
 *     deriveViewMode pattern) exactly so the table is testable without
 *     a browser.
 *   - Browser drives pin the boot behavior: the cluster recipe applied
 *     through the ordinary activation path, the durable-truth URL
 *     claim and its handoff back to layers=, the ocean gating, and the
 *     legacy links that must keep working byte for byte.
 */

// ---------------------------------------------------------------------------
// Browser: cluster boots, the durable-truth claim, and its handoff
// ---------------------------------------------------------------------------

/**
 * Stub the two wildfire-recipe agency endpoints with empty
 * FeatureCollections: an empty result is a genuine terminal on state
 * (`no-data`), so the boot is deterministic and the cluster claim
 * cannot be dropped by a live-agency outage mid-spec (smoke-suite
 * doctrine: never couple to live values).
 */
async function stubWildfireRecipe(page: import('./offline-test').Page): Promise<void> {
  const empty = JSON.stringify({ type: 'FeatureCollection', features: [] });
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: empty })
  );
  await page.route('**/NOAA_Satellite_Smoke_Detection*/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: empty })
  );
}

test.describe('S2 cluster= in the browser', () => {
  test('a cluster=wildfire boot applies the current recipe over the untouched reference set', async ({
    page
  }) => {
    await stubWildfireRecipe(page);
    await gotoApp(page, '?cluster=wildfire');

    // gotoApp pins a display boot to the console (tests/helpers.ts).
    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);

    // The current-horizon recipe: perimeters plus smoke ONLY
    // (D-0.7.0-043 part 1), through the ordinary activation path.
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).toBeChecked();
    // The drought default surface does not ride along...
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    // ...and the default-on reference set is left alone.
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).toBeChecked();
    await expect(layerCheckbox(page, 'states')).toBeChecked();

    // The durable-truth claim (D-0.7.0-044): the URL carries ONLY the
    // one-word token; no granular layers= while the display is clean.
    await waitForLayerSettled(page, 'nifc-fires');
    const params = new URLSearchParams(await search(page));
    expect(params.get('cluster')).toBe('wildfire');
    expect(params.get('layers')).toBeNull();
  });

  test('customizing a layer drops cluster= for the granular layers= (D-0.7.0-044)', async ({
    page
  }) => {
    await stubWildfireRecipe(page);
    await gotoApp(page, '?cluster=wildfire');
    await waitForLayerSettled(page, 'nifc-fires');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'))
      .toBe('wildfire');

    // The moment the user customizes (any divergence from the cluster's
    // composition), the claim comes off and the honest list goes on.
    await layerCheckbox(page, 'places').check();
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'))
      .toBeNull();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);
    await expect.poll(async () => (await urlLayers(page)).has('nifc-fires')).toBe(true);
  });

  test('layers= outranks cluster= at boot: layers wins, cluster is dropped on sync', async ({
    page
  }) => {
    await stubUsdmWeeks(page);
    await gotoApp(page, '?layers=usdm&cluster=wildfire');
    await waitForLayerSettled(page, 'usdm');
    await expect(page.locator('[data-layer-status="usdm"]')).toHaveClass(/\bready\b/);

    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'nifc-fires')).not.toBeChecked();
    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();

    await waitForLayerSettled(page, 'usdm');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'), {
        timeout: 25_000
      })
      .toBeNull();
    await expect
      .poll(async () => (await urlLayers(page)).has('usdm'), { timeout: 25_000 })
      .toBe(true);
  });

  test('an unknown cluster token reads as absence and is dropped (policy rule 2)', async ({
    page
  }) => {
    await gotoApp(page, '?cluster=volcano');

    // Absence means the default display: the default-on set activates.
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    await waitForLayerSettled(page, 'states');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'), {
        timeout: 25_000
      })
      .toBeNull();
  });
});

test.describe('S2 ocean= in the browser', () => {
  test('an ocean boot applies the ENSO cluster and keeps the pair in the URL (D-0.7.0-042/053)', async ({
    page
  }) => {
    await gotoApp(page, '?cluster=enso&ocean=pacific');

    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    // The ENSO display: the shipped SST anomaly surface, reference set
    // untouched, drought surface off.
    await expect(layerCheckbox(page, 'sst-anomaly')).toBeChecked();
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(layerCheckbox(page, 'states')).toBeChecked();

    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('cluster')).toBe('enso');
    expect(params.get('ocean')).toBe('pacific');
    expect(params.get('layers')).toBeNull();
    // ENSO's default flow kind (wind, E2-4) is the absence of `flow=`: the
    // boot opens it without writing it back (tests/enso-flow-default.spec.ts).
    expect(params.has('flow')).toBe(false);
  });

  test('ocean= without cluster=enso is ignored and dropped on sync', async ({ page }) => {
    await gotoApp(page, '?ocean=pacific');

    // The default display boots (the ocean alone claims nothing).
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    await waitForLayerSettled(page, 'states');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('ocean'), {
        timeout: 25_000
      })
      .toBeNull();
  });
});

test.describe('S2 framing= and the legacy links in the browser', () => {
  test('a framing boot round-trips framing= and claims one camera (region= is dropped)', async ({
    page
  }) => {
    await gotoApp(page, '?framing=arid-west');

    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    // Camera-only: no briefing opened, no cluster claimed, and the
    // default display activated untouched.
    await expect(page.locator('#impact-panel')).toHaveCount(0);
    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }

    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('framing')).toBe('arid-west');
    // One camera vocabulary at a time: framing= replaces region=.
    expect(params.get('region')).toBeNull();
  });

  test('an unknown framing token returns camera custody to the legacy region and is dropped', async ({ page }) => {
    await gotoApp(page, '?framing=atlantis');

    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('framing')).toBeNull();
    // With no framing active, the legacy region emission is unchanged: it
    // falls back to DEFAULT_REGION, national since DR-109.
    expect(params.get('region')).toBe('national');
  });

  test('a region click clears the minimap framing (one camera vocabulary)', async ({
    page
  }) => {
    await gotoApp(page, '?framing=pacific-coast');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBe('pacific-coast');

    // An explicit legacy region choice is a camera gesture: the framing
    // context resets and region= returns to the URL.
    await selectRegion(page, 'central_oregon');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBeNull();
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('region'))
      .toBe('central_oregon');
  });

  test('legacy region= links keep working byte for byte, national included (D-0.7.0-039)', async ({
    page
  }) => {
    await stubUsdmWeeks(page);
    // An ordinary curated region: honored exactly as today.
    await gotoApp(page, '?region=central_oregon&layers=usdm');
    await waitForLayerSettled(page, 'usdm');
    await expect(page.locator('[data-layer-status="usdm"]')).toHaveClass(/\bready\b/);
    await expect(regionSelect(page)).toHaveValue('region:central_oregon');
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();

    // The national alias: still a valid region (the camera fit rides
    // REGIONS.national as always), still re-emitted as region=national,
    // and it produces NO framing token. D-0.7.0-041's staged plan would
    // have normalized region=national to absence once the bare-URL
    // default stopped framing Washington; DR-109 (S30D D1, ruling R3
    // option a) met that precondition and DECLINED the normalization:
    // region= is written on every canonical URL, national included, so a
    // link written after the flip stays immune to any future default
    // change and a deliberate national choice made inside ENSO survives a
    // reload instead of being overridden by the ENSO zoom camera. This
    // assertion therefore does not flip to absence; DEFAULT_REGION in
    // src/config/regions.ts is now 'national' and both syncUrl and pushUrl
    // keep writing the token regardless.
    await gotoApp(page, '?region=national');
    await expect(regionSelect(page)).toHaveValue('region:national');
    await waitForLayerSettled(page, 'states');
    const params = new URLSearchParams(await search(page));
    expect(params.get('region')).toBe('national');
    expect(params.get('framing')).toBeNull();
  });

  test('select= still outranks the display parameters for the view door (D-0.7.0-017)', async ({
    page
  }) => {
    await stubWildfireRecipe(page);
    await gotoApp(page, '?select=state:WA&cluster=wildfire');

    // The sharer meant the briefing: Brief opens with the deep-linked
    // panel, while the cluster display still applies underneath.
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);
    await expect(page.locator('#impact-panel')).toBeVisible({ timeout: 15_000 });
    await expect(layerCheckbox(page, 'nifc-fires')).toBeChecked();
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('cluster'), {
        timeout: 25_000
      })
      .toBe('wildfire');
    // The one-shot select= is never re-emitted (policy rule 8).
    await expect
      .poll(async () => (await search(page)).includes('select='), { timeout: 25_000 })
      .toBe(false);
  });
});
