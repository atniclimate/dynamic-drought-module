/**
 * The honest-disablement hook (0.8.0 T-M0-4, N4a): the capability level of
 * one axis for the coverage family a region belongs to. M-BREADTH consults
 * this to disable unsupported analyses rather than failing quietly. N2-A's
 * impact panel is the first runtime caller. 'partial' keeps its full meaning;
 * there is deliberately no boolean convenience wrapper collapsing partial
 * and full.
 *
 * A separate module on purpose: src/config/capability-matrix.ts stays
 * import-free (the coverage-matrix
 * generator imports it through Node's native type stripping, which cannot
 * resolve extensionless local imports), and the matrix stays out of the
 * eager entry graph until a behavioral consumer imports this hook.
 */

import { CAPABILITY_MATRIX } from './capability-matrix';
import { REGIONS, type RegionKey } from './regions';
import type {
  CapabilityAxisKey,
  CapabilityLevel
} from '../types/capability-matrix';

type RuntimeRegionKey = RegionKey | string | null;

const UNKNOWN_REGION_NOTE =
  'Drought impact analysis and resource routing are unavailable because this selection has no recognized coverage region.';

function regionCoverageFamily(
  regionKey: RuntimeRegionKey
): keyof typeof CAPABILITY_MATRIX | null {
  if (
    typeof regionKey !== 'string' ||
    !Object.prototype.hasOwnProperty.call(REGIONS, regionKey)
  ) {
    return null;
  }
  return REGIONS[regionKey as RegionKey].coverageFamily;
}

export function regionCapabilityLevel(
  regionKey: RuntimeRegionKey,
  axis: CapabilityAxisKey
): CapabilityLevel {
  const family = regionCoverageFamily(regionKey);
  return family === null ? 'none' : CAPABILITY_MATRIX[family][axis].level;
}

/** The matrix note paired with `regionCapabilityLevel`, for honest UI copy. */
export function regionCapabilityNote(
  regionKey: RuntimeRegionKey,
  axis: CapabilityAxisKey
): string {
  const family = regionCoverageFamily(regionKey);
  return family === null
    ? UNKNOWN_REGION_NOTE
    : CAPABILITY_MATRIX[family][axis].note;
}
