import type { SourceResult } from './sources';
import type { Horizon, SourcedClaim } from './types';

/**
 * Fold a set of source results into a horizon: concatenate the claims in the
 * order given (which carries the wildfire-and-heat foregrounding), and set the
 * status from how many fetches succeeded. A horizon with every source failing
 * reads as `unavailable`; a mix reads as `partial`; all-ok reads as `ready`.
 */
export function fillHorizon(
  horizon: Horizon,
  results: SourceResult[],
  extraClaims: SourcedClaim[] = []
): void {
  const claims: SourcedClaim[] = [];
  const notes: string[] = [];
  let ok = 0;
  for (const result of results) {
    if (result.ok) {
      ok += 1;
      claims.push(...result.claims);
    } else if (result.note) {
      notes.push(result.note);
    }
  }
  claims.push(...extraClaims);
  horizon.claims = claims;

  if (results.length === 0) {
    horizon.status = claims.length > 0 ? 'ready' : 'unavailable';
  } else if (ok === results.length) {
    horizon.status = 'ready';
  } else if (ok > 0 || extraClaims.length > 0) {
    horizon.status = 'partial';
  } else {
    horizon.status = 'unavailable';
  }
  if (notes.length > 0) {
    horizon.note = notes.join(' ');
  } else {
    delete horizon.note;
  }
}
