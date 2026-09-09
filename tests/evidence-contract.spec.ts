import { expect, test, type Page } from '@playwright/test';

import {
  claimDateLine,
  EVIDENCE_PRESENTATION,
  makeClaim
} from '../src/impact/evidence';
import type { EvidenceClass } from '../src/impact/types';
import { renderClaim } from '../src/ui/claim-render';
import { gotoApp } from './helpers';

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

const SEVEN: ReadonlyArray<readonly [EvidenceClass, string]> = [
  ['observed', 'Observed'],
  ['analyzed', 'Analyzed'],
  ['classified', 'Classified'],
  ['modeled-analysis', 'Modeled analysis'],
  ['modeled', 'Modeled'],
  ['derived', 'Derived'],
  ['outlook', 'Outlook']
];

function claimOf(evidence: EvidenceClass) {
  return makeClaim({
    text: 'A test statement.',
    source: 'Test source',
    evidence,
    dates: { retrieved: '2026-07-21' }
  });
}

test.describe('evidence class mapping (the one helper)', () => {
  test('all seven classes map to their own labels', () => {
    for (const [evidence, label] of SEVEN) {
      expect(EVIDENCE_PRESENTATION[evidence].label, evidence).toBe(label);
    }
  });

  test('the legacy kind is derived from evidence, observation-toned only for the fact classes', () => {
    for (const [evidence] of SEVEN) {
      const claim = claimOf(evidence);
      const factClass = evidence === 'observed' || evidence === 'analyzed' || evidence === 'classified';
      expect(claim.kind, evidence).toBe(factClass ? 'observation' : 'outlook');
    }
  });
});

test.describe('claim rendering honesty', () => {
  test('each class renders its own badge label and CSS class', () => {
    for (const [evidence, label] of SEVEN) {
      const html = renderClaim(claimOf(evidence));
      expect(html, evidence).toContain(`impact-claim impact-claim-${evidence}"`);
      expect(html, evidence).toContain(`>${label}</span>`);
    }
  });

  test('a modeled claim never renders with observation styling', () => {
    const html = renderClaim(claimOf('modeled'));
    expect(html).toContain('impact-claim impact-claim-modeled"');
    expect(html).not.toContain('impact-claim-observed');
    expect(html).not.toContain('impact-claim-observation');
    expect(html).not.toContain('>Observed</span>');
  });

  test('modeled-analysis renders its own honest label, not Outlook', () => {
    const html = renderClaim(claimOf('modeled-analysis'));
    expect(html).toContain('impact-claim impact-claim-modeled-analysis"');
    expect(html).toContain('>Modeled analysis</span>');
    expect(html).not.toContain('>Outlook</span>');
  });

  test('every dated claim renders its date line', () => {
    const html = renderClaim(claimOf('analyzed'));
    expect(html).toContain('impact-claim-date');
    expect(html).toContain('Retrieved 2026-07-21');
  });

  test('uncertainty is rendered, including the explicit not-quantified state', () => {
    const quantified = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        evidence: 'outlook',
        dates: { retrieved: '2026-07-21' },
        uncertainty: { kind: 'categorical', text: 'tercile odds, not a deterministic value' }
      })
    );
    expect(quantified).toContain('impact-claim-uncertainty');
    expect(quantified).toContain('Uncertainty: tercile odds, not a deterministic value');

    const notQuantified = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        evidence: 'outlook',
        dates: { retrieved: '2026-07-21' },
        uncertainty: { kind: 'not-quantified', text: 'the source publishes no uncertainty band' }
      })
    );
    expect(notQuantified).toContain('Uncertainty: not quantified (the source publishes no uncertainty band)');
  });

  test('derived lineage is rendered as a visible trace', () => {
    const html = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        evidence: 'derived',
        dates: { retrieved: '2026-07-21' },
        lineage: ['input one', 'input two']
      })
    );
    expect(html).toContain('impact-claim-lineage');
    expect(html).toContain('Derived from: input one; input two');
    // No reference given: no title attribute is invented.
    expect(html).not.toContain('<p class="impact-claim-lineage" title=');
  });

  test('method and support are rendered, not just carried (DDM-P13-T02)', () => {
    const html = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        evidence: 'classified',
        dates: { valid: '2026-09-08', retrieved: '2026-09-08' },
        method: { basis: 'HeatRisk is calculated over a 24-hour period, not an instant.' },
        support: { reporting: 'the cell at the selected point', legendKey: 'heatrisk' }
      })
    );
    expect(html).toContain('impact-claim-uncertainty');
    expect(html).toContain(
      'Method: HeatRisk is calculated over a 24-hour period, not an instant.'
    );
    expect(html).toContain('Support: the cell at the selected point');
    // The legend is reachable from the claim through a link to the shared
    // legend panel, keyed to the section that already carries it. The title
    // names what happens when the layer is off (DDM-P13-T02 correction,
    // clause 3): the visible text stays the plain "Legend".
    expect(html).toContain(
      '<a href="#legend-panel" data-legend-key="heatrisk" title="Legend; turns the layer on if it is off">Legend</a>'
    );
  });

  test('a claim with neither method nor support renders no method/support line', () => {
    const html = renderClaim(claimOf('observed'));
    expect(html).not.toContain('Method:');
    expect(html).not.toContain('Support:');
    expect(html).not.toContain('legend-panel');
  });

  test('method provenance fields join baseline, version, and source vintage', () => {
    const html = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' },
        method: { baseline: '1991-2020 normal', version: '2.6', sourceVintage: '2025 release' }
      })
    );
    expect(html).toContain('Method: 1991-2020 normal baseline; version 2.6; source vintage 2025 release');
  });

  test('a lineage reference rides the title attribute, never the sentence (DR-058 a)', () => {
    const html = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        evidence: 'derived',
        dates: { retrieved: '2026-09-03' },
        lineage: ['a plain-language input'],
        lineageRef: 'ddm-drought-impact-modeling'
      })
    );
    expect(html).toContain(
      '<p class="impact-claim-lineage" title="ddm-drought-impact-modeling">Derived from: a plain-language input</p>'
    );
    // The id appears exactly once, as the attribute, and not in the text.
    expect(html.split('ddm-drought-impact-modeling')).toHaveLength(2);
  });
});

