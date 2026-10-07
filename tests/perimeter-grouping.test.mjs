import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { normalizePerimeterIdentity, overlapDecisionFromMeasures, groupPerimeterRecords,
  PERIMETER_OVERLAP_RULE, PerimeterKernelLimitError } = await import('../src/util/perimeter-grouping.ts');
const { FIRE_PERIMETER_ISSUERS } = await import('../src/config/fire-perimeter-issuers.ts');
const limits = { maxVersions: 30, maxRecords: 20, maxPairChecks: 200,
  maxIdentityChars: 1000, maxComponentsPerPair: 20 }; // synthetic test allowances only
const record = (issuer, id, geometryFingerprint = id, revisionFingerprint = id) => ({
  issuer, geometryFingerprint, revisionFingerprint,
  properties: issuer === 'nifc' ? { attr_UniqueFireIdentifier: id } : { FIRE_YEAR: 2026, FIRE_NUMBER: id }
});
const measured = components => ({ status: 'measured', measures: { leftAreaM2: 100_000,
  rightAreaM2: 100_000, components } });
const yes = () => measured([{ areaM2: 50_000, perimeterM: 100_000 }]);
const no = () => measured([]);
const unknown = () => ({ status: 'undetermined' });
test('issuer identity uses source keys and explicit fingerprints, never name or OBJECTID across reads', () => {
  const a = record('nifc', ' 2026-waxxx-000009 ');
  assert.equal(normalizePerimeterIdentity(a, 1000).recordKey, 'nifc:2026-WAXXX-000009');
  const first = normalizePerimeterIdentity(a, 1000);
  assert.equal(first.fireYear, 2026);
  assert.equal(normalizePerimeterIdentity({ ...a, properties: { ...a.properties, OBJECTID: 999, name: 'Other' } }, 1000).recordKey, first.recordKey);
  assert.notEqual(normalizePerimeterIdentity({ ...a, geometryFingerprint: 'new-geometry' }, 1000).versionKey, first.versionKey);
  assert.notEqual(normalizePerimeterIdentity({ ...a, revisionFingerprint: 'new-attributes' }, 1000).versionKey, first.versionKey);
  const fallback = normalizePerimeterIdentity({ ...a, properties: { attr_IrwinID: ' {ABC-DEF} ', attr_FireDiscoveryDateTime: Date.UTC(2025, 11, 31) } }, 1000);
  assert.equal(fallback.recordKey, 'nifc:irwin:abc-def'); assert.equal(fallback.fireYear, 2025);
  assert.equal(normalizePerimeterIdentity({ ...a, properties: { attr_FireDiscoveryDateTime: null } }, 1000).fireYear, null);
  const bc = normalizePerimeterIdentity(record('bcws', ' k61186 '), 1000);
  assert.equal(bc.recordKey, 'bcws:2026-K61186'); assert.equal(bc.fireYear, null, 'fiscal identity is not calendar compatibility');
  assert.throws(() => normalizePerimeterIdentity(record('cwfis-m3', 'm3'), 1000), TypeError);
});
test('ratified per-component rule admits sub-hectare half-smaller, never sums separated components', () => {
  assert.equal(PERIMETER_OVERLAP_RULE.minAreaM2, 10_000);
  assert.ok(Math.abs(PERIMETER_OVERLAP_RULE.minMeanWidthM - 111.32) < 1e-10, 'binary64 representation of the stated derivation');
  assert.equal(PERIMETER_OVERLAP_RULE.smallerRecordFraction, 0.5);
  const check = (components, smaller = 25_000) => overlapDecisionFromMeasures({ leftAreaM2: smaller, rightAreaM2: 1_000_000, components });
  assert.equal(check([{ areaM2: 6_000, perimeterM: 10_000 }], 12_000), 'containment');
  assert.equal(check([{ areaM2: 8_000, perimeterM: 10_000 }, { areaM2: 8_000, perimeterM: 10_000 }]), 'separate');
  assert.equal(check([{ areaM2: 10_000, perimeterM: 100 }]), 'width');
  assert.equal(check([{ areaM2: 9_999, perimeterM: 100 }]), 'separate');
  assert.equal(check([]), 'separate');
  assert.equal(check([{ areaM2: 0, perimeterM: 100 }]), 'undetermined');
  assert.equal(check([{ areaM2: 10_000, perimeterM: 100 }, { areaM2: NaN, perimeterM: 20 }]), 'undetermined');
  assert.equal(check([{ areaM2: 15_000, perimeterM: 100 }, { areaM2: 15_000, perimeterM: 100 }]), 'undetermined',
    'each component fits but total cannot exceed the smaller record');
  assert.equal(check([{ areaM2: 10_000, perimeterM: 100 }, { areaM2: 1, perimeterM: 0 }]), 'undetermined',
    'qualifying first component never hides invalid later output');
  assert.equal(overlapDecisionFromMeasures({ leftAreaM2: Number.MAX_VALUE, rightAreaM2: Number.MAX_VALUE,
    components: [{ areaM2: Number.MAX_VALUE * 0.75, perimeterM: Number.MAX_VALUE }] }), 'containment',
    'finite narrow component must not acquire a false width reason through doubled-area overflow');
});
test('chains and singleton keys are deterministic in all six input orders', () => {
  const a = record('nifc', '2026-A'); const b = record('bcws', 'B'); const c = record('nifc', '2026-C');
  const expected = [{ key: 'fa:bcws:2026-B+nifc:2026-A+nifc:2026-C', members: ['bcws:2026-B', 'nifc:2026-A', 'nifc:2026-C'] }];
  for (const order of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) {
    const seen = [];
    const result = groupPerimeterRecords(order, (left,right) => { seen.push([left.issuer,right.issuer]); return yes(); }, limits);
    assert.deepEqual(result.groups, expected); assert.equal(result.complete, true);
    assert.ok(seen.every(([left,right]) => left !== right));
  }
  assert.deepEqual(groupPerimeterRecords([a,c], () => assert.fail('Same issuer must not request clipping'), limits).groups,
    [{ key: 'nifc:2026-A', members: ['nifc:2026-A'] }, { key: 'nifc:2026-C', members: ['nifc:2026-C'] }]);
});
test('all versions survive, any compatible version can link, and known unequal years skip evidence', () => {
  const a = record('nifc', '2026-A', 'old', 'v1');
  const newer = { ...a, geometryFingerprint: 'new', revisionFingerprint: 'v2' };
  const b = record('bcws', 'B');
  const result = groupPerimeterRecords([a,newer,b,a], (left,right) =>
    [left,right].some(v => v.geometryFingerprint === 'old') ? yes() : no(), limits);
  assert.equal(result.versions.length, 3); assert.equal(result.groups.length, 1);
  const prior = { ...b, properties: { FIRE_YEAR: 2025, FIRE_NUMBER: 'B' } };
  const calendarIssuer = { id: 'test-calendar', recordId: () => 'C', fireYear: () => 2025, sourceVersion: () => null };
  const calendar = record('test-calendar', 'C');
  const table = [...FIRE_PERIMETER_ISSUERS, calendarIssuer];
  assert.equal(groupPerimeterRecords([a,calendar], () => assert.fail('Known unequal calendar years'), limits, table).groups.length, 2);
  const unknownYear = { ...a, properties: { attr_IrwinID: 'abcd' } };
  assert.equal(groupPerimeterRecords([unknownYear,calendar], yes, limits, table).groups.length, 1);
  const january = { ...a, properties: { attr_IrwinID: 'january', attr_FireDiscoveryDateTime: Date.UTC(2026,0,15) } };
  const march = { ...prior, properties: { ...prior.properties, TRACK_DATE: Date.UTC(2026,2,20), LOAD_DATE: Date.UTC(2026,2,21) } };
  assert.equal(normalizePerimeterIdentity(march, 1000).recordKey, 'bcws:2025-B');
  assert.equal(normalizePerimeterIdentity(march, 1000).fireYear, null);
  assert.equal(groupPerimeterRecords([january,march], yes, limits).groups.length, 1,
    'April-March fiscal identity must not fabricate a calendar-year conflict');
});
test('unknown pairs remain singletons and incomplete; unkeyed geometry identity stays explicit', () => {
  const a = record('nifc', '2026-A'); const b = record('bcws', 'B');
  const result = groupPerimeterRecords([a,b], unknown, limits);
  assert.equal(result.complete, false); assert.equal(result.groups.length, 2);
  assert.deepEqual(result.unresolvedPairs, [['bcws:2026-B', 'nifc:2026-A']]);
  const unkeyed = { ...a, properties: {}, geometryFingerprint: 'exact-coordinate-hash' };
  const fallback = groupPerimeterRecords([unkeyed], no, limits);
  assert.equal(fallback.complete, false); assert.equal(fallback.groups[0].key, 'nifc:geom:exact-coordinate-hash');
});
test('third issuer is a table extension, and membership is independent of caller order', () => {
  const third = { id: 'test-agency', recordId: () => 'C', fireYear: () => 2026, sourceVersion: () => null };
  const inputs = [record('nifc','2026-A'),record('bcws','B'),record('test-agency','C')];
  assert.equal(groupPerimeterRecords(inputs, yes, limits, [...FIRE_PERIMETER_ISSUERS,third]).groups.length, 1);
  assert.throws(() => groupPerimeterRecords(inputs, yes, limits), TypeError);
});
test('required resource seams refuse excess without returning a partial exact graph', () => {
  const inputs = [record('nifc','2026-A'),record('bcws','B')];
  for (const delta of [{ maxVersions: 1 }, { maxRecords: 1 }, { maxPairChecks: 1 }, { maxIdentityChars: 2 }])
    assert.throws(() => groupPerimeterRecords(inputs, yes, { ...limits, ...delta }), PerimeterKernelLimitError);
  assert.throws(() => groupPerimeterRecords(inputs, () => measured([{ areaM2: 1, perimeterM: 1 }, { areaM2: 1, perimeterM: 1 }]),
    { ...limits, maxComponentsPerPair: 1 }), PerimeterKernelLimitError);
  assert.throws(() => groupPerimeterRecords(inputs, yes, { ...limits, maxPairChecks: 0 }), RangeError);
});
