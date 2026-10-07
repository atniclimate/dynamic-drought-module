import { FIRE_PERIMETER_ISSUERS, type PerimeterIssuerIdentity } from '../config/fire-perimeter-issuers';
import { NIFC_MAX_ALLOWABLE_OFFSET_DEG } from '../config/wildfire-presentation';

/** DR-137: the positive-area containment clause has NO one-hectare floor. */
export const PERIMETER_OVERLAP_RULE = {
  minAreaM2: 10_000, // one hectare, SI unit conversion
  minMeanWidthM: 2 * NIFC_MAX_ALLOWABLE_OFFSET_DEG * 111_320,
  smallerRecordFraction: 0.5
} as const;
export interface IntersectionMeasures {
  readonly leftAreaM2: number;
  readonly rightAreaM2: number;
  readonly components: readonly { readonly areaM2: number; readonly perimeterM: number }[];
}
export type PerimeterDecision = 'width' | 'containment' | 'separate' | 'undetermined';
/** Measures must come from the admitted complete geometry, never issuer-reported size. */
export function overlapDecisionFromMeasures(value: IntersectionMeasures): PerimeterDecision {
  if (![value.leftAreaM2, value.rightAreaM2].every(n => Number.isFinite(n) && n > 0)) return 'undetermined';
  const smaller = Math.min(value.leftAreaM2, value.rightAreaM2);
  // Validate the WHOLE result before accepting any component.
  if (value.components.some(c => !Number.isFinite(c.areaM2) || c.areaM2 <= 0 ||
      !Number.isFinite(c.perimeterM) || c.perimeterM <= 0 || c.areaM2 > smaller)) return 'undetermined';
  // Complete disjoint intersection components cannot total more than either input.
  // Canonical positive-term order keeps refusal independent of component order.
  // No tolerance is invented: inconsistent/rounded-over input is undetermined.
  const totalArea = value.components.map(c => c.areaM2).sort((a, b) => a - b).reduce((sum, area) => sum + area, 0);
  if (!Number.isFinite(totalArea) || totalArea > smaller) return 'undetermined';
  if (value.components.some(c => c.areaM2 >= PERIMETER_OVERLAP_RULE.minAreaM2 &&
      c.areaM2 / c.perimeterM >= PERIMETER_OVERLAP_RULE.minMeanWidthM / 2)) return 'width';
  if (value.components.some(c => c.areaM2 >= PERIMETER_OVERLAP_RULE.smallerRecordFraction * smaller)) return 'containment';
  return 'separate';
}

