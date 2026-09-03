import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoApp, PILL } from './helpers';
import { routeAllTribalFixtures } from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';

/**
 * DR-035a: boot tolerance for a renderer that cannot start.
 *
 * The failure this guards is the one the honesty doctrine cannot tolerate:
 * an interface that looks complete while showing nothing, indistinguishable
 * from a broken deploy. MapLibre 6 requires WebGL 2 and has no WebGL 1
 * fallback, so "this browser cannot render the map" is now a reachable
 * state on real devices, not a hypothetical.
 *
 * The first case removes WebGL 2 before any application code runs. It does
 * not use `gotoApp`, because `gotoApp` asserts the sidebar's generated
 * controls and those are built from a live map by design; the stubs it
 * installs are also unnecessary here, since a boot that never constructs a
 * map never issues a boundary, minimap, or tile request. The second case
 * uses `gotoApp` unchanged and asserts the notice never appears on a
 * healthy boot.
 */

const NO_WEBGL2_TEXT = 'This browser has no WebGL 2, which the map needs.';
const NOT_RENDERING_TEXT = 'The map is not rendering yet.';

/**
 * Remove WebGL 2 from the page before any script runs, leaving every other
 * context type alone (2D canvas is used elsewhere in the app).
 */
async function removeWebGl2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      ...args: unknown[]
    ) {
      if (args[0] === 'webgl2' || args[0] === 'webgl') return null;
      return (
        original as unknown as (
          this: HTMLCanvasElement,
          ...rest: unknown[]
        ) => unknown
      ).apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

test('without WebGL 2 the chrome still boots and says so', async ({ page }) => {
  await removeWebGl2(page);
  // A raw boot outside gotoApp still installs the suite-wide boundary and
  // minimap stubs itself (tests/boundary-boot-inventory.test.mjs): a map-less
  // boot activates no layer today, but the stub is the rule, not the outcome.
  await routeAllTribalFixtures(page);
  await installMinimapAnalysisStubs(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // The notice is present, visible, and says only what was observed.
  const notice = page.locator('.renderer-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(NO_WEBGL2_TEXT);
  await expect(notice).toHaveAttribute('data-reason', 'no-webgl2');

  // The chrome is up rather than a blank frame: the sidebar and its brand
  // header are visible.
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('.brand-text h1')).toHaveText(
    'Dynamic Drought Module'
  );

  // The build stamps still identify this boot (T1-0 receipt integrity):
  // they are written before the capability probe, so a degraded boot is
  // still attributable to a commit and a run.
  const stamps = await page.evaluate(() => ({
    sha: document.documentElement.dataset.ddmBuildSha ?? '',
    nonce: document.documentElement.dataset.ddmBuildNonce ?? ''
  }));
  expect(stamps.sha.length).toBeGreaterThan(0);
  expect(stamps.nonce.length).toBeGreaterThan(0);

  // Rule 6: no layer may sit at `loading` forever. Nothing activates on a
  // map-less boot, so no pill claims to be loading anything.
  await expect(page.locator(`[data-layer-status]:text-is("${PILL.loading}")`)).toHaveCount(
    0
  );

  // The attribution route stays reachable without a renderer: the
  // map-information disclosure is wired and opens (license obligation).
  await page.locator('#map-info-btn').click();
  await expect(page.locator('#map-info-panel')).toBeVisible();
});

test('a healthy boot never shows the renderer notice', async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator('.renderer-notice')).toHaveCount(0);
  // Neither reason's copy is anywhere on a page whose map is painting.
  await expect(page.getByText(NO_WEBGL2_TEXT)).toHaveCount(0);
  await expect(page.getByText(NOT_RENDERING_TEXT)).toHaveCount(0);
});
