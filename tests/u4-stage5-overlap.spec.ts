import { test, expect } from './offline-test';

import { gotoApp, layerCheckbox } from './helpers';

/**
 * U4 stage-5 matrix findings, pinned (the browser pass caught three
 * bottom-chrome collisions): the embed viewport gets the auto-compact
 * attribution control; the desktop attribution bar never reaches the joined
 * scale controls.
 */

async function box(page: import('./offline-test').Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

async function boxes(page: import('./offline-test').Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })
  );
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
  test('the 400x600 embed seats the credits disclosure closed', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console');
    // The disclosure starts closed, freeing the bottom bar the legend chip
    // and ATNI badge sit on while keeping credits one tap away (owner
    // direction 2026-08-31: the question-mark panel carries the credits).
    await expect(page.locator('#map-info-btn')).toBeVisible();
    await expect(page.locator('#map-info-panel')).toBeHidden();
  });

  test('the embed credits button is clickable, never under the brand badge', async ({
    page
  }) => {
    // The live 0.6.9 pass: the ATNI badge intercepted the disclosure's
    // pointer events at 400x600, locking the data-source disclosure. A
    // trial click exercises real hit-testing; it fails on interception.
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console');
    const toggle = page.locator('#map-info-btn');
    await expect(toggle).toBeVisible();
    await toggle.click({ trial: true });

    const toggleBox = await toggle.boundingBox();
    const badgeBox = await page.locator('.embed-brand').boundingBox();
    if (!toggleBox || !badgeBox) throw new Error('toggle or badge has no box');
    expect(
      intersects(toggleBox, badgeBox),
      'the brand badge overlaps the credits button'
    ).toBe(false);
  });

  test('at 1024 the credits button clears the joined scales', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoApp(page, '?view=console');
    await page.evaluate(() => document.fonts.ready);

    const credits = await box(page, '.map-info-btn');
    const scales = await boxes(page, '.maplibregl-ctrl-scale');
    expect(scales).toHaveLength(2);
    for (const scale of scales) {
      expect(intersects(credits, scale), 'the credits button overlaps a scale control').toBe(false);
    }
    const orderedScales = [...scales].sort((a, b) => a.y - b.y);
    const scaleGap = orderedScales[1]!.y -
      (orderedScales[0]!.y + orderedScales[0]!.height);
    expect(Math.abs(scaleGap), `scale controls have a ${scaleGap}px gap`).toBeLessThanOrEqual(1);
    expect(
      Math.abs(orderedScales[1]!.x - orderedScales[0]!.x),
      'joined scale controls do not share a left edge'
    ).toBeLessThanOrEqual(1);
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
