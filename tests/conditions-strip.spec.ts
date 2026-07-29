import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  urlLayers,
  waitForLayerSettled,
  PILL
} from './helpers';

/**
 * UX-3 conditions strip: a dated at-a-glance summary at the top of the
 * sidebar. Data model is "reflect the map" (honest): a metric shows a number
 * only when its layer is active and rendered. Since E1 deliverable 6
 * (D-0.7.0-041 part 2, review E1.4) the off-state Alerts and Fires tiles
 * retire outright: the strip keeps the drought reading and the date line
 * always, and an event tile renders only while its layer is on. These are
 * the deterministic backbone assertions; the exact drought category and
 * counts depend on live upstream data and are verified in the manual
 * ddm-ui-verifier lane, not this gate.
 */
test.describe('UX-3 conditions strip', () => {
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

    // The strip is the first section in the scroll area, above Region.
    const firstPanel = page.locator('.sidebar-scroll > .panel').first();
    await expect(firstPanel).toHaveAttribute('id', 'conditions-strip');
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
    // category / none, or an honest unavailable if the upstream blips). This
    // holds regardless of network: it proves the strip tracks the active set.
    await expect
      .poll(async () => drought.locator('.conditions-sublabel').textContent())
      .not.toBe('US Drought Monitor');
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
    // Regression for docs/ddm-critical-review-2026-07-07.md #6: a drifted or
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

  test('the tiles are real buttons with stable semantics and honest wording', async ({
    page
  }) => {
    await gotoApp(page);

    const drought = page.locator('.conditions-metric[data-metric="drought"]');
    const alerts = page.locator('.conditions-metric[data-metric="alerts"]');
    const fires = page.locator('.conditions-metric[data-metric="fires"]');

    // Real button semantics (guardrail spec: never a sometimes-button),
    // with aria-pressed from the layer's on-state. USDM is default-on; the
    // two event layers are off and their tiles retired (E1 deliverable 6),
    // so the pressed/off wording contract is asserted on the drought tile
    // (its off state is exercised by the release-blocker spec below).
    await expect(drought).toHaveJSProperty('tagName', 'BUTTON');
    await expect(drought).toHaveAttribute('aria-pressed', 'true');
    await expect(alerts).toHaveCount(0);
    await expect(fires).toHaveCount(0);

    // Status and action stay distinct in the accessible name.
    const droughtLabel = (await drought.getAttribute('aria-label')) ?? '';
    expect(droughtLabel).toContain('layer on');
    expect(droughtLabel).toContain('Press to hide');
  });

  test('RELEASE BLOCKER (D-0.7.0-008): the drought tile label, announcement, and catalog sync move together', async ({
    page
  }) => {
    // A deterministic USDM week so the re-show reaches `live` regardless
    // of the upstream's mood.
    const usdmFc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { DM: 2, MapDate: Date.now() - 24 * 60 * 60 * 1000 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]]
          }
        }
      ]
    };
    const fulfill = (route: Parameters<Parameters<typeof page.route>[1]>[0]): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(usdmFc)
      });
    await page.route('**/USDM_current/**', fulfill);
    await page.route('**/USDM_archive/**', fulfill);

    await gotoApp(page, '?region=washington_state&layers=usdm');
    await waitForLayerSettled(page, 'usdm');

    const tile = page.locator('.conditions-metric[data-metric="drought"]');
    const live = page.locator('#layer-status-live');

    // ON: pressed, and the accessible name pairs the reading with the action.
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(await tile.getAttribute('aria-label')).toContain('layer on. Press to hide.');

    // Press to hide: the layer leaves the URL, the catalog checkbox
    // unchecks, the live region announces the off transition, and the tile
    // relabels to the off wording WITH the surface-replacement disclosure
    // (the guardrail spec's named risk: USDM replaces the active surface).
    await tile.click();
    await expect.poll(async () => !(await urlLayers(page)).has('usdm')).toBe(true);
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(live).toHaveText('US Drought Monitor: off');
    await expect(tile).toHaveAttribute('aria-pressed', 'false');
    await expect(tile.locator('.conditions-value')).toHaveText('Layer off');
    const offLabel = (await tile.getAttribute('aria-label')) ?? '';
    expect(offLabel).toContain('US Drought Monitor layer off');
    expect(offLabel).toContain('replaces the current condition surface');

    // Press to show: the surface returns through the shared toggle command,
    // so the URL, the checkbox, the pill, and the announcement move as one.
    await tile.click();
    await expect.poll(async () => (await urlLayers(page)).has('usdm')).toBe(true);
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await waitForLayerSettled(page, 'usdm');
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.live);
    await expect(live).toHaveText('US Drought Monitor: live');
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
  });

  test('the on-map drought key reflects the USDM surface', async ({ page }) => {
    // Console boot: the uncheck below drives the catalog checkbox, and E1
    // deliverable 1 hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');

    // USDM is default-on, so the key is visible with six swatches: the
    // leading "None" entry (U4b: bare basemap grey reads as "no drought",
    // a deliberate state, never breakage) then the five categories (D0
    // through D4) sourced from the same USDM_CATEGORIES table as the map
    // fill. Registry-driven, no fetch: deterministic.
    const key = page.locator('#map-key');
    await expect(key).toBeVisible();
    await expect(key.locator('.map-key-swatch')).toHaveCount(6);
    await expect(key.locator('.map-key-item').first()).toContainText('None');

    // Turning the USDM surface off hides the key: it never claims a surface
    // that is not on the map.
    await waitForLayerSettled(page, 'usdm');
    await layerCheckbox(page, 'usdm').uncheck();
    await expect(key).toBeHidden();
  });
});
