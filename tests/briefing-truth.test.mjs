import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D P3-TRUTH: the Impact Briefing never states more than its reads
 * established. Three defects, each driven here through the REAL source
 * fetchers in `src/impact/sources.ts` and the REAL cell builder in
 * `src/impact/matrix.ts`, with only `fetch` stubbed (no network decides a
 * result) and, for the loaded-perimeters path, the layer module's one reader
 * replaced (see the load hook below).
 *
 *   1. A partly failed outlook read (one CPC extended-range window, or some
 *      SPC Day 1-8 days) is "live (partial)", never "live": the surviving
 *      claims stay and the cell status is `partial`.
 *   2. A loaded fire perimeter "intersects" a place only when its GEOMETRY
 *      meets the place's query rectangle, not merely its bounding box.
 *   3. A fire-only NWS active-alerts answer is a read for the Heat row too:
 *      the Heat cell carries the existing heat absence sentence and is never
 *      "unavailable".
 *
 * Red on base (a94eee5): cases 1 read `ready`, cases 2 state one perimeter
 * intersecting, case 3 reads `unavailable`.
 */

// The product modules import each other without extensions (`../util/escape`),
// which the bundler resolves and Node's type stripping does not. This hook
// appends `.ts` to a relative, extensionless specifier whose parent is a
// `.ts` module and whose `.ts` target exists (tests/popup-frame.test.mjs, the
// same hook).
//
// The load hook replaces ONE module: `src/layers/nifc-fires.ts`, which the
// briefing reaches only through a dynamic import behind the registry-status
// guard, and which Node cannot strip (a constructor parameter property) nor
// run (MapLibre, the DOM). Its replacement exports the one reader the
// briefing calls, `loadedNifcCollection`, answering whatever collection a
// case has put on `globalThis.__p3truthLoadedNifc`.
//
// Repair round 1: while `globalThis.__p3truthFailOverlap` is set, the
// briefing's dynamic import of `../util/polygon-overlap` resolves to a fresh,
// uniquely queried URL (so no module cache answers it) whose load throws: a
// chunk that failed to load.
//
// Repair round 2: `globalThis.__p3truthLazy` maps a specifier the briefing
// imports lazily ('../util/polygon-overlap', './cpc-extended') to a mode:
// 'fail' (the chunk fails to load), 'hold' (its load stays pending until the
// case releases it, through `globalThis.__p3truthHeld`), or 'defect' (the
// overlap module loads and its function throws a TypeError, a code defect).
// Each import resolves to a fresh URL, so no module cache answers it.
const NIFC_LAYER_MODULE = '/src/layers/nifc-fires.ts';
let failedOverlapLoads = 0;
let lazyLoads = 0;
globalThis.__p3truthHeld = [];
const HELD_MODULE =
  'await new Promise((release) => globalThis.__p3truthHeld.push(release));' +
  ' export const geometriesOverlap = () => true;' +
  ' export const loadedNifcCollection = () => globalThis.__p3truthLoadedNifc ?? null;' +
  ' export const readCpcOutlookClaims = async () => ({ claims: [], ok: true });';
const DEFECT_MODULE =
  'export function geometriesOverlap() { throw new TypeError("P3-TRUTH stub: an overlap implementation defect"); }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    const lazy = globalThis.__p3truthLazy?.[specifier];
    if (lazy !== undefined && typeof context.parentURL === 'string') {
      lazyLoads += 1;
      return { url: `p3truth:${lazy}/${lazyLoads}`, shortCircuit: true };
    }
    if (
      globalThis.__p3truthFailOverlap === true &&
      specifier === '../util/polygon-overlap' &&
      typeof context.parentURL === 'string'
    ) {
      failedOverlapLoads += 1;
      return {
        url: new URL(`../util/polygon-overlap.ts?p3truth-fail=${failedOverlapLoads}`, context.parentURL).href,
        shortCircuit: true
      };
    }
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.includes('p3truth-fail=') || url.startsWith('p3truth:fail/')) {
      throw new Error('P3-TRUTH stub: the polygon-overlap chunk failed to load');
    }
    if (url.startsWith('p3truth:hold/')) {
      return { format: 'module', shortCircuit: true, source: HELD_MODULE };
    }
    if (url.startsWith('p3truth:defect/')) {
      return { format: 'module', shortCircuit: true, source: DEFECT_MODULE };
    }
    if (url.endsWith(NIFC_LAYER_MODULE)) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function loadedNifcCollection() { return globalThis.__p3truthLoadedNifc ?? null; }'
      };
    }
    return nextLoad(url, context);
  }
});

const sources = await import('../src/impact/sources.ts');
const matrix = await import('../src/impact/matrix.ts');
const { registry } = await import('../src/state/registry.ts');
const { clearNwsResponseCache } = await import('../src/impact/nws-point.ts');
const { buildNifcAreaPerimeterClaim } = await import('../src/config/wildfire-presentation.ts');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Run `body` with `fetch` answered by `answer(url)`; restore afterwards.
 * `openFetchScopes` lets a case wait for a read it released to finish, so a
 * late restore never lands inside the next case. */
let openFetchScopes = 0;
async function withFetch(answer, body) {
  const original = globalThis.fetch;
  openFetchScopes += 1;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return answer(url);
  };
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
    openFetchScopes -= 1;
  }
}

