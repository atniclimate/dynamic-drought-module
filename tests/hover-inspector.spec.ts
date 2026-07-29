import { test, expect } from '@playwright/test';
import { gotoApp, layerCheckbox, waitForLayerSettled } from './helpers';

/**
 * UX-4 hover inspector: a what-is-under-my-cursor readout that reflects the
 * active layers. Driven here with the bundled `states` layer (synchronous, no
 * agency fetch) so the assertion is deterministic; the drought and river fields
 * ride the same mechanism and are checked in the manual lane.
 */
test.describe('UX-4 hover inspector', () => {
  test('names what is under the cursor from an active layer, and clears on mouseout', async ({
    page
  }) => {
    // Console boot: this spec drives a catalog checkbox, and E1 deliverable 1
    // hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');

    const inspector = page.locator('#hover-inspector');
    await expect(inspector).toBeHidden();

    // Turn on the bundled state boundaries so a hover has something to name.
    await layerCheckbox(page, 'states').check();
    await waitForLayerSettled(page, 'states');

    const map = page.locator('#map');
    const box = await map.boundingBox();
    if (!box) throw new Error('no map box');
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;

    // Nudge the pointer until the readout appears. The just-activated state
    // fill needs a paint before queryRenderedFeatures returns it, and the
    // readout only samples on a fresh mousemove, so each poll re-moves the
    // pointer rather than re-checking a stale frame.
    await expect
      .poll(
        async () => {
          await page.mouse.move(cx, cy);
          await page.mouse.move(cx + 8, cy + 4);
          await page.waitForTimeout(120);
          return inspector.isVisible();
        },
        { timeout: 8000, message: 'hover readout never appeared over the state fill' }
      )
      .toBe(true);
    await expect(inspector.locator('.hover-item', { hasText: 'State' })).toHaveCount(1);

    // Moving the pointer off the map canvas clears the readout.
    await page.mouse.move(box.x - 60, cy);
    await expect(inspector).toBeHidden();
  });
});
