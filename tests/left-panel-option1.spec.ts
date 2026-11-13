import { test, expect } from './offline-test';

import { gotoApp, search } from './helpers';
import { stubUsdmWeeks, USDM_FIXTURE_PRIOR_WEEK } from './usdm-fixtures';

test.describe('D-0.7.0-067 contextual time rail', () => {
  test('desktop reads hazard, time, place, then selection response with Share on the map', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=usdm');

    const shellOrder = await page.locator('#shell-panel .shell').evaluate((shell) => {
      const children = Array.from(shell.children);
      return [
        '.shell-view',
        '.shell-when',
        '.shell-minimap-map',
        '.shell-minimap-popover-wrap',
        '#shell-region-host',
        '#shell-refine-host'
      ].map((selector) => children.findIndex((child) => child.matches(selector)));
    });
    expect(shellOrder.every((index) => index >= 0)).toBe(true);
    expect(shellOrder).toEqual([...shellOrder].sort((a, b) => a - b));
    await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
    // Settled runtime order: syncTimeBarHost seats the bar right after the
    // shell panel, but the hidden conditions-strip home marker (and the
    // strip itself when it is not on the map) still sits between the bar and Brief
    // display, so only the document order is asserted for that pair. The
    // ENSO buttons sit between Brief display and the view details.
    const settledOrder = await page.evaluate(() => {
      const ids = ['shell-panel', 'time-bar', 'brief-display', 'enso-flow-controls', 'shell-details-panel'];
      const nodes = ids.map((id) => document.getElementById(id));
      return nodes.every((node, i) => node && (i === 0 || nodes[i - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(settledOrder).toBe(true);
    await expect(page.locator('#brief-display + #enso-flow-controls + #shell-details-panel')).toHaveCount(1);
    await expect(page.locator('#shell-details-island > #shell-conditions-summary')).toHaveCount(1);

    // S4 supersession (the 2026-07-18 design record, S4c): on the
    // desktop Brief shell the full #time-bar stands down (attached for
    // console/mobile, display gone here), and the compact date line moved
    // to the Console column foot (owner 2026-11-13): attached, not drawn.
    // The D-0.7.0-067 stable-node contract above still holds on the DOM.
    await expect(page.locator('#time-bar')).toBeHidden();
    await expect(page.locator('#time-bar')).toBeAttached();
    await expect(page.locator('#shell-time')).toBeAttached();
    await expect(page.locator('#shell-time')).toBeHidden();
    await expect(page.locator('#brief-display')).toBeVisible();
    await expect(page.locator('#brief-display #studio-entry-pair')).toBeVisible();
    await expect(page.locator('#brief-display #enso-driver')).toHaveCount(0);
    await expect(page.locator('#brief-selection-summary')).toBeHidden();
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    const search = page.locator('#brief-search [data-ddm-search]');
    await search.fill('oregon');
    await page.locator('#brief-search [data-search-kind="place"][data-search-id="OR"]').click();
    await expect(page.locator('#brief-place-name')).toHaveText('Oregon');
    // Repair R2 (2026-11-13): the name card left the column; its paragraph
    // stays as the visually hidden live region that announces the choice.
    await expect(page.locator('#brief-secondary-actions + #brief-selection-summary #brief-place-context')).toHaveClass(/\bsr-only\b/);
    await expect(page.locator('#brief-head #brief-place-context')).toHaveCount(0);
    // Visual uniformity wave 1, D6 (2026-11-13): the sentence that repeated
    // the name is gone; the chosen place has ONE briefing door, the region
    // row's, where the Brief column once added a second.
    await expect(page.locator('#brief-selection-summary')).not.toContainText('focused on');
    await expect(page.locator('#brief-full-report-link')).toHaveCount(0);
    const door = page.locator('#shell-region-host #region-briefing-btn');
    await expect(door).toBeVisible();
    // The door carries the name on its own line, over its two words (R2).
    await expect(door.locator('.region-briefing-place')).toHaveText('Oregon');
    await expect(door.locator('.region-briefing-action')).toHaveText('Open briefing');
    await expect(door).toHaveAccessibleName('Open briefing for Oregon');

    // A search pick asks for the place, so its briefing opens at once on
    // every shell (owner 2026-11-13); the door stays the way back to it.
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
    // A desktop hard close retires its owned selection. Its report door
    // becomes hidden, so the stable Brief search receives keyboard focus.
    await panel.locator('.impact-panel-close').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#brief-selection-summary')).toBeHidden();
    await expect(door).toBeHidden();
    await expect(page.locator('#app')).not.toHaveAttribute('data-place-selected', '');
    await expect(search).toBeFocused();
    await search.fill('oregon');
    await page.locator('#brief-search [data-search-kind="place"][data-search-id="OR"]').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#brief-selection-summary')).toBeHidden();
    await expect(search).toBeFocused();
  });

  test('the date line is the Console column foot and steps aside in Brief', async ({ page }) => {
    await stubUsdmWeeks(page);
    await gotoApp(page, '?view=console&layers=usdm');
    const line = page.locator('#shell-time[data-has-spec="true"]');
    await expect(line).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.shell-when #shell-time')).toHaveCount(0);
    expect(
      await page.locator('.sidebar-scroll').evaluate((el) => el.lastElementChild?.id)
    ).toBe('shell-time-island');
    await page.locator('.view-switch [data-view="brief"]').click();
    await expect(page.locator('#shell-time')).toBeHidden();
  });

  test('mobile Brief moves the same focused control between stable hosts', async ({ page }) => {
    await stubUsdmWeeks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, '?view=brief&layers=usdm');
    await expect(page.locator('#time-bar')).toHaveAttribute('data-register', 'observed');
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Valid Jun 30, 2026');

    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');

    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible();
    await expect(page.locator('#sheet-time-host > #time-bar')).toHaveCount(1);
    // The sheet's PLACE-studio entry stays VISIBLE: the footer place tab
    // opens the at-hand search, not the studio, so this button is the only
    // mobile door to the full PLACE studio (D-0.7.0-054; integration
    // reconciliation of the lane's hide).
    await expect(page.locator('#sheet-place-studio-entry')).toBeVisible();
    expect(
      await page
        .locator('#mobile-footer-nav button[data-tab="place"]')
        .evaluate((button) => button.nextElementSibling?.getAttribute('data-tab'))
    ).toBe('layers');

    // found-091: the footer place-tab press sets the detent attribute at
    // once, but #sidebar's own open transition (mobile-panels.css, 180ms)
    // is still running under it; a rect read here can land mid-animation.
    // Wait for that transition to settle before measuring, on a fresh
    // computed style each poll (never a fixed sleep).
    await expect
      .poll(async () =>
        page.locator('#sidebar').evaluate((el) => getComputedStyle(el).transform)
      )
      .toMatch(/^(none|matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\))$/);

    const targets = bar.locator(
      '.time-bar-step, .time-bar-play, .time-bar-jump, .time-bar-modes button'
    );
    const targetHeights = await targets.evaluateAll((elements) =>
      elements.map((el) => el.getBoundingClientRect().height)
    );
    for (const height of targetHeights) {
      expect(height).toBeGreaterThanOrEqual(44);
    }

    const previous = bar.locator('[data-step="-1"]');
    await expect(previous).toBeEnabled();
    await previous.focus();
    await expect(previous).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Valid Jun 23, 2026');
    expect(new URLSearchParams(await search(page)).get('week')).toBe(USDM_FIXTURE_PRIOR_WEEK);
    await expect(previous).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    // The desktop seat honors the S4 band order: the bar returns AFTER
    // the shell panel (VIEW / MAP CONTEXT / WHEN / SHOWN NOW), not
    // between the brief head and the shell (DG-080 review finding 4).
    await expect(page.locator('#shell-panel + #time-bar')).toHaveCount(1);
    // S4 supersession: the rehosted rail is attached in its desktop slot
    // but display-gone in desktop Brief (Brief states no date in the
    // column), so the cross-host FOCUS carry ends at the
    // desktop line; the rehost itself (the D-0.7.0-067 stable-host
    // contract) is still pinned above.
    await expect(page.locator('#time-bar')).toBeHidden();
  });

  test('embed keeps the floating date hidden through its explicit exit', async ({ page }) => {
    await stubUsdmWeeks(page);
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=brief&layers=usdm');
    await expect(page.locator('#time-bar')).toHaveAttribute('data-register', 'observed');
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Valid Jun 30, 2026');
    expect(new URLSearchParams(await search(page)).get('layers')?.split(',')).toContain('usdm');

    await expect(page.locator('#time-bar')).toBeHidden();
    await expect(page.locator('#embed-date-stamp')).toBeHidden();
    await page.locator('#sidebar-expand').click();
    await expect(page.locator('#app')).not.toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#embed-date-stamp')).toBeHidden();
    await expect(page.locator('#time-bar')).toBeHidden();

    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#sheet-time-host > #time-bar')).toBeVisible();
  });
});
