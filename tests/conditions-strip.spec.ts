import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  urlLayers,
  waitForLayerSettled,
  PILL
} from './helpers';
import { stubRecentSatellite } from './satellite-fixture';
import { SATELLITE_PROBE_BBOX } from '../src/map/satellite';

/**
 * UX-3 conditions strip: a dated at-a-glance summary of the rendered map.
 * Data model is "reflect the map" (honest): a metric shows a number
 * only when its layer is active and rendered. Since E1 deliverable 6
 * (D-0.7.0-041 part 2, review E1.4) the off-state Alerts and Fires tiles
 * retire outright: the strip keeps the drought reading and the date line
 * always, and an event tile renders only while its layer is on. These are
 * the deterministic backbone assertions; the exact drought category and
 * counts depend on live upstream data and are verified in the manual
 * ddm-ui-verifier lane, not this gate.
 */
test.describe('UX-3 conditions strip', () => {
  test('the drought indicator updates after its polygons render while unrelated satellite tiles remain pending', async ({ page }) => {
    // Satellite is installed after the base map loads. Hold its rendered
    // tiles, but let its probe succeed, so map controls work while global
    // idle cannot fire. The independently held NADM source resolves later.
    await stubRecentSatellite(page);
    let releaseSatellite!: () => void;
    let releaseDrought!: () => void;
    const satelliteGate = new Promise<void>((resolve) => { releaseSatellite = resolve; });
    const droughtGate = new Promise<void>((resolve) => { releaseDrought = resolve; });
    let heldSatelliteTiles = 0;
    let droughtRequested = false;
    await page.route('**/MERGEDGC_Last_24hr/ImageServer/exportImage?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('bbox') !== SATELLITE_PROBE_BBOX) {
        heldSatelliteTiles += 1;
        await satelliteGate;
      }
      await route.fallback();
    });
    await page.route('**/NADM-current.geojson', async (route) => {
      droughtRequested = true;
      await droughtGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { DROUGHTCAT: 'd3', YEAR_MONTH: '202607' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]]
            }
          }]
        })
      });
    });

    try {
      await gotoApp(page, '?view=brief&layers=nadm-drought&basemap=satellite', { bootIdle: false });
      await expect.poll(() => droughtRequested).toBe(true);
      await expect.poll(() => heldSatelliteTiles).toBeGreaterThan(0);
      const drought = page.locator('#map-condition-indicator .conditions-metric[data-metric="drought"]');
      await expect(drought).toHaveAttribute('data-tone', 'loading');
      releaseDrought();
      await expect(drought).toHaveAttribute('data-tone', 'data');
      await expect(drought.locator('.conditions-value')).toHaveText('D3');
      await expect(drought.locator('.conditions-sublabel')).toContainText('Extreme drought');
      // No satellite response has been released: this read must follow the
      // drought source's render, rather than depend on whole-map idle.
      await expect(drought).not.toContainText('No polygon');
    } finally {
      releaseDrought();
      releaseSatellite();
    }
  });

  test('renders the drought tile at the top; off-state event tiles retire (E1 deliverable 6)', async ({
    page
  }) => {
    await gotoApp(page);

    const strip = page.locator('#conditions-strip');
    await expect(strip).toBeVisible();

    // The two event layers are off by default, so only the drought tile
    // renders; the retired "Layer off / Show" cards never appear.
    const tiles = page.locator('#conditions-metrics .conditions-metric');
    await expect(tiles).toHaveCount(1);
    await expect(tiles.nth(0)).toHaveAttribute('data-metric', 'drought');

    // Desktop Brief moves the original strip to the top-left map indicator.
    // Its old visual title stands down, while the valid-date slot and the one
    // metric root stay on the same node.
    await expect(page.locator('#conditions-strip-dock > #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#map-condition-indicator #conditions-strip')).toHaveCount(1);
    await expect(page.locator('#shell-conditions-heading')).toHaveText('Conditions in view');
    await expect(strip.locator('.conditions-title')).toBeHidden();
    await expect(strip.locator('#conditions-date')).toBeAttached();

    await waitForLayerSettled(page, 'nadm-drought');
    const drought = tiles.nth(0);
    await expect(drought).toHaveAttribute('data-tone', 'data');
    const oneLine = await drought.evaluate((tile) => {
      const value = tile.querySelector<HTMLElement>('.conditions-value');
      const label = tile.querySelector<HTMLElement>('.conditions-sublabel');
      if (!value || !label) return false;
      const valueRect = value.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return valueRect.bottom >= labelRect.top && labelRect.bottom >= valueRect.top;
    });
    expect(oneLine).toBe(true);
    await expect(drought.locator('.conditions-sublabel')).not.toContainText('in view');
    await expect(drought).toHaveAttribute('aria-label', /in view/i);

    await page.locator('.view-switch [data-view="console"]').click();
    await expect(page.locator('#conditions-strip-home + #conditions-strip')).toHaveCount(1);
    await expect(strip.locator('.conditions-title')).toBeVisible();
  });

  test('metrics reflect the active set: off event tiles are absent, the active surface reflects', async ({
    page
  }) => {
    await gotoApp(page);

    const drought = page.locator('.conditions-metric[data-metric="drought"]');
    const alerts = page.locator('.conditions-metric[data-metric="alerts"]');
    const fires = page.locator('.conditions-metric[data-metric="fires"]');

    // E1 deliverable 6: with their layers off, the Alerts and Fires tiles
    // do not render at all (the cluster buttons become the activation
    // affordance at S4; today the catalog toggles remain the door).
    await expect(alerts).toHaveCount(0);
    await expect(fires).toHaveCount(0);

    // USDM is default-on, so once it activates the drought tile stops reading
    // the off-state sublabel and reflects the layer (loading, then a real
    // category / explicit no-polygon read, or an honest unavailable if the
    // upstream blips). This holds regardless of network: it proves the strip
    // tracks the active set.
    await expect
      .poll(async () => drought.locator('.conditions-sublabel').textContent())
      .not.toBe('US Drought Monitor');
  });

  test('desktop Brief keeps the full categorical legend behind Layer legends', async ({
    page
  }) => {
    await gotoApp(page);
    await waitForLayerSettled(page, 'nadm-drought');
    const key = page.locator('.sidebar-legend-disclosure > summary');
    await expect(key).toBeVisible();
    await expect(page.locator('#sidebar-key-host > #legend-panel')).toBeHidden();
    await key.click();
    await expect(page.locator('#sidebar-key-host > #legend-panel')).toBeVisible();
  });

  test('the fires tile appears and reflects the wildfire layer once it is on', async ({
    page
  }) => {
    // Console boot: the catalog drives the toggle, and E1 deliverable 1
    // hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');

    const fires = page.locator('.conditions-metric[data-metric="fires"]');
    // E1 deliverable 6: no off-state card before the layer goes on.
    await expect(fires).toHaveCount(0);

    // Turn the NIFC perimeter layer on and let its activation settle. The
    // reflect-the-map contract is asserted only when the layer actually
    // renders; on an upstream outage the honest outcome is an "unavailable"
    // pill with the checkbox self-corrected off and the tile still absent,
    // which is correct behavior, not a regression, so the spec skips rather
    // than fails (the deterministic backbone never reds on a blipping agency).
    await layerCheckbox(page, 'nifc-fires').check();
    await waitForLayerSettled(page, 'nifc-fires');
    const pill = (await layerPill(page, 'nifc-fires').textContent())?.trim();
    test.skip(pill !== PILL.live, 'NIFC upstream unavailable; nothing rendered to reflect');

    // The layer is live: the tile appears and reflects the count (a real
    // zero keeps full contrast; it is an answer, not an absence).
    await expect(fires).toHaveCount(1);
    await expect
      .poll(async () => fires.locator('.conditions-sublabel').textContent())
      .not.toBe('wildfires');
  });

  test('a frozen USDM feed degrades to an explicit stale read, not a confident current one', async ({
    page
  }) => {
    // Regression for critical-review finding #6 (2026-07-07): a drifted or
    // frozen upstream that keeps returning an OLD week used to render as if it
    // were current drought. Serve a valid D3 polygon over the Pacific Northwest
    // whose MapDate is years old; the reading must still show (it is the best
    // available) but be marked stale on both the tile and the date line.
    const staleUsdm = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { DM: 3, MapDate: Date.UTC(2020, 0, 1) },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]]
          }
        }
      ]
    };
    await page.route('**/USDM_current/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(staleUsdm)
      })
    );

    await gotoApp(page, '?region=washington_state&layers=usdm');
    await waitForLayerSettled(page, 'usdm');
    // Features rendered, so the layer is genuinely live (not an error path).
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.live);

    const drought = page.locator('.conditions-metric[data-metric="drought"]');
    // The category still surfaces (best available) but is flagged stale.
    await expect.poll(async () => drought.getAttribute('data-stale')).toBe('true');
    await expect(drought.locator('.conditions-value')).toHaveText('D3');
    await expect(drought.locator('.conditions-stale-tag')).toHaveText('stale');

    // The date line says so explicitly, in the warn tone.
    const date = page.locator('#conditions-date');
    await expect(date).toHaveAttribute('data-stale', 'true');
    await expect(date).toContainText('stale, data as of');
  });

  test('an empty USDM artifact cannot become a confident no-drought reading', async ({
    page
  }) => {
    const emptyUsdm = { type: 'FeatureCollection', features: [] };
    await page.route('**/USDM_current/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyUsdm)
      })
    );

    await gotoApp(page, '?region=washington_state&layers=usdm');
    await waitForLayerSettled(page, 'usdm');
    await expect(layerPill(page, 'usdm')).toHaveText(
      'no coverage returned by the active drought source'
    );

    const drought = page.locator('.conditions-metric[data-metric="drought"]');
    await expect(drought.locator('.conditions-value')).toHaveText('No polygon');
    await expect(drought.locator('.conditions-sublabel')).toContainText(
      'no D0-D4 polygon rendered'
    );
    await expect(drought).not.toContainText('no drought in view');
  });

  test('the tiles are real buttons with stable semantics and honest wording', async ({
    page
  }) => {
    await gotoApp(page);

    const drought = page.locator('.conditions-metric[data-metric="drought"]');
    const alerts = page.locator('.conditions-metric[data-metric="alerts"]');
    const fires = page.locator('.conditions-metric[data-metric="fires"]');

    // Real button semantics (guardrail spec: never a sometimes-button),
    // with aria-pressed from the layer's on-state. NADM is default-on; the
    // two event layers are off and their tiles retired (E1 deliverable 6),
    // so the pressed/off wording contract is asserted on the drought tile
    // (its off state is exercised by the release-blocker spec below).
    await expect(drought).toHaveJSProperty('tagName', 'BUTTON');
    await expect(drought).toHaveAttribute('aria-expanded', 'false');
    await expect(alerts).toHaveCount(0);
    await expect(fires).toHaveCount(0);

    // Status and action stay distinct in the accessible name.
    const droughtLabel = (await drought.getAttribute('aria-label')) ?? '';
    expect(droughtLabel).toContain('drought details and key');
    expect(droughtLabel).not.toContain('Press to hide');
  });

  test('clicking the drought reading opens its key without removing the polygon or changing URL state', async ({
    page
  }) => {
    await gotoApp(page, '?region=washington_state');
    for (const key of [
      'hillshade',
      'nadm-drought',
      'aiannh',
      'bia-reservations',
      'states'
    ]) {
      await waitForLayerSettled(page, key);
    }

    const tile = page.locator('.conditions-metric[data-metric="drought"]');
    const beforeUrl = page.url();
    const beforeReading = await tile.locator('.conditions-value').textContent();
    await expect(tile).toHaveAttribute('aria-expanded', 'false');
    await tile.click();
    await expect(tile).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#map-key-content')).toBeVisible();
    await expect(page.locator('#map-key-content')).toContainText('D3');
    expect(page.url()).toBe(beforeUrl);
    expect((await urlLayers(page)).has('nadm-drought')).toBe(true);
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();
    await expect(tile.locator('.conditions-value')).toHaveText(beforeReading ?? '');
    await tile.click();
    await expect(tile).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#map-key-content')).toBeHidden();
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();
    await expect(layerPill(page, 'nadm-drought')).toHaveText(PILL.live);
  });

  test('a non-drought view leads with its own tiles; the off drought anchor renders last (W2-D10)', async ({
    page
  }) => {
    // A heat-style view: alerts on, no drought surface. The strip keeps
    // the drought anchor tile (the one road back to the drought surface)
    // but demotes its off state behind the active hazard's own read.
    const alertFixture = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            prod_type: 'Heat Advisory',
            onset: '2026-08-18T08:00:00-07:00',
            ends: '2026-08-19T20:00:00-07:00',
            expiration: Date.now() + 86_400_000,
            wfo: 'KPDT'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-125, 42],
                [-116, 42],
                [-116, 49],
                [-125, 49],
                [-125, 42]
              ]
            ]
          }
        }
      ]
    };
    await page.route('**/WWA/watch_warn_adv/MapServer/1/query**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(alertFixture)
      })
    );
    // Deterministic NADM for the show-again leg (gotoApp skips its default
    // stub when the query names layers).
    await page.route('**/NADM-current.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { DROUGHTCAT: 'd2', YEAR_MONTH: '202606' },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]
                ]
              }
            }
          ]
        })
      })
    );

    await gotoApp(page, '?view=console&layers=nws-alerts');
    await waitForLayerSettled(page, 'nws-alerts');

    const tiles = page.locator('#conditions-metrics .conditions-metric');
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0)).toHaveAttribute('data-metric', 'alerts');
    await expect(tiles.nth(1)).toHaveAttribute('data-metric', 'drought');
    const droughtTile = tiles.nth(1);
    await expect(droughtTile.locator('.conditions-value')).toHaveText('Layer off');
    await expect(droughtTile.locator('.conditions-action')).toHaveText('Show');

    // The drought view itself is unchanged: turning the surface on returns
    // its tile to the front.
    await droughtTile.click();
    await waitForLayerSettled(page, 'nadm-drought');
    await expect(tiles.nth(0)).toHaveAttribute('data-metric', 'drought');
    await expect(tiles.nth(0)).toHaveAttribute('aria-expanded', 'false');
  });

  test('Console retains a compact on-map drought disclosure alongside the layer legend', async ({ page }) => {
    // Console boot: the uncheck below drives the catalog checkbox, and E1
    // deliverable 1 hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');

    // The default NADM surface keeps a compact trigger while its full key
    // stays behind the disclosure.
    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expect(key.locator('#map-key-content')).toBeHidden();
    await expect(page.locator('#legend-panel [data-legend="nadm-drought"]')).toBeVisible();

    // Turning the USDM surface off hides the key: it never claims a surface
    // that is not on the map.
    await waitForLayerSettled(page, 'nadm-drought');
    await layerCheckbox(page, 'nadm-drought').uncheck();
    await expect(key).toBeHidden();
  });
});
