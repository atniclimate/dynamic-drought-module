import { fingerprintPerimeter } from './perimeter-fingerprints';
import { measurePerimeterGeometry } from './perimeter-measures';
import { groupPerimeterRecords, normalizePerimeterIdentity, type PairEvidence } from './perimeter-grouping';
import { assertPerimeterJobLimits, type PerimeterJobLimits, type PerimeterJobResult } from './perimeter-job-contract';
import type { ClipCoordinates } from './polygon-clip-validation';
import type { PolygonClipLimits } from './polygon-clip-contract';
type Intersect = (a: unknown, b: unknown, limits: PolygonClipLimits) => ClipCoordinates;
/** Worker-only whole job. Injected loader is a pure-test seam, never a runtime provider. */
export async function runPerimeterJob(sourceJson: string, limits: PerimeterJobLimits,
  loadIntersection: () => Promise<Intersect> = async () => (await import('./polygon-clip')).intersectPolygons
): Promise<PerimeterJobResult> {
  assertPerimeterJobLimits(limits);
  if (typeof sourceJson !== 'string' || sourceJson.length > limits.maxInputChars) throw new RangeError('Perimeter input allowance exceeded.');
  const raw: unknown = JSON.parse(sourceJson);
  if (!Array.isArray(raw) || raw.length > limits.kernel.maxVersions) throw new RangeError('Invalid perimeter source list.');
  let vertices = 0;
  const prepared = raw.map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid perimeter record.');
    const r = value as Record<string, unknown>;
    if (typeof r['issuer'] !== 'string' || (r['properties'] !== null &&
      (!r['properties'] || typeof r['properties'] !== 'object' || Array.isArray(r['properties'])))) throw new TypeError('Invalid perimeter record.');
    const properties = r['properties'] as Record<string, unknown> | null;
    const fingerprint = fingerprintPerimeter(r['geometry'], properties, limits.fingerprint);
    for (const polygon of fingerprint.geometry.coordinates) for (const ring of polygon) {
      vertices += ring.length;
      if (vertices > limits.maxTotalVertices) throw new RangeError('Whole-job vertex allowance exceeded.');
    }
    const input = { issuer: r['issuer'], properties, geometryFingerprint: fingerprint.geometryFingerprint,
      revisionFingerprint: fingerprint.revisionFingerprint };
    const identity = normalizePerimeterIdentity(input, limits.kernel.maxIdentityChars);
    const geometry = fingerprint.geometry;
    const measures = measurePerimeterGeometry(geometry, limits.clip.input);
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of geometry.coordinates) for (const ring of polygon) for (const p of ring) {
      bbox[0] = Math.min(bbox[0]!, p[0]); bbox[1] = Math.min(bbox[1]!, p[1]);
      bbox[2] = Math.max(bbox[2]!, p[0]); bbox[3] = Math.max(bbox[3]!, p[1]);
    }
    return { input, identity, geometry, measures, bbox, index };
  });
  const byVersion = new Map(prepared.map(row => [row.identity.versionKey, row]));
  const key = (a: string, b: string): string => JSON.stringify([a, b]);
  const evidence = new Map<string, PairEvidence>();
  const candidates: [string, string][] = [];
  // Kernel owns issuer and comparable-year filtering. This first pass enumerates
  // compatible versions, never using a positive bbox overlap as evidence.
  groupPerimeterRecords(prepared.map(row => row.input), (a, b) => {
    const left = byVersion.get(a.versionKey)!; const right = byVersion.get(b.versionKey)!;
    const id = key(a.versionKey, b.versionKey);
    if (Math.min(left.bbox[2]!, right.bbox[2]!) <= Math.max(left.bbox[0]!, right.bbox[0]!) ||
      Math.min(left.bbox[3]!, right.bbox[3]!) <= Math.max(left.bbox[1]!, right.bbox[1]!)) {
      const separate: PairEvidence = { status: 'measured', measures: {
        leftAreaM2: left.measures.areaM2, rightAreaM2: right.measures.areaM2, components: [] } };
      evidence.set(id, separate); return separate;
    }
    if (candidates.length >= limits.maxCandidatePairs) throw new RangeError('Candidate-pair allowance exceeded.');
    candidates.push([a.versionKey, b.versionKey]); return { status: 'undetermined' };
  }, limits.kernel);
  if (candidates.length) {
    const intersect = await loadIntersection();
    for (const [a, b] of candidates) {
      const left = byVersion.get(a)!; const right = byVersion.get(b)!;
      let answer: PairEvidence;
      try {
        const coordinates = intersect(left.geometry, right.geometry, limits.clip);
        const components = coordinates.length ? measurePerimeterGeometry({ type: 'MultiPolygon', coordinates }, limits.clip.output).components : [];
        if (components.length > limits.kernel.maxComponentsPerPair) throw new RangeError('Component allowance exceeded.');
        answer = { status: 'measured', measures: { leftAreaM2: left.measures.areaM2, rightAreaM2: right.measures.areaM2, components } };
      } catch { answer = { status: 'undetermined' }; }
      evidence.set(key(a, b), answer);
    }
  }
  const graph = groupPerimeterRecords(prepared.map(row => row.input), (a, b) =>
    evidence.get(key(a.versionKey, b.versionKey)) ?? { status: 'undetermined' }, limits.kernel);
  const indices = new Map<string, number[]>();
  for (const row of prepared) { const list = indices.get(row.identity.versionKey) ?? []; list.push(row.index); indices.set(row.identity.versionKey, list); }
  return { graph, sources: graph.versions.map(version => ({ versionKey: version.versionKey, indices: indices.get(version.versionKey)! })) };
}
