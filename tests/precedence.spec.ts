import { test, expect } from '@playwright/test';
import {
  gotoApp,
  regionSelect,
  search,
  stubHeatRiskCatalog,
  waitForLayerSettled
} from './helpers';

/**
 * S30D D1's precedence spec (DDM-P10-T13, DR-109; the "precedence spec" named
 * in the checkpoint's own gate). Pins the URL, Reset and embed precedence
 * rules from `planning/2026-09-25-desktop-pass/design/precedence.md` rows A1,
 * D1 to D3, G1 and G4, and the Q6 fix to `selectRegion`'s
 * closeImpactPanel guard (`src/ui/sidebar.ts:558-564`).
 *
 * DR-109: `DEFAULT_REGION` moves from `washington_state` to `national`. Every
 * case below that names `region:national` fails on the pre-flip tree, where
 * a bare boot still frames Washington.
 */
test.describe('precedence: boot, Reset and embed defaults (DR-109)', () => {
  test('a bare desktop boot frames the nation, opens the sidebar, and writes no mode, 3D, imagery or sidebar token', async ({
    page
  }) => {
    await gotoApp(page);

    await expect(regionSelect(page)).toHaveValue('region:national');
    await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect(page.locator('#sidebar')).toBeVisible();

    const params = new URLSearchParams(await search(page));
    // Drought is the default mode, encoded by the ABSENCE of `cluster=`
    // (src/config/clusters.ts: drought's urlToken is null).
    expect(params.has('cluster')).toBe(false);
    // Neither 3D key exists in this URL yet (D4 has not shipped).
    expect(params.has('terrain3d')).toBe(false);
    expect(params.has('fire3d')).toBe(false);
    // No imagery view or sidebar-collapse token: every default is absence.
    expect(params.has('basemap')).toBe(false);
    expect(params.has('sidebar')).toBe(false);
  });

  test('Reset under the national default keeps the typed place and an open briefing', async ({
    page
  }) => {
    // Where a user can press Reset with a briefing open: the phone. On the
    // desktop the briefing is a modal dialog seated over the right edge
    // (`.impact-panel` is fixed top/right/bottom above the map controls,
    // aria-modal="true" with a Tab trap, src/ui/impact-panel.ts:176-192,
    // :266), so #reset-btn sits under it and no pointer or keyboard reaches
    // it until the briefing closes. On the phone the briefing is hosted in
    // the sheet, non-modal, at the half detent, and the right-side map
    // controls stay reachable beside it (tests/hazard-rail.spec.ts, "the
    // rail stays reachable beside open panels").
    await page.setViewportSize({ width: 390, height: 844 });
    // select=state:WA opens the impact briefing at boot; the boot's silent
    // region fit (national, DR-109) runs first and sets STATE.currentRegion.
    await gotoApp(page, '?select=state:WA');

    const app = page.locator('#app');
    const panel = page.locator('#impact-panel');
    await expect(page.locator('#sheet-report .impact-panel')).toHaveCount(1, { timeout: 15_000 });
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(panel).toHaveClass(/\bopen\b/);
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(regionSelect(page)).toHaveValue('region:national');

    // Reset re-selects the SAME region (national). Before the Q6 fix,
    // selectRegion's closeImpactPanel guard fires unconditionally whenever
    // the target region's impactSynthesis is 'none' (which national's is,
    // src/config/capability-matrix.ts:124-127), closing the just-opened
    // briefing even though the region never changed.
    await page.locator('#reset-btn').click();

    await expect(regionSelect(page)).toHaveValue('region:national');
    await expect(panel).toHaveClass(/\bopen\b/);
    // The briefing the Reset left open is the one the full report shows:
    // raise it and read it, visible, still on the typed place.
    await page.locator('#sheet-report-door').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
  });

  test('Reset returns a framing boot to the national default', async ({ page }) => {
    await gotoApp(page, '?framing=arid-west');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBe('arid-west');

    await page.locator('#reset-btn').click();

    // The legacy region fit under the framing boot is DEFAULT_REGION
    // (national after DR-109); an explicit region click clears framing=.
    await expect(regionSelect(page)).toHaveValue('region:national');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('framing'))
      .toBeNull();
  });

  test('Reset changes only the camera claim', async ({ page }) => {
    await gotoApp(page, '?layers=usdm,tribal&view=console');
    await waitForLayerSettled(page, 'usdm');

    const before = new URLSearchParams(await search(page));
    expect(before.get('region')).toBe('national');

    await page.locator('#reset-btn').click();

    const after = new URLSearchParams(await search(page));
    expect(after.get('region')).toBe('national');
    for (const key of ['layers', 'view']) {
      expect(after.get(key), `${key} unchanged by Reset`).toBe(before.get(key));
    }
  });

  test('an embed pinned to region=washington_state&view=brief keeps the Washington framing and the Brief door', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&region=washington_state&view=brief');

    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await expect(regionSelect(page)).toHaveValue('region:washington_state');

    const params = new URLSearchParams(await search(page));
    expect(params.get('view')).toBe('brief');
    // The Brief door never mounts the console catalog island (headroom C1;
    // src/ui/sidebar.ts's isBriefEmbed boot decision). `#catalog-search` is
    // a static container in index.html that every boot carries, so the
    // island's absence is read from what it renders: no layer checkbox at
    // all (tests/boundary-stubs.spec.ts, "the brief embed").
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
  });

  test.describe('G1: duplicate and invalid tokens (pin today\'s behaviour, pass before and after)', () => {
    test('a duplicated region resolves first-wins (pinned)', async ({ page }) => {
      await gotoApp(page, '?region=central_oregon&region=cascades');
      await expect(regionSelect(page)).toHaveValue('region:central_oregon');
    });

    test('temporal tokens resolve first-wins and invalid reads as now', async ({ page }) => {
      // horizon=: a duplicated key resolves via URLSearchParams.get, which
      // returns only the first occurrence (the same rule week, dmode, sst
      // and outlook follow).
      await gotoApp(page, '?horizon=weeks-ahead&horizon=season-ahead');
      expect(new URLSearchParams(await search(page)).get('horizon')).toBe('weeks-ahead');

      // An invalid token reads as the default ("now"/current), which is
      // absence in the canonical URL.
      await gotoApp(page, '?horizon=bogus');
      expect(new URLSearchParams(await search(page)).get('horizon')).toBeNull();
    });

    test('heatday and spi duplicates are rejected, never resolved by position', async ({
      page
    }) => {
      await gotoApp(page, '?cluster=heat&heatday=3&heatday=6');
      expect(new URLSearchParams(await search(page)).get('heatday')).toBeNull();

      await gotoApp(page, '?spi=30&spi=60');
      expect(new URLSearchParams(await search(page)).get('spi')).toBeNull();
    });
  });

  // A6 (D1 M6, 2026-09-27; found-009, DDM-P10-T09): a deep link to a horizon
  // the mode cannot show boots on Current Conditions. Outside G1 on purpose:
  // G1 pins behaviour that passes before and after, and this row is red
  // before its fix. Extreme Heat's season-ahead recipe is empty
  // (src/config/clusters.ts: no verified surface exists yet), so the deep
  // link used to commit that empty horizon anyway and press the very chip
  // `horizonDisabledReason` (src/ui/island/shell.tsx) disables. The parser
  // now boots it on `current` (src/state/url.ts's resolveHorizonForCluster).
  test('a deep link to a horizon the mode cannot show boots on Current Conditions', async ({
    page
  }) => {
    // The redirected boot shows Extreme Heat's current recipe (HeatRisk and
    // the WWA notices): both answered locally.
    await stubHeatRiskCatalog(page);
    await page.route(
      (url) => url.pathname.endsWith('/watch_warn_adv/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] })
        })
    );
    await gotoApp(page, '?view=console&cluster=heat&horizon=season-ahead');

    const current = page.locator('.shell-horizon-btn[data-horizon="current"]');
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(await current.getAttribute('aria-disabled')).toBeNull();
    // The unshowable horizon stays unpressed AND disabled with its reason.
    expect(await season.getAttribute('aria-pressed')).toBe('false');
    expect(await season.getAttribute('aria-disabled')).toBe('true');
    // horizon=current is absence in the canonical URL; the mode survives.
    const params = new URLSearchParams(await search(page));
    expect(params.get('horizon')).toBeNull();
    expect(params.get('cluster')).toBe('heat');
    // The redirect lands on a real surface, not a reference-only read.
    await expect(page.locator('input[data-layer-key="heatrisk"]')).toBeChecked();
  });
});
