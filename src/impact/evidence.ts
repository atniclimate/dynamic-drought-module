/**
 * The evidence/claim contract (0.8.0 T-P0-2; D-0.8.0-012).
 *
 * Every `SourcedClaim` carries a truthful `evidence` class naming what kind
 * of knowledge the statement rests on, plus its dates. This module is the ONE
 * mapping from an evidence class to its visible label, its CSS class, and the
 * legacy `kind` compatibility tone; construction sites build claims through
 * `makeClaim` so a claim can never exist without the required fields, and the
 * renderer derives its presentation from here so a modeled or derived read can
 * never wear observation styling (the honesty doctrine: no modeled surface
 * presented as observed, uncertainty shown, every claim dated).
 *
 * The seven classes:
 *   observed          a measurement or directly-observed fact (telemetry, an
 *                     alert in effect, mapped fire perimeters)
 *   analyzed          an expert-analyzed authoritative product (the USDM map)
 *   classified        a categorical classification of source data
 *   modeled-analysis  a model-assimilated analysis of current conditions
 *   modeled           a model output (simulated, not observed)
 *   derived           a DDM-computed read built from sourced inputs; carries
 *                     `lineage` naming those inputs
 *   outlook           a forward probability or tendency, never a certainty
 */

import type { EvidenceClass, SourcedClaim } from './types';

/**
 * The presentation for one evidence class: visible label, CSS class token,
 * and legacy tone. The renderer takes label AND class from here (one mapping,
 * one place presentation can change).
 */
export interface EvidencePresentation {
  /** The badge label, for example "Modeled analysis" (never "Outlook"). */
  readonly label: string;
  /** The claim's CSS class token, for example "impact-claim-modeled". */
  readonly cssClass: string;
  /**
   * The legacy two-value tone `SourcedClaim.kind` is derived from. Purely a
   * compatibility value for older consumers; the renderer styles from
   * `evidence`, not from this.
   */
  readonly tone: 'observation' | 'outlook';
}

/**
 * The single evidence-class mapping (T-P0-2: one helper covers all seven).
 * Forward-looking and model-borne classes take the outlook tone so nothing
 * simulated or probabilistic can inherit the plain-fact presentation.
 */
export const EVIDENCE_PRESENTATION: Readonly<Record<EvidenceClass, EvidencePresentation>> = {
  observed: { label: 'Observed', cssClass: 'impact-claim-observed', tone: 'observation' },
  analyzed: { label: 'Analyzed', cssClass: 'impact-claim-analyzed', tone: 'observation' },
  classified: { label: 'Classified', cssClass: 'impact-claim-classified', tone: 'observation' },
  'modeled-analysis': { label: 'Modeled analysis', cssClass: 'impact-claim-modeled-analysis', tone: 'outlook' },
  modeled: { label: 'Modeled', cssClass: 'impact-claim-modeled', tone: 'outlook' },
  derived: { label: 'Derived', cssClass: 'impact-claim-derived', tone: 'outlook' },
  outlook: { label: 'Outlook', cssClass: 'impact-claim-outlook', tone: 'outlook' }
};

/** A claim under construction: everything but the derived legacy `kind`. */
export type SourcedClaimInput = Omit<SourcedClaim, 'kind'>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The typed claim factory: the only sanctioned way to build a `SourcedClaim`,
 * in src/ and in specs alike. Because specs are excluded from typecheck, the
 * contract is enforced HERE at runtime, not only by the input type: text and
 * source must be non-empty, `evidence` must be one of the seven classes, and
 * the claim must carry at least one ISO 8601 (`YYYY-MM-DD`) date (every claim
 * is dated; that is the contract, not a style preference). The legacy `kind`
 * is derived, never set independently. Construction sites sit inside their
 * fetchers' try/catch, so a violation degrades to that source's honest
 * unavailable note rather than rendering an uncontracted claim.
 */
export function makeClaim(input: SourcedClaimInput): SourcedClaim {
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new Error('makeClaim: text must be a non-empty string');
  }
  if (typeof input.source !== 'string' || input.source.length === 0) {
    throw new Error('makeClaim: source must be a non-empty string');
  }
  const pres = EVIDENCE_PRESENTATION[input.evidence];
  if (!pres) {
    throw new Error(`makeClaim: unknown evidence class "${String(input.evidence)}"`);
  }
  const dates = input.dates ?? {};
  const dateValues = [dates.valid, dates.issued, dates.published, dates.retrieved].filter(
    (d): d is string => d !== undefined
  );
  if (dateValues.length === 0) {
    throw new Error('makeClaim: every claim carries at least one date');
  }
  for (const d of dateValues) {
    if (!ISO_DAY.test(d)) {
      throw new Error(`makeClaim: dates must be ISO 8601 YYYY-MM-DD, got "${d}"`);
    }
  }
  return { ...input, kind: pres.tone };
}

/** Today as an ISO 8601 date, for `dates.retrieved` on live fetches. */
export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The shown date line for a claim. Precedence: valid, else issued, else
 * published, else retrieved (so `retrieved` always shows when nothing more
 * specific exists). Returns null only for a claim with no dates at all.
 */
export function claimDateLine(claim: Pick<SourcedClaim, 'dates'>): string | null {
  const d = claim.dates;
  if (!d) return null;
  if (d.valid) return `Valid ${d.valid}`;
  if (d.issued) return `Issued ${d.issued}`;
  if (d.published) return `Published ${d.published}`;
  if (d.retrieved) return `Retrieved ${d.retrieved}`;
  return null;
}
