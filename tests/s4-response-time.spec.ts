import { test, expect, type Page } from './offline-test';
import { gotoApp, waitForLayerSettled } from './helpers';

/**
 * S4c: the desktop Brief place click and the compact temporal adapter (the
 * TimeBarSpec facade).
 *
 * The response case drives the live reservation layer against the synthetic
 * route fixture (gotoApp's boundary stubs): a center click is a real
 * place-bearing hit. Since the owner's 2026-11-13 ruling ("clicking on a place
 * should open the impact briefing drawer") it opens the place's briefing on
 * the desktop Brief shell: never a map popup, and never the panel-foot card,
 * which carried the place response before.
 */

async function clickCenterForBriefing(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const panel = page.locator('#impact-panel');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(panel).toBeVisible({ timeout: 1500 });
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

test.describe('S4c desktop Brief place click', () => {
  test('a place-bearing click in desktop Brief opens its briefing: no popup, no panel-foot card, no door', async ({
    page
  }) => {
    // The reservation layer alone, so the one place under the centre is the
    // synthetic reservation and the briefing's title is known.
    await gotoApp(page, '?region=washington_state&view=brief&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterForBriefing(page);

    await expect(page.locator('#impact-panel-title')).toHaveText('Synthetic Reservation Fixture');
    // The briefing is the one answer: no map popup, no foot card, no door to it.
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
    await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
    await expect(page.locator('[data-ddm-impact-trigger]')).toHaveCount(0);
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
    // VIEW / MAP CONTEXT / WHEN band order. The date line is Console-only
    // (owner 2026-11-13), so in Brief it is only attached.
    await expect(page.locator('#shell-time[data-has-spec="true"]')).toBeAttached({
      timeout: 45_000
    });
    await expect(page.locator('#shell-panel + #time-bar')).toHaveCount(1);

    // Console: the shell panel and the full bar are BOTH visible there,
    // so the reseat would be a visible order regression, not a masked
    // one. The order must hold after the owner's install too.
    await page.locator('.view-switch [data-view="console"]').click();
    await expect(page.locator('#time-bar')).toBeVisible();
    await expect(page.locator('#shell-time')).toBeVisible();
    await expect(page.locator('#shell-panel + #time-bar')).toHaveCount(1);
  });
});

test.describe('S4c compact/detail temporal adapters', () => {
  test('the compact WHEN row mirrors the installed spec and carries no time door', async ({
    page
  }) => {
    await stubUsdmTimeSurface(page);
    await gotoApp(page, '?view=brief&layers=usdm');
    // The USDM surface installs its TimeBarSpec on activation; the
    // compact row mirrors it through the facade. It sits at the column
    // foot and reads in Console only (owner 2026-11-13): attached in Brief.
    const timeRow = page.locator('#shell-time[data-has-spec="true"]');
    await expect(timeRow).toBeAttached({ timeout: 45_000 });
    await expect(timeRow).toBeHidden();
    await expect(page.locator('.shell-time-headline')).not.toHaveText('');
    await expect(page.locator('.shell-time-headline')).toHaveCSS('font-family', /^"?DDM Heros"?,/);
    await expect(page.locator('.shell-time-headline')).toHaveCSS('font-variant-numeric', /^(?:lining-nums tabular-nums|tabular-nums lining-nums)$/);

    // The full sidebar rail stands down in desktop Brief; the embed date
    // chip contract is untouched.
    await expect(page.locator('#time-bar')).toBeHidden();

    // Console draws the line as the scroll column's very last element.
    await page.locator('.view-switch [data-view="console"]').click();
    await expect(timeRow).toBeVisible();
    await expect(page.locator('.shell-when #shell-time')).toHaveCount(0);
    expect(
      await page.locator('.sidebar-scroll').evaluate((el) => el.lastElementChild?.id)
    ).toBe('shell-time-island');

    // The WHEN row is a read-only date statement: no time door, no popover.
    await expect(page.locator('#shell-time-more')).toHaveCount(0);
    await expect(page.locator('#shell-time-popover')).toHaveCount(0);
  });
});
