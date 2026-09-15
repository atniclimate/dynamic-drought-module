import { test, expect, type Locator } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';

async function rect(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test.describe('mobile side rail and glass panels', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('boots map-first with a vertical rail and no drawer affordance', async ({ page }) => {
    await gotoApp(page);

    const app = page.locator('#app');
    const rail = page.locator('#mobile-footer-nav');
    const buttons = rail.locator('button[data-tab]');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('aria-label', 'Mobile panels');
    await expect(buttons).toHaveCount(4);
    await expect(page.locator('#sheet-grabber')).toBeHidden();
    await expect(page.locator('.sheet-hint')).toHaveCount(0);
    await expect(page.locator('#sidebar')).toBeHidden();

    const boxes = await buttons.evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })
    );
    expect(boxes.every((box) => Math.abs(box.x - boxes[0]!.x) < 1)).toBe(true);
    expect(boxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index]!.y).toBeGreaterThan(boxes[index - 1]!.y);
    }

    const mapBox = await rect(page.locator('#map'));
    expect(mapBox.height).toBeGreaterThanOrEqual(840);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  });

  test('Place drops a top-anchored glass panel and a second press closes it', async ({ page }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const place = page.locator('#mobile-footer-nav button[data-tab="place"]');

    await expect(place).toHaveAttribute('aria-controls', 'sidebar');
    await place.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(place).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sheet-search [data-ddm-search]')).toBeVisible();

    const railBox = await rect(page.locator('#mobile-footer-nav'));
    const panelBox = await rect(page.locator('#sidebar'));
    expect(panelBox.y).toBeGreaterThan(40);
    expect(panelBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(844);
    const panelStyle = await page.locator('#sidebar').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        position: style.position,
        background: style.backgroundColor,
        backdrop: style.backdropFilter,
        radius: style.borderRadius
      };
    });
    expect(panelStyle.position).toBe('fixed');
    expect(panelStyle.background).toMatch(/rgba\(/);
    expect(panelStyle.backdrop).not.toBe('none');
    expect(panelStyle.radius).not.toBe('0px');

    await place.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(place).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sidebar')).toBeHidden();
  });

  test('Escape closes the active panel and returns focus to its rail button', async ({ page }) => {
    await gotoApp(page);
    const layers = page.locator('#mobile-footer-nav button[data-tab="layers"]');
    await layers.click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');

    await page.locator('#region-select').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(layers).toBeFocused();
    await expect(layers).toHaveAttribute('aria-expanded', 'false');
  });

  test('Layers and Alerts keep their content and the rail remains available', async ({ page }) => {
    await gotoApp(page, '?view=console');
    const app = page.locator('#app');
    await page.locator('#hazard-rail button[data-preset="hazard-enso"]').click();
    const layers = page.locator('#mobile-footer-nav button[data-tab="layers"]');
    await layers.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#panel-region')).toBeVisible();
    await expect(page.locator('#panel-quick-views')).toBeVisible();
    await expect(page.locator('#sheet-enso-flow-host')).toBeVisible();
    await expect(page.locator('#sheet-enso-flow-host #enso-flow-controls')).toBeVisible();
    await expect(page.locator('#sheet-all-layers-btn')).toBeVisible();

    await page.locator('#sheet-all-layers-btn').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(page.locator('#panel-layers')).toBeVisible();
    await expect(page.locator('#mobile-footer-nav')).toBeVisible();
    const fullPanel = await rect(page.locator('#sidebar'));
    expect(fullPanel.y).toBeGreaterThan(40);
    expect(fullPanel.y + fullPanel.height).toBeLessThanOrEqual(844);

    const alerts = page.locator('#mobile-footer-nav button[data-tab="alerts"]');
    await alerts.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-alerts')).toBeVisible();
    await expect(page.locator('#sheet-alerts .panel-title')).toHaveText('Alerts');
    await expect(alerts).toHaveAttribute('aria-expanded', 'true');
    await expect(layers).toHaveAttribute('aria-expanded', 'false');
  });

  test('a selected place keeps the at-hand summary and full report path', async ({ page }) => {
    await gotoApp(page, '?select=state:WA');
    const app = page.locator('#app');
    const hostedPanel = page.locator('#sheet-report .impact-panel');
    await expect(hostedPanel).toHaveCount(1, { timeout: 15_000 });
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    await page.locator('#sheet-report-door').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(hostedPanel).toBeVisible();
    await expect(hostedPanel).toHaveAttribute('aria-modal', 'false');

    await page.locator('.impact-panel-close').focus();
    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(hostedPanel).toHaveClass(/\bopen\b/);
    await expect(page.locator('#sheet-report-door')).toBeFocused();
    await expect(page.locator('.sheet-at-hand-title')).not.toHaveText('Pick a place');
  });

  test('an open desktop report rehosts when the viewport becomes a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await gotoApp(page, '?view=console');
    await page.locator('.region-briefing-btn').click();
    await expect(page.locator('#impact-panel')).toHaveClass(/\bopen\b/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');
    await expect(page.locator('#sheet-report .impact-panel')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    const panel = page.locator('#impact-panel');
    await expect.poll(async () => panel.evaluate((element) => element.parentElement === document.body)).toBe(true);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
  });

  test('short phones keep search results and panel actions reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await gotoApp(page);
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    const input = page.locator('#sheet-search [data-ddm-search]');
    await expect(input).toBeVisible();
    await input.fill('Yak');
    const results = page.locator('#sheet-search .ddm-search-results');
    await expect(results).toBeVisible();

    const panelBox = await rect(page.locator('#sidebar'));
    const inputBox = await rect(input);
    const resultsBox = await rect(results);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(600);
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(600);
    expect(resultsBox.y + resultsBox.height).toBeLessThanOrEqual(600);
  });

  test('opening a side panel does not add a bottom camera inset', async ({ page }) => {
    const southEdges: number[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.includes('biamaps.geoplatform.gov')) return;
      const match = /geometry=([^&]+)/.exec(url);
      if (!match) return;
      const values = decodeURIComponent(match[1]!).split(',').map(Number);
      if (values.length === 4 && values.every(Number.isFinite)) southEdges.push(values[1]!);
    });
    await gotoApp(page, '?layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await expect.poll(() => southEdges.length).toBeGreaterThan(0);
    const before = southEdges[southEdges.length - 1]!;

    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await page.waitForTimeout(350);
    const after = southEdges[southEdges.length - 1]!;
    expect(Math.abs(after - before)).toBeLessThan(0.2);
  });

  test('a place chosen while the full panel is open still frames the map', async ({ page }) => {
    const envelopes: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.includes('biamaps.geoplatform.gov')) return;
      const match = /geometry=([^&]+)/.exec(url);
      if (match) envelopes.push(decodeURIComponent(match[1]!));
    });
    await gotoApp(page, '?layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await expect.poll(() => envelopes.length).toBeGreaterThan(0);
    const beforeCount = envelopes.length;

    await page.locator('#mobile-footer-nav button[data-tab="brief"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');
    const input = page.locator('#sheet-search [data-ddm-search]');
    await input.fill('Washington');
    await page.locator('#sheet-search .ddm-search-result').filter({ hasText: 'Washington' }).first().click();

    await expect.poll(() => envelopes.length).toBeGreaterThan(beforeCount);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');
    expect(envelopes[envelopes.length - 1]).not.toBe(envelopes[beforeCount - 1]);
  });

  test('phone URLs cannot surface the desktop 3D control', async ({ page }) => {
    await gotoApp(page, '?cluster=wildfire&fire3d=true');
    await expect(page.locator('#shell-fire3d')).toHaveCount(0);
    await expect(page.locator('#shell-fire3d-refused')).toHaveCount(0);
  });
});

test.describe('mobile embed exit', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('embed stays rail-free and exits to the closed mobile shell', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
    await expect(page.locator('#hazard-rail')).toBeHidden();

    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bembed\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#mobile-footer-nav')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#sheet-grabber')).toBeHidden();
  });
});