/** A minimal selection context: the fetchers read `lngLat` and the bboxes. */
function place(lng, lat, bbox) {
  return {
    kind: 'state',
    title: 'P3-TRUTH test place',
    properties: null,
    lngLat: { lng, lat },
    ...(bbox ? { bbox } : {}),
    regionKey: null,
    containing: {}
  };
}

/** One cell, settled from exactly the lane results given. */
function settledCell(horizon, hazard, laneResults) {
  const cell = matrix.createHorizonCells(horizon)[hazard];
  matrix.fillCell(cell, new Map(laneResults));
  return cell;
}

function feature(properties, geometry = null) {
  return { type: 'Feature', properties, geometry };
}

function collection(features) {
  return { type: 'FeatureCollection', features };
}

const signal = () => new AbortController().signal;

/** Yield to the event loop `ticks` times through `setImmediate`, which no
 * case mocks (the deadline cases mock only `setTimeout`). */
async function yieldTicks(ticks) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether `promise` settles within `ticks` event-loop turns, and its value. */
async function settlesWithin(promise, ticks = 500) {
  let outcome = { settled: false };
  promise.then((value) => {
    outcome = { settled: true, value };
  });
  for (let i = 0; i < ticks && !outcome.settled; i += 1) await yieldTicks(1);
  return outcome;
}

/** Wait (bounded) until `count` held lazy loads are pending; true if so. */
async function untilHeld(count) {
  for (let i = 0; i < 500 && globalThis.__p3truthHeld.length < count; i += 1) await yieldTicks(1);
  return globalThis.__p3truthHeld.length >= count;
}

/** Release every held lazy load, clear the lazy modes, and wait (bounded)
 * for any read still in flight to finish. */
async function releaseLazy() {
  for (const release of globalThis.__p3truthHeld.splice(0)) release();
  delete globalThis.__p3truthLazy;
  for (let i = 0; i < 500 && openFetchScopes > 0; i += 1) await yieldTicks(1);
}

/** Run `body` with `console.warn` captured; returns [result, warnings]. */
async function withWarnings(body) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    return [await body(), warnings];
  } finally {
    console.warn = original;
  }
}

// ---------------------------------------------------------------------------
// 1. Partial outlook reads
// ---------------------------------------------------------------------------

const CPC_WINDOW_DATES = {
  fcst_date: Date.UTC(2026, 8, 1),
  start_date: Date.UTC(2026, 8, 7),
  end_date: Date.UTC(2026, 8, 11)
};

/** CPC extended-range answer: `windows` maps a window's MapServer path to
 * `{ 0: temperature feature | status, 1: precipitation feature | status }`. */
function cpcAnswer(windows) {
  return (url) => {
    for (const [path, layers] of Object.entries(windows)) {
      if (!url.includes(`/${path}/MapServer/`)) continue;
      const layer = /\/MapServer\/(\d+)\/query/.exec(url)?.[1];
      const reply = layers[layer];
      if (reply === CPC_ANSWERED_ERROR) {
        // An HTTP 200 ArcGIS error envelope: the service ANSWERED, with an error.
        return jsonResponse({ error: { code: 500, message: 'Could not access any server machines.' } });
      }
      if (typeof reply === 'number') return jsonResponse({ message: 'stubbed failure' }, reply);
      return jsonResponse(collection(reply ? [feature(reply)] : []));
    }
    return jsonResponse({ message: 'unexpected host' }, 599);
  };
}

const CPC_ANSWERED_ERROR = 'answered-error';
const CPC_ABOVE_TEMP = { cat: 'Above', prob: 50, ...CPC_WINDOW_DATES };
const CPC_BELOW_PRECIP = { cat: 'Below', prob: 40, ...CPC_WINDOW_DATES };
const CPC_WINDOW_NOTE = 'One CPC outlook window did not respond.';

test('a CPC read whose 8-14 day window failed is live (partial): the 6-10 day claim stays and the window note reaches the cell', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: 503, 1: 503 }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.5, 47.4), signal())
  );
  assert.equal(result.ok, true, 'the surviving window is an answer, not a failure');
  assert.equal(result.claims.length, 1);
  assert.match(
    result.claims[0].text,
    /^CPC 6-10 day outlook: above-normal temperature \(50% odds\), below-normal precipitation \(40% odds\)\./
  );

  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'partial', 'one window failed, so the cell is live (partial), never live');
  assert.deepEqual(cell.claims, result.claims, 'the surviving window is kept, never discarded');
  assert.equal(cell.note, CPC_WINDOW_NOTE);
});

test('a CPC read whose precipitation layers failed in both windows is live (partial) and does not claim a window failed', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: 503 },
      cpc_8_14_day_outlk: { 0: CPC_ABOVE_TEMP, 1: 503 }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.6, 47.4), signal())
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims.length, 2, 'both windows answered for temperature');

  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'partial', 'a variable the read did not establish keeps the cell partial');
  assert.deepEqual(cell.claims, result.claims);
  // Exact (repair round 1): no window is silent, and no sentence for a failed
  // variable exists yet (proposed to the owner), so the cell carries no note.
  assert.equal(cell.note, undefined, 'both windows answered, so no window is reported as silent');
});

test('a CPC read with one layer request failed in one window is live (partial) and carries no window note', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: 503, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.62, 47.4), signal())
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims.length, 2);
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'partial', 'one failed request leaves the read incomplete');
  assert.equal(cell.note, undefined);
});

