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

const asyncBody = (name) => {
  const found = source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(found, `${name} is still an async source function with its own closing line`);
  return stripTypeScriptTypes(found);
};
const constant = (name) => {
  const found = source.match(new RegExp(`^const ${name} = [^;]+;`, 'm'))?.[0];
  assert.ok(found, `${name} is still a top-level constant`);
  return found;
};

// Audit 6 finding 1: Middle Rockies (11.4 MB) and Northern Basin and Range
// (8.7 MB) full-resolution candidates are over the 8 MiB default cap.
test('an ecoregion selection reads its candidates under the 24 MiB cap', async () => {
  const caps = [];
  const load = new Function(
    'URLS',
    'fetchJson',
    `${body('arcGisEnvelopeParams')}\n${body('ecoregionCandidateParams')}\n` +
      `${constant('ECOREGION_CANDIDATE_MAX_BYTES')}\n${constant('ECOREGION_CANDIDATE_TIMEOUT_MS')}\n` +
      'const assertFeatureCollection = (raw) => raw;\n' +
      'const loadServiceEnvelopePieces = async (bbox, signal, run) => [await run(bbox, signal)];\n' +
      'const mergeByStableIdentifier = (groups) => groups.flat();\n' +
      'const textProperty = () => null;\n' +
      'const normalizedFeature = () => null;\n' +
      'const abortIfNeeded = () => {};\n' +
      `${asyncBody('loadEcoregionCandidates')}\nreturn loadEcoregionCandidates;`
  )({ epaEcoregionsMapServer: 'https://epa.test' }, async (url, signal, init, maxBytes, timeoutMs) => {
    caps.push([url.includes('maxAllowableOffset'), maxBytes, timeoutMs]);
    return { type: 'FeatureCollection', features: [] };
  });
  await load([-117, 42, -111, 49], new AbortController().signal, 'ecoregion');
  // Audit 7 finding 3: the same two reads also get a 20 s budget, not the 8 s default.
  assert.deepEqual(caps, [
    [false, 24 * 1024 * 1024, 20_000],
    [false, 24 * 1024 * 1024, 20_000]
  ]);
});

// Audit 6 finding 2: the overlap words must not flip with the live map zoom.
test('Studio watershed reads use a fixed zoom, never the map', async () => {
  assert.equal(/\bgetMap\b/.test(source), false, 'place-studio.tsx no longer reads the map');
  const zooms = [];
  const fns = new Function(
    'loadWatershedSelectionGeometry',
    'loadWatershedCandidates',
    `${constant('STUDIO_WATERSHED_ZOOM')}\n` +
      'const resolvedSelection = () => null;\n' +
      'const loadServiceEnvelopePieces = async (bbox, signal, run) => [await run(bbox, signal)];\n' +
      'const mergeByStableIdentifier = () => [];\n' +
      `${asyncBody('resolveWatershedSelection')}\n${asyncBody('loadWatershedOverlapCandidates')}\n` +
      'return { resolveWatershedSelection, loadWatershedOverlapCandidates };'
  )(
    async (entry, zoom) => {
      zooms.push(zoom);
      return null;
    },
    async (piece, zoom) => {
      zooms.push(zoom);
      return { type: 'FeatureCollection', features: [] };
    }
  );
  const signal = new AbortController().signal;
  await fns.resolveWatershedSelection({ id: '1709' }, signal);
  await fns.loadWatershedOverlapCandidates([-124, 42, -116, 46], signal);
  assert.deepEqual(zooms, [9, 9]);
});

test('Tribe candidates and the shared envelope builder stay at full resolution', () => {
  const shared = new Function(`${body('arcGisEnvelopeParams')}\nreturn arcGisEnvelopeParams;`)();
  assert.equal(shared('-117,42,-111,49', 'x').has('maxAllowableOffset'), false);
});
