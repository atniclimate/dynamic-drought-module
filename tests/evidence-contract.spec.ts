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
