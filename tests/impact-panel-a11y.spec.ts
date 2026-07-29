import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * Impact briefing panel accessibility (critical-review #16, WCAG 2.4.3 / 2.1.2).
 * The panel is a role="dialog"; while open it must contain keyboard focus (so a
 * keyboard user is never dropped onto the canvas, which has no keyboard path),
 * announce itself modal, and close on Escape.
 *
 * The panel is opened here via the `?select=state:WA` deep link (a boot-time,
 * keyboard-independent path). The focus-RESTORE-to-opener half of #16 needs a
 * focusable opener (the sidebar keyboard trigger tracked as #9) and is exercised
 * once that lands; this spec covers the containment, modality, and Escape close.
 */
test.describe('impact panel accessibility', () => {
  test('opens modal with focus on close, traps Tab, and closes on Escape', async ({ page }) => {
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    // The deep link fetches the bundled state boundary, then opens the panel.
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // While open it is modal to assistive tech and focus sits on the close button.
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    const closeBtn = panel.locator('.impact-panel-close');
    await expect(closeBtn).toBeFocused();

    // Tab containment: shift-Tab from the first focusable (the close button)
    // wraps to the last focusable inside the panel, never escaping to the canvas.
    await page.keyboard.press('Shift+Tab');
    const stillInside = await panel.evaluate((el) => el.contains(document.activeElement));
    expect(stillInside).toBe(true);

    // Escape closes the panel and clears the modal flag.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5_000 });
    await expect(panel).toHaveAttribute('aria-modal', 'false');
  });

  test('the region briefing trigger opens the state briefing and restores focus (#9, #16)', async ({
    page
  }) => {
    // Default region washington_state is anchored to the WA state briefing.
    // The region briefing trigger lives in the region panel, which is a
    // console-only "where" control since U3e (D-0.7.0-009: Brief leads with
    // the place search), so exercise the trigger in console mode.
    await gotoApp(page, '?view=console');

    const trigger = page.locator('#region-briefing-btn');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('Washington');

    // Open via the keyboard-reachable trigger (focus, then Enter).
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // The briefing describes the anchored state (its own title), not the viewport.
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');

    // Closing returns focus to the trigger (the opener), not the body: the
    // focus-restore half of #16, exercised now that a keyboard opener exists.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5_000 });
    await expect(trigger).toBeFocused();
  });

  test('a region spanning several states shows no briefing trigger (#9)', async ({ page }) => {
    // The national framing has no single briefable boundary, so no trigger.
    await gotoApp(page, '?region=national');
    await expect(page.locator('#region-briefing-btn')).toBeHidden();
  });
});
