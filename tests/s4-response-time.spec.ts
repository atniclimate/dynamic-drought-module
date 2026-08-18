import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { routeAllTribalFixtures } from './tribal-fixtures';

/**
 * S4c: the panel-foot response (the coordinator's swappable sink) and
 * the compact/detail temporal adapters (the TimeBarSpec facade + the
 * "More time" popover), including the focus-restoration contract.
 *
 * The response cases drive the two live Tribal-geography layers against
 * the synthetic route fixtures, exactly as the coordinator suite does:
 * a center click is a real place-bearing hit, and on the desktop shell
 * it must land at the panel foot, not in a map popup.
 */

async function clickCenterForFootResponse(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const foot = page.locator('#panel-response .coordinated-response');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(foot).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
}

async function stubUsdmTimeSurface(page: Page): Promise<void> {
  const body = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { DM: 2, MapDate: Date.UTC(2026, 7, 11) },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]]
        }
      }
    ]
  });
  const fulfill = (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body });
  await page.route('**/USDM_current/**', fulfill);
  await page.route('**/USDM_archive/**', fulfill);
}

test.describe('S4c panel-foot response', () => {
  test('a place-bearing click lands at the panel foot, frozen head over scrolling body, no popup', async ({
    page
  }) => {
    await routeAllTribalFixtures(page);
    await gotoApp(page);
    // The sink registers with the island; the fixture layers must paint.
    await expect(page.locator('.shell-cluster-btn')).toHaveCount(4);
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterForFootResponse(page);

    // One response, at the foot; never a second surface.
    await expect(page.locator('.maplibregl-popup-content')).toHaveCount(0);
    const card = page.locator('#panel-response .panel-response-card');
    await expect(card).toBeVisible();
    // Frozen head: title and the briefing door.
    await expect(
      card.locator('.coordinated-response-head .popup-title')
    ).toBeVisible();
    // The active-cluster-aware context line.
    await expect(card.locator('.panel-response-context')).toHaveText(
      /view · Current$/
    );
    // The scrolling body exists as the one bounded scroll region.
    await expect(card.locator('.coordinated-response-body')).toBeAttached();

    // Closing retires the response and clears the place selection.
    await card.locator('.panel-response-close').click();
    await expect(
      page.locator('#panel-response .coordinated-response')
    ).toHaveCount(0);
    await expect(page.locator('#brief-place-context')).toBeHidden();
  });
});

test.describe('S4c time-bar desktop seat (DG-080 review finding 4)', () => {
  test('a real temporal owner install keeps the bar seated after the shell panel in Brief and Console', async ({
    page
  }) => {
    await stubUsdmTimeSurface(page);
    await gotoApp(page, '?view=brief&layers=usdm');
    // The USDM surface installs its TimeBarSpec on activation; every
    // install re-runs syncTimeBarHost, which used to reseat the bar
    // directly after #brief-head, above the shell, undoing the static
    // VIEW / MAP CONTEXT / WHEN band order.
    await expect(page.locator('#shell-time[data-has-spec="true"]')).toBeVisible({
      timeout: 45_000
    });
    await expect(page.locator('#shell-panel + #time-bar')).toHaveCount(1);

    // Console: the shell panel and the full bar are BOTH visible there,
    // so the reseat would be a visible order regression, not a masked
    // one. The order must hold after the owner's install too.
    await page.locator('.view-switch [data-view="console"]').click();
    await expect(page.locator('#time-bar')).toBeVisible();
    await expect(page.locator('#shell-panel + #time-bar')).toHaveCount(1);
  });
});

test.describe('S4c compact/detail temporal adapters', () => {
  test('the compact WHEN row mirrors the installed spec; More time opens the detail; Escape restores focus', async ({
    page
  }) => {
    await stubUsdmTimeSurface(page);
    await gotoApp(page, '?view=brief&layers=usdm');
    // The USDM surface installs its TimeBarSpec on activation; the
    // compact row mirrors it through the facade.
    const timeRow = page.locator('#shell-time[data-has-spec="true"]');
    await expect(timeRow).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.shell-time-headline')).not.toHaveText('');

    // The full sidebar rail stands down on the desktop shell (compact
    // owns the WHEN band); the embed date chip contract is untouched.
    await expect(page.locator('#time-bar')).toBeHidden();

    const more = page.locator('#shell-time-more');
    // W2-D9: the More time door is a disclosure and reports its state.
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    const popover = page.locator('#shell-time-popover');
    await expect(popover).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    // The detail renders from the same spec: the USDM stepped rail (an
    // authored product: a discrete rail, never a Play control).
    await expect(popover.locator('.shell-time-detail')).toBeVisible();
    await expect(popover.locator('.time-bar-rail')).toHaveCount(1);
    await expect(popover.locator('.time-bar-play')).toHaveCount(0);

    // Focus restoration: Escape closes the popover and returns focus to
    // the door that opened it.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
  });
});