test('a CPC window whose two layers answered with no feature is complete: not partial and no did-not-respond note', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: null, 1: null }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.63, 47.4), signal())
  );
  assert.equal(result.ok, true);
  assert.equal(result.partial, undefined, 'an answered-empty layer is an answer, not a failure');
  assert.equal(result.claims.length, 1, 'the empty window states nothing');
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'ready');
  assert.equal(cell.note, undefined, 'the window answered, so it is never reported as silent');
});

test('a CPC read whose every layer answered with no feature is a complete read with nothing to state, never "did not respond"', async () => {
  const result = await withFetch(
    cpcAnswer({ cpc_6_10_day_outlk: {}, cpc_8_14_day_outlk: {} }),
    () => sources.fetchCpcOutlookClaims(place(-120.64, 47.4), signal())
  );
  assert.equal(result.ok, true, 'all four requests answered');
  assert.deepEqual(result.claims, []);
  assert.equal(result.note, undefined);
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  // The cell's own existing absence sentence, never a failure note.
  assert.equal(cell.status, 'unavailable');
  assert.equal(cell.note, matrix.CELL_ABSENCE.nearTerm.drought);
});

test('a CPC layer that answered with a category the code cannot read leaves the read live (partial) with no note', async () => {
  const result = await withFetch(
    cpcAnswer({
      // A non-text category, and a text code that is none of the four CPC uses.
      cpc_6_10_day_outlk: { 0: { ...CPC_ABOVE_TEMP, cat: 42 }, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: { ...CPC_ABOVE_TEMP, cat: 'XYZ' }, 1: CPC_BELOW_PRECIP }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.65, 47.4), signal())
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims.length, 2, 'each window still states its readable precipitation lean');
  for (const claim of result.claims) {
    assert.doesNotMatch(claim.text, /temperature/, 'an unreadable category is never stated');
    assert.equal(claim.chartSvg, undefined, 'no temperature bar for a temperature the claim does not state');
  }
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'partial', 'the read did not establish the temperature lean');
  assert.equal(cell.note, undefined, 'it answered, so "did not respond" would be false');
});

test('a CPC window whose two requests got HTTP 200 error envelopes is live (partial) without the did-not-respond note: it answered', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: CPC_ANSWERED_ERROR, 1: CPC_ANSWERED_ERROR }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.66, 47.4), signal())
  );
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'partial', 'the 8-14 day window established nothing');
  assert.equal(cell.claims.length, 1);
  assert.equal(cell.note, undefined, 'an answered error is never reported as a window that did not respond');

  // One answered error and one silent failure in the same window: the window
  // did answer in part, so the note is still false for it.
  const mixed = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: CPC_ANSWERED_ERROR, 1: 503 }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.67, 47.4), signal())
  );
  const mixedCell = settledCell('nearTerm', 'drought', [['cpcExtended', mixed]]);
  assert.equal(mixedCell.status, 'partial');
  assert.equal(mixedCell.note, undefined);
});

test('a CPC window whose answer this code fails on is live (partial), logged, and never reported as a window that did not respond', async () => {
  const [result, warnings] = await withWarnings(() =>
    withFetch(
      cpcAnswer({
        cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
        // An issuance instant no Date can format: both requests answered,
        // then the sentence builder throws on the answer.
        cpc_8_14_day_outlk: { 0: { ...CPC_ABOVE_TEMP, fcst_date: 1e20 }, 1: { ...CPC_BELOW_PRECIP, fcst_date: 1e20 } }
      }),
      () => sources.fetchCpcOutlookClaims(place(-120.76, 47.4), signal())
    )
  );
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'partial');
  assert.equal(cell.claims.length, 1);
  assert.equal(cell.note, undefined, 'the window answered; "did not respond" would be false');
  assert.ok(warnings.length > 0, 'a developer sees the failure');
});

test('a CPC read whose every request got an error envelope keeps the existing answered-with-an-error note', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ANSWERED_ERROR, 1: CPC_ANSWERED_ERROR },
      cpc_8_14_day_outlk: { 0: CPC_ANSWERED_ERROR, 1: CPC_ANSWERED_ERROR }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.68, 47.4), signal())
  );
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'unavailable');
  assert.equal(
    cell.note,
    'The CPC extended-range outlooks is unavailable: it answered with an error rather than data.'
  );
});

// The review's notation: F a failed request, E an answered-empty layer, U a
// category the code cannot read; temperature then precipitation, 6-10 day
// window then 8-14 day window.
const CPC_FAILED = 503;
const CPC_UNREADABLE_TEMP = { ...CPC_ABOVE_TEMP, cat: 'XYZ' };
const CPC_UNREADABLE_PRECIP = { ...CPC_BELOW_PRECIP, cat: 'XYZ' };

