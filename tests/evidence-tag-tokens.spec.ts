import { test, expect } from './offline-test';
import { gotoApp } from './helpers';
import { makeClaim } from '../src/impact/evidence';
import type { EvidenceClass } from '../src/impact/types';
import { renderClaim } from '../src/ui/claim-render';

const tiers: { evidence: EvidenceClass; label: string; border: string; ink: string; fill: string }[] = [
  { evidence: 'observed', label: 'Observed', border: 'solid', ink: 'rgb(1, 11, 19)', fill: 'rgb(232, 236, 240)' },
  ...(['analyzed', 'classified', 'derived'] as const).map(evidence => ({
    evidence, label: evidence[0]!.toUpperCase() + evidence.slice(1), border: 'solid',
    ink: 'rgb(232, 236, 240)', fill: 'rgba(0, 0, 0, 0)'
  })),
  ...(['modeled', 'modeled-analysis', 'outlook'] as const).map(evidence => ({
    evidence, label: evidence === 'modeled-analysis' ? 'Modeled analysis' : evidence[0]!.toUpperCase() + evidence.slice(1),
    border: 'dashed', ink: 'rgb(198, 203, 212)', fill: 'rgba(0, 0, 0, 0)'
  }))
];

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test('D3 evidence tags retain seven words in three neutral form tiers: ' + reducedMotion, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion });
    await gotoApp(page, '?view=console&layers=none&flow=off');
    const markup = tiers.map(({ evidence }) => renderClaim(makeClaim({
      text: 'Synthetic evidence contract specimen.', source: 'Offline fixture',
      product: 'usdm', evidence, dates: { valid: '2026-10-01' },
      lineage: ['Synthetic fixture input']
    }))).join('');
    await page.evaluate(html => {
      const specimen = document.createElement('section');
      specimen.id = 'evidence-token-specimen';
      specimen.style.cssText = 'position:fixed;inset:10px 10px 10px auto;width:380px;overflow:auto;z-index:10000;padding:16px;background:var(--surface-raised);color:var(--ink)';
      specimen.innerHTML = html;
      document.body.append(specimen);
    }, markup);
    const specimen = page.locator('#evidence-token-specimen');
    for (const tier of tiers) {
      const badge = specimen.locator('.impact-claim-' + tier.evidence + ' .impact-claim-badge');
      await expect(badge).toHaveText(tier.label);
      await expect(badge).toHaveCSS('color', tier.ink);
      await expect(badge).toHaveCSS('background-color', tier.fill);
      await expect(badge).toHaveCSS('border-top-style', tier.border);
      await expect(badge).toHaveCSS('border-top-width', '1px');
      await expect(badge).toHaveCSS('border-top-color', tier.evidence === 'observed' ? 'rgb(232, 236, 240)' : tier.border === 'solid' ? 'rgb(198, 203, 212)' : 'rgb(152, 161, 180)');
      await expect(badge).toHaveCSS('animation-name', 'none');
    }
  });
}
