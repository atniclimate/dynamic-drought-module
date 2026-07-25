/**
 * The honest-disablement hook (0.8.0 T-M0-4, N4a): the capability level of
 * one axis for the coverage family a region belongs to. M-BREADTH consults
 * this to disable unsupported analyses rather than failing quietly; no
 * runtime caller exists yet, and 'partial' keeps its full meaning (what
 * 'partial' PERMITS is ruled when a behavioral consumer earns it; there is
 * deliberately no boolean convenience wrapper collapsing partial and full).
 *
 * A separate module on purpose: src/config/regions.ts stays metadata-only,
 * src/config/capability-matrix.ts stays import-free (the coverage-matrix
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

export function regionCapabilityLevel(
  regionKey: RegionKey,
  axis: CapabilityAxisKey
): CapabilityLevel {
  return CAPABILITY_MATRIX[REGIONS[regionKey].coverageFamily][axis].level;
}