test('of the no-claim CPC reads, only EEEE states the absence sentence; FEFE and UUUU state no sentence at all', async () => {
  const cellFor = async (windows, lng) => {
    const result = await withFetch(cpcAnswer(windows), () =>
      sources.fetchCpcOutlookClaims(place(lng, 47.4), signal())
    );
    assert.deepEqual(result.claims, []);
    return settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  };
  const eeee = await cellFor({ cpc_6_10_day_outlk: {}, cpc_8_14_day_outlk: {} }, -120.69);
  const fefe = await cellFor(
    {
      cpc_6_10_day_outlk: { 0: CPC_FAILED, 1: null },
      cpc_8_14_day_outlk: { 0: CPC_FAILED, 1: null }
    },
    -120.71
  );
  const uuuu = await cellFor(
    {
      cpc_6_10_day_outlk: { 0: CPC_UNREADABLE_TEMP, 1: CPC_UNREADABLE_PRECIP },
      cpc_8_14_day_outlk: { 0: CPC_UNREADABLE_TEMP, 1: CPC_UNREADABLE_PRECIP }
    },
    -120.72
  );
  const absence = matrix.CELL_ABSENCE.nearTerm.drought;
  assert.deepEqual([eeee.status, eeee.note], ['unavailable', absence], 'EEEE: four answered-empty layers are established emptiness');
  // FEFE and UUUU did not establish emptiness, and both answered (so "did not
  // respond" is false). The empty note keeps the renderer's own fallback
  // ("No source answered ...", src/ui/impact-panel-runtime.ts) off the cell
  // too; the proposed sentences are in the P3-TRUTH report for the owner.
  assert.deepEqual([fefe.status, fefe.note], ['unavailable', ''], 'FEFE: failed temperature, empty precipitation');
  assert.deepEqual([uuuu.status, uuuu.note], ['unavailable', ''], 'UUUU: schema drift in every layer');
});

test('a CPC read with both windows complete stays live', async () => {
  const result = await withFetch(
    cpcAnswer({
      cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
      cpc_8_14_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP }
    }),
    () => sources.fetchCpcOutlookClaims(place(-120.7, 47.4), signal())
  );
  const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
  assert.equal(cell.status, 'ready');
  assert.equal(cell.claims.length, 2);
  assert.equal(cell.note, undefined);
});

// The CPC extended-range read sits behind a dynamic import (repair round 2,
// bytes): its loader must never reject, never outlive the briefing's abort,
// and never wait past the existing per-request deadline (TIMEOUT_MS, 10 s).
const CPC_ALL_READABLE = cpcAnswer({
  cpc_6_10_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP },
  cpc_8_14_day_outlk: { 0: CPC_ABOVE_TEMP, 1: CPC_BELOW_PRECIP }
});

test('a CPC outlook chunk that fails to load settles the cell unavailable with no sentence, and is logged', async () => {
  globalThis.__p3truthLazy = { './cpc-extended': 'fail' };
  const requests = [];
  try {
    const [result, warnings] = await withWarnings(() =>
      withFetch(
        (url) => {
          requests.push(url);
          return CPC_ALL_READABLE(url);
        },
        () => sources.fetchCpcOutlookClaims(place(-120.73, 47.4), signal())
      )
    );
    assert.deepEqual(requests, [], 'no CPC request is made without the outlook code');
    const cell = settledCell('nearTerm', 'drought', [['cpcExtended', result]]);
    assert.deepEqual([cell.status, cell.note], ['unavailable', '']);
    assert.ok(warnings.length > 0, 'a developer sees the failed load');
  } finally {
    await releaseLazy();
  }
});

test('a held CPC outlook chunk settles on the briefing abort, with no request and no claim', async () => {
  globalThis.__p3truthLazy = { './cpc-extended': 'hold' };
  const requests = [];
  const controller = new AbortController();
  try {
    const pending = withFetch(
      (url) => {
        requests.push(url);
        return CPC_ALL_READABLE(url);
      },
      () => sources.fetchCpcOutlookClaims(place(-120.74, 47.4), controller.signal)
    );
    const held = await untilHeld(1);
    assert.deepEqual(requests, [], 'no CPC request is made before the outlook code loads');
    assert.ok(held, 'setup: the outlook chunk load is held');
    controller.abort();
    const outcome = await settlesWithin(pending);
    assert.equal(outcome.settled, true, 'the read settles on abort');
    assert.deepEqual(outcome.value, { claims: [], ok: false });
  } finally {
    await releaseLazy();
  }
});

test('a held CPC outlook chunk settles the cell unavailable with no sentence at the 10-second deadline, not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.__p3truthLazy = { './cpc-extended': 'hold' };
  const requests = [];
  try {
    const pending = withFetch(
      (url) => {
        requests.push(url);
        return CPC_ALL_READABLE(url);
      },
      () => sources.fetchCpcOutlookClaims(place(-120.75, 47.4), signal())
    );
    const held = await untilHeld(1);
    assert.deepEqual(requests, [], 'no CPC request is made before the outlook code loads');
    assert.ok(held, 'setup: the outlook chunk load is held');
    t.mock.timers.tick(9_999);
    assert.equal((await settlesWithin(pending, 50)).settled, false, 'still waiting before the deadline');
    t.mock.timers.tick(1);
    const outcome = await settlesWithin(pending);
    assert.equal(outcome.settled, true, 'the read settles at the deadline');
    const cell = settledCell('nearTerm', 'drought', [['cpcExtended', outcome.value]]);
    assert.deepEqual([cell.status, cell.note], ['unavailable', '']);
  } finally {
    await releaseLazy();
  }
});

/** SPC Day 1-8 answer: `layers` maps a layer id to a feature's properties
 * or an HTTP status; every other layer answers an empty collection. */
