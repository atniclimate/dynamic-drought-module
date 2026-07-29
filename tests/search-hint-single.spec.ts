import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * U-UX-FIX-1 DEG-1: the search hint appears ONCE.
 *
 * The shared search island rendered its placeholder text a second, visible
 * time as an at-rest paragraph (`.ddm-search-empty`) directly beneath the
 * input, in every host and both orientations. The paragraph is removed
 * (src/ui/island/search.tsx): the input already carries the same words as
 * both its placeholder and its aria-label, so assistive tech loses
 * nothing. The honest zero-match copy, which shares the class but lives
 * INSIDE `.ddm-search-results`, must survive.
 */

test.describe('DEG-1 the search hint renders once', () => {
  test('desktop console catalog: no visible at-rest duplicate under the input', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    const root = page.locator('#catalog-search .ddm-search');
    const input = root.locator('[data-ddm-search]');
    await expect(input).toBeVisible();

    // At rest (empty query) the hint exists exactly once: as the input's
    // placeholder. No `.ddm-search-empty` paragraph sits under the input.
    await expect(root.locator(':scope > .ddm-search-empty')).toHaveCount(0);
    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    expect(placeholder.length).toBeGreaterThan(0);
    await expect(root.getByText(placeholder, { exact: true })).toHaveCount(0);

    // GUARD: the honest zero-match message (same class, inside the
    // results region) still appears for a query that matches nothing.
    await input.fill('zzzqqqxx');
    const zeroMatch = root.locator('.ddm-search-results .ddm-search-empty');
    await expect(zeroMatch).toBeVisible();
    await expect(zeroMatch).toContainText('No matches');

    // And clearing the query returns to the single-instance rest state.
    await input.fill('');
    await expect(root.locator('.ddm-search-empty')).toHaveCount(0);
  });

  test('mobile portrait (390x844) Place pane: the at-rest paragraph is gone from the DOM', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    // The Place door raises the sheet with the ONE shared search mounted.
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    const root = page.locator('#sheet-search .ddm-search');
    await expect(root.locator('[data-ddm-search]')).toBeVisible();
    // DELIBERATE structure pin, not a visibility pin: pre-fix CSS already
    // hid the at-rest paragraph in THIS host (a sheet-scoped display:none),
    // so an attached-count assertion is the only one that fails on the
    // pre-fix tree here; the visible-regression fail-then-pass evidence
    // lives in the desktop and landscape tests above and below. The
    // shipped DEG-1 mechanism is REMOVAL (the handoff allowed
    // screen-reader-only or removed; removal also retired two dead
    // sheet-scoped hiding rules in app.css). If a future ratified change
    // reintroduces a screen-reader-only hint, THIS is the line to edit.
    await expect(root.locator(':scope > .ddm-search-empty')).toHaveCount(0);
  });

  test('mobile landscape (844x390) desktop-shell search: no visible at-rest duplicate', async ({
    page
  }) => {
    // The triage reproduced the duplicate in both orientations; at 844x390
    // the 720px breakpoint serves the desktop shell, whose Brief head
    // hosts the search.
    await page.setViewportSize({ width: 844, height: 390 });
    await gotoApp(page);
    const root = page.locator('#brief-search .ddm-search');
    await expect(root.locator('[data-ddm-search]')).toBeAttached();
    await expect(root.locator(':scope > .ddm-search-empty')).toHaveCount(0);
  });
});
