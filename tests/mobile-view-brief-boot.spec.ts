import { test, expect } from '@playwright/test';
import { gotoApp, search } from './helpers';

/**
 * U-UX-FIX-1 DEF-2: an explicit `?view=brief` is honored on a mobile cold
 * load (invariant 6.2, URL as state).
 *
 * The app stamps `view=` onto every URL after the first sync, so a shared
 * or reloaded Brief link used to boot the sheet CLOSED like a bare URL:
 * the sender's Brief surface never reproduced. The fix captures the RAW
 * explicitness at parse time (src/state/url.ts `explicitView`), threads it
 * through the sidebar's boot seeding (`setExplicitBriefBoot`) to the
 * mobile sheet, whose boot activation raises the Brief surface at the
 * half detent ONLY for that explicit ask. A bare boot keeps the ratified
 * map-first closed state (D-0.7.0-041), pinned again here as the guard.
 */

test.describe('DEF-2 explicit view=brief on a mobile cold load (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a shared ?view=brief URL boots the Brief sheet at half with its content', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief');

    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    // The explicit ask raises the Brief surface at its half detent; the
    // grabber (hidden at closed) is visible, and the at-hand block shows
    // its honest invitation (no unsolicited briefing, D-0.7.0-041: the
    // link asked for the Brief DOOR, not for a place report).
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-grabber')).toBeVisible();
    await expect(page.locator('.sheet-at-hand-title')).toBeVisible();
    await expect(page.locator('.sheet-at-hand-title')).toHaveText('Pick a place');
    await expect(page.locator('#sheet-report .impact-panel')).toHaveCount(0);

    // Round-trip: the URL still claims the Brief door after the first
    // canonical write, and the ephemeral detent never enters it.
    const params = new URLSearchParams(await search(page));
    expect(params.get('view')).toBe('brief');
    expect(await search(page)).not.toMatch(/detent|sheet|tab/i);
  });

  test('a RELOAD of the app-stamped URL still reproduces the Brief sheet', async ({
    page
  }) => {
    // The failure mode the triage caught: the app writes view=brief into
    // the address bar on first load, so the URL a user copies IS the
    // stamped one. Reloading it must reproduce the Brief surface.
    await gotoApp(page, '?view=brief');
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#preset-chips .preset-chip')).not.toHaveCount(0);
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
  });

  test('GUARD: a bare boot stays map-first closed; the derived Brief mode earns no raise (D-0.7.0-041)', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    // Derived Brief (bare URL) is NOT an explicit ask: closed, edgeless.
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#sheet-grabber')).toBeHidden();
  });

  test('GUARD: an explicit view=console boot stays map-first closed', async ({ page }) => {
    await gotoApp(page, '?view=console');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-console\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
  });

  test('GUARD: view=brief inside an embed stays sheetless (the embed contract)', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&embed=true');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(page.locator('#sheet-grabber')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
  });

  test('GUARD: the embed-exit reveal opens at peek even when the boot URL carried view=brief (the ratified peek contract)', async ({
    page
  }) => {
    // This pins the PEEK CONTRACT of the embed-exit reveal (D-0.7.0-017):
    // the expand control exits embed and reveals the sheet at peek, never
    // the half-detent Brief raise. It is NOT a one-shot-consumption pin
    // (DG-080-REVIEW r2 finding 3 named the earlier title honestly wrong
    // about that): the production reveal path calls activate('peek')
    // explicitly, and an explicit initial overrides any stale
    // explicit-view flag, so this test stays green whether or not the
    // flag was consumed. The one-shot mechanism itself is pinned by the
    // desktop-to-mobile crossing spec at the bottom of this file.
    await gotoApp(page, '?view=brief&embed=true');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bembed\b/);
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bembed\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
  });
});

test.describe('DEF-2 one-shot consumption across a desktop-to-mobile crossing', () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test('a desktop ?view=brief boot spends the flag: a later crossing to mobile stays map-first closed', async ({
    page
  }) => {
    // The core one-shot mechanism (DG-080-REVIEW finding 4): the boot
    // evaluation clears the explicit-view flag even when the boot
    // viewport activated no sheet (a desktop boot does not), so the
    // shell activation on a later viewport crossing must NOT treat the
    // stale ask as current intent. The crossing boots the sheet at the
    // ratified map-first closed detent (D-0.7.0-041).
    await gotoApp(page, '?view=brief');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#sheet-grabber')).toBeHidden();
  });
});
