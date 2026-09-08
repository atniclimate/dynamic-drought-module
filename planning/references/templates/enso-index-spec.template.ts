/**
 * TEMPLATE, not run. Acceptance spec for one observed index added to the ENSO
 * briefing. Copy to tests/enso-__slug-kebab__.spec.ts, fill the placeholders,
 * and add the path to the verify:smoke list in package.json.
 *
 * Header contract (the recon spec audit found only eleven of 113 specs name a
 * task id; every Wave 2 spec must): name the task id and quote the acceptance
 * sentence verbatim in the first comment block.
 *
 * Task: __DDM-Pxx-Tyy__, "__task title__"
 * Acceptance: "__acceptance sentence, verbatim from docs/ROADMAP.yaml__"
 *
 * Three fixtures are required, mirroring tests/enso-horizons.spec.ts:
 *   with-block     the snapshot carries the __slug__ block
 *   without-block  the block is absent (an older snapshot)
 *   stale          retrieved is older than HARD_STALE_DAYS
 *
 * Reuse the fixture-serving machinery from tests/enso-horizons.spec.ts
 * (route interception of URLS.ensoIndicesLocal with a fixture body). Do not
 * fetch CPC in a test.
 */

import { expect, test, type Page } from '@playwright/test';
// The forbidden forecast-language list S11 factored out. Confirm the export
// name in tests/enso-forecast-language.ts before use.
import { FORECAST_LANGUAGE } from './enso-forecast-language';

// Fixture helpers: import from tests/enso-horizons.spec.ts if they are
// exported, otherwise lift them into a shared tests/enso-fixtures.ts first.
// The three names below are placeholders for whatever that file provides.
declare function serveEnsoSnapshot(page: Page, fixture: 'with-block' | 'without-block' | 'stale'): Promise<void>;
declare function openBriefingAt(page: Page, lngLat: readonly [number, number]): Promise<void>;
declare function ensoCellText(page: Page, horizon: 'current' | 'nearTerm' | 'longRange'): Promise<string>;

const SELECTED_POINT: readonly [number, number] = [-120.5, 47.5];

/** The register's issuer_meaning quote, under 15 words, as it should render. */
const ISSUER_MEANING_FRAGMENT = '__issuer meaning fragment__';

test.describe('__Name__ in the ENSO briefing (__DDM-Pxx-Tyy__)', () => {
  test('with the block: the current horizon shows the observed index once, cited', async ({ page }) => {
    await serveEnsoSnapshot(page, 'with-block');
    await openBriefingAt(page, SELECTED_POINT);

    const current = await ensoCellText(page, 'current');
    expect(current).toContain(ISSUER_MEANING_FRAGMENT);

    // Shown under one horizon only (DDM-P12-T02 acceptance carries forward).
    const nearTerm = await ensoCellText(page, 'nearTerm');
    const longRange = await ensoCellText(page, 'longRange');
    expect(nearTerm).not.toContain(ISSUER_MEANING_FRAGMENT);
    expect(longRange).not.toContain(ISSUER_MEANING_FRAGMENT);

    // The claim carries a source link to the product page in the register.
    const sourceHref = await page
      .locator('[data-testid="enso-current"] a[data-claim-source]')
      .filter({ hasText: '__ISSUER__ __Name__' })
      .getAttribute('href');
    expect(sourceHref).toBe('__URL__');
  });

  test('with the block: the sentence contains no forecast language', async ({ page }) => {
    await serveEnsoSnapshot(page, 'with-block');
    await openBriefingAt(page, SELECTED_POINT);
    const current = await ensoCellText(page, 'current');
    for (const phrase of FORECAST_LANGUAGE) {
      expect(current.toLowerCase(), `forbidden phrase: ${phrase}`).not.toContain(phrase);
    }
  });

  test('without the block: nothing about the index renders and the rest still does', async ({ page }) => {
    await serveEnsoSnapshot(page, 'without-block');
    await openBriefingAt(page, SELECTED_POINT);
    const current = await ensoCellText(page, 'current');
    expect(current).not.toContain(ISSUER_MEANING_FRAGMENT);
    // The RONI index-state read still renders: the block was optional.
    expect(current).toMatch(/operational RONI season/);
  });

  test('stale snapshot: the index claim is withheld like the tendency claim', async ({ page }) => {
    await serveEnsoSnapshot(page, 'stale');
    await openBriefingAt(page, SELECTED_POINT);
    const current = await ensoCellText(page, 'current');
    expect(current).not.toContain(ISSUER_MEANING_FRAGMENT);
    expect(current).toMatch(/Refresh the snapshot for the current state/);
  });
});
