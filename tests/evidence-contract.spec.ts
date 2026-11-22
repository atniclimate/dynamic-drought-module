import { expect, test, type Page } from './offline-test';

import { makeClaim } from '../src/impact/evidence';
import { renderClaim } from '../src/ui/claim-render';
import { gotoApp, showFullDetail } from './helpers';

/**
 * The evidence/claim contract (0.8.0 T-P0-2; D-0.8.0-012).
 *
 * Pins the honesty core of the contract: the seven evidence classes map to
 * their own labels and styling through the ONE helper in
 * src/impact/evidence.ts; the legacy `kind` is derived, never independent; a
 * modeled-class claim never renders with observation styling and
 * modeled-analysis never renders as "Outlook"; the shown date line follows
 * the valid > issued > published > retrieved precedence; and the live panel
 * renders evidence badges and date lines on real briefing claims.
 */

// ---------------------------------------------------------------------------
// Rendered panel: real briefing claims carry evidence badges and date lines
// ---------------------------------------------------------------------------

const EMPTY_COLLECTION = JSON.stringify({ type: 'FeatureCollection', features: [] });

/** Deterministic briefing sources: USDM answers D2; the rest answer empty. */
async function stubBriefingSources(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { DM: 2 }, geometry: null }]
      })
    })
  );
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('https://mapservices.weather.noaa.gov/**', (route) =>
    route.fulfill({ contentType: 'application/geo+json', body: EMPTY_COLLECTION })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' })
  );
}

test.describe('rendered briefing under the contract', () => {
  test('claims carry truthful evidence badges and date lines', async ({ page }) => {
    await stubBriefingSources(page);
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);

    // The USDM category claim is analyzed, never plain "Observed".
    const usdmClaim = panel.locator('.impact-claim', {
      hasText: "as of this week's U.S. Drought Monitor"
    });
    await expect(usdmClaim.first()).toBeVisible({ timeout: 15_000 });
    await expect(usdmClaim.first().locator('.impact-claim-badge')).toHaveText('Analyzed');
    await expect(usdmClaim.first().locator('.impact-claim-date')).toContainText('Retrieved');

    // DDM-P13-T02 F2: the USDM category claim carries the same percentile
    // basis as the DSCI claim, and the Legend link that reaches the USDM
    // legend section (support.legendKey: 'usdm').
    await expect(usdmClaim.first()).toContainText('Method:');
    await expect(usdmClaim.first()).toContainText('D0 to D4 by percentile');
    await expect(usdmClaim.first()).toContainText('Support: the USDM polygons in this area');
    const usdmLegendLink = usdmClaim.first().locator('a[data-legend-key="usdm"]');
    await expect(usdmLegendLink).toBeVisible();
    // DDM-P13-T02 F4: `usdm` is role: 'surface' (src/config/layers.ts), so
    // the hydrated title discloses the surface replacement BEFORE the click.
    await expect(usdmLegendLink).toHaveAttribute(
      'title',
      'Legend; turns the US Drought Monitor layer on if it is off, replacing the surface layer showing now'
    );

    // The wildfire companion is a DDM-derived read and is labeled so.
    const wildfireClaim = panel.locator('.impact-claim', { hasText: 'Wildfire:' });
    await expect(wildfireClaim.first().locator('.impact-claim-badge')).toHaveText('Derived');

    // The ENSO tilt (from the bundled snapshot) is derived, dated by the
    // snapshot's retrieval date.
    const ensoClaim = panel.locator('.impact-claim', { hasText: 'Relative Oceanic Nino Index' });
    await expect(ensoClaim.first()).toBeVisible({ timeout: 15_000 });
    await expect(ensoClaim.first().locator('.impact-claim-badge')).toHaveText('Derived');
    // U-ENSO-REPAIR (2026-07-27) added per-index upstream publication dates, so
    // this claim's date line now resolves to `published` under the DOCUMENTED
    // precedence in src/impact/types.ts (valid, else issued, else published,
    // else retrieved). That is the contract working, not a regression: this
    // assertion previously read `Retrieved` only because no published date
    // existed to outrank it.
    await expect(ensoClaim.first().locator('.impact-claim-date')).toContainText('Published');
    // The honesty property the old assertion was really protecting is that the
    // reader can still tell HOW OLD the snapshot is, which the date chip no
    // longer carries. Pin it where it actually lives, in the provenance
    // sentence, so a future change cannot drop both.
    await expect(panel).toContainText(/snapshot (retrieved|dated) \d{4}-\d{2}-\d{2}/);

    // The legacy tone classes are gone from the DOM.
    await expect(panel.locator('.impact-claim-observation')).toHaveCount(0);
  });

  test('the stylesheet keeps modeled presentation distinct from observed (computed styles)', async ({
    page
  }) => {
    // No live source emits a modeled claim yet, so inject renderClaim output
    // for the three contested classes into the real page and read COMPUTED
    // badge styles: a dropped or observation-colored .impact-claim-modeled
    // rule must fail here, not ride green on markup tokens alone.
    await stubBriefingSources(page);
    await gotoApp(page, '');
    const html = (['observed', 'modeled', 'modeled-analysis'] as const)
      .map((evidence) =>
        renderClaim(
          makeClaim({
            text: `A ${evidence} statement.`,
            source: 'Test source',
            product: 'usdm',
            evidence,
            dates: { retrieved: '2026-07-21' }
          })
        )
      )
      .join('');
    const colors = await page.evaluate((markup) => {
      const host = document.createElement('div');
      host.innerHTML = markup;
      document.body.appendChild(host);
      const badgeColor = (selector: string): string => {
        const el = host.querySelector<HTMLElement>(`${selector} .impact-claim-badge`);
        return el ? getComputedStyle(el).color : 'MISSING';
      };
      return {
        observed: badgeColor('.impact-claim-observed'),
        modeled: badgeColor('.impact-claim-modeled'),
        modeledAnalysis: badgeColor('.impact-claim-modeled-analysis'),
        modeledAnalysisLabel:
          host.querySelector('.impact-claim-modeled-analysis .impact-claim-badge')?.textContent ?? ''
      };
    }, html);
    expect(colors.observed).not.toBe('MISSING');
    expect(colors.modeled).not.toBe('MISSING');
    expect(colors.modeledAnalysis).not.toBe('MISSING');
    expect(colors.modeled).not.toBe(colors.observed);
    expect(colors.modeledAnalysis).not.toBe(colors.observed);
    expect(colors.modeledAnalysisLabel).toBe('Modeled analysis');
  });
});

