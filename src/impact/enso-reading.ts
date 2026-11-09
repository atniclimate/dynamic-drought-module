/**
 * The observed ENSO index state as a structured reading (owner direction
 * 2026-11-09 (sprint), DR-pending), for the surfaces that draw the index on
 * its own scale (src/ui/gauges.ts `indexGaugeSvg`) instead of a sentence.
 *
 * WHY THIS IS AN ADAPTER AND NOT A CONSTRUCTION SITE. Every other reading is
 * set where its claim is built (src/impact/sources.ts). The ENSO claims are
 * built in src/impact/enso.ts, which belonged to another lane during the
 * sprint this was written in, so the reading is attached one step later, in
 * the lane loader (`loadEnsoClaims`, src/impact/hydrate.ts). It reads no new
 * source and states no new value: the fields below are the ones enso.ts
 * already validates and prints (`roni.latest`, src/impact/enso.ts:43-48 and
 * 390-393; `roni.state`, enso.ts:58-66 and 407-430), from the same bundled
 * snapshot through the same shared, page-lifetime transport (enso.ts:954-960),
 * so this costs no second request. When enso.ts sets `reading` itself, delete
 * this module and the call in hydrate.ts.
 *
 * It never parses the claim's prose, and it would sooner attach nothing than
 * disagree with it:
 *   - no reading unless enso.ts's own label read (`readEnsoPhaseLabel`)
 *     answers, names the same season and year, and names the same conditions;
 *   - no reading past enso.ts's hard staleness cutoff (`staleAsOf`), where the
 *     claim itself has degraded to a dated past-tense sentence;
 *   - no reading when the snapshot carries no state block (a snapshot built
 *     before 2026-09-02): the onset rule lives in enso.ts and is not restated
 *     here.
 * A failed or cancelled read returns the lane's result unchanged.
 */

import { URLS } from '../config/urls';
import { ENSO_INDICES_SHARED_KEY, fetchSharedJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';
import type { EnsoPhaseLabel } from './enso';
import type { SourceResult } from './sources';
import type { EnsoIndexReading } from './types';

/** enso.ts `PHASE_NAME`, read back as the snapshot's own phase key. */
const CONDITIONS_BY_NAME: Readonly<Record<string, EnsoIndexReading['conditions']>> = {
  'El Nino': 'el-nino',
  'La Nina': 'la-nina',
  neutral: 'neutral'
};

function readingFromSnapshot(json: unknown, label: EnsoPhaseLabel): EnsoIndexReading | null {
  if (!isObject(json) || !isObject(json.roni)) return null;
  const { latest, state } = json.roni;
  if (!isObject(latest) || !isObject(state)) return null;
  const { anom, seas, year, preliminary } = latest;
  const { conditions, threshold } = state;
  if (
    typeof anom !== 'number' ||
    !Number.isFinite(anom) ||
    typeof seas !== 'string' ||
    typeof year !== 'number' ||
    !Number.isInteger(year) ||
    typeof preliminary !== 'boolean' ||
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold <= 0
  ) {
    return null;
  }
  if (conditions !== 'el-nino' && conditions !== 'la-nina' && conditions !== 'neutral') return null;
  // The label is enso.ts's own answer about the same snapshot. Any
  // disagreement means this reader and that module are not looking at the
  // same state, so nothing is drawn.
  if (label.season !== seas || label.year !== year) return null;
  if (CONDITIONS_BY_NAME[label.conditionsName] !== conditions) return null;
  return {
    kind: 'enso-index',
    index: 'RONI',
    value: anom,
    season: seas,
    year,
    preliminary,
    conditions,
    threshold
  };
}

/**
 * Attach the index reading to the lane's `ensoIndex` claim, and to no other.
 * `readLabel` is enso.ts's `readEnsoPhaseLabel`, passed in by the loader that
 * already holds that lazily imported module.
 */
export async function attachEnsoReading(
  result: SourceResult,
  signal: AbortSignal,
  readLabel: (signal: AbortSignal) => Promise<EnsoPhaseLabel | null>
): Promise<SourceResult> {
  if (!result.ok || !result.claims.some((claim) => claim.product === 'ensoIndex')) return result;
  try {
    const label = await readLabel(signal);
    if (signal.aborted || label === null || label.staleAsOf !== null) return result;
    const json = await fetchSharedJsonWithBudget(
      ENSO_INDICES_SHARED_KEY,
      URLS.ensoIndicesLocal,
      { headers: { Accept: 'application/json' } },
      signal,
      6000
    );
    if (signal.aborted) return result;
    const reading = readingFromSnapshot(json, label);
    if (reading === null) return result;
    return {
      ...result,
      claims: result.claims.map((claim) =>
        claim.product === 'ensoIndex' ? { ...claim, reading } : claim
      )
    };
  } catch {
    return result;
  }
}
