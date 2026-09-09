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

import { claimDateLine, claimRegisterTag, EVIDENCE_PRESENTATION } from '../impact/evidence';
import type { SourcedClaim } from '../impact/types';
import { escapeHtml } from '../util/escape';

/**
 * A claim's `method` fields, joined into one compact phrase, or null when the
 * claim carries none. `basis` (the issuer's own method statement, quoted
 * where it is set) leads; the provenance fields follow.
 */
function methodPhrase(method: SourcedClaim['method']): string | null {
  if (!method) return null;
  const bits: string[] = [];
  if (method.basis) bits.push(method.basis);
  if (method.baseline) bits.push(`${method.baseline} baseline`);
  if (method.version) bits.push(`version ${method.version}`);
  if (method.sourceVintage) bits.push(`source vintage ${method.sourceVintage}`);
  return bits.length > 0 ? bits.join('; ') : null;
}

/**
 * A claim's `support` fields (excluding `legendKey`, rendered separately as a
 * link), joined into one compact phrase, or null when the claim carries none.
 */
function supportPhrase(support: SourcedClaim['support']): string | null {
  if (!support) return null;
  const bits: string[] = [];
  if (support.reporting) bits.push(support.reporting);
  if (support.native) bits.push(`native ${support.native}`);
  if (support.effective) bits.push(`effective ${support.effective}`);
  return bits.length > 0 ? bits.join('; ') : null;
}

/**
 * Render a single sourced claim to HTML. Uncertainty and derivation lineage
 * are RENDERED, not just carried: a recorded-but-hidden uncertainty is not
 * "uncertainty shown", and a Derived badge without its inputs is not a trace
 * (the DG-080-REVIEW T-P0-2 blocker). DDM-P13-T02 (ROADMAP.yaml:506) renders
 * `support` and `method` too, for the same reason: a claim's basis is not
 * "reachable" if the app already downloaded it and never showed it. The
 * per-product legend, when the claim names one (`support.legendKey`), is
 * reached through a plain link to the shared legend panel
 * (`src/ui/legend-registry.ts`), the same panel the map layer already builds
 * its section into.
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
  // Observed/outlook register word (DDM-P8-T03, R3; per-claim override
  // DR-070 amended 2026-09-08): text only, beside the source line, so a
  // reader can tell the register without decoding the seven-way badge above.
  // src/impact/evidence.ts owns the one mapping and its override.
  const registerHtml = ` <span class="impact-claim-register">${escapeHtml(claimRegisterTag(claim))}</span>`;
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
  // A per-product legend already exists (src/ui/legend-registry.ts) when the
  // claim names the section it lives in; the link is a plain, static anchor
  // to the one shared panel, not a DOM lookup, so this stays pure (DDM-P13-T02).
  // DDM-P13-T02 correction: the href stays the no-script fallback (jumps to
  // the shared panel by id); the DOM-aware click handler that makes this
  // reachable in one click, layer on or off, lives in
  // src/ui/impact-panel-runtime.ts (the panel's owner), not here.
  const legendHtml =
    typeof claim.support?.legendKey === 'string' && claim.support.legendKey.length > 0
      ? ` <a href="#legend-panel" data-legend-key="${escapeHtml(claim.support.legendKey)}" title="Legend; turns the layer on if it is off">Legend</a>`
      : '';
  // Method and support are rendered, not just carried, for the same honesty
  // reason as uncertainty and lineage above: the app already downloads this
  // basis for some claims and previously kept it data-only (DDM-P13-T02,
  // ROADMAP.yaml:506).
  const method = methodPhrase(claim.method);
  const support = supportPhrase(claim.support);
  const methodSupportBits = [
    method ? `Method: ${method}` : null,
    support ? `Support: ${support}` : null
  ].filter((b): b is string => b !== null);
  const methodSupportHtml =
    methodSupportBits.length > 0
      ? `<p class="impact-claim-uncertainty">${methodSupportBits.map((b) => escapeHtml(b)).join(' · ')}</p>`
      : '';
  return `
    <div class="impact-claim ${pres.cssClass}">
      <span class="impact-claim-badge">${escapeHtml(pres.label)}</span>
      <p class="impact-claim-text">${escapeHtml(claim.text)}</p>
      ${chart}
      ${uncertainty}
      ${lineage}
      <p class="impact-claim-source">Source: ${sourceHtml}${dateHtml}${registerHtml}${legendHtml}</p>
      ${methodSupportHtml}
    </div>
  `;
}
