import { test, expect } from '@playwright/test';
import { PILL, gotoApp, layerPill, waitForLayerSettled } from './helpers';

/**
 * Discovery zoom gates. Two layers of gating apply since 0.7.0 H4
 * (D-0.7.0-007): the whole-layer discovery gate (a viewport wider than 25
 * raw square degrees fires NO discovery queries and the pill reads "zoom in
 * to load"), and inside it the original RAWS-specific cap (critical-review
 * #3). At the national framing nothing may fire; after flying to a station
 * (zoom 9, a few square degrees) discovery runs and RAWS fires. Assertions
 * count request INITIATION (independent of whether the NIFC upstream is
 * reachable), so they are deterministic.
 */
test.describe('telemetry discovery zoom gates', () => {
  test('no discovery fires at the national framing; RAWS fires after flying to a station', async ({
    page
  }) => {
    let rawsRequests = 0;
    let usgsDiscoveryRequests = 0;
    page.on('request', (req) => {
      if (req.url().includes('/PublicView_RAWS/')) rawsRequests++;
      if (req.url().includes('waterservices.usgs.gov') && req.url().includes('bBox')) {
        usgsDiscoveryRequests++;
      }
    });

    // National framing: far above the 25-square-degree gate, so the layer
    // settles at "zoom in to load" without a single discovery query.
    await gotoApp(page, '?region=national&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    await expect(layerPill(page, 'telemetry')).toHaveText(PILL.zoomIn);
    expect(rawsRequests, 'RAWS must not fire at the national framing').toBe(0);
    expect(
      usgsDiscoveryRequests,
      'USGS viewport discovery must not fire at the national framing'
    ).toBe(0);

    // Fly to a curated station (zoom 9): the viewport now fits the gate, so
    // discovery re-runs and RAWS is allowed to fire. The Water & Snow panel is
    // collapsed by default (U3f2), so reveal it before reaching the station.
    await page.locator('#telemetry-reveal').click();
    await page.locator('.telemetry-item', { hasText: 'Ice Harbor Dam' }).click();
    await expect
      .poll(() => rawsRequests, {
        message: 'RAWS should fire once the viewport is inside the discovery gate',
        timeout: 20_000
      })
      .toBeGreaterThan(0);
  });
});