function spcAnswer(layers) {
  return (url) => {
    if (!url.includes('/SPC_firewx/MapServer/')) {
      return jsonResponse({ message: 'unexpected host' }, 599);
    }
    const layer = /\/MapServer\/(\d+)\/query/.exec(url)?.[1];
    const reply = layers[layer];
    if (typeof reply === 'number') return jsonResponse({ message: 'stubbed failure' }, reply);
    return jsonResponse(collection(reply ? [feature(reply)] : []));
  };
}

test('an SPC read whose Day 3 query failed is live (partial): every day that answered keeps its claim and Day 3 is never folded into "no area"', async () => {
  const result = await withFetch(
    spcAnswer({
      1: { dn: 8, valid: '202609091700', expire: '202609101200' },
      8: 503
    }),
    () => sources.fetchSpcFireOutlookClaims(place(-120.5, 47.5), signal())
  );
  assert.equal(result.ok, true, 'seven of eight days answered');
  const texts = result.claims.map((claim) => claim.text);
  assert.ok(
    texts.some((text) => text.startsWith('SPC Day 1 Fire Weather Outlook: Critical risk from wind and relative humidity at this point')),
    texts.join(' | ')
  );
  assert.ok(
    texts.includes(
      'SPC Day 2 Fire Weather Outlook: no Elevated, Critical, or Extremely Critical area is drawn over this point for this day.'
    ),
    texts.join(' | ')
  );
  assert.ok(
    texts.includes('SPC Day 3-8 Fire Weather Outlook: no area is drawn over this point for Days 4, 5, 6, 7, and 8.'),
    texts.join(' | ')
  );

  const cell = settledCell('nearTerm', 'fire', [['spcFireOutlook', result]]);
  assert.equal(cell.status, 'partial', 'a failed day makes the cell live (partial), never live');
  assert.deepEqual(cell.claims, result.claims, 'the days that answered are kept, never discarded');
});

test('an SPC read whose Day 1 answered with an unrecognized dn is live (partial): the day is dropped, never invented, never folded into "no area"', async () => {
  const result = await withFetch(
    spcAnswer({ 1: { dn: 0, valid: '202609091700', expire: '202609101200' } }),
    () => sources.fetchSpcFireOutlookClaims(place(-120.55, 47.5), signal())
  );
  assert.equal(result.ok, true);
  const texts = result.claims.map((claim) => claim.text);
  assert.ok(texts.every((text) => !text.startsWith('SPC Day 1 ')), texts.join(' | '));
  const cell = settledCell('nearTerm', 'fire', [['spcFireOutlook', result]]);
  assert.equal(cell.status, 'partial', 'the read did not establish Day 1');
  assert.deepEqual(cell.claims, result.claims);
});

test('an SPC read whose Day 4 answered with an unrecognized label is live (partial)', async () => {
  const result = await withFetch(
    spcAnswer({ 11: { dn: 5, label: '0.05', valid: '202609111200', expire: '202609121200', issue: '202609082156' } }),
    () => sources.fetchSpcFireOutlookClaims(place(-120.56, 47.5), signal())
  );
  const texts = result.claims.map((claim) => claim.text);
  assert.ok(
    texts.includes('SPC Day 3-8 Fire Weather Outlook: no area is drawn over this point for Days 3, 5, 6, 7, and 8.'),
    texts.join(' | ')
  );
  const cell = settledCell('nearTerm', 'fire', [['spcFireOutlook', result]]);
  assert.equal(cell.status, 'partial', 'the read did not establish Day 4');
});

test('an SPC read with every day answering stays live', async () => {
  const result = await withFetch(
    spcAnswer({ 1: { dn: 8, valid: '202609091700', expire: '202609101200' } }),
    () => sources.fetchSpcFireOutlookClaims(place(-120.6, 47.5), signal())
  );
  const cell = settledCell('nearTerm', 'fire', [['spcFireOutlook', result]]);
  assert.equal(cell.status, 'ready');
  assert.equal(cell.note, undefined);
});

// ---------------------------------------------------------------------------
// 2. A loaded perimeter intersects only when its geometry does
// ---------------------------------------------------------------------------

/** A ring polygon: the outer square [-122, 46] to [-118, 49] with a hole
 * [-121, 46.8] to [-119, 48.2]. */
const DONUT = {
  type: 'Polygon',
  coordinates: [
    [[-122, 46], [-118, 46], [-118, 49], [-122, 49], [-122, 46]],
    [[-121, 46.8], [-121, 48.2], [-119, 48.2], [-119, 46.8], [-121, 46.8]]
  ]
};

/** A thin band from the south-west corner to the north-east corner of its
 * box [-122, 46] to [-118, 49]; the north-west and south-east corners of the
 * box are empty ground. */
const DIAGONAL = {
  type: 'Polygon',
  coordinates: [
    [[-122, 46], [-121.6, 46], [-118, 48.6], [-118, 49], [-118.4, 49], [-122, 46.4], [-122, 46]]
  ]
};

function wildfire(id, geometry) {
  return feature(
    { attr_UniqueFireIdentifier: id, attr_IncidentName: id, attr_IncidentTypeCategory: 'WF' },
    geometry
  );
}

/** The briefing's NIFC read for `bbox`, answered from a loaded collection
 * holding `features`; any network request fails the case. */
