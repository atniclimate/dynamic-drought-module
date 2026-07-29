import { test, expect } from '@playwright/test';
import { gotoApp, search } from './helpers';

/**
 * S4b: the framing minimap, pointer and keyboard (the S4 design record
 * section 3; D-0.7.0-039/041/054). Passing this file is the ruled
 * precondition for the staged desktop retirement of #panel-region (the
 * CSS hide shipped with this unit); the panel itself stays in the DOM
 * for the mobile sheet until S6, and legacy region= URLs are parsed
 * regardless.
 */

test.describe('S4b minimap', () => {
  test('renders the nine framings plus ALL, with ALL committed at boot', async ({
    page
  }) => {
    await gotoApp(page);
    await expect(page.locator('.shell-minimap-map .shell-minimap-region')).toHaveCount(9);
    await expect(page.locator('.shell-minimap-map .shell-minimap-all')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    // The desktop region grid is retired behind the minimap (staged:
    // DOM preserved, display gone).
    await expect(page.locator('#panel-region')).toBeHidden();
    await expect(page.locator('#panel-region')).toBeAttached();
  });

  test('pointer: choosing a framing writes framing= instead of region= and shows coverage copy', async ({
    page
  }) => {
    await gotoApp(page);
    await page
      .locator('.shell-minimap-map [data-framing="pacific-coast"]')
      .click();
    await page.waitForFunction(() =>
      window.location.search.includes('framing=pacific-coast')
    );
    // Camera exclusivity (S2): one camera vocabulary at a time.
    expect(await search(page)).not.toContain('region=');
    // Coverage honesty: the caption carries the user-facing clause.
    await expect(page.locator('.shell-minimap-map .shell-minimap-note')).toContainText(
      'British Columbia portions are outside US-scoped display sources'
    );
    await expect(
      page.locator('.shell-minimap-map [data-framing="pacific-coast"]')
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('the required framing provenance rides the accessible name, the hover title, and the caption (DG-080 blocker 2)', async ({
    page
  }) => {
    await gotoApp(page);
    const region = page.locator('.shell-minimap-map [data-framing="pacific-coast"]');
    const qualification = /an owned simplification, not an authoritative boundary/;
    // Accessible name: label, coverage clause, then the provenance
    // qualification (FramingDef.provenance is required, D-0.7.0-051).
    await expect(region).toHaveAttribute('aria-label', qualification);
    // Hover title: label plus the same qualification.
    await expect(region).toHaveAttribute('title', qualification);
    // Caption surfaces: the persistent provenance line qualifies the
    // drawn shapes even before any framing commits...
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-provenance')
    ).toHaveText(qualification);
    // ...and stays with the committed framing's own note after a commit.
    await region.click();
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-provenance')
    ).toHaveText(qualification);
    // Coverage copy stays a separate sentence; it does not substitute
    // for the geometry provenance.
    await expect(page.locator('.shell-minimap-map .shell-minimap-note')).toContainText(
      'British Columbia portions are outside US-scoped display sources'
    );
  });

  test('keyboard: arrows move focus WITHOUT committing; Enter commits the focused framing', async ({
    page
  }) => {
    await gotoApp(page);
    const pacific = page.locator('.shell-minimap-map [data-framing="pacific-coast"]');
    await pacific.click();
    await pacific.focus();
    // Arrow browsing is free: focus moves, the committed claim does not
    // (a commit is a camera flight plus a URL write; deferred to
    // Enter/Space per the WAI-ARIA expensive-side-effect allowance).
    await page.keyboard.press('ArrowRight');
    const arid = page.locator('.shell-minimap-map [data-framing="arid-west"]');
    await expect(arid).toBeFocused();
    await expect(arid).toHaveAttribute('aria-checked', 'false');
    await expect(pacific).toHaveAttribute('aria-checked', 'true');
    expect(await search(page)).toContain('framing=pacific-coast');
    // Enter on the focused option commits it: camera claim and URL.
    await page.keyboard.press('Enter');
    await expect(arid).toHaveAttribute('aria-checked', 'true');
    await page.waitForFunction(() =>
      window.location.search.includes('framing=arid-west')
    );
    // Browsing back without committing leaves the arid claim standing.
    await page.keyboard.press('ArrowLeft');
    await expect(pacific).toBeFocused();
    await expect(arid).toHaveAttribute('aria-checked', 'true');
    expect(await search(page)).toContain('framing=arid-west');
  });

  test('ALL clears the framing claim back to absence', async ({ page }) => {
    await gotoApp(page);
    await page.locator('.shell-minimap-map [data-framing="mexico"]').click();
    await page.waitForFunction(() =>
      window.location.search.includes('framing=mexico')
    );
    // The Mexico coverage sentence, exactly as ruled.
    await expect(page.locator('.shell-minimap-map .shell-minimap-note')).toContainText(
      'The current display layers do not cover Mexico'
    );
    await page.locator('.shell-minimap-map .shell-minimap-all').click();
    await page.waitForFunction(
      () => !window.location.search.includes('framing=')
    );
    await expect(page.locator('.shell-minimap-map .shell-minimap-all')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
