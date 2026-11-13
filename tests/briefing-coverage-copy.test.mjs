import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Public briefing copy outside the Pacific Northwest (the look of 2026-11-05):
 *
 *  - D4: the family coverage line (`CAPABILITY_MATRIX[family].impactSynthesis.note`,
 *    read by src/impact/source-policy.ts) writes "Pacific Northwest" out,
 *    never the bare abbreviation "PNW". Since DR-256 the briefing prints a
 *    family line only for a place outside the United States geographies.
 *  - P3-26: the Tribe's-own resource slot names no repository path
 *    ("see data/README.md") in public copy.
 *
 * Red on base (6748f25): the CONUS note ends "outside the PNW." and the slot
 * ends "(see data/README.md)." Plain `node --test` (Node 24 strips types).
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { CAPABILITY_MATRIX, COVERAGE_FAMILY_KEYS } = await import('../src/config/capability-matrix.ts');
const { buildResources } = await import('../src/impact/resources.ts');
const { briefingSourcePolicy, sourceMayRun, uncoveredSourceGroups } = await import('../src/impact/source-policy.ts');

/** A State selection that carries its own postal code, as a clicked State boundary does. */
function stateContext(code, lng, lat) {
  return {
    kind: 'state',
    title: code,
    properties: { STUSPS: code },
    lngLat: { lng, lat },
    regionKey: 'national',
    containing: { state: code, basis: 'feature-property' }
  };
}

// DR-256: coverage is decided per source by its issuer's service, never by the Northwest family.
const NATIONAL_US_SOURCES = ['usdm', 'dsci', 'nifc', 'cpcExtended', 'enso', 'waterSupply', 'cpcSeasonal'];

test('outside the Northwest every United States source runs where its issuer covers the place', () => {
  for (const [code, lng, lat] of [['AZ', -111.7, 34.3], ['MT', -109.6, 47.0], ['AK', -150.0, 64.0], ['HI', -155.5, 19.6]]) {
    const policy = briefingSourcePolicy(stateContext(code, lng, lat));
    for (const key of NATIONAL_US_SOURCES) {
      assert.ok(sourceMayRun(policy, key), `${code}: ${key} reads`);
    }
    // The Northwest-curated resources keep their data limit.
    assert.equal(policy.droughtImpact.enabled, false, `${code}: resources stay Northwest`);
    for (const group of uncoveredSourceGroups(policy)) {
      assert.doesNotMatch(group.note, /not validated outside|No briefing support/, `${code}: ${group.note}`);
    }
  }
  const washington = briefingSourcePolicy(stateContext('WA', -120.5, 47.4));
  assert.equal(washington.droughtImpact.enabled, true);
  assert.deepEqual(uncoveredSourceGroups(washington), []);
});

test('a source that does not cover the place is named once with its own capability note', () => {
  const alaska = briefingSourcePolicy(stateContext('AK', -150.0, 64.0));
  const groups = uncoveredSourceGroups(alaska);
  const names = groups.flatMap((group) => group.labels);
  assert.equal(new Set(names).size, names.length, 'each source once');
  assert.ok(groups.some((group) => group.note === alaska.sources.heatRisk.note && group.labels.includes('NWS HeatRisk')));
  assert.ok(groups.some((group) => group.note === alaska.sources.spcFireOutlook.note));
  assert.ok(!names.includes('NWS point observation and grid guidance'), 'point heat keeps its own section');
  // Canada keeps the regional gate it had: no United States drought source reads there.
  const canada = briefingSourcePolicy({
    kind: 'state',
    title: 'Canada test place',
    properties: null,
    lngLat: { lng: -123.1, lat: 49.3 },
    regionKey: 'british_columbia',
    containing: { state: null, basis: 'none' }
  });
  for (const key of NATIONAL_US_SOURCES) assert.ok(!sourceMayRun(canada, key), `Canada: ${key} gated`);
});

test('every family\'s briefing coverage line writes the Pacific Northwest out', () => {
  for (const family of COVERAGE_FAMILY_KEYS) {
    // The landscape signature note now reads in Technical information's "not covered" list too.
    for (const axis of ['impactSynthesis', 'landscapeSignature']) {
      const note = CAPABILITY_MATRIX[family][axis].note;
      assert.doesNotMatch(note, /\bPNW\b/, `${family} ${axis}: ${note}`);
    }
  }
  assert.equal(
    CAPABILITY_MATRIX.conus.impactSynthesis.note,
    'Northwest-curated resources and the Pacific Northwest ENSO tendency are not read outside the Pacific Northwest; every other briefing source reads where its issuer covers the place.'
  );
});

test('Landscape context draws only for an ecoregion; every other place lists the signature as not covering it, with no instruction', async () => {
  const { landscapeContextShown, landscapeUncoveredGroup, UNSUPPORTED_LANDSCAPE_SELECTION_NOTE } = await import('../src/impact/landscape-resolution.ts');
  assert.doesNotMatch(UNSUPPORTED_LANDSCAPE_SELECTION_NOTE, /\bSelect an?\b/);
  const ecoregion = {
    kind: 'ecoregion',
    title: 'Cascades',
    properties: { US_L3CODE: '4' },
    lngLat: { lng: -122, lat: 46 },
    regionKey: 'washington_state',
    containing: { state: 'WA', basis: 'feature-property' }
  };
  assert.equal(landscapeContextShown(ecoregion), true);
  assert.equal(landscapeUncoveredGroup(ecoregion, briefingSourcePolicy(ecoregion).geography), null);
  for (const [code, lng, lat, family] of [['AZ', -111.7, 34.3, 'conus'], ['WA', -120.5, 47.4, 'pnw'], ['AK', -150.0, 64.0, 'ak-hi']]) {
    const state = stateContext(code, lng, lat);
    assert.equal(landscapeContextShown(state), false, `${code}: no Landscape section`);
    const group = landscapeUncoveredGroup(state, briefingSourcePolicy(state).geography);
    assert.deepEqual(group?.labels, ['Landscape signature'], code);
    assert.equal(group?.note, CAPABILITY_MATRIX[family].landscapeSignature.note, `${code}: its own capability note`);
  }
});

test('the briefing resources name no repository path', () => {
  const resources = buildResources({
    kind: 'state',
    title: 'Washington',
    properties: { STUSPS: 'WA' },
    lngLat: { lng: -120.5, lat: 47.4 },
    regionKey: 'washington_state',
    containing: { state: 'WA', basis: 'feature-property' }
  });
  const own = resources.find((resource) => resource.tier === 'tribe-own');
  assert.ok(own, 'the Tribe\'s-own slot still leads');
  assert.equal(resources[0], own);
  for (const resource of resources) {
    assert.doesNotMatch(
      `${resource.label} ${resource.description ?? ''} ${resource.agency}`,
      /data\/README|README\.md/
    );
  }
});