async function nifcFromLoaded(features, bbox) {
  registry.setStatus('nifc-fires', 'ready');
  globalThis.__p3truthLoadedNifc = {
    collection: collection(features),
    envelope: null,
    fetchedAt: Date.UTC(2026, 9, 4, 12)
  };
  const requests = [];
  try {
    const [cx, cy] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    const result = await withFetch(
      (url) => {
        requests.push(url);
        return jsonResponse({ message: 'no network expected' }, 599);
      },
      () => sources.fetchNifcClaims(place(cx, cy, bbox), signal())
    );
    assert.deepEqual(requests, [], 'the loaded collection answers; no WFIGS request');
    assert.equal(result.ok, true);
    assert.equal(result.claims.length, 1);
    return result.claims[0].text;
  } finally {
    delete globalThis.__p3truthLoadedNifc;
    registry.setStatus('nifc-fires', 'loading');
  }
}

const NO_PERIMETER = buildNifcAreaPerimeterClaim([]);
const ONE_WILDFIRE = buildNifcAreaPerimeterClaim(['WF']);

test('a place inside a perimeter hole is not stated to intersect it', async () => {
  const text = await nifcFromLoaded([wildfire('HOLE-1', DONUT)], [-120.5, 47.2, -119.5, 47.8]);
  assert.equal(text, NO_PERIMETER);
});

test('a place in the empty corner of a diagonal perimeter box is not stated to intersect it', async () => {
  const text = await nifcFromLoaded([wildfire('DIAG-1', DIAGONAL)], [-121.9, 48.5, -121.5, 48.9]);
  assert.equal(text, NO_PERIMETER);
});

test('a place truly inside a perimeter, or crossed by it, is still stated to intersect it', async () => {
  assert.equal(
    await nifcFromLoaded([wildfire('HOLE-1', DONUT)], [-121.8, 46.2, -121.4, 46.6]),
    ONE_WILDFIRE,
    'inside the ring itself'
  );
  assert.equal(
    await nifcFromLoaded([wildfire('DIAG-1', DIAGONAL)], [-120.4, 47.0, -119.6, 47.6]),
    ONE_WILDFIRE,
    'crossed by the diagonal band'
  );
  assert.equal(
    await nifcFromLoaded([wildfire('HOLE-1', DONUT)], [-123, 45, -117, 50]),
    ONE_WILDFIRE,
    'a place whose rectangle holds the whole perimeter'
  );
});

test('a perimeter that only touches the place rectangle along an edge is stated to intersect it (the service intersects rule)', async () => {
  // ArcGIS `esriSpatialRelIntersects` is true when the two geometries share
  // any point, boundary included, so the network read counts an edge touch;
  // the loaded-collection read must agree.
  const square = {
    type: 'Polygon',
    coordinates: [[[-120, 47], [-119, 47], [-119, 48], [-120, 48], [-120, 47]]]
  };
  assert.equal(
    await nifcFromLoaded([wildfire('EDGE-1', square)], [-121, 47.2, -120, 47.8]),
    ONE_WILDFIRE
  );
});

test('a polygon-overlap chunk that fails to load never leaves the NIFC read unsettled: it answers through the network read', async () => {
  registry.setStatus('nifc-fires', 'ready');
  globalThis.__p3truthLoadedNifc = {
    collection: collection([wildfire('HOLE-1', DONUT)]),
    envelope: null,
    fetchedAt: Date.UTC(2026, 9, 4, 12)
  };
  globalThis.__p3truthFailOverlap = true;
  const requests = [];
  try {
    const bbox = [-121.8, 46.2, -121.4, 46.6];
    const result = await withFetch(
      (url) => {
        requests.push(url);
        return jsonResponse(
          collection([
            feature({ attr_UniqueFireIdentifier: 'NET-1', attr_IncidentName: 'NET-1', attr_IncidentTypeCategory: 'WF' })
          ])
        );
      },
      () => sources.fetchNifcClaims(place(-121.6, 46.4, bbox), signal())
    );
    assert.ok(failedOverlapLoads > 0, 'setup: the overlap chunk load was attempted and failed');
    assert.ok(
      requests.some((url) => url.includes('WFIGS_Interagency_Perimeters_Current')),
      'the failed overlap load falls through to the network read'
    );
    assert.equal(result.ok, true);
    assert.equal(result.claims[0].text, ONE_WILDFIRE);
  } finally {
    delete globalThis.__p3truthFailOverlap;
    delete globalThis.__p3truthLoadedNifc;
    registry.setStatus('nifc-fires', 'loading');
  }
});

/** Put `features` on the loaded perimeters layer at `status`. */
function loadPerimeters(features, status = 'ready') {
  registry.setStatus('nifc-fires', status);
  globalThis.__p3truthLoadedNifc = {
    collection: collection(features),
    envelope: null,
    fetchedAt: Date.UTC(2026, 9, 4, 12)
  };
}

function clearPerimeters() {
  delete globalThis.__p3truthLoadedNifc;
  registry.setStatus('nifc-fires', 'loading');
}

const isWfigs = (url) => url.includes('WFIGS_Interagency_Perimeters_Current');
const NET_WILDFIRE = collection([
  feature({ attr_UniqueFireIdentifier: 'NET-1', attr_IncidentName: 'NET-1', attr_IncidentTypeCategory: 'WF' })
]);

