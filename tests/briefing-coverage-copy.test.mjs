import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Public briefing copy outside the Pacific Northwest (the look of 2026-11-05):
 *
 *  - D4: the coverage line a briefing prints when impact synthesis is
 *    unavailable (`CAPABILITY_MATRIX[family].impactSynthesis.note`, read by
 *    src/impact/source-policy.ts) writes "Pacific Northwest" out, never the
 *    bare abbreviation "PNW".
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

test('every family\'s briefing coverage line writes the Pacific Northwest out', () => {
  for (const family of COVERAGE_FAMILY_KEYS) {
    const note = CAPABILITY_MATRIX[family].impactSynthesis.note;
    assert.doesNotMatch(note, /\bPNW\b/, `${family}: ${note}`);
  }
  assert.equal(
    CAPABILITY_MATRIX.conus.impactSynthesis.note,
    'The briefing synthesis and resource routing are not validated outside the Pacific Northwest.'
  );
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
