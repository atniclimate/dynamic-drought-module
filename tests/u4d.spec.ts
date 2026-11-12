import { test, expect } from './offline-test';

import type { Locator, Page } from '@playwright/test';

import { ACKNOWLEDGEMENTS, PROVIDERS } from '../src/config/acknowledgements';
import {
  SATELLITE_CAVEAT_NOTE,
  SATELLITE_COVERAGE_NOTE,
  SATELLITE_UNAVAILABLE_NOTE
} from '../src/ui/map-technical-information';
import { gotoApp, layerCheckbox, search, waitForLayerSettled } from './helpers';
import {
  failRecentSatelliteTiles,
  SATELLITE_FRAME,
  SATELLITE_NEW_FRAME,
  SATELLITE_OLDER_FRAME,
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
 * cases, the satellite-default canonical write, explicit off-state
 * stickiness, and the SAT description: exact observation detail is available
 * to assistive technology exactly when satellite is selected.
 */

const SWITCHER = '.basemap-switcher-btn';
const IMAGERY_CHIP = '#basemap-vintage';
/** The frame the map holds, stamped from the installed source (src/map/satellite.ts). */
const SATELLITE_STAMP = 'data-ddm-satellite';
let satelliteStub: SatelliteStubController;

/** The Impact Briefing's Technical information, opened through the map key's link. */
/** Console warnings the app logs when it rejects the service's placeholder image; collect before navigation. */
function collectPlaceholderWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && /placeholder image/.test(message.text())) warnings.push(message.text());
  });
  return warnings;
}

async function openTechnicalInformation(page: Page): Promise<Locator> {
  await page.locator('button[data-open-technical-information]').first().dispatchEvent('click');
  const notes = page.locator('#impact-panel .impact-technical-information');
  await expect(notes).toHaveJSProperty('open', true);
  return notes;
}

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
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(SWITCHER)).toHaveText('SAT');
  });

  test('the established satellite token canonicalizes to the default omission', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');

    // An unrelated durable-state change (a layer toggle) re-emits the URL;
    // Satellite remains active through the unrelated write.
    await waitForLayerSettled(page, 'states');
    await layerCheckbox(page, 'states').uncheck();
    await expect.poll(async () => search(page)).not.toContain('basemap=');
  });

  test('unknown and empty tokens read as the satellite default and canonicalize away', async ({
    page
  }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      // The offline harness answers unstubbed hosts with 503; Chromium logs those without the URL.
      if (message.type() === 'error' && !/https?:\/\/|^Failed to load resource/.test(message.text())) {
        problems.push(message.text());
      }
    });

    await gotoApp(page, '?view=console&basemap=bogus');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');

    await gotoApp(page, '?view=console&basemap=');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');
    // A malformed token is read without an error.
    expect(problems).toEqual([]);
  });

  test('a duplicated parameter is malformed and pins to the satellite default', async ({
    page
  }) => {
    // D-0.7.0-031 edge-case rule (re-pinned by the stage-5 adversarial
    // major 5): ambiguity is rejected, never resolved by position.
    await gotoApp(page, '?view=console&basemap=satellite&basemap=bogus');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');

    await gotoApp(page, '?view=console&basemap=bogus&basemap=satellite');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');
  });

  test('embeds honor the satellite default without a redundant token', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console&basemap=satellite');
    await expect(page.locator('#app')).toHaveClass(/embed/);
    expect(await search(page)).not.toContain('basemap=');
    expect(await search(page)).toContain('embed=true');
  });

  test('basemap=default records and preserves an explicit satellite-off choice', async ({ page }) => {
    await gotoApp(page, '?view=console&basemap=default');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).toContain('basemap=default');
    await waitForLayerSettled(page, 'states');
    await layerCheckbox(page, 'states').uncheck();
    await expect.poll(async () => search(page)).toContain('basemap=default');
  });
});