test.describe('factory runtime enforcement (specs are not typechecked)', () => {
  test('rejects a claim with no date', () => {
    expect(() => makeClaim({ text: 't', source: 's', evidence: 'observed' })).toThrow(
      /at least one date/
    );
  });

  test('rejects empty text, empty source, unknown evidence, malformed dates', () => {
    const dates = { retrieved: '2026-07-21' } as const;
    expect(() => makeClaim({ text: '', source: 's', evidence: 'observed', dates })).toThrow();
    expect(() => makeClaim({ text: 't', source: '', evidence: 'observed', dates })).toThrow();
    expect(() =>
      makeClaim({ text: 't', source: 's', evidence: 'guessed' as never, dates })
    ).toThrow(/unknown evidence class/);
    expect(() =>
      makeClaim({ text: 't', source: 's', evidence: 'observed', dates: { retrieved: '07/21/2026' } })
    ).toThrow(/ISO 8601/);
  });
});

test.describe('date precedence (valid > issued > published > retrieved)', () => {
  const base = { text: 't', source: 's', evidence: 'observed' } as const;

  test('valid wins over everything', () => {
    expect(
      claimDateLine(
        makeClaim({
          ...base,
          dates: { valid: '2026-07-14', issued: '2026-07-15', published: '2026-07-16', retrieved: '2026-07-21' }
        })
      )
    ).toBe('Valid 2026-07-14');
  });

  test('issued, then published, then retrieved', () => {
    expect(
      claimDateLine(makeClaim({ ...base, dates: { issued: '2026-07-15', retrieved: '2026-07-21' } }))
    ).toBe('Issued 2026-07-15');
    expect(
      claimDateLine(makeClaim({ ...base, dates: { published: '2026-07-16', retrieved: '2026-07-21' } }))
    ).toBe('Published 2026-07-16');
    expect(claimDateLine(makeClaim({ ...base, dates: { retrieved: '2026-07-21' } }))).toBe(
      'Retrieved 2026-07-21'
    );
  });

  test('a legacy undated object yields no line (the factory itself refuses one)', () => {
    // Constructed raw deliberately: makeClaim throws on a dateless claim, so
    // the null path exists only for defensive rendering of legacy objects.
    expect(claimDateLine({ dates: undefined })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Day, not instant: a product defined over a day (USDM's weekly map, valid on
// a Tuesday; HeatRisk's daily raster) is never presented with clock-time
// precision at the claim's date chip (DDM-P13-T02, ROADMAP.yaml:506 clause 4).
// `makeClaim` already enforces every date as a bare YYYY-MM-DD (evidence.ts's
// ISO_DAY check), so this pins that the render layer never widens that back
// out into a timestamp, for the two named day-defined products specifically.
// ---------------------------------------------------------------------------

test.describe('day, not instant', () => {
  test('the USDM-shaped claim (weekly map, valid on a Tuesday) renders a day, never a clock time', () => {
    const html = renderClaim(
      makeClaim({
        text: 'As of the Sep 2, 2026 map, statewide drought severity is 210.',
        source: 'U.S. Drought Monitor (NDMC / NOAA / USDA)',
        evidence: 'analyzed',
        dates: { valid: '2026-09-02', retrieved: '2026-09-08' },
        support: { reporting: 'statewide (Test State)', legendKey: 'usdm' },
        method: { basis: 'The NDMC publishes no DSCI trend threshold and calls the index itself experimental.' }
      })
    );
    expect(html).toContain('impact-claim-date">Valid 2026-09-02</span>');
    // No hour, minute, "T" separator, or UTC clock reaches the date chip.
    expect(html).not.toMatch(/impact-claim-date">[^<]*(?:UTC|[T:]\d)/);
  });

  test('the HeatRisk-shaped claim (daily raster) renders a day, never a clock time, and names its own 24-hour-period basis', () => {
    const html = renderClaim(
      makeClaim({
        text: 'HeatRisk (Experimental) value 2, Moderate, at the selected point.',
        source: 'National Weather Service HeatRisk (Experimental)',
        evidence: 'classified',
        dates: { valid: '2026-09-08', retrieved: '2026-09-08' },
        support: { native: 'National Weather Service HeatRisk raster cell', reporting: 'the cell at the selected point', legendKey: 'heatrisk' },
        method: {
          basis:
            'HeatRisk "provides a forecast of the potential level of risk for heat-related impacts to occur over a 24-hour period" and is calculated "from the current date through seven days in the future" (HeatRisk v2.6 Overview).'
        }
      })
    );
    expect(html).toContain('impact-claim-date">Valid 2026-09-08</span>');
    expect(html).not.toMatch(/impact-claim-date">[^<]*(?:UTC|[T:]\d)/);
    // The 24-hour-period framing itself is what makes "a day, not an instant"
    // honest here; it is reachable in the rendered method line.
    expect(html).toContain('over a 24-hour period');
  });
});

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

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

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
  });
});
