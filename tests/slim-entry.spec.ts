import { test, expect } from '@playwright/test';
import { gotoApp, search } from './helpers';

const PANEL_RUNTIME_PRIMARY =
  '**/assets/impact-panel-runtime-primary-*.js';
const WORKER_PROXY = 'https://ddm-proxy.atniclimate.workers.dev/**';

test.describe('lazy impact briefing cluster', () => {
  test('a deep link opens and hydrates the briefing while preserving embed state', async ({
    page
  }) => {
    // Settle the optional live proxy reads immediately. The bundled El Nino /
    // Southern Oscillation evidence still hydrates the long-range horizon.
    await page.route(WORKER_PROXY, (route) => route.abort('failed'));

    await gotoApp(page, '?embed=true&view=brief&select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(
      panel.locator('.impact-claim-derived', {
        hasText: 'Relative Oceanic Nino Index'
      }).first()
    ).toBeVisible({ timeout: 25_000 });

    const params = new URLSearchParams(await search(page));
    expect(params.get('embed')).toBe('true');
    expect(params.has('select')).toBe(false);
  });

  test('a failed panel chunk uses the one mobile sheet and its detent contract', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(PANEL_RUNTIME_PRIMARY, (route) => route.abort('failed'));

    await gotoApp(page, '?view=brief&select=state:WA');

    const app = page.locator('#app');
    const panel = page.locator('#impact-panel');
    await expect(page.locator('.impact-panel')).toHaveCount(1, {
      timeout: 15_000
    });
    await expect(page.locator('#sheet-report > #impact-panel')).toHaveCount(1);
    await expect(panel).toHaveClass(/\bsheet-hosted\b/);
    await expect(panel).toHaveClass(/\bopen\b/);
    await expect(panel).toHaveAttribute('aria-modal', 'false');
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-report-door')).toBeVisible();
    await expect(page.locator('.sheet-at-hand-title')).toHaveText('Washington');

    await page.locator('#sheet-report-door').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-capability-unavailable')).toContainText(
      'Drought impact unavailable'
    );
    await expect(panel.locator('.impact-horizon-note')).toContainText(
      'application module could not load'
    );

    await panel.locator('.impact-panel-close').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(panel).toHaveClass(/\bopen\b/);
    await expect(page.locator('#sheet-report-door')).toBeFocused();
    expect(pageErrors).toEqual([]);
  });

  test('the unavailable modal contains forward and reverse Tab focus', async ({
    page
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(PANEL_RUNTIME_PRIMARY, (route) => route.abort('failed'));

    await gotoApp(page, '?embed=true&view=brief&select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel.locator('.impact-panel-close')).toBeFocused();

    await page.keyboard.press('Tab');
    expect(
      await panel.evaluate((element) => element.contains(document.activeElement))
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(
      await panel.evaluate((element) => element.contains(document.activeElement))
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test('a transient primary chunk failure recovers on a later open', async ({
    page
  }) => {
    const pageErrors: Error[] = [];
    const runtimeRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (
        /\/assets\/impact-panel-runtime-(primary|recovery)-[^/]+\.js$/.test(
          request.url()
        )
      ) {
        runtimeRequests.push(request.url());
      }
    });
    await page.route(PANEL_RUNTIME_PRIMARY, (route) => route.abort('failed'));

    await gotoApp(page, '?view=console');
    const trigger = page.locator('#region-briefing-btn');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('.impact-capability-unavailable')).toBeVisible();

    await panel.locator('.impact-panel-close').click();
    await expect(panel).toBeHidden({ timeout: 5_000 });
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(panel.locator('.impact-horizons')).toBeVisible();
    await expect(panel.locator('.impact-capability-unavailable')).toHaveCount(0);

    expect(
      runtimeRequests.some((url) =>
        /\/assets\/impact-panel-runtime-primary-[^/]+\.js$/.test(url)
      )
    ).toBe(true);
    expect(
      runtimeRequests.some((url) =>
        /\/assets\/impact-panel-runtime-recovery-[^/]+\.js$/.test(url)
      )
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test('a close intent drops a late panel chunk completion', async ({ page }) => {
    let releaseRuntime = (): void => {};
    const runtimeRelease = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let markRuntimeStarted = (): void => {};
    const runtimeStarted = new Promise<void>((resolve) => {
      markRuntimeStarted = resolve;
    });

    await page.route(PANEL_RUNTIME_PRIMARY, async (route) => {
      markRuntimeStarted();
      await runtimeRelease;
      await route.continue();
    });

    await gotoApp(page, '?select=state:WA');
    await runtimeStarted;
    await page.locator('.view-switch [data-view="console"]').click();
    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);

    const runtimeResponse = page.waitForResponse((response) =>
      /\/assets\/impact-panel-runtime-primary-[^/]+\.js$/.test(response.url())
    );
    releaseRuntime();
    await runtimeResponse;
    await page.waitForTimeout(500);

    await expect(page.locator('#impact-panel.open')).toHaveCount(0);
  });
});