export interface PerimeterIdentityInput {
  readonly issuer: string;
  readonly properties: Readonly<Record<string, unknown>> | null;
  /** Required canonical generalized-coordinate fingerprint, produced upstream. */
  readonly geometryFingerprint: string;
  /** Required fingerprint of the complete source revision, including raw attributes. */
  readonly revisionFingerprint: string;
}
export interface PerimeterVersionIdentity {
  readonly issuer: string;
  readonly recordKey: string;
  readonly versionKey: string;
  readonly fireYear: number | null;
  readonly unkeyed: boolean;
  readonly geometryFingerprint: string;
  readonly revisionFingerprint: string;
}
export interface PerimeterKernelLimits {
  readonly maxVersions: number;
  readonly maxRecords: number;
  readonly maxPairChecks: number;
  readonly maxIdentityChars: number;
  readonly maxComponentsPerPair: number;
}
export class PerimeterKernelLimitError extends Error {
  constructor() { super('Perimeter kernel allowance exceeded.'); this.name = 'PerimeterKernelLimitError'; }
}
function checkedLimits(limits: PerimeterKernelLimits): void {
  if (![limits.maxVersions, limits.maxRecords, limits.maxPairChecks, limits.maxIdentityChars,
    limits.maxComponentsPerPair].every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError('Invalid perimeter kernel limits.');
}
function checkText(value: string, limit: number): void {
  if (typeof value !== 'string' || !value || value.length > limit) throw new PerimeterKernelLimitError();
}
export function normalizePerimeterIdentity(
  input: PerimeterIdentityInput, maxIdentityChars: number,
  issuers: readonly PerimeterIssuerIdentity[] = FIRE_PERIMETER_ISSUERS
): PerimeterVersionIdentity {
  if (!Number.isSafeInteger(maxIdentityChars) || maxIdentityChars <= 0) throw new RangeError('Invalid identity limit.');
  const issuer = issuers.find(row => row.id === input.issuer);
  if (!issuer) throw new TypeError('Unsupported perimeter issuer.');
  if (!/^[a-z][a-z0-9-]*$/.test(issuer.id)) throw new TypeError('Invalid perimeter issuer identity.');
  checkText(input.geometryFingerprint, maxIdentityChars); checkText(input.revisionFingerprint, maxIdentityChars);
  const properties = input.properties ?? {};
  const id = issuer.recordId(properties);
  const recordKey = issuer.id + ':' + (id ?? 'geom:' + encodeURIComponent(input.geometryFingerprint));
  const versionKey = JSON.stringify([recordKey, issuer.sourceVersion(properties),
    input.geometryFingerprint, input.revisionFingerprint]);
  checkText(recordKey, maxIdentityChars); checkText(versionKey, maxIdentityChars);
  return { issuer: issuer.id, recordKey, versionKey, fireYear: issuer.fireYear(properties),
    unkeyed: id === null, geometryFingerprint: input.geometryFingerprint, revisionFingerprint: input.revisionFingerprint };
}
export interface PerimeterGroup {
  readonly key: string;
  readonly members: readonly string[];
}
export interface PerimeterKernelResult {
  readonly groups: readonly PerimeterGroup[];
  /** Evidence completeness for supplied identities only, not provider/K coverage. */
  readonly complete: boolean;
  readonly unresolvedPairs: readonly (readonly [string, string])[];
  readonly versions: readonly PerimeterVersionIdentity[];
}
export type PairEvidence = { readonly status: 'measured'; readonly measures: IntersectionMeasures } |
  { readonly status: 'undetermined' };
/**
 * Pure record graph only. No extent argument, fetch, geometry repair, or Worker import.
 * The producer must bind evidence to BOTH exact version identities. Missing evidence
 * is undetermined. It must not substitute bbox overlap for an intersection decision.
 */
export function groupPerimeterRecords(
  inputs: readonly PerimeterIdentityInput[],
  evidence: (left: PerimeterVersionIdentity, right: PerimeterVersionIdentity) => PairEvidence,
  limits: PerimeterKernelLimits,
  issuers: readonly PerimeterIssuerIdentity[] = FIRE_PERIMETER_ISSUERS
): PerimeterKernelResult {
  checkedLimits(limits);
  if (inputs.length > limits.maxVersions) throw new PerimeterKernelLimitError();
  if (new Set(issuers.map(row => row.id)).size !== issuers.length) throw new TypeError('Duplicate perimeter issuer.');
  const versions = [...new Map(inputs.map(input => {
    const item = normalizePerimeterIdentity(input, limits.maxIdentityChars, issuers);
    return [item.versionKey, item] as const;
  })).values()].sort((a, b) => a.versionKey < b.versionKey ? -1 : a.versionKey > b.versionKey ? 1 : 0);
  const records = new Map<string, PerimeterVersionIdentity[]>();
  for (const version of versions) {
    const list = records.get(version.recordKey) ?? [];
    list.push(version); records.set(version.recordKey, list);
  }
  if (records.size > limits.maxRecords) throw new PerimeterKernelLimitError();
  const keys = [...records.keys()].sort(); const parent = keys.map((_, i) => i);
  const find = (index: number): number => {
    let head = index;
    while (parent[head] !== head) head = parent[head]!;
    while (parent[index] !== index) { const next = parent[index]!; parent[index] = head; index = next; }
    return head;
  };
  let checks = 0;
  const spend = (): void => { if (++checks > limits.maxPairChecks) throw new PerimeterKernelLimitError(); };
  const unresolvedPairs: [string, string][] = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    spend();
    const a = records.get(keys[i]!)!; const b = records.get(keys[j]!)!;
    if (a[0]!.issuer === b[0]!.issuer) continue;
    let linked = false; let uncertain = false;
    pair: for (const av of a) for (const bv of b) {
      spend();
      if (av.fireYear !== null && bv.fireYear !== null && av.fireYear !== bv.fireYear) continue;
      const answer = evidence(av, bv);
      if (answer.status === 'undetermined') { uncertain = true; continue; }
      if (answer.measures.components.length > limits.maxComponentsPerPair) throw new PerimeterKernelLimitError();
      const decision = overlapDecisionFromMeasures(answer.measures);
      if (decision === 'undetermined') uncertain = true;
      else if (decision !== 'separate') { linked = true; break pair; }
    }
    if (linked) { const x = find(i); const y = find(j); parent[Math.max(x, y)] = Math.min(x, y); }
    else if (uncertain) unresolvedPairs.push([keys[i]!, keys[j]!]);
  }
  const sets = new Map<number, string[]>();
  keys.forEach((key, index) => { const head = find(index); const set = sets.get(head) ?? []; set.push(key); sets.set(head, set); });
  const groups = [...sets.values()].map(members => ({
    key: members.length === 1 ? members[0]! : 'fa:' + members.join('+'), members
  })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { groups, complete: unresolvedPairs.length === 0 && !versions.some(v => v.unkeyed), unresolvedPairs, versions };
}