// ---------------------------------------------------------------------------
// Legend reachable in one click, layer off or on (DDM-P13-T02 correction,
// clause 3). The verifier refuted the first cut: the Legend link pointed at
// `#legend-panel`, which the registry (src/ui/legend-registry.ts) leaves
// hidden and empty while the product's map layer is off. This pins the fix:
// clicking the link with the layer off turns the layer on and reaches the
// section, and the URL's `layers=` list picks up the layer key.
// ---------------------------------------------------------------------------

test.describe('legend reachable from the claim (DDM-P13-T02 correction)', () => {
  test('the USDM claim\'s Legend link turns the layer on and opens its section when the layer starts off', async ({
    page
  }) => {
    await stubBriefingSources(page);
    // The generic `**/proxy?*` stub above answers every proxied call with an
    // empty body; the severity-trend claim that carries `support.legendKey:
    // 'usdm'` (src/impact/sources.ts fetchDsciTrendClaims) needs a real
    // two-point DSCI series to render at all, so this narrower, later route
    // wins for that one upstream call (Playwright runs the most recently
    // registered matching route first).
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 84);
    const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
    await page.route('**/proxy?url=*GetDSCI*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          { mapDate: isoDay(start), dsci: 200 },
          { mapDate: isoDay(end), dsci: 210 }
        ])
      })
    );

    // A bare boot draws usdm now (DR-270), so the boot lists the reference
    // layers alone to start with the USDM layer off.
    await gotoApp(page, '?select=state:WA&view=brief&layers=aiannh,bia-reservations,states,hillshade');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await showFullDetail(page);

    // The USDM layer starts off: no `layers=` naming it yet.
    expect(new URL(page.url()).searchParams.get('layers') ?? '').not.toContain('usdm');
    await expect(page.locator('#layer-toggle-usdm')).not.toBeChecked();

    const legendLink = panel.locator('a[data-legend-key="usdm"]').first();
    await expect(legendLink).toBeVisible({ timeout: 15_000 });
    await legendLink.click();

    // The layer turns on...
    await expect(page.locator('#layer-toggle-usdm')).toBeChecked();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('layers'), { timeout: 10_000 })
      .toContain('usdm');

    // ...and its legend section becomes visible in the shared panel
    // (getLegendSection non-null, the panel not hidden), which is exactly
    // what the click promised.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const legendPanel = document.getElementById('legend-panel');
            const section = document.querySelector('.legend-section[data-legend="usdm"]');
            return { panelHidden: legendPanel?.hidden ?? true, sectionExists: section !== null };
          }),
        { timeout: 10_000 }
      )
      .toEqual({ panelHidden: false, sectionExists: true });
    // The desktop Brief draws no legend panel (display: none), so the link
    // opens the on-map Key, where the layer's legend reads.
    await expect(page.locator('#map-key')).toHaveAttribute('data-key-details-open', 'true');
    // Opening the box is not reaching the legend: focus moves into the Key's legend content, and the
    // content a reader finds there is the issuer's classes, not an empty drawer.
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#map-key-legend'))), { timeout: 10_000 })
      .toBe(true);
    await expect(page.locator('#map-key-legend .map-key-swatch').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#map-key-legend .map-key-item').first()).not.toBeEmpty();
  });
});
