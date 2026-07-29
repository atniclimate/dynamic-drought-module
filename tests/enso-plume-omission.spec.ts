import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { gotoApp } from './helpers';

/**
 * ENSO plume omission (0.8.0 T-P0-1). The CPC probabilistic-outlook plume was
 * scraped from an HTML table, contrary to the anti-scrape doctrine, and was
 * removed 2026-07-21 (D-0.8.0-011 finding 3). The bundled snapshot is now
 * indices-only, and the app's honest-absence path renders the observed
 * ONI/RONI claim with NO probabilistic plume claim or chart.
 *
 * Deterministic: the briefing reads the BUNDLED snapshot, so this asserts the
 * shipped truth, not a live endpoint. If a plume ever returns it must come
 * from a documented machine feed or an explicitly-labeled modeled ensemble
 * (workplan T-V0-3 / U-ENSO-REPAIR), and this spec is then updated alongside
 * that unit, never loosened on its own.
 */
test.describe('ENSO plume omission (indices-only snapshot)', () => {
  test('no scraper identifier survives at source level (anti-scrape pin)', () => {
    // Source-level regression pin (review finding 2): the artifact/UI checks
    // below would not catch a reintroduced scraper whose snapshot was not yet
    // regenerated. Reject the removed identifiers across the live trees.
    const banned = [
      'fetchProbabilities',
      'PROBABILITIES_URL',
      'probabilities-table',
      'analysis_monitoring/enso/roni/probabilities'
    ];
    for (const needle of banned) {
      let out = '';
      try {
        // -l: list matching files; -F: fixed string. Exit 1 = no matches.
        out = execFileSync(
          'git',
          ['grep', '-lF', needle, '--', 'scripts', 'src', 'public',
           ':(exclude)tests/enso-plume-omission.spec.ts'],
          { encoding: 'utf8' }
        );
      } catch {
        // git grep exits non-zero when nothing matches: the desired state.
      }
      expect(out.trim(), `"${needle}" must not reappear in scripts/src/public`).toBe('');
    }
  });

  test('the bundled snapshot carries no probabilities block', async ({ page }) => {
    await gotoApp(page);
    const snapshot = await page.evaluate(async () => {
      const resp = await fetch('data/enso-indices.json');
      return (await resp.json()) as Record<string, unknown>;
    });
    // Indices present; the scraped block gone.
    expect(snapshot.oni).toBeTruthy();
    expect(snapshot.roni).toBeTruthy();
    expect(snapshot.retrieved).toBeTruthy();
    expect(snapshot.probabilities).toBeUndefined();
  });

  test('the briefing renders the RONI/ONI claim without a plume', async ({ page }) => {
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The observed-index ENSO claim renders (the honest surviving surface).
    const ensoClaim = panel.locator('.impact-claim', {
      hasText: 'operational RONI'
    });
    await expect(ensoClaim.first()).toBeVisible({ timeout: 30_000 });

    // No claim sourced to the removed CPC probabilistic outlook, and no
    // odds-by-season plume chart anywhere in the panel.
    await expect(
      panel.locator('.impact-claim', { hasText: 'probabilistic ENSO outlook' })
    ).toHaveCount(0);
    await expect(
      panel.locator('.impact-claim-chart', { hasText: 'odds of El Nino' })
    ).toHaveCount(0);
  });
});
