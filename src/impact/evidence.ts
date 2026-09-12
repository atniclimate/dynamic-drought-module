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
import { PRODUCT_KEYS } from '../config/products';

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

/**
 * The reader-facing observed/outlook register word (DDM-P8-T03, owner ruling
 * R3, 2026-09-07): a second, plainer word placed beside a claim's source
 * line so a reader can tell, without decoding the seven-way badge, whether a
 * claim describes something already true or something the app expects.
 *
 * This is NOT `EvidencePresentation.tone` above. `derived` and `classified`
 * carry the `outlook`/`observation` TONE the T-P0-2 badge styling needs, but
 * that tone answers "should this look cautious," not "is this the observed
 * or the outlook register." Every `derived` claim this app builds is a
 * present-tense read computed from already-observed inputs (the wildfire
 * companion inferred from the current USDM category; the ENSO index-state
 * and Pacific Northwest tendency reads), never a probability, so `derived`
 * renders `observed` here (the exact case DR-031 raised: the near-term ENSO
 * claim under a heading that must not imply a forecast the app does not
 * have). `classified` is not named in the R3 ruling; it renders `observed`
 * by the same reasoning the badge tone already gives it: an issuer's own
 * classification of a currently valid state (HeatRisk's 0-4 class), not a
 * forecast. `modeled` and `modeled-analysis` are unused by any claim as of
 * this ruling; both render `outlook`, matching their existing tone, because
 * a model output is exactly the forward-looking case the tag exists to mark.
 *
 * A claim whose text would be misdescribed by its class's tag renders none
 * (R3's escape hatch) rather than take this table's default. The 2026-09-07
 * inventory of every claim site found none that needed it; DR-070 amended
 * 2026-09-08 later created the first one: a HeatRisk claim in force is
 * OUTLOOK register (the issuer's own words, HeatRisk "provides a forecast of
 * the potential level of risk ... over a 24-hour period", override the
 * classified -> observed reading for HeatRisk only; every other classified
 * source keeps observed). `src/impact/sources.ts` sets that one claim's
 * `register` field; read this table through `claimRegisterTag`, not
 * directly, so a per-claim override is never missed. `src/ui/claim-render.ts`
 * renders the result beside the source line; `CELL_ABSENCE` prose in
 * `src/impact/matrix.ts` never reaches this table (R4: an absence is neither
 * register).
 */
export const CLAIM_REGISTER_TAG: Readonly<Record<EvidenceClass, 'observed' | 'outlook'>> = {
  observed: 'observed',
  analyzed: 'observed',
  classified: 'observed',
  'modeled-analysis': 'outlook',
  modeled: 'outlook',
  derived: 'observed',
  outlook: 'outlook'
};

/**
 * The reader-facing register for one claim: its explicit `register` override
 * when set (DR-070 amended 2026-09-08), else `CLAIM_REGISTER_TAG`'s
 * per-evidence-class default. The only sanctioned way to read a claim's
 * register; callers must not index `CLAIM_REGISTER_TAG` directly, or a
 * future per-claim override would be silently skipped.
 */
export function claimRegisterTag(
  claim: Pick<SourcedClaim, 'evidence' | 'register'>
): 'observed' | 'outlook' {
  return claim.register ?? CLAIM_REGISTER_TAG[claim.evidence];
}

/** A claim under construction: everything but the derived legacy `kind`. */
export type SourcedClaimInput = Omit<SourcedClaim, 'kind'>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The typed claim factory: the only sanctioned way to build a `SourcedClaim`,
 * in src/ and in specs alike. Because specs are excluded from typecheck, the
 * contract is enforced HERE at runtime, not only by the input type: text and
 * source must be non-empty, `evidence` must be one of the seven classes,
 * `product` must be a `PRODUCT_KEYS` member (DDM-P14-T05 microtask 2), and
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
  if (!PRODUCT_KEYS.includes(input.product)) {
    throw new Error(`makeClaim: unknown product key "${String(input.product)}"`);
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
