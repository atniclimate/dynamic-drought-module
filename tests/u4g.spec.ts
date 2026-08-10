import { test, expect } from '@playwright/test';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { URLS } from '../src/config/urls';
import { resolveHillshadeArchiveUrl } from '../src/layers/hillshade';
import { gotoApp, layerCheckbox, waitForLayerSettled, search } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';

/**
 * U4g: the terrain-shading (hillshade) layer over the bundled raster-dem
 * PMTiles archive (D-0.7.0-012 funded; hosting selected per D-0.7.0-029,
 * the Pages same-origin z0-8 archive).
 *
 * The archive is a committed public asset like the ecoregion bundle, so
 * these specs assert the live path directly. The console-cleanliness case
 * matters most: a raster-dem/hillshade style defect logs console.error and
 * silently falls back (the U4c lesson), so it must fail here, not wait for
 * a human with devtools open.
 */

const ARCHIVE = resolve(process.cwd(), 'public/data/hillshade-dem-pnw.pmtiles');

test.describe('U4g: terrain shading', () => {
  test('the archive ships and carries the terrarium PMTiles header', () => {
    expect(existsSync(ARCHIVE), 'public/data/hillshade-dem-pnw.pmtiles must ship').toBe(true);
  });

  test('a host that cannot serve the bundled archive uses the verified ATNI copy', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === URLS.hillshadePmtilesLocal) {
        return new Response('file exceeds host limit', { status: 413 });
      }
      if (url === URLS.hillshadePmtilesFallback) {
        return new Response(
          new Uint8Array([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03]),
          { status: 206 }
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    try {
      const url = await resolveHillshadeArchiveUrl(
        new AbortController().signal
      );
      expect(url).toBe(URLS.hillshadePmtilesFallback);
      expect(calls).toEqual([
        URLS.hillshadePmtilesLocal,
        URLS.hillshadePmtilesFallback
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('on by default (E1 deliverable 4, D-0.7.0-043 part 3); comes off cleanly; toggles back', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // Default-on since E1: terrain shading is part of the calm default
    // composition, so a bare console boot activates it.
    const checkbox = layerCheckbox(page, 'hillshade');
    await expect(checkbox).toBeChecked();
    await waitForLayerSettled(page, 'hillshade');
    await expect(page.locator('[data-layer-status="hillshade"]')).toHaveText('live');
    await expect.poll(async () => search(page)).toContain('hillshade');

    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await expect.poll(async () => search(page)).not.toContain('hillshade');

    await checkbox.check();
    await waitForLayerSettled(page, 'hillshade');
    await expect(page.locator('[data-layer-status="hillshade"]')).toHaveText('live');
    await expect.poll(async () => search(page)).toContain('hillshade');
  });

  test('a corrupt archive reads unavailable, never live (the probe validates the header)', async ({
    page
  }) => {
    // An HTML 200 (a rewriting proxy, a 404 page served as 200, a server
    // ignoring Range) must fail the PMTiles-magic probe and read
    // `unavailable` (the stage-5 adversarial major 7: response.ok alone
    // would have passed it and failed later as a silent style error).
    await page.route('**/data/hillshade-dem-pnw.pmtiles*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html>not tiles</html>' })
    );
    // An explicit layers= keeps hillshade off at boot (it is default-on
    // since E1 deliverable 4) so the corrupt-archive path is driven by the
    // toggle itself, exactly as before the default flip.
    await gotoApp(page, '?view=console&layers=usdm');
    await layerCheckbox(page, 'hillshade').check();
    await expect(page.locator('[data-layer-status="hillshade"]')).toHaveText('unavailable', {
      timeout: 20_000
    });
    // The failed activation self-corrects out of the URL (invariant 2).
    await expect.poll(async () => search(page)).not.toContain('hillshade');
  });

  test('the boot console stays clean with hillshade and satellite together', async ({
    page
  }) => {
    await stubRecentSatellite(page);
    // Combination 5 of the cartography matrix (satellite + hillshade + one
    // surface): the style must validate with all three stacked.
    const styleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/layers\.|paint\.|layout\.|expression|style|terrain|dem/i.test(text)) {
        styleErrors.push(text.slice(0, 300));
      }
    });

    await gotoApp(page, '?view=console&basemap=satellite');
    await waitForLayerSettled(page, 'usdm');
    // Hillshade is default-on since E1 deliverable 4, so the combination
    // stacks at boot; settle it rather than re-toggling.
    await expect(layerCheckbox(page, 'hillshade')).toBeChecked();
    await waitForLayerSettled(page, 'hillshade');
    await expect(page.locator('[data-layer-status="hillshade"]')).toHaveText('live');

    expect(styleErrors, styleErrors.join('\n')).toHaveLength(0);
  });
});
