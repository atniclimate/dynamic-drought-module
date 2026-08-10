import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox } from './helpers';
import { stubRecentSatellite } from './satellite-fixture';

/**
 * U4 stage-5 matrix findings, pinned (the browser pass caught three
 * bottom-chrome collisions): the embed viewport gets the auto-compact
 * attribution control; the desktop attribution bar never reaches the
 * scale control; the satellite observation chip gets its own dock row and the
 * dock lifts clear of a wrapped attribution bar.
 */

async function box(page: import('@playwright/test').Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test.describe('U4 stage-5: bottom-chrome collisions stay fixed', () => {
  test.beforeEach(async ({ page }) => {
    await stubRecentSatellite(page);
  });

  test('the 400x600 embed gets the compact attribution control', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console');
    // MapLibre auto-compacts below 640px map width; the collapsed control
    // frees the bottom bar the legend chip and ATNI badge sit on.
    await expect(page.locator('.maplibregl-ctrl-attrib')).toHaveClass(/maplibregl-compact/);
  });

  test('the embed attribution toggle is clickable, never under the brand badge', async ({
    page
  }) => {
    // The live 0.6.9 pass: the ATNI badge intercepted the toggle's pointer
    // events at 400x600, locking the data-source disclosure. A trial click
    // exercises real hit-testing; it fails on interception.
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console');
    const toggle = page.locator('.maplibregl-ctrl-attrib-button');
    await expect(toggle).toBeVisible();
    await toggle.click({ trial: true });

    const toggleBox = await toggle.boundingBox();
    const badgeBox = await page.locator('.embed-brand').boundingBox();
    if (!toggleBox || !badgeBox) throw new Error('toggle or badge has no box');
    expect(
      intersects(toggleBox, badgeBox),
      'the brand badge overlaps the attribution toggle'
    ).toBe(false);
  });

  test('at 1024 with satellite on, the attribution clears the scale and the chip', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoApp(page, '?view=console&basemap=satellite');
    await expect(page.locator('#basemap-vintage')).toBeVisible();

    const attrib = await box(page, '.maplibregl-ctrl-attrib');
    const scale = await box(page, '.maplibregl-ctrl-scale');
    const chip = await box(page, '#basemap-vintage');

    expect(intersects(attrib, scale), 'attribution overlaps the scale control').toBe(false);
    expect(intersects(attrib, chip), 'attribution overlaps the imagery chip').toBe(false);
  });

  test('the observation chip stays readable at 400px', async ({
    page
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console&basemap=satellite');
    const chip = page.locator('#basemap-vintage');
    await expect(chip).toBeVisible();
    const b = await chip.boundingBox();
    if (!b) throw new Error('chip has no box');
    expect(b.height, `chip is ${b.height}px tall`).toBeLessThanOrEqual(64);
  });

  test('places labels stay above a surface activated after them (the reassert hook)', async ({
    page
  }) => {
    // The Node specs pin the arithmetic; this drives the real controller
    // path: places on, then a surface switch, with a clean console (a
    // moveLayer defect logs a style error).
    const styleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/layers\.|paint\.|layout\.|expression|style/i.test(m.text())) {
        styleErrors.push(m.text().slice(0, 200));
      }
    });
    await gotoApp(page, '?view=console');
    await layerCheckbox(page, 'places').check();
    await expect(page.locator('[data-layer-status="places"]')).toHaveText('live');
    // Switch the condition surface (usdm -> heatrisk) AFTER the labels.
    await layerCheckbox(page, 'heatrisk').check();
    await expect(page.locator('[data-layer-status="heatrisk"]')).not.toHaveText('loading...', {
      timeout: 30_000
    });
    expect(styleErrors, styleErrors.join('\n')).toHaveLength(0);
  });
});
