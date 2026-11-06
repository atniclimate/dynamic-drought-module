import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
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
      'const assertCompleteFeatureCollection = (raw) => raw;\n' +
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
test('Studio watershed reads take no zoom and never read the map', async () => {
  assert.equal(/\bgetMap\b/.test(source), false, 'place-studio.tsx no longer reads the map');
  const seen = [];
  const fns = new Function(
    'loadWatershedSelectionGeometry',
    'loadWatershedCandidates',
    'const resolvedSelection = () => null;\n' +
      'const loadServiceEnvelopePieces = async (bbox, signal, run) => [await run(bbox, signal)];\n' +
      'const mergeByStableIdentifier = () => [];\n' +
      `${asyncBody('resolveWatershedSelection')}\n${asyncBody('loadWatershedOverlapCandidates')}\n` +
      'return { resolveWatershedSelection, loadWatershedOverlapCandidates };'
  )(
    async (entry, signal) => {
      seen.push(signal);
      return null;
    },
    async (piece, signal) => {
      seen.push(signal);
      return { type: 'FeatureCollection', features: [] };
    }
  );
  const signal = new AbortController().signal;
  await fns.resolveWatershedSelection({ id: '1709' }, signal);
  await fns.loadWatershedOverlapCandidates([-124, 42, -116, 46], signal);
  assert.deepEqual(seen, [signal, signal]);
});

// Audit round 4: an ecoregion's overlap list read only the PNW strip for every
// kind, so Tribes and watersheds inside Central Basin and Range below 41.5 N
// (EPA extent 36.4 to 42.4 N) were never fetched and silently missing.
test('an ecoregion selection reads Tribes, states and watersheds over its whole extent', async () => {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    }
  });
  const { bboxIntersection } = await import('../src/util/bbox.ts');
  const seen = {};
  const record = (kind) => async (bbox) => {
    seen[kind] = [...bbox];
    return { type: 'FeatureCollection', features: [] };
  };
  const loadOverlapView = new Function(
    'bboxIntersection',
    'loadTribeCandidates',
    'loadStateCandidates',
    'loadEcoregionCandidates',
    'loadWatershedOverlapCandidates',
    `${stripTypeScriptTypes(constant('PNW_BOUNDS'))}\n` +
      "const PLACE_TYPE_ORDER = ['tribe', 'state', 'ecoregion', 'watershed'];\n" +
      'const overlapPairAvailable = () => true;\n' +
      'const abortIfNeeded = () => {};\n' +
      'const computeOverlapRows = () => ({ rows: [], hasSuppressedSlivers: false });\n' +
      `${asyncBody('loadCandidateKind')}\n${asyncBody('loadOverlapView')}\nreturn loadOverlapView;`
  )(bboxIntersection, record('tribe'), record('state'), record('ecoregion'), record('watershed'));
  const centralBasinAndRange = [-120.3, 36.44, -111.4, 42.36];
  const view = await loadOverlapView(
    { kind: 'ecoregion', id: '13' },
    { bbox: centralBasinAndRange, geometry: null },
    new AbortController().signal
  );
  assert.equal(view.status, 'ready');
  assert.deepEqual(seen.tribe, centralBasinAndRange);
  assert.deepEqual(seen.state, centralBasinAndRange);
  assert.deepEqual(seen.watershed, centralBasinAndRange);
  assert.deepEqual(
    seen.ecoregion.map((value) => Math.round(value * 100) / 100),
    [-120.3, 41.5, -111.4, 42.36],
    'the ecoregion catalog alone stays PNW-scoped'
  );
});

/**
 * Audit round 5, R5-39 and R5-40, on the shipped exit hand-off bodies with the
 * real place-return slots. Back to map with no briefing handed back unlights
 * the studio's place (nothing else would); a Nation's briefing draws its
 * boundary as the located overlay after the open, since the restore may turn
 * the Tribal layers that lit it off again. Red on 0ffe87a: none of these exist.
 */
