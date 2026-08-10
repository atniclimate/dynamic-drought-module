import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox, search, waitForLayerSettled } from './helpers';
import {
  failRecentSatelliteTiles,
  SATELLITE_FRAME,
  SATELLITE_NEW_FRAME,
  satelliteObservationRangeText,
  type SatelliteStubController,
  stubRecentSatellite
} from './satellite-fixture';

/**
 * U4d: the basemap switcher and the `basemap=` URL parameter
 * (D-0.7.0-031 CONFIRMED 2026-07-14; D-0.7.0-028 rules the imagery).
 *
 * ADDITIVE specs only: the existing url-state and embed suites are
 * UNMODIFIED (the D-031 spec posture). These pin the parameter's edge
 * cases (unknown, empty, duplicate first-wins), the default-omission
 * canonical write, embed stickiness, and the honesty chip: the exact
 * observation time is visible exactly when satellite is selected.
 */

const SWITCHER = '.basemap-switcher-btn';
const IMAGERY_CHIP = '#basemap-vintage';
let satelliteStub: SatelliteStubController;

test.beforeEach(async ({ page }) => {
  satelliteStub = await stubRecentSatellite(page);
});

test.describe('U4d: the basemap= parameter', () => {
  test('absent parameter stays absent through the boot canonical write', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    // The boot write has already run (gotoApp settles on built chrome).
    expect(await search(page)).not.toContain('basemap=');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
  });

  test('basemap=satellite seeds the mode and survives an unrelated sync', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).toContain('basemap=satellite');

    // An unrelated durable-state change (a layer toggle) re-emits the URL;
    // the basemap token must ride along (invariant 2 stickiness).
    await waitForLayerSettled(page, 'states');
    await layerCheckbox(page, 'states').uncheck();
    await expect.poll(async () => search(page)).toContain('basemap=satellite');
  });

  test('unknown and empty tokens read as the default and canonicalize away', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=bogus');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');

    await gotoApp(page, '?view=console&basemap=');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');
  });

  test('a duplicated parameter is malformed and pins to the default, both orders', async ({
    page
  }) => {
    // D-0.7.0-031 edge-case rule (re-pinned by the stage-5 adversarial
    // major 5): ambiguity is rejected, never resolved by position.
    await gotoApp(page, '?view=console&basemap=satellite&basemap=bogus');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');

    await gotoApp(page, '?view=console&basemap=bogus&basemap=satellite');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');
  });

  test('embeds honor basemap=satellite and keep it sticky', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console&basemap=satellite');
    await expect(page.locator('#app')).toHaveClass(/embed/);
    expect(await search(page)).toContain('basemap=satellite');
    expect(await search(page)).toContain('embed=true');
  });
});

test.describe('U4d: the switcher control and the honesty chip', () => {
  test('the switcher toggles satellite on and off with real button semantics', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveAccessibleName(/satellite/i);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).toContain('basemap=satellite');
    // The observation notice appears with the imagery as a plain statement,
    // separate from legal attribution.
    await expect(page.locator(IMAGERY_CHIP)).toBeVisible();

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(page.locator(IMAGERY_CHIP)).toBeHidden();
  });

  test('a satellite deep link shows exact frame context without a click', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(chip).toContainText('Context only');
    await expect(chip).toContainText('daytime approximate true color');
    await expect(chip).toContainText('nighttime infrared with static lights');
    await expect(chip).toContainText('Coverage ends near 76°N');
  });

  test('a bad newest frame falls back to the previous recent candidate', async ({
    page
  }) => {
    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME]);
    satelliteStub.failProbeFrame(SATELLITE_NEW_FRAME.objectId);

    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(satelliteStub.probeFrameIds).toContain(SATELLITE_NEW_FRAME.objectId);
    expect(satelliteStub.probeFrameIds).toContain(SATELLITE_FRAME.objectId);
  });

  test('a bad rendered refresh restores the last known-good frame', async ({
    page
  }) => {
    await page.clock.install();
    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));

    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME]);
    satelliteStub.failRenderedFrame(SATELLITE_NEW_FRAME.objectId);
    await page.clock.fastForward(10 * 60_000);

    await expect.poll(() =>
      satelliteStub.renderedFrameIds.includes(SATELLITE_NEW_FRAME.objectId)
    ).toBe(true);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(chip).toContainText('refresh delayed');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).toContain('basemap=satellite');
  });

  test('an installed frame is removed after it ages beyond the source policy', async ({
    page
  }) => {
    const endTime = Date.now() - (26 * 60 * 60_000 - 5 * 60_000);
    const expiringFrame = {
      objectId: 9025,
      name: 'MERGEDGC.10-minute.fixture_expiring.color',
      startTime: endTime - 9 * 60_000,
      endTime
    };
    satelliteStub.setFrames([expiringFrame]);
    await page.clock.install();
    await gotoApp(page, '?view=console&basemap=satellite');

    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(
      satelliteObservationRangeText(expiringFrame)
    );
    await page.clock.fastForward(10 * 60_000);

    await expect(page.locator(SWITCHER)).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(chip).toBeHidden();
  });

  test('NOAA imagery and the visible default-map underlay are both attributed', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    const attrib = page.locator('.maplibregl-ctrl-attrib');
    await expect(attrib).toContainText('NOAA NESDIS GOES GeoColor');
    await expect(attrib).toContainText('OpenStreetMap');
  });

  test('dead selected-frame tiles revert the mode honestly', async ({
    page
  }) => {
    // Kill every pinned frame request before boot: the URL must not keep
    // claiming a satellite view that cannot render.
    await failRecentSatelliteTiles(page);
    await gotoApp(page, '?view=console&basemap=satellite');

    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(page.locator(IMAGERY_CHIP)).toBeHidden();
    // The default basemap is back on screen (its attribution returns).
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap');
  });
});