test('a DEGRADED (transfer-limited) loaded collection is never reused for a count or an absence: the network read answers', async () => {
  // The layer marks a transfer-limited response degraded
  // (src/layers/nifc-fires.ts, `lastAppliedStatus`), and the real parser
  // reports that response as truncated; its getter carries no completeness.
  const { parseArcGisPolygonFeatureCollection } = await import('../src/config/wildfire-presentation.ts');
  const parsed = parseArcGisPolygonFeatureCollection(
    { ...collection([wildfire('FAR-1', DONUT)]), exceededTransferLimit: true },
    'NIFC WFIGS'
  );
  assert.equal(parsed.truncated, true, 'setup: the response is truncated');
  loadPerimeters(parsed.collection.features, 'degraded');
  const requests = [];
  try {
    const bbox = [-117.5, 40.2, -117.1, 40.6];
    const result = await withFetch(
      (url) => {
        requests.push(url);
        return jsonResponse(NET_WILDFIRE);
      },
      () => sources.fetchNifcClaims(place(-117.3, 40.4, bbox), signal())
    );
    assert.ok(requests.some(isWfigs), 'a truncated collection declines; the service is asked');
    assert.equal(result.claims[0].text, ONE_WILDFIRE, 'never "No current mapped NIFC fire perimeters intersect ..."');
  } finally {
    clearPerimeters();
  }
});

test('the loaded read and the network read test the same rounded rectangle: an edge the service rounds onto counts on both', async () => {
  // The service query rounds the rectangle to 4 decimals, so its east edge
  // -120.00004 becomes -120 and meets this perimeter's west edge.
  const square = {
    type: 'Polygon',
    coordinates: [[[-120, 47], [-119, 47], [-119, 48], [-120, 48], [-120, 47]]]
  };
  const bbox = [-121, 47.2, -120.00004, 47.8];
  assert.equal(await nifcFromLoaded([wildfire('EDGE-2', square)], bbox), ONE_WILDFIRE, 'the loaded read');

  let queried = null;
  const network = await withFetch(
    (url) => {
      queried = new URL(url).searchParams.get('geometry').split(',').map(Number);
      return jsonResponse(NET_WILDFIRE);
    },
    () => sources.fetchNifcClaims(place(-120.5, 47.5, bbox), signal())
  );
  assert.deepEqual(queried, [-121, 47.2, -120, 47.8], 'the network read asks for the rounded rectangle');
  assert.equal(network.claims[0].text, ONE_WILDFIRE);
});

test('an unwrapped rectangle across the antimeridian declines the loaded read, which tests one rectangle only', async () => {
  const bbox = [179, 45, 181, 46];
  loadPerimeters([wildfire('DATELINE-1', { type: 'Polygon', coordinates: [[[-179.8, 45.2], [-179.2, 45.2], [-179.2, 45.8], [-179.8, 45.8], [-179.8, 45.2]]] })]);
  const requests = [];
  try {
    const result = await withFetch(
      (url) => {
        requests.push(url);
        return jsonResponse(NET_WILDFIRE);
      },
      () => sources.fetchNifcClaims({ ...place(180, 45.5, bbox), serviceBbox: bbox }, signal())
    );
    assert.equal(requests.filter(isWfigs).length, 2, 'the service read splits it in two');
    assert.equal(result.claims[0].text, ONE_WILDFIRE);
  } finally {
    clearPerimeters();
  }
});

// The fast path's two lazy loads, each held in turn.
const NIFC_LAZY_LOADS = ['../layers/nifc-fires', '../util/polygon-overlap'];

test('a held layer or overlap chunk settles the NIFC read on the briefing abort, with no request and no late claim', async () => {
  for (const specifier of NIFC_LAZY_LOADS) {
    loadPerimeters([wildfire('HOLE-1', DONUT)]);
    globalThis.__p3truthLazy = { [specifier]: 'hold' };
    const requests = [];
    const controller = new AbortController();
    try {
      const [outcome, warnings] = await withWarnings(async () => {
        const pending = withFetch(
          (url) => {
            requests.push(url);
            return jsonResponse(NET_WILDFIRE);
          },
          () => sources.fetchNifcClaims(place(-121.6, 46.4, [-121.8, 46.2, -121.4, 46.6]), controller.signal)
        );
        assert.ok(await untilHeld(1), `setup: the ${specifier} load is held`);
        controller.abort();
        return settlesWithin(pending);
      });
      assert.equal(outcome.settled, true, `${specifier}: the read settles on abort`);
      assert.deepEqual(outcome.value, { claims: [], ok: false });
      assert.deepEqual(requests, [], 'an aborted read starts no network read');
      assert.deepEqual(warnings, [], 'a cancellation is not a defect');
    } finally {
      await releaseLazy();
      clearPerimeters();
    }
  }
});

