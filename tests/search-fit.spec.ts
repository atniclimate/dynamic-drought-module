import { test, expect, type Page } from './offline-test';

import { gotoApp, waitForLayerSettled } from './helpers';

/**
 * U-UX-FIX-1 DEF-5: the search fit pads only for a panel that will
 * actually render.
 *
 * Owner 2026-11-13: a search pick now opens the briefing drawer on every
 * shell, so the right pad is reserved on this path again and Washington is
 * framed in the map left of the drawer. The history below is the original
 * fault; the probe now sits just west of the open drawer's left edge, where
 * Washington's eastern side (or Idaho at the seam) lands under the padded
 * fit. A fit that never ran leaves the boot's wide framing there instead.
 *
 * The proven cause (2026-07-24 reproduction): briefingCameraPadding() in
 * src/state/deep-link.ts unconditionally reserved the desktop right
 * camera pad of min(480px, 50vw) for the impact panel, and
 * openStateBriefing() applied it even on the summary-first search path,
 * where on desktop the impact panel NEVER opens (the selection renders in
 * the LEFT sidebar column). The camera therefore fit Washington into an
 * effective viewport shrunk by 480px: zoom 5.71 instead of ~6.52, with
 * the frame reaching east past -110 (western Montana and southern
 * Alberta visible). The fix follows the panel: the right pad is reserved
 * only on paths where the impact panel opens over the map; the
 * summary-first desktop fit uses symmetric aesthetic margins.
 *
 * Assertion strategy (production build; the dev-only map handle is
 * dead-code eliminated from dist/, so the camera cannot be read
 * directly): the hover inspector's State readout names the state fill
 * under the cursor, which makes the fitted viewport's east edge
 * observable. After the fit settles at 1440x900, a probe at 90% of the
 * map width on the vertical midline must sit inside or immediately east
 * of Washington's envelope (Washington, or Idaho at the border seam).
 * Under the phantom 480px pad the same probe reads Montana (the buggy
 * fit's east edge is near -110.5), so this spec fails on the pre-fix
 * tree and passes after.
 */

/**
 * Read the hover inspector's State value at a map-relative point,
 * wiggling the mouse so a fresh mousemove always fires (the inspector
 * coalesces to one update per animation frame). Empty string when no
 * state is under the cursor or the readout is hidden.
 */
async function stateUnderProbe(page: Page, fx: number, fy: number): Promise<string> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const x = box.x + box.width * fx;
  const y = box.y + box.height * fy;
  await page.mouse.move(x - 3, y - 2);
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  const item = page.locator('#hover-inspector .hover-item', { hasText: 'State' });
  if ((await item.count()) === 0) return '';
  const text = (await item.first().textContent()) ?? '';
  return text.replace(/^\s*State/, '').trim();
}

test.describe('DEF-5 the search fit frames the place beside the briefing drawer (desktop)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('selecting Washington frames the state in the map left of the open briefing', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    // The probes read the bundled state fill through the hover inspector,
    // so the default-on states layer must be painted and queryable.
    await waitForLayerSettled(page, 'states');

    // Select Washington through the shared search: the pick opens its
    // briefing drawer over the map's right side (owner 2026-11-13).
    await page.locator('#catalog-search [data-ddm-search]').fill('washington');
    await page
      .locator('#catalog-search [data-search-group="place"] [data-search-kind="place"]', {
        hasText: 'Washington'
      })
      .first()
      .click();
    await expect(page.locator('#app')).toHaveAttribute('data-place-selected', '');

    // PREMISE PIN: this path opens the impact panel over the map's right
    // side, so the fit's right pad is the drawer's.
    const drawer = page.locator('#impact-panel.open');
    await expect(drawer).toBeVisible();
    const mapBox = await page.locator('#map').boundingBox();
    const drawerBox = await drawer.boundingBox();
    if (!mapBox || !drawerBox) throw new Error('map or drawer has no box');
    // Just west of the drawer's left edge, on the midline, as a map fraction.
    const fx = (drawerBox.x - 40 - mapBox.x) / mapBox.width;

    // Let the fit's fly settle: the probe must read a STABLE state, not a
    // frame of the animation. Two identical non-empty reads 600ms apart
    // hold only once the camera has landed (mid-fly the longitude under a
    // fixed pixel is still moving).
    let settled = '';
    await expect(async () => {
      const first = await stateUnderProbe(page, fx, 0.5);
      await page.waitForTimeout(600);
      const second = await stateUnderProbe(page, fx, 0.5);
      expect(first).not.toBe('');
      expect(first).toBe(second);
      settled = second;
    }).toPass({ timeout: 25_000 });

    // The load-bearing assertion: the padded fit puts Washington's eastern
    // side (Idaho accepted at the border seam) just west of the drawer.
    expect(
      ['Washington', 'Idaho'],
      `the probe west of the drawer read "${settled}": the fit did not frame ` +
        'Washington in the map left of the open briefing'
    ).toContain(settled);
  });
});
