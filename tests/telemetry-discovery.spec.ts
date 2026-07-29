import { test, expect } from '@playwright/test';
import { PILL, gotoApp, layerCheckbox, layerPill, waitForLayerSettled } from './helpers';

const SEED_STATION_IDS = ['ihr', 'bono3', 'snotel_791'] as const;

function seedMarker(page: import('@playwright/test').Page, id: string) {
  return page.locator(`.telemetry-marker[data-telemetry-station-id="${id}"]`);
}

/**
 * A2 telemetry discovery smoke coverage. Discovery can enrich the map with
 * live USGS stations, but the deterministic contract is the curated seed set:
 * those markers render whether the live endpoint succeeds, fails, or asks the
 * user to zoom in.
 *
 * Telemetry left the default-on set (0.7.0 H4, D-0.7.0-018 item 1), so these
 * specs activate it explicitly via `?layers=`. At the default Washington
 * region framing the viewport is wider than the 25-square-degree discovery
 * gate (D-0.7.0-007), so the deterministic terminal pill here is
 * "zoom in to load" with the curated seeds rendered; the discovery-enriched
 * path is exercised by the RAWS gate spec at a tighter viewport.
 */
const TELEMETRY_ON = '?layers=usdm,tribal,telemetry';

test.describe('telemetry discovery', () => {
  test('telemetry reaches a terminal pill and renders curated seeds', async ({
    page
  }) => {
    await gotoApp(page, TELEMETRY_ON);

    await waitForLayerSettled(page, 'telemetry');
    // The H4 honesty contract, pinned exactly: at this wide viewport the
    // pill is "zoom in to load", never live / live (partial) / unavailable.
    await expect(layerPill(page, 'telemetry')).toHaveText(PILL.zoomIn);

    for (const id of SEED_STATION_IDS) {
      await expect(seedMarker(page, id)).toHaveCount(1);
    }
  });

  test('toggling telemetry off clears markers, cap note, and pill', async ({ page }) => {
    await gotoApp(page, TELEMETRY_ON);
    await waitForLayerSettled(page, 'telemetry');

    await layerCheckbox(page, 'telemetry').uncheck();

    for (const id of SEED_STATION_IDS) {
      await expect(seedMarker(page, id)).toHaveCount(0);
    }
    await expect(page.locator('#telemetry-discovery-note')).toBeHidden();
    await expect(layerPill(page, 'telemetry')).toBeEmpty();
  });

  test('toggling telemetry back on re-renders curated seeds and settles again', async ({
    page
  }) => {
    await gotoApp(page, TELEMETRY_ON);
    await waitForLayerSettled(page, 'telemetry');

    await layerCheckbox(page, 'telemetry').uncheck();
    await expect(layerPill(page, 'telemetry')).toBeEmpty();

    await layerCheckbox(page, 'telemetry').check();
    await waitForLayerSettled(page, 'telemetry');
    await expect(layerPill(page, 'telemetry')).toHaveText(PILL.zoomIn);

    for (const id of SEED_STATION_IDS) {
      await expect(seedMarker(page, id)).toHaveCount(1);
    }
  });
});