test('a held layer or overlap chunk gives way to the network read at the 10-second deadline, not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const specifier of NIFC_LAZY_LOADS) {
    loadPerimeters([wildfire('HOLE-1', DONUT)]);
    globalThis.__p3truthLazy = { [specifier]: 'hold' };
    const requests = [];
    try {
      const pending = withFetch(
        (url) => {
          requests.push(url);
          return jsonResponse(NET_WILDFIRE);
        },
        () => sources.fetchNifcClaims(place(-121.6, 46.4, [-121.8, 46.2, -121.4, 46.6]), signal())
      );
      assert.ok(await untilHeld(1), `setup: the ${specifier} load is held`);
      t.mock.timers.tick(9_999);
      await yieldTicks(50);
      assert.deepEqual(requests, [], `${specifier}: no network read before the deadline`);
      t.mock.timers.tick(1);
      const outcome = await settlesWithin(pending);
      assert.ok(requests.some(isWfigs), `${specifier}: the network read starts at the deadline`);
      assert.equal(outcome.settled, true);
      assert.equal(outcome.value.claims[0].text, ONE_WILDFIRE);
    } finally {
      await releaseLazy();
      clearPerimeters();
    }
  }
});

test('an overlap implementation defect falls back to the network read and is logged for a developer', async () => {
  loadPerimeters([wildfire('HOLE-1', DONUT)]);
  globalThis.__p3truthLazy = { '../util/polygon-overlap': 'defect' };
  try {
    const [result, warnings] = await withWarnings(() =>
      withFetch(
        () => jsonResponse(collection([])),
        () => sources.fetchNifcClaims(place(-121.6, 46.4, [-121.8, 46.2, -121.4, 46.6]), signal())
      )
    );
    assert.equal(result.claims[0].text, NO_PERIMETER, 'the network answer stands');
    assert.ok(
      warnings.some((args) => args.some((arg) => arg instanceof TypeError)),
      'the TypeError reaches console.warn'
    );
  } finally {
    await releaseLazy();
    clearPerimeters();
  }
});

// ---------------------------------------------------------------------------
// 3. A fire-only NWS answer is a Heat read too
// ---------------------------------------------------------------------------

function nwsAlertsAnswer(events) {
  return (url) => {
    // The production read goes through the Worker proxy (`nwsRequestUrl`,
    // `src/impact/nws-point.ts`), which carries the upstream URL encoded.
    if (!decodeURIComponent(url).includes('https://api.weather.gov/alerts/active?')) {
      return jsonResponse({ message: 'unexpected host' }, 599);
    }
    return jsonResponse(
      collection(events.map((event) => ({ type: 'Feature', properties: { event } })))
    );
  };
}

const HEAT_ABSENCE = 'NWS reports no active extreme-heat alert at the selected point.';

test('a fire-only NWS answer gives the Heat cell its absence claim, never unavailable', async () => {
  clearNwsResponseCache();
  const result = await withFetch(nwsAlertsAnswer(['Red Flag Warning']), () =>
    sources.fetchNwsAlertClaims(place(-120.41, 47.41), signal())
  );
  assert.equal(result.ok, true);

  const heat = settledCell('current', 'heat', [['nwsAlerts', result]]);
  assert.equal(heat.status, 'ready', 'the alerts service answered for heat');
  assert.equal(heat.claims.length, 1);
  assert.equal(heat.claims[0].text, HEAT_ABSENCE);
  assert.deepEqual(heat.claims[0].hazards, ['heat']);
  assert.equal(heat.note, undefined);

  const fire = settledCell('current', 'fire', [['nwsAlerts', result]]);
  assert.ok(
    fire.claims.some((claim) => claim.text.startsWith('A fire-weather alert is in effect here: Red Flag Warning.')),
    fire.claims.map((claim) => claim.text).join(' | ')
  );
  assert.ok(
    fire.claims.every((claim) => claim.text !== HEAT_ABSENCE),
    'the heat absence sentence speaks for the Heat row only'
  );
});

test('a heat-only NWS answer leaves the Fire row exactly as at base: no alerts claim of its own', async () => {
  clearNwsResponseCache();
  // vocab-allow: a verbatim NWS product name, quoted fixture data
  const result = await withFetch(nwsAlertsAnswer(['Heat Advisory']), () =>
    sources.fetchNwsAlertClaims(place(-120.43, 47.43), signal())
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.claims.map((claim) => [claim.text, claim.hazards]),
    [
      [
        'An extreme-heat alert is in effect here: Heat Advisory. Heat raises drinking-water demand and human-health stress.',
        ['heat']
      ]
    ]
  );
  const fire = settledCell('current', 'fire', [['nwsAlerts', result]]);
  assert.deepEqual(fire.claims, [], 'the alerts lane files nothing in the Fire row');
  assert.equal(fire.status, 'loading', 'the Fire row still waits on NIFC, as at base');
  const heat = settledCell('current', 'heat', [['nwsAlerts', result]]);
  assert.equal(heat.status, 'ready');
});

test('an NWS answer with neither alert keeps the one shared all-clear in both rows', async () => {
  clearNwsResponseCache();
  const result = await withFetch(nwsAlertsAnswer([]), () =>
    sources.fetchNwsAlertClaims(place(-120.42, 47.42), signal())
  );
  const shared = 'No active red-flag fire-weather or extreme-heat alerts at this location right now (NWS).';
  for (const hazard of ['fire', 'heat']) {
    const cell = settledCell('current', hazard, [['nwsAlerts', result]]);
    assert.deepEqual(
      cell.claims.map((claim) => claim.text),
      [shared],
      `${hazard} row`
    );
  }
  // The Heat row's only current lane is this one; the Fire row also waits on
  // NIFC, which this case does not settle.
  assert.equal(settledCell('current', 'heat', [['nwsAlerts', result]]).status, 'ready');
});