test.describe('U4d: the switcher control and assistive observation status', () => {
  test('the switcher toggles satellite on and off with real button semantics', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveAccessibleName(/satellite/i);
    await expect(btn).toHaveAttribute('aria-describedby', 'basemap-vintage');
    await expect(page.locator(IMAGERY_CHIP)).not.toBeInViewport();

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => search(page)).toContain('basemap=default');
    await expect(page.locator(IMAGERY_CHIP)).toBeHidden();

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(page.locator(IMAGERY_CHIP)).not.toBeInViewport();
  });

  test('a satellite deep link shows exact frame context without a click', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    const btn = page.locator(SWITCHER);
    await expect(chip).not.toBeInViewport();
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(btn).toHaveAccessibleDescription(/NOAA GOES GeoColor/);
    // Live imagery never reads as unavailable.
    await expect(btn).not.toHaveAccessibleDescription(/unavailable/);
    await expect(btn).not.toHaveAttribute('title', /unavailable/);
    await expect(btn).not.toHaveAttribute('data-imagery-unavailable');
    await expect(page.locator('html')).toHaveAttribute(SATELLITE_STAMP, String(SATELLITE_FRAME.objectId));
    // The caveats and the coverage clause (the product's real geometry, two
    // GOES disks, and its daylight seam) read in the Impact Briefing, not in
    // the hidden chip (owner rule 2026-10-13). Asserted against the exported
    // constants so the copy and the spec cannot drift.
    const notes = await openTechnicalInformation(page);
    await expect(notes).toContainText(SATELLITE_CAVEAT_NOTE);
    await expect(notes).toContainText(SATELLITE_COVERAGE_NOTE);
    await expect(notes).not.toContainText(SATELLITE_UNAVAILABLE_NOTE);
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

  test('a newest frame that serves the placeholder image falls back to the previous frame', async ({
    page
  }) => {
    // NOAA's service has answered pinned requests with HTTP 200 and a black
    // and white placeholder image (2026-11-11). The probe must reject it.
    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME]);
    satelliteStub.servePlaceholderFrame(SATELLITE_NEW_FRAME.objectId);
    const warnings = collectPlaceholderWarnings(page);

    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(satelliteStub.probeFrameIds).toContain(SATELLITE_NEW_FRAME.objectId);
    expect(satelliteStub.renderedFrameIds).not.toContain(SATELLITE_NEW_FRAME.objectId);
    // Rejected as the placeholder, not merely undecodable.
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('when the two newest frames serve placeholder map tiles the selection walks back to the third', async ({
    page
  }) => {
    // Both probes see imagery, so each frame is installed and dropped at tile time in turn.
    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME, SATELLITE_OLDER_FRAME]);
    satelliteStub.servePlaceholderFrame(SATELLITE_NEW_FRAME.objectId, 'tiles');
    satelliteStub.servePlaceholderFrame(SATELLITE_FRAME.objectId, 'tiles');
    const warnings = collectPlaceholderWarnings(page);

    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_OLDER_FRAME), { timeout: 30_000 });
    expect(warnings.length).toBeGreaterThan(0);
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute(SATELLITE_STAMP, String(SATELLITE_OLDER_FRAME.objectId));
    expect(satelliteStub.probeFrameIds).toEqual(expect.arrayContaining([
      SATELLITE_NEW_FRAME.objectId,
      SATELLITE_FRAME.objectId,
      SATELLITE_OLDER_FRAME.objectId
    ]));
    expect(satelliteStub.renderedFrameIds).toEqual(expect.arrayContaining([
      SATELLITE_NEW_FRAME.objectId,
      SATELLITE_FRAME.objectId,
      SATELLITE_OLDER_FRAME.objectId
    ]));
  });

  test('placeholder map tiles from the newest frame walk back to the previous frame', async ({
    page
  }) => {
    // The newest frame's probe sees imagery, so it is installed; its map
    // tiles come back as the placeholder, and the selection walks back.
    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME]);
    satelliteStub.servePlaceholderFrame(SATELLITE_NEW_FRAME.objectId, 'tiles');
    const warnings = collectPlaceholderWarnings(page);

    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME), { timeout: 30_000 });
    expect(warnings.length).toBeGreaterThan(0);
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(SWITCHER)).not.toHaveAttribute('data-imagery-unavailable');
    await expect(page.locator('html')).toHaveAttribute(SATELLITE_STAMP, String(SATELLITE_FRAME.objectId));
    expect(satelliteStub.renderedFrameIds).toContain(SATELLITE_NEW_FRAME.objectId);
    expect(await search(page)).not.toContain('basemap=');
  });

  test('when every frame serves the placeholder image the map falls back to the plain map', async ({
    page
  }) => {
    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME]);
    satelliteStub.servePlaceholderFrame(SATELLITE_NEW_FRAME.objectId);
    satelliteStub.servePlaceholderFrame(SATELLITE_FRAME.objectId);
    const warnings = collectPlaceholderWarnings(page);

    // Drought opens on satellite by default; the guard keeps that default safe.
    await gotoApp(page, '?view=console');
    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    expect(warnings.length).toBeGreaterThan(0);
    await expect(btn).toHaveAttribute('data-imagery-unavailable', '');
    await expect(btn).toHaveAttribute('title', /unavailable/);
    await expect(btn).toHaveAccessibleDescription(/unavailable/);
    expect(await search(page)).not.toContain('basemap=');
    // No frame was installed: the placeholder frames never reached the map.
    expect(satelliteStub.renderedFrameIds).toEqual([]);
    await expect(page.locator('html')).not.toHaveAttribute(SATELLITE_STAMP);
    await expect(page.locator(IMAGERY_CHIP)).toBeHidden();
    await expect(page.locator('#map-osm-credit')).toBeVisible();
    // The words a sighted visitor can read: the Impact Briefing says so, with no observation time.
    const notes = await openTechnicalInformation(page);
    await expect(notes).toContainText(SATELLITE_UNAVAILABLE_NOTE);
    await expect(notes).not.toContainText(SATELLITE_CAVEAT_NOTE);
  });

  test('placeholder map tiles from a frame whose probe passed are never drawn', async ({
    page
  }) => {
    // The probe sees imagery but the map tiles come back as the placeholder:
    // each is answered transparent and the frame is dropped; with no other
    // frame the walk back ends on the plain map.
    satelliteStub.servePlaceholderFrame(SATELLITE_FRAME.objectId, 'tiles');
    const warnings = collectPlaceholderWarnings(page);

    await gotoApp(page, '?view=console&basemap=satellite');
    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    expect(warnings.length).toBeGreaterThan(0);
    await expect(btn).toHaveAttribute('data-imagery-unavailable', '');
    expect(satelliteStub.renderedFrameIds).toContain(SATELLITE_FRAME.objectId);
    await expect(page.locator('html')).not.toHaveAttribute(SATELLITE_STAMP);
    await expect(page.locator(IMAGERY_CHIP)).toBeHidden();
    await expect.poll(async () => search(page)).not.toContain('basemap=');
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
    // Stop advancing at rollback so the restored frame can load before its own deadline.
    await expect.poll(async () => {
      await page.clock.fastForward(1_000);
      return chip.textContent();
    }, { intervals: [100] }).toContain('refresh delayed');
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).not.toContain('basemap=');
  });

  test('a refresh whose frame serves placeholder tiles restores the last known-good frame', async ({
    page
  }) => {
    const warnings = collectPlaceholderWarnings(page);
    await page.clock.install();
    await gotoApp(page, '?view=console&basemap=satellite');
    const chip = page.locator(IMAGERY_CHIP);
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));

    satelliteStub.setFrames([SATELLITE_NEW_FRAME, SATELLITE_FRAME]);
    satelliteStub.servePlaceholderFrame(SATELLITE_NEW_FRAME.objectId, 'tiles');
    await page.clock.fastForward(10 * 60_000);

    await expect.poll(() =>
      satelliteStub.renderedFrameIds.includes(SATELLITE_NEW_FRAME.objectId)
    ).toBe(true);
    // Stop advancing at rollback so the restored frame can load before its own deadline.
    await expect.poll(async () => {
      await page.clock.fastForward(1_000);
      return chip.textContent();
    }, { intervals: [100] }).toContain('refresh delayed');
    await expect(chip).toContainText(satelliteObservationRangeText(SATELLITE_FRAME));
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute(SATELLITE_STAMP, String(SATELLITE_FRAME.objectId));
    expect(await search(page)).not.toContain('basemap=');
    expect(warnings.length).toBeGreaterThan(0);
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
    // Owner direction 2026-08-31: the credits render in the map-information
    // panel; the attribution control is gone.
    // Value-only migration (S30D D1 M22, DR-162; design record
    // acknowledgements-table.md section 4.3): the OpenStreetMap underlay's
    // credit is on the map itself while it draws, and the NOAA imagery is
    // credited by its row in the Acknowledgements, reached through the
    // credits line's pointer.
    await expect(page.locator('#map-osm-credit')).toBeVisible();
    await expect(page.locator('#map-osm-credit')).toContainText('OpenStreetMap');
    await page.locator('#map-info-btn').click();
    await page.locator('#map-info-attribution button[data-open-acknowledgements]').click();
    // The GOES GeoColor imagery (src/map/satellite.ts, the
    // `satellite-geocolor` provider) is found by the product it credits:
    // through its provider link to the rows that credit it, never by an
    // issuer name alone. The NESDIS Satellite Maps row is that credit.
    const geoColorRows = PROVIDERS['satellite-geocolor'];
    expect(geoColorRows).toContain('noaa-nesdis');
    for (const id of geoColorRows) {
      await expect(
        page.locator(`#impact-panel .impact-acknowledgements [data-ack-id="${id}"] .ack-name`)
      ).toHaveText(ACKNOWLEDGEMENTS[id].name);
    }
    await expect(
      page.locator('#impact-panel .impact-acknowledgements [data-ack-id="noaa-nesdis"] .ack-name')
    ).toHaveText('NOAA NESDIS Satellite Maps');
    await page.keyboard.press('Escape');
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
    // The default basemap is back on screen (its credit returns).
    // Value-only migration (S30D D1 M22, DR-162): that credit is on the map.
    await expect(page.locator('#map-osm-credit')).toBeVisible();
    await expect(page.locator('#map-osm-credit')).toContainText('OpenStreetMap');
  });
});