test('Back to map unlights the studio place unless a briefing follows, and a Nation briefing draws its boundary', async () => {
  const { clearPlaceReturn, setPlaceReturnBriefing, setPlaceReturnDisplayCommand, takePlaceReturn } =
    await import('../src/state/place-return.ts');
  const log = [];
  const exit = new Function(
    'setPlaceReturnBriefing',
    'takePlaceReturn',
    'clearStudioEmphasis',
    'openImpactPanel',
    'showStudioReturnBoundary',
    `${source.match(/^let briefingHandedBack = false;$/m)?.[0]}\n` +
      `${body('runReturnHandoff')}\n${body('queueReturnBriefing')}\n${body('openReturnBriefing')}\n` +
      'return { runReturnHandoff, queueReturnBriefing, openReturnBriefing };'
  )(
    setPlaceReturnBriefing,
    takePlaceReturn,
    () => log.push('unlight'),
    (context) => log.push(`open ${context.title}`),
    (geometry) => log.push(`draw ${geometry.type}`)
  );
  const resolved = { context: { title: 'Fixture Nation' }, geometry: { type: 'Polygon' } };

  clearPlaceReturn();
  exit.runReturnHandoff();
  assert.deepEqual(log.splice(0), ['unlight'], 'no briefing: the lit place is cleared');

  setPlaceReturnDisplayCommand(() => log.push('cluster'));
  exit.runReturnHandoff();
  assert.deepEqual(log.splice(0), ['cluster', 'unlight'], 'a display command alone is not a briefing');

  exit.queueReturnBriefing(() => exit.openReturnBriefing({ kind: 'tribe' }, resolved));
  exit.runReturnHandoff();
  assert.deepEqual(log.splice(0), ['open Fixture Nation', 'draw Polygon'], 'a Nation briefing keeps it lit and draws its boundary after the open');

  exit.queueReturnBriefing(() => exit.openReturnBriefing({ kind: 'state' }, resolved));
  exit.runReturnHandoff();
  assert.deepEqual(log.splice(0), ['open Fixture Nation'], 'only a Nation draws the located overlay');

  exit.queueReturnBriefing(() => exit.openReturnBriefing({ kind: 'tribe' }, resolved));
  clearPlaceReturn();
  exit.runReturnHandoff();
  assert.deepEqual(log.splice(0), ['unlight'], 'a briefing voided before the exit does not hold the light');
});

/**
 * Audit round 6, R6-4, on the shipped chase body: Back to map before the
 * studio resolved its choice chases the briefing; a chase that fails or finds
 * nothing unlights the place it lit, unless a newer place now owns the light.
 * Red on f27a23c: a failed chase left the place lit with nothing open.
 */
test('a Back to map chase that ends without a briefing unlights the studio place, but not a newer one', async () => {
  const log = [];
  let typed = { kind: 'tribe', id: 'a' };
  let resolveResult = () => Promise.reject(new Error('offline'));
  let lit = [];
  const chase = new Function(
    'getTypedPlace',
    'resolvePlaceSelection',
    'openReturnBriefing',
    'clearStudioEmphasis',
    'getEmphasisTargets',
    `${body('placeStillCurrent')}\n${body('chaseBriefingOnReturn')}\nreturn chaseBriefingOnReturn;`
  )(
    () => typed,
    () => resolveResult(),
    (entry) => log.push(`open ${entry.id}`),
    () => log.push('unlight'),
    () => lit
  );
  const entry = { kind: 'tribe', id: 'a' };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  chase(entry, null)();
  await settle();
  assert.deepEqual(log.splice(0), ['unlight'], 'a failed resolve unlights');

  chase(entry, Promise.reject(new Error('aborted')))();
  await settle();
  assert.deepEqual(log.splice(0), ['unlight'], 'an aborted chase whose own resolve fails unlights');

  resolveResult = () => Promise.resolve(null);
  chase(entry, null)();
  await settle();
  assert.deepEqual(log.splice(0), ['unlight'], 'nothing resolved unlights');

  resolveResult = () => Promise.resolve({ context: {}, geometry: {} });
  chase(entry, null)();
  await settle();
  assert.deepEqual(log.splice(0), ['open a'], 'a resolved chase opens the briefing and keeps the light');

  typed = { kind: 'tribe', id: 'b' };
  resolveResult = () => Promise.reject(new Error('offline'));
  chase(entry, null)();
  await settle();
  assert.deepEqual(log.splice(0), [], 'a newer place keeps its own light');

  // Review finding 2: a map click on a reservation or Tribal land area during
  // the chase lights it without changing the typed place; its light stays.
  typed = { kind: 'tribe', id: 'a' };
  chase(entry, null)();
  lit = [{ source: 'bia', id: 7 }];
  await settle();
  assert.deepEqual(log.splice(0), [], 'a newer map emphasis keeps its light');
});

test('Tribe candidates and the shared envelope builder stay at full resolution', () => {
  const shared = new Function(`${body('arcGisEnvelopeParams')}\nreturn arcGisEnvelopeParams;`)();
  assert.equal(shared('-117,42,-111,49', 'x').has('maxAllowableOffset'), false);
});
