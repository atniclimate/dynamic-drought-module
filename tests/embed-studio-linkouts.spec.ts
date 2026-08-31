import { test, expect, type Locator } from '@playwright/test';
import { gotoApp } from './helpers';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test.describe('Embed studio link-outs at 400x600', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('the pair stacks at the right without colliding with map chrome', async ({ page }) => {
    await gotoApp(page, '?embed=true');

    const pair = page.locator('#studio-linkout-pair');
    const place = pair.locator('#place-studio-entry');
    const layers = pair.locator('#layers-studio-entry');
    const share = page.locator('#share-btn');
    const reset = page.locator('#reset-btn');
    const expand = page.locator('#sidebar-expand');

    await expect(pair).toBeVisible();
    await expect(expand).toBeVisible();

    const [pairBox, placeBox, layersBox, shareBox, resetBox, expandBox] = await Promise.all([
      pair.boundingBox(),
      place.boundingBox(),
      layers.boundingBox(),
      share.boundingBox(),
      reset.boundingBox(),
      expand.boundingBox()
    ]);
    expect(pairBox).not.toBeNull();
    expect(placeBox).not.toBeNull();
    expect(layersBox).not.toBeNull();
    expect(shareBox).not.toBeNull();
    expect(resetBox).not.toBeNull();
    expect(expandBox).not.toBeNull();

    expect(pairBox!.width).toBeLessThanOrEqual(240);
    expect(layersBox!.y).toBeGreaterThanOrEqual(placeBox!.y + placeBox!.height);
    expect(Math.abs(400 - 8 - (shareBox!.x + shareBox!.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(400 - 8 - (resetBox!.x + resetBox!.width))).toBeLessThanOrEqual(1);
    expect(overlaps(pairBox!, expandBox!)).toBe(false);
    expect(overlaps(shareBox!, expandBox!)).toBe(false);
    expect(overlaps(resetBox!, expandBox!)).toBe(false);

    for (const selector of ['.map-info-btn', '#embed-date-stamp']) {
      const chrome = page.locator(selector);
      if (await chrome.isVisible()) {
        const chromeBox = await chrome.boundingBox();
        expect(chromeBox).not.toBeNull();
        expect(overlaps(pairBox!, chromeBox!)).toBe(false);
      }
    }
  });
});
