/**
 * Pure claim rendering under the evidence/claim contract (0.8.0 T-P0-2).
 *
 * Kept free of DOM and application state so the evidence-contract spec can
 * import it directly: the badge label, CSS class, and date line all derive
 * from the ONE mapping in src/impact/evidence.ts, so a modeled or derived
 * read can never wear observation styling and every dated claim shows its
 * date (the honesty doctrine). `src/ui/impact-panel.ts` consumes this for
 * every claim it renders.
 */

import { claimDateLine, EVIDENCE_PRESENTATION } from '../impact/evidence';
import type { SourcedClaim } from '../impact/types';
import { escapeHtml } from '../util/escape';

/**
 * Render a single sourced claim to HTML. Uncertainty and derivation lineage
 * are RENDERED, not just carried: a recorded-but-hidden uncertainty is not
 * "uncertainty shown", and a Derived badge without its inputs is not a trace
 * (the DG-080-REVIEW T-P0-2 blocker). `support` and `method` stay data-only
 * for now because every current claim already names them in its prose where
 * they bear on honesty (statewide, basin forecast point, 1991-2020 normal).
 */
export function renderClaim(claim: SourcedClaim): string {
  const pres = EVIDENCE_PRESENTATION[claim.evidence];
  const dateLine = claimDateLine(claim);
  const sourceHtml =
    typeof claim.sourceUrl === 'string' && claim.sourceUrl.startsWith('https://')
      ? `<a href="${escapeHtml(claim.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(claim.source)}</a>`
      : escapeHtml(claim.source);
  // chartSvg is trusted, self-generated markup from src/ui/charts.ts (never
  // user-supplied), so it is injected as-is beneath the claim text.
  const chart = claim.chartSvg ? `<div class="impact-claim-chart">${claim.chartSvg}</div>` : '';
  const dateHtml = dateLine ? ` <span class="impact-claim-date">${escapeHtml(dateLine)}</span>` : '';
  const uncertainty = claim.uncertainty
    ? `<p class="impact-claim-uncertainty">Uncertainty: ${escapeHtml(claim.uncertainty.kind === 'not-quantified' ? `not quantified (${claim.uncertainty.text})` : claim.uncertainty.text)}</p>`
    : '';
  // The lineage reads in plain language; the internal doctrine or model id
  // behind it rides a title attribute (DR-058 a), machine-readable and one
  // hover away, never inside the public sentence.
  const lineageRef =
    typeof claim.lineageRef === 'string' && claim.lineageRef.length > 0
      ? ` title="${escapeHtml(claim.lineageRef)}"`
      : '';
  const lineage =
    claim.lineage && claim.lineage.length > 0
      ? `<p class="impact-claim-lineage"${lineageRef}>Derived from: ${claim.lineage.map((l) => escapeHtml(l)).join('; ')}</p>`
      : '';
  return `
    <div class="impact-claim ${pres.cssClass}">
      <span class="impact-claim-badge">${escapeHtml(pres.label)}</span>
      <p class="impact-claim-text">${escapeHtml(claim.text)}</p>
      ${chart}
      ${uncertainty}
      ${lineage}
      <p class="impact-claim-source">Source: ${sourceHtml}${dateHtml}</p>
    </div>
  `;
}
