// Page-free tests moved from evidence-contract.spec.ts: they never open a page, so they run in the pure lane.
import { expect, test } from './offline-test';

import { claimDateLine, EVIDENCE_PRESENTATION, makeClaim } from '../src/impact/evidence';
import type { EvidenceClass } from '../src/impact/types';
import { renderClaim } from '../src/ui/claim-render';

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
    product: 'usdm',
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
        product: 'usdm',
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
        product: 'usdm',
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
        product: 'usdm',
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
        product: 'heatrisk',
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

  test('DR-070 amended 2026-09-08: a per-claim register override renders its own word, not its evidence class default', () => {
    // The HeatRisk exception: classified evidence, but the register reads
    // outlook because the claim sets it explicitly. The badge (evidence
    // class) is unaffected; only the register word beside the source line
    // changes.
    const overridden = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        product: 'heatrisk',
        evidence: 'classified',
        register: 'outlook',
        dates: { retrieved: '2026-09-08' }
      })
    );
    expect(overridden).toContain('impact-claim impact-claim-classified"');
    expect(overridden).toContain('>Classified</span>');
    expect(overridden).toContain('<span class="impact-claim-register">outlook</span>');
    expect(overridden).not.toContain('<span class="impact-claim-register">observed</span>');

    // Every other classified claim, with no override set, still renders the
    // class default (observed): the amendment names HeatRisk alone.
    const defaulted = renderClaim(claimOf('classified'));
    expect(defaulted).toContain('<span class="impact-claim-register">observed</span>');
  });

  test('method provenance fields join baseline, version, and source vintage', () => {
    const html = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        product: 'usdm',
        evidence: 'observed',
        dates: { retrieved: '2026-07-21' },
        method: { baseline: '1991-2020 normal', version: '2.6', sourceVintage: '2025 release' }
      })
    );
    expect(html).toContain('Method: 1991-2020 normal baseline; version 2.6; source vintage 2025 release');
  });

  test('a basis that ends its own sentence joins the provenance without ".;"', () => {
    const claim = (method: { basis: string; version?: string }): string =>
      renderClaim(
        makeClaim({ text: 't', source: 's', product: 'usdm', evidence: 'observed', dates: { retrieved: '2026-07-21' }, method })
      );
    // Seen in the fuel moisture briefing (2026-11-22): "not a field measurement.; version model v01".
    const joined = claim({ basis: 'An estimate, not a field measurement.', version: 'v01' });
    expect(joined).toContain('Method: An estimate, not a field measurement; version v01');
    expect(joined).not.toContain('.;');
    // Alone, the basis keeps the full stop its author gave it.
    expect(claim({ basis: 'An estimate, not a field measurement.' })).toContain('Method: An estimate, not a field measurement.');
  });

  test('a lineage reference rides the title attribute, never the sentence (DR-058 a)', () => {
    const html = renderClaim(
      makeClaim({
        text: 't',
        source: 's',
        product: 'usdm',
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
    expect(() =>
      makeClaim({ text: 't', source: 's', product: 'usdm', evidence: 'observed' })
    ).toThrow(/at least one date/);
  });

  test('rejects empty text, empty source, unknown evidence, malformed dates', () => {
    const dates = { retrieved: '2026-07-21' } as const;
    expect(() =>
      makeClaim({ text: '', source: 's', product: 'usdm', evidence: 'observed', dates })
    ).toThrow();
    expect(() =>
      makeClaim({ text: 't', source: '', product: 'usdm', evidence: 'observed', dates })
    ).toThrow();
    expect(() =>
      makeClaim({ text: 't', source: 's', product: 'usdm', evidence: 'guessed' as never, dates })
    ).toThrow(/unknown evidence class/);
    expect(() =>
      makeClaim({
        text: 't',
        source: 's',
        product: 'usdm',
        evidence: 'observed',
        dates: { retrieved: '07/21/2026' }
      })
    ).toThrow(/ISO 8601/);
  });

  test('rejects a claim with no product and a claim with an unknown product key (DDM-P14-T05 microtask 2)', () => {
    const dates = { retrieved: '2026-07-21' } as const;
    expect(() =>
      makeClaim({ text: 't', source: 's', evidence: 'observed', dates } as never)
    ).toThrow(/unknown product key/);
    expect(() =>
      makeClaim({ text: 't', source: 's', product: 'not-a-product' as never, evidence: 'observed', dates })
    ).toThrow(/unknown product key/);
  });
});

test.describe('date precedence (valid > issued > published > retrieved)', () => {
  const base = { text: 't', source: 's', product: 'usdm', evidence: 'observed' } as const;

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
    expect(claimDateLine({})).toBeNull();
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
        product: 'usdm',
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
        product: 'heatrisk',
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
