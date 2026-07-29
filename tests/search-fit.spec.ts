import { test, expect, type Page } from '@playwright/test';

import { gotoApp, waitForLayerSettled } from './helpers';

/**
 * U-UX-FIX-1 DEF-5: the summary-first search fit pads only for a panel
 * that will actually render.
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

test.describe('DEF-5 the summary-first search fit uses the full map container (desktop)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('selecting Washington frames the state, not a 480px-padded phantom panel', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    // The probes read the bundled state fill through the hover inspector,
    // so the default-on states layer must be painted and queryable.
    await waitForLayerSettled(page, 'states');

    // Select Washington through the shared search (the summary-first path,
    // D-0.7.0-070: the selection renders in the left sidebar; no popup, no
    // right-side briefing panel).
    await page.locator('#catalog-search [data-ddm-search]').fill('washington');
    await page
      .locator('#catalog-search [data-search-group="place"] [data-search-kind="place"]', {
        hasText: 'Washington'
      })
      .first()
      .click();
    await expect(page.locator('#app')).toHaveAttribute('data-place-selected', '');

    // PREMISE PIN: on desktop this path opens NO impact panel over the
    // map's right side. If a ratified change ever makes the panel open
    // here, the pad should follow it and this spec must be rethought.
    await expect(page.locator('#impact-panel.open')).toHaveCount(0);

    // Let the fit's fly settle: the probe must read a STABLE state, not a
    // frame of the animation. Two identical non-empty reads 600ms apart
    // hold only once the camera has landed (mid-fly the longitude under a
    // fixed pixel is still moving).
    let settled = '';
    await expect(async () => {
      const first = await stateUnderProbe(page, 0.9, 0.5);
      await page.waitForTimeout(600);
      const second = await stateUnderProbe(page, 0.9, 0.5);
      expect(first).not.toBe('');
      expect(first).toBe(second);
      settled = second;
    }).toPass({ timeout: 25_000 });

    // The load-bearing assertion. Correct fit (symmetric margins, zoom
    // ~6.52 at this viewport): 90% of the map width on the midline is at
    // roughly longitude -117.4, inside eastern Washington (Idaho is
    // accepted as border-seam tolerance; the state spans barely 0.4 deg
    // of margin here). Buggy fit (480px phantom right pad, zoom 5.71):
    // the same probe is at roughly -111.9, firmly inside Montana.
    expect(
      ['Washington', 'Idaho'],
      `the right-edge probe read "${settled}": the fitted viewport extends far east of ` +
        'Washington, which means the camera padded for an impact panel that never opened'
    ).toContain(settled);
  });
});
