import type { PolygonClipLimits } from './polygon-clip-contract';
import type { PerimeterFingerprintLimits } from './perimeter-fingerprints';
import type { PerimeterKernelLimits, PerimeterKernelResult } from './perimeter-grouping';
export interface PerimeterJobLimits {
  readonly maxInputChars: number;
  readonly maxTotalVertices: number;
  readonly maxCandidatePairs: number;
  readonly fingerprint: PerimeterFingerprintLimits;
  readonly kernel: PerimeterKernelLimits;
  readonly clip: PolygonClipLimits;
}
export interface PerimeterJobRequest {
  readonly operation: 'group-perimeters';
  readonly generation: number;
  /** JSON array of {issuer, geometry, properties}; caller retains these exact bytes. */
  readonly sourceJson: string;
  readonly limits: PerimeterJobLimits;
}
export interface PerimeterJobResult {
  readonly graph: PerimeterKernelResult;
  /** Exact source array positions, including duplicate versions, for raw readback. */
  readonly sources: readonly { readonly versionKey: string; readonly indices: readonly number[] }[];
}
export type PerimeterJobReply = { readonly operation: 'group-perimeters'; readonly generation: number } &
  ({ readonly ok: true; readonly result: PerimeterJobResult } | { readonly ok: false; readonly reason: 'job-failed' });
export function assertPerimeterJobLimits(limits: PerimeterJobLimits): void {
  const values = [limits.maxInputChars, limits.maxTotalVertices, limits.maxCandidatePairs,
    limits.fingerprint.maxNodes, limits.fingerprint.maxDepth, limits.fingerprint.maxChars,
    limits.fingerprint.geometry.maxVertices, limits.fingerprint.geometry.maxSegmentTests,
    limits.kernel.maxVersions, limits.kernel.maxRecords, limits.kernel.maxPairChecks,
    limits.kernel.maxIdentityChars, limits.kernel.maxComponentsPerPair,
    limits.clip.input.maxVertices, limits.clip.input.maxSegmentTests,
    limits.clip.output.maxVertices, limits.clip.output.maxSegmentTests];
  if (!values.every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError('Invalid perimeter job limits.');
}
