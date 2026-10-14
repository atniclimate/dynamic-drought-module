import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

/**
 * Audit 5 finding 2: Idaho's full-resolution Level IV candidates are 12.7 MB,
 * over the 8 MiB body cap, so a state (or Tribe) selection simplifies its
 * ecoregion candidates. An ecoregion selection stays at full resolution so
 * nested Level IV rows still read `contains`. Runs the shipped bodies.
 */
const source = readFileSync(new URL('../src/ui/island/place-studio.tsx', import.meta.url), 'utf8');
const body = (name) => {
  const found = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(found, `${name} is still a source function with its own closing line`);
  return stripTypeScriptTypes(found);
};
const ecoregionCandidateParams = new Function(
  `${body('arcGisEnvelopeParams')}\n${body('ecoregionCandidateParams')}\nreturn ecoregionCandidateParams;`
)();

test('a state selection simplifies its ecoregion candidates', () => {
  const params = ecoregionCandidateParams('-117,42,-111,49', 'US_L3CODE,US_L3NAME', 'state');
  assert.equal(params.get('maxAllowableOffset'), '0.0005');
  assert.equal(params.get('geometry'), '-117,42,-111,49');
});

test('an ecoregion selection keeps its ecoregion candidates at full resolution', () => {
  const params = ecoregionCandidateParams('-117,42,-111,49', 'US_L3CODE,US_L3NAME', 'ecoregion');
  assert.equal(params.has('maxAllowableOffset'), false);
});

test('Tribe candidates and the shared envelope builder stay at full resolution', () => {
  const shared = new Function(`${body('arcGisEnvelopeParams')}\nreturn arcGisEnvelopeParams;`)();
  assert.equal(shared('-117,42,-111,49', 'x').has('maxAllowableOffset'), false);
});
