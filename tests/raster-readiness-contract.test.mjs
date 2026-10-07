import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * DDM-P14-T04 (register item found-001): raster readiness is tile-proven.
 *
 * The outcome, in the roadmap's words: "The gridded-index and
 * sea-surface-temperature surfaces report live (partial) when only part of
 * the view is covered, and never report live before a tile is proven." The
 * owner-confirmed scope covers all three raster activations that used to
 * report `ready` before any tile (sst-anomaly, hillshade, gridded-index),
 * and sst-anomaly's private first-tile wait becomes shared.
 *
 * Two halves:
 *
 *   1. THE CONTRACT (source scan, no import): every module under `src/`
 *      that declares a `raster` or `raster-dem` source either reaches
 *      `ready` only through tile proof (a completeness watch below the
 *      boot-idle budget, on every raster source it adds, and no literal
 *      `ready` write), or is a declared exception whose reason is written
 *      here. A new raster module fails this file until it is one or the
 *      other.
 *
 *   2. THE BEHAVIOUR (browser-free): the three modules are driven through
 *      their real `activate`/`deactivate` on a fake map that keeps a
 *      listener table (the FakeWhpMap pattern, tests/usfs-whp.spec.ts), with
 *      a fail-closed `fetch` stub, so no case can reach a live service.
 *      Deadlines run on node:test's mocked `setTimeout`.
 *
 * Runs under plain `node --test` (Node 24 strips the types), with the
 * resolve hook tests/boot-idle-seam.test.mjs uses for extensionless
 * imports. Three modules sst-anomaly imports cannot load under type
 * stripping or without a DOM (src/util/frame-stepper.ts has a parameter
 * property, src/layers/enso-flow.ts imports CSS, src/ui/time-bar.ts reads
 * `matchMedia` at import), so a load hook stands in for exactly those three
 * with the few named exports sst-anomaly uses. The time-bar stand-in
 * records the bar each layer installs, which is how a case steps the SST
 * rail the way a user does.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Environment: the smallest window and document the three modules touch.
// ---------------------------------------------------------------------------

const timeBars = new Map();
globalThis.__rasterReadinessTest = { timeBars, prefetch: false };
globalThis.window = globalThis;
globalThis.document = {
  documentElement: { dataset: {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  hidden: false
};
globalThis.location = new URL('https://ddm.test/?view=console');
globalThis.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {}
});
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const STAND_INS = new Map([
  [
    '/src/util/frame-stepper.ts',
    'export const FRAME_FADE_MS = 0;\n' +
      'export function prefetchAllowed() { return globalThis.__rasterReadinessTest.prefetch === true; }\n' +
      'export async function crossfadeFrames() {}\n'
  ],
  [
    '/src/layers/enso-flow.ts',
    'export function activateEnsoFlow() {}\n' +
      'export function cancelEnsoFlowLoad() {}\n' +
      'export function deactivateEnsoFlow() {}\n'
  ],
  [
    '/src/ui/time-bar.ts',
    'export function setTimeBar(key, config) { globalThis.__rasterReadinessTest.timeBars.set(key, config); }\n' +
      'export function clearTimeBar(key) { globalThis.__rasterReadinessTest.timeBars.delete(key); }\n'
  ]
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
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
    for (const [suffix, source] of STAND_INS) {
      if (url.endsWith(suffix)) return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

// ---------------------------------------------------------------------------
// Part 1: the contract, by source scan
// ---------------------------------------------------------------------------

/** Comments out, strings kept (the pure-lane inventory's rule: `https://` survives). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `.ts` and `.tsx` file under `dir` (finding C9: a `.tsx` source used to be invisible to this scan). */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const posix = (path) => path.split(sep).join('/');

/** The object literal around `index`, by brace balance, or null. */
function enclosingObject(text, index) {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1, body: text.slice(start, i + 1) };
    }
  }
  return null;
}

/** The balanced argument text of every `name(` call in `text`. */
function callArguments(text, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let match;
  while ((match = re.exec(text)) !== null) {
    let depth = 0;
    const open = match.index + match[0].length - 1;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return out;
}

/** Split top-level arguments on commas outside brackets. */
function topLevelArgs(argText) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const ch of argText) {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

/**
 * Every raster or raster-dem SOURCE declaration under `dir` (default `src/`):
 * an object literal typed raster or raster-dem that carries `tiles` or `url`
 * and no `source` key (a layer spec names its `source`; a source spec does
 * not). `.ts` and `.tsx` are both scanned (finding C9).
 *
 * Each row's `identity` is the name this activation path is known by: the
 * `map.addSource(<id>, ...)` argument when the call is present (matching
 * `sourceIdExpr`, which the tile-proven rows below still key on), or the
 * object's own property key for a literal style source (`style.ts`'s
 * `basemap:`). `EXCEPTIONS` below is keyed by `${file}#${identity}`, not by
 * file alone, so a second, undispositioned raster source added to an already
 * exempt file has no identity to match and fails the contract (finding C9:
 * "a new unproved raster source in an already-exempt file inherits the
 * existing paragraph and passes").
 */
function scanRasterSources(dir = join(ROOT, 'src'), baseDir = ROOT) {
  const found = [];
  for (const file of listSourceFiles(dir)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const re = /\btype\s*:\s*['"`](raster|raster-dem)['"`]/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const object = enclosingObject(text, match.index);
      if (!object) continue;
      // `tiles` may be shorthand (`{ type: 'raster', tiles, ... }`, satellite.ts).
      const isSource =
        /\b(tiles|url)\b\s*[:,}]/.test(object.body) && !/\bsource\s*:/.test(object.body);
      if (!isSource) continue;
      const before = text.slice(Math.max(0, object.start - 200), object.start);
      const add = /addSource\(\s*([^,()]+(?:\([^()]*\))?)\s*,\s*$/.exec(before);
      const key = add ? null : /([$\w]+)\s*:\s*$/.exec(before);
      found.push({
        file: posix(relative(baseDir, file)),
        kind: match[1],
        sourceIdExpr: add ? add[1].trim() : null,
        identity: add ? add[1].trim() : key ? key[1] : null
      });
    }
  }
  return found;
}

/**
 * The exception half of the contract, isolated so a self-test can drive it
 * against a synthetic fixture: every source's `${file}#${identity}` must
 * name its own exception (an unnamed identity, `(unnamed)`, never matches
 * one), and every declared exception must still name a source that exists
 * and a reason with real content.
 */
function exceptionProblems(sources, exceptions) {
  const problems = [];
  const found = new Set(sources.map((s) => `${s.file}#${s.identity ?? '(unnamed)'}`));
  for (const source of sources) {
    const identityKey = `${source.file}#${source.identity ?? '(unnamed)'}`;
    if (!exceptions.has(identityKey)) {
      problems.push(
        `${identityKey}: adds a raster source but is neither a tile-proven row nor a declared exception naming this identity`
      );
    }
  }
  for (const [identityKey, reason] of exceptions) {
    if (!found.has(identityKey)) problems.push(`${identityKey}: declared, but adds no raster source; remove the row`);
    if (reason.trim().length <= 20) problems.push(`${identityKey}: an exception must name its reason`);
  }
  return problems;
}

/** The boot-idle budget, read where the product defines it. */
function bootIdleBudgetMs() {
  const text = readFileSync(join(ROOT, 'src/state/boot-idle.ts'), 'utf8');
  const match = /const DEFAULT_QUIESCENCE_BUDGET_MS = ([\d_]+);/.exec(text);
  assert.ok(match, 'src/state/boot-idle.ts no longer declares DEFAULT_QUIESCENCE_BUDGET_MS');
  return Number(match[1].replace(/_/g, ''));
}

/** The one completeness deadline every tile-proven row passes. */
function sharedProofDeadlineMs() {
  const text = readFileSync(join(ROOT, 'src/util/raster-status.ts'), 'utf8');
  const match = /export const RASTER_PROOF_DEADLINE_MS = ([\d_]+);/.exec(text);
  assert.ok(
    match,
    'src/util/raster-status.ts must export RASTER_PROOF_DEADLINE_MS, the one completeness deadline the tile-proven rows share'
  );
  return Number(match[1].replace(/_/g, ''));
}

/**
 * The tile-proven rows (adapter-matrix rows C1 and C3; C2, hillshade, is a
 * declared exception below). Each must watch every raster source it adds in
 * completeness mode at the shared deadline, and must never write `ready`
 * itself.
 */
const TILE_PROVEN = new Map([
  ['src/layers/gridded-index.ts', 'C3 gridded index (NIDIS SPI), DDM-P14-T04'],
  ['src/layers/sst-anomaly.ts', 'C1 SST anomaly (GIBS GHRSST MUR, default and every dated frame), DDM-P14-T04']
]);

/**
 * Declared exceptions: named source/activation identities that do not reach a
 * pill through this rule, and why. Keyed by `${file}#${identity}` (finding
 * C9), not by file: a new raster source added to one of these files, under a
 * different identity, has no row here and fails the contract until it gets
 * its own disposition.
 */
const EXCEPTIONS = new Map([
  [
    'src/layers/dryness-ground.ts#s.sourceId',
    'dormant: dryness-ground is reached only through dryness-grey-protocol, which no shipped module imports, so no build carries it (checked 2026-10-08 for release 0.7.1); it must become tile-proven before its admission activates it, and this exception is removed then'
  ],
  [
    'src/layers/hillshade.ts#SOURCE_ID',
    'C2 hillshade (bundled PNW raster-dem PMTiles): a director\'s-ruling exception at DDM-P14-T04, decided on a measured build-time profile. With the shared completeness watcher wired here, the Fire 3D pair (fire3d-mode.spec.ts, view-contracts.spec.ts) fell from 57/59 to 47/59 (I:/claude-temp/ddm-s30d/gates/c4-bisect-fire3d.log): the 3D scene\'s own animation suppresses map idle, so every 3D boot waited out the tile-proof deadline. Restoring the probe-then-add design with no tile wait (c4-hillshade-probe.log) returned the pair to 58/59. The archive is bundled, same-origin and deterministic, so the residual risk a tile proof would catch is small next to the 3D cost it imposes'
  ],
  [
    'src/layers/heatrisk.ts#sourceId',
    'tile-proven already (completeness watch, reportInitialSuccess), but its TILE_SUCCESS_DEADLINE_MS is 10,000 ms, equal to the boot-idle budget, and an empty idle cycle reads ready behind its own map-centre coverage gate. The file is owned by M2 and D2, so the mismatch is declared here rather than edited'
  ],
  [
    'src/layers/usfs-whp.ts#SOURCE_ID',
    'tile-proven already (the precedent: completeness watch with reportInitialSuccess), but its TILE_SUCCESS_DEADLINE_MS is 10,000 ms, equal to the boot-idle budget, with the default empty-idle ready; outside this task\'s files, declared rather than edited'
  ],
  [
    'src/layers/whp-3d.ts#SOURCE_ID',
    'the Fire 3D hazard drape: it writes no registry status and no pill; activation probes the archive header and returns a boolean to the 3D scene'
  ],
  [
    'src/map/satellite.ts#SOURCE_ID',
    'the satellite basemap chip, not a registry layer: frame-pinned completeness with a 30 s deadline drives the chip text, never a layer pill'
  ],
  [
    'src/map/fire3d.ts#TERRAIN_SOURCE_ID',
    'the Fire 3D terrain source, not a registry layer: its watcher only fails the scene on error and writes no layer status'
  ],
  [
    'src/map/style.ts#basemap',
    'the base style\'s basemap raster, declared in the style JSON rather than added by a layer module; it has no pill'
  ]
]);

test('every raster activation path under src/ reaches ready only through tile proof, and each exception names its reason', () => {
  const sources = scanRasterSources();
  const files = new Set(sources.map((s) => s.file));
  // Every violation is collected before the one assertion, so a red run
  // names each row that fails, not only the first.
  const problems = [];

  // Enumeration, both ways: nothing undeclared, nothing stale. Tile-proven
  // rows are files (each source inside one is checked below, by identity,
  // against its own watcher); every other source must carry its own named
  // exception (finding C9: exceptions are identities, not whole files).
  for (const file of TILE_PROVEN.keys()) {
    if (!files.has(file)) problems.push(`${file}: declared, but adds no raster source; remove the row`);
  }
  const exemptSources = sources.filter((s) => !TILE_PROVEN.has(s.file));
  problems.push(...exceptionProblems(exemptSources, EXCEPTIONS));

  // The shared deadline sits strictly below the boot-idle budget.
  const budget = bootIdleBudgetMs();
  let deadline = null;
  try {
    deadline = sharedProofDeadlineMs();
  } catch (err) {
    problems.push(err.message);
  }
  if (deadline !== null && !(deadline < budget)) {
    problems.push(`RASTER_PROOF_DEADLINE_MS (${deadline}) must sit strictly below the boot-idle budget (${budget})`);
  }

  // Each row: every raster source it adds is watched at the shared deadline,
  // and no literal ready write bypasses the watcher.
  for (const file of TILE_PROVEN.keys()) {
    const text = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    const watches = callArguments(text, 'watchRasterTiles').map(topLevelArgs);
    if (watches.length === 0) problems.push(`${file}: no watchRasterTiles call, so nothing proves a tile`);
    for (const args of watches) {
      const options = args[3] ?? '';
      if (!/\b(TILE_PROOF_WATCH|RASTER_PROOF_DEADLINE_MS)\b/.test(options)) {
        problems.push(`${file}: watchRasterTiles(${args[0]}, ${args[1]}, ...) is not in completeness mode at the shared deadline`);
      }
      if (/emptyIdleOutcome\s*:\s*'ready'/.test(options)) {
        problems.push(`${file}: an empty idle cycle must not read ready`);
      }
    }
    const watchedIds = new Set(watches.map((args) => args[1]));
    for (const source of sources.filter((s) => s.file === file)) {
      if (!source.sourceIdExpr) {
        problems.push(`${file}: a raster source is declared outside an addSource call`);
      } else if (!watchedIds.has(source.sourceIdExpr)) {
        problems.push(`${file}: addSource(${source.sourceIdExpr}, ...) has no watcher of its own`);
      }
    }
    for (const write of text.match(/\b(?:reportStatus|setStatus)\s*\([^()]*'ready'\s*\)/g) ?? []) {
      problems.push(`${file}: writes ready itself instead of through tile proof: ${write}`);
    }
  }

  // The stepping path's first-tile wait is the shared one.
  const sst = stripComments(readFileSync(join(ROOT, 'src/layers/sst-anomaly.ts'), 'utf8'));
  if (/function waitForSourceTiles\b/.test(sst)) problems.push('src/layers/sst-anomaly.ts: keeps a private first-tile wait');
  if (!/\bwaitForRasterTileProof\s*\(/.test(sst)) {
    problems.push('src/layers/sst-anomaly.ts: does not use the shared first-tile wait');
  }

  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Self-tests: the scanner and the exception check, on synthetic fixtures
// (finding C9). These prove the scoping and the .tsx reach of the contract
// test itself, without touching src/.
// ---------------------------------------------------------------------------

/** A scratch directory outside the checkout, torn down after the case. */
function withFixtureDir(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'ddm-raster-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

test('C9 self-test: a new raster source in an already-exempt file has no identity to match, and fails', (t) => {
  const dir = withFixtureDir(t, {
    'exempt-file.ts': [
      "export function activate(map) {",
      "  map.addSource(KNOWN_ID, { type: 'raster', tiles: ['https://example.test/{z}/{x}/{y}.png'] });",
      "  map.addSource(NEW_ID, { type: 'raster', tiles: ['https://example.test/other/{z}/{x}/{y}.png'] });",
      "}"
    ].join('\n')
  });
  const sources = scanRasterSources(dir, dir);
  assert.equal(sources.length, 2, 'the fixture should yield exactly two raster sources');
  const fixtureExceptions = new Map([
    ['exempt-file.ts#KNOWN_ID', 'a synthetic exception with a real reason, long enough to pass the length check']
  ]);
  const problems = exceptionProblems(sources, fixtureExceptions);
  assert.ok(
    problems.some((p) => p.startsWith('exempt-file.ts#NEW_ID:')),
    `expected a problem naming exempt-file.ts#NEW_ID, got ${JSON.stringify(problems)}`
  );
  assert.ok(
    !problems.some((p) => p.startsWith('exempt-file.ts#KNOWN_ID:')),
    `the already-dispositioned identity should not fail: ${JSON.stringify(problems)}`
  );
});

test('C9 self-test: a same-count replacement of an exempt source is not covered by its old exception', (t) => {
  const dir = withFixtureDir(t, {
    'exempt-file.ts': [
      "export function activate(map) {",
      "  map.addSource(OLD_ID, { type: 'raster', tiles: ['https://example.test/{z}/{x}/{y}.png'] });",
      "}"
    ].join('\n')
  });
  const exceptions = new Map([
    ['exempt-file.ts#OLD_ID', 'a synthetic exception with a real reason, long enough to pass the length check']
  ]);

  // Control: the original identity is named by its exception, no problems.
  let sources = scanRasterSources(dir, dir);
  assert.equal(sources.length, 1, 'the fixture should yield exactly one raster source');
  assert.deepEqual(exceptionProblems(sources, exceptions), []);

  // The Codex round-3 amendment's scenario (channel line 858): the file's
  // single raster source is REPLACED (a new addSource identity) while the
  // file's raster-source count stays 1 to 1. This is distinct from the
  // addition case above, where the count grows.
  writeFileSync(
    join(dir, 'exempt-file.ts'),
    [
      "export function activate(map) {",
      "  map.addSource(NEW_ID, { type: 'raster', tiles: ['https://example.test/other/{z}/{x}/{y}.png'] });",
      "}"
    ].join('\n')
  );
  sources = scanRasterSources(dir, dir);
  assert.equal(sources.length, 1, 'the replacement should still yield exactly one raster source (1 to 1)');
  const problems = exceptionProblems(sources, exceptions);
  assert.ok(
    problems.some((p) => p.startsWith('exempt-file.ts#NEW_ID:')),
    `expected a problem naming the new, unmatched identity, got ${JSON.stringify(problems)}`
  );
  assert.ok(
    problems.some((p) => p.startsWith('exempt-file.ts#OLD_ID:')),
    `expected a problem naming the now-stale old exception row, got ${JSON.stringify(problems)}`
  );
  assert.equal(problems.length, 2, `expected exactly the two problems above, got ${JSON.stringify(problems)}`);

  // Once the exception is updated to name the new identity, the check clears.
  exceptions.delete('exempt-file.ts#OLD_ID');
  exceptions.set(
    'exempt-file.ts#NEW_ID',
    'a synthetic exception with a real reason, long enough to pass the length check'
  );
  assert.deepEqual(exceptionProblems(sources, exceptions), []);
});

/**
 * Finding (this task): two `addSource` calls that share one literal identity
 * text inside the same exempt file collapse to a single `${file}#${identity}`
 * key. `exceptionProblems`'s `found` set is built with `sources.map(...)`
 * fed into a `Set`, so the duplicate key de-duplicates there; more directly,
 * its per-source loop checks `exceptions.has(identityKey)` for each entry
 * independently, and an identical identityKey text means an exception that
 * disposes the first also, silently, disposes the second. A second raster
 * source in an already-exempt file is only caught when it carries an
 * identity the scan has not already seen once. This case is filed `todo`
 * (Node's `{ todo: true }` runs it and reports a failure without failing the
 * suite, node --test todo-probe): it names the gap without turning a lane
 * this brief does not own (`exceptionProblems`, `scanRasterSources`) red for
 * everyone. Fixing the collapse is a handoff, not a new self-test case.
 */
test(
  'C9 self-test: two addSource calls sharing one literal identity in an exempt file collapse to one key and the second is silently exempted',
  { todo: true },
  (t) => {
    const dir = withFixtureDir(t, {
      'exempt-file.ts': [
        "export function activate(map) {",
        "  map.addSource(SOURCE_ID, { type: 'raster', tiles: ['https://example.test/first/{z}/{x}/{y}.png'] });",
        "}",
        "export function activateAlternate(map) {",
        "  map.addSource(SOURCE_ID, { type: 'raster', tiles: ['https://example.test/second/{z}/{x}/{y}.png'] });",
        "}"
      ].join('\n')
    });
    const sources = scanRasterSources(dir, dir);
    assert.equal(sources.length, 2, 'the fixture should yield two raster-source declarations');
    const exceptions = new Map([
      ['exempt-file.ts#SOURCE_ID', 'a synthetic exception with a real reason, long enough to pass the length check']
    ]);
    const problems = exceptionProblems(sources, exceptions);
    // The desired behaviour: a second, distinct raster addition under a
    // reused identity text should still surface as its own problem, not
    // vanish because the first occurrence's exception matched the same key.
    assert.ok(
      problems.length > 0,
      'two distinct raster sources sharing one identity text should not both clear silently under one exception'
    );
  }
);

test('C9 self-test: a raster source in a .tsx file is discovered by the scanner', (t) => {
  const dir = withFixtureDir(t, {
    'exempt-file.tsx': [
      "export function activate(map) {",
      "  map.addSource(TSX_ID, { type: 'raster', tiles: ['https://example.test/{z}/{x}/{y}.png'] });",
      "}"
    ].join('\n')
  });
  const sources = scanRasterSources(dir, dir);
  assert.deepEqual(
    sources.map((s) => `${s.file}#${s.identity}`),
    ['exempt-file.tsx#TSX_ID']
  );
});

// ---------------------------------------------------------------------------
// Part 2: behaviour on a fake map
// ---------------------------------------------------------------------------

class FakeMap {
  constructor() {
    this.sources = new Map();
    this.layers = new Map();
    this.listeners = new Map();
    this.loadedSources = new Set();
  }
  getSource(id) {
    return this.sources.get(id);
  }
  addSource(id, spec) {
    if (this.sources.has(id)) throw new Error(`There is already a source with ID "${id}".`);
    this.sources.set(id, spec);
  }
  removeSource(id) {
    this.sources.delete(id);
    this.loadedSources.delete(id);
  }
  getLayer(id) {
    return this.layers.get(id);
  }
  addLayer(spec) {
    this.layers.set(spec.id, spec);
  }
  removeLayer(id) {
    this.layers.delete(id);
  }
  getStyle() {
    return { layers: [...this.layers.values()] };
  }
  setLayoutProperty() {}
  setPaintProperty() {}
  getBounds() {
    // A Pacific view that includes the Nino 3.4 box, so no toast is raised.
    return { getWest: () => -200, getEast: () => -80, getSouth: () => -30, getNorth: () => 50 };
  }
  isSourceLoaded(id) {
    return this.loadedSources.has(id);
  }
  on(event, handler) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return this;
  }
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
  emit(event, payload = {}) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload);
  }
  listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  /** MapLibre's per-tile `dataloading`, re-fired as `sourcedataloading`. */
  requestTile(sourceId, key) {
    this.emit('sourcedataloading', { sourceId, dataType: 'source', tile: { tileID: { key } } });
  }
  /** A tile that loaded; `settled` marks the source's last visible tile. */
  loadTile(sourceId, key, settled = false) {
    if (settled) this.loadedSources.add(sourceId);
    this.emit('sourcedata', {
      sourceId,
      dataType: 'source',
      tile: { tileID: { key } },
      isSourceLoaded: settled
    });
  }
  idle() {
    this.emit('idle', {});
  }
  /** A tile leaving the view with no data (errored or pending): MapLibre's `dataabort`. */
  abortTile(sourceId, key) {
    this.emit('sourcedataabort', { sourceId, dataType: 'source', tile: { tileID: { key } } });
  }
  /** A camera change (a pan, a zoom, a resize): MapLibre's `move`. */
  move() {
    this.emit('move', {});
  }
}

const HILLSHADE_ARCHIVE = join(ROOT, 'public/data/hillshade-dem-pnw.pmtiles');

/** The committed archive's own 127-byte header, answered as a ranged read. */
function hillshadeHeaderResponse() {
  const fd = openSync(HILLSHADE_ARCHIVE, 'r');
  const head = Buffer.alloc(127);
  try {
    readSync(fd, head, 0, 127, 0);
  } finally {
    closeSync(fd);
  }
  return new Response(new Uint8Array(head), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-126/${statSync(HILLSHADE_ARCHIVE).size}` }
  });
}

const DOMAINS_XML =
  "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
  '<ows:Identifier>time</ows:Identifier>' +
  '<Domain>2026-09-20/2026-09-24/P1D</Domain>' +
  '<Size>1</Size></DimensionDomain></Domains>';

/** Fail-closed fetch: the three layers' own reads answer; anything else throws. */
function installFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('REQUEST=DescribeDomains')) {
      return new Response(DOMAINS_XML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    if (url.endsWith('/info.json')) {
      return new Response(JSON.stringify({ date: '2026-09-24', tilezmax: '6' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.endsWith('hillshade-dem-pnw.pmtiles')) return hillshadeHeaderResponse();
    throw new Error(`unexpected egress from a node test: ${url}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

const { registry } = await import('../src/state/registry.ts');

/** Every status the key is given from now on, in order. */
function recordStatus(key) {
  const seen = [];
  const off = registry.on('status-change', (k, status) => {
    if (k === key) seen.push(status);
  });
  return { seen, off };
}

/** Let awaited fetch and stream work finish (microtasks and I/O callbacks). */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * One case per layer, with the module, a fake map, the recorder, and the
 * fetch stub, torn down in order whatever the case does.
 */
async function withLayer(key, modulePath, body, { timers } = {}) {
  const mod = await import(modulePath);
  const map = new FakeMap();
  const fetchStub = installFetch();
  registry.deactivate(key);
  const status = recordStatus(key);
  // What the layer controller does before every activation
  // (src/state/layer-controller.ts, activateWithIndicator).
  registry.setStatus(key, 'loading');
  try {
    await body({ mod, map, status, fetchStub, timers });
  } finally {
    mod.deactivate(map);
    registry.deactivate(key);
    status.off();
    fetchStub.restore();
    globalThis.__rasterReadinessTest.prefetch = false;
  }
}

/**
 * The deadline the behaviour cases tick past. The contract case above fails
 * loudly when the shared export is missing; here a missing export must not
 * abort the file before those cases can report their own readings, so the
 * 10 s precedent (usfs-whp, heatrisk) stands in.
 */
const deadlineMs = (() => {
  try {
    return sharedProofDeadlineMs();
  } catch {
    return 10_000;
  }
})();

// -- the shared first-tile wait ----------------------------------------------

test('an unproven wait never reports ready: the shared wait returns unproven at its deadline with no tile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { waitForRasterTileProof } = await import('../src/util/raster-proof.ts');
  const map = new FakeMap();
  const wait = waitForRasterTileProof(map, 'frame-a', new AbortController().signal, 6_000);
  map.requestTile('frame-a', 'a1');
  map.loadTile('other-source', 'x1', true); // another source's evidence is not this one's
  t.mock.timers.tick(6_000);
  assert.equal(await wait, 'unproven');
  assert.equal(map.listenerCount(), 0, 'the wait left a listener behind');
});

test('an unproven wait never reports ready: a source that settles with every tile failed is unproven', async () => {
  const { waitForRasterTileProof } = await import('../src/util/raster-proof.ts');
  const map = new FakeMap();
  const wait = waitForRasterTileProof(map, 'frame-a', new AbortController().signal, 60_000);
  map.requestTile('frame-a', 'a1');
  // MapLibre counts an errored tile as loaded: the source settles, no tile succeeded.
  map.loadedSources.add('frame-a');
  map.emit('sourcedata', { sourceId: 'frame-a', dataType: 'source', isSourceLoaded: true });
  assert.equal(await wait, 'unproven');
  assert.equal(map.listenerCount(), 0);
});

test('the shared wait is proven by a successful tile once the source settles, and a cancel leaves nothing pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { waitForRasterTileProof } = await import('../src/util/raster-proof.ts');
  const map = new FakeMap();
  const proven = waitForRasterTileProof(map, 'frame-a', new AbortController().signal, 60_000);
  map.requestTile('frame-a', 'a1');
  map.loadTile('frame-a', 'a1', true);
  assert.equal(await proven, 'proven');

  const controller = new AbortController();
  const cancelled = waitForRasterTileProof(map, 'frame-b', controller.signal, 60_000);
  controller.abort();
  assert.equal(await cancelled, 'unproven');
  assert.equal(map.listenerCount(), 0, 'a cancelled wait left a listener behind');
  map.loadTile('frame-b', 'b1', true); // a late tile after the cancel changes nothing
});

// -- gridded-index (row C3) -------------------------------------------------

const GRIDDED = '../src/layers/gridded-index.ts';

test('gridded-index stays loading until its first selected-frame tile succeeds, then reads live', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map }) => {
    await mod.activate(map);
    assert.equal(registry.getStatus('gridded-index'), 'loading');
    map.requestTile('gridded-index', 't1');
    assert.equal(registry.getStatus('gridded-index'), 'loading');
    map.loadTile('gridded-index', 't1', true);
    assert.equal(registry.getStatus('gridded-index'), 'ready');
  });
});

test('gridded-index reads live (partial) when a stated subset of its tiles fails', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map }) => {
    await mod.activate(map);
    // A view straddling the CONUS edge: NIDIS answers 404 outside its box
    // (probed 2026-09-26), so the outside tile never loads.
    map.requestTile('gridded-index', 'inside');
    map.requestTile('gridded-index', 'outside');
    map.loadTile('gridded-index', 'inside');
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
  });
});

/*
 * The order cases below follow MapLibre 6.6's own 404 path
 * (node_modules/maplibre-gl/src/tile/tile_manager.ts): a tile that answers
 * 404 is marked errored and fires NO event (`_loadTile`); MapLibre then
 * requests its parent as a fallback (`_updateRetainedTiles`), but skips that
 * parent while a sibling of the failed tile is still loading, so the
 * fallback request can come a frame AFTER the source settled and the watcher
 * closed the view's cycle. An errored tile stays on the map silently until
 * it leaves the view, which fires `sourcedataabort`; a loaded tile leaves
 * silently (it is cached). The browser case (tests/raster-status.spec.ts,
 * odd x columns 404) passed or failed on exactly this order.
 */

test('gridded-index reads live (partial) when tile failures arrive after a success in the same cycle', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    for (const key of ['inside', 'outside-a', 'outside-b']) map.requestTile('gridded-index', key);
    // outside-a answers 404; its parent is requested at once and also answers
    // 404; the grandparent is requested and loads.
    map.requestTile('gridded-index', 'outside-a-parent');
    map.requestTile('gridded-index', 'shared-grandparent');
    map.loadTile('gridded-index', 'shared-grandparent');
    // outside-b answers 404; its parent waits behind its loading sibling.
    // The sibling loads and settles the source: the view's cycle closes.
    map.loadTile('gridded-index', 'inside', true);
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
    // The next frame: outside-b's fallback parent is requested and answers
    // 404. Its own parent (the shared grandparent) already renders, so
    // MapLibre requests nothing more, and the map goes idle.
    map.requestTile('gridded-index', 'outside-b-parent');
    map.idle();
    assert.equal(
      registry.getStatus('gridded-index'),
      'degraded',
      `a failure after the settling success read ${status.seen.join(' -> ')}`
    );
  });
});

test('gridded-index reads live (partial) when tile failures arrive before the successes that settle the view', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 'inside');
    map.requestTile('gridded-index', 'outside');
    // outside answers 404 first; its parent waits behind its loading sibling,
    // which then loads and settles the source.
    map.loadTile('gridded-index', 'inside', true);
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
    // The next frame: the fallback parent is requested and loads. The failed
    // tile is still on the map (no `sourcedataabort` came for it).
    map.requestTile('gridded-index', 'outside-parent');
    map.loadTile('gridded-index', 'outside-parent', true);
    assert.equal(
      registry.getStatus('gridded-index'),
      'degraded',
      `the fallback cycle spoke for the view: read ${status.seen.join(' -> ')}`
    );
  });
});

test('gridded-index keeps a failed tile that stays in view in its verdict across a camera move', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 'inside');
    map.requestTile('gridded-index', 'outside');
    map.loadTile('gridded-index', 'inside', true); // outside answered 404
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
    // A small pan (or a resize) brings one new tile in; the failed tile stays.
    map.move();
    map.requestTile('gridded-index', 'east');
    map.loadTile('gridded-index', 'east', true);
    assert.equal(
      registry.getStatus('gridded-index'),
      'degraded',
      `a hole still on the map was forgotten: read ${status.seen.join(' -> ')}`
    );
  });
});

test('gridded-index reads unavailable after a pan from a partial view to one wholly off coverage (DR-050 a)', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 'inside');
    map.requestTile('gridded-index', 'outside');
    map.loadTile('gridded-index', 'inside', true); // outside answered 404
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
    // The pan: the new view's tiles are requested, then the old ones leave
    // (the errored one with `sourcedataabort`, the loaded one silently).
    map.move();
    map.requestTile('gridded-index', 'alaska-1');
    map.requestTile('gridded-index', 'alaska-2');
    map.abortTile('gridded-index', 'outside');
    map.idle(); // both Alaska tiles answered 404
    assert.equal(
      registry.getStatus('gridded-index'),
      'error',
      `a tile that left the view spoke for the new one: read ${status.seen.join(' -> ')}`
    );
  });
});

test('gridded-index reads unavailable off coverage, never live (DR-050 a)', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 'alaska-1');
    map.requestTile('gridded-index', 'alaska-2');
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'error');
    assert.ok(!status.seen.includes('ready'), `read ${status.seen.join(' -> ')}`);
  });
  await withLayer('gridded-index', GRIDDED, async ({ mod, map }) => {
    await mod.activate(map);
    map.idle(); // an empty cycle: no tile evidence at all
    assert.equal(registry.getStatus('gridded-index'), 'error');
  });
});

test('gridded-index is not downgraded below live (partial) when a later cycle\'s deadline fires after a rendered frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 't1');
    map.loadTile('gridded-index', 't1', true);
    assert.equal(registry.getStatus('gridded-index'), 'ready');
    map.requestTile('gridded-index', 't2'); // a pan opens a new cycle that never finishes
    t.mock.timers.tick(deadlineMs);
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
    assert.ok(!status.seen.includes('error'), `read ${status.seen.join(' -> ')}`);
  });
});

/**
 * Re-activate a proven layer with no deactivate between, the way the layer
 * controller does (loading first). The source is left as it was and its
 * tiles are cached, so MapLibre emits no tile event for it afterward.
 */
async function reactivateOverUntouchedSource(mod, map, key, sourceId) {
  const source = map.getSource(sourceId);
  assert.ok(source, `${sourceId} is not on the map before the re-activation`);
  registry.setStatus(key, 'loading');
  await mod.activate(map);
  assert.equal(map.getSource(sourceId), source, `the re-activation rebuilt ${sourceId}`);
}

test("gridded-index re-activated over a rendered, untouched source keeps its verdict and is never downgraded by the new cycle's deadline alone", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 't1');
    map.loadTile('gridded-index', 't1', true);
    assert.equal(registry.getStatus('gridded-index'), 'ready');
    const mark = status.seen.length;
    await reactivateOverUntouchedSource(mod, map, 'gridded-index', 'gridded-index');
    t.mock.timers.tick(deadlineMs);
    assert.equal(registry.getStatus('gridded-index'), 'ready', `read ${status.seen.slice(mark).join(' -> ')}`);
    map.idle(); // an idle with no tile event is not a fresh empty cycle either
    assert.equal(registry.getStatus('gridded-index'), 'ready', `read ${status.seen.slice(mark).join(' -> ')}`);
    const after = status.seen.slice(mark);
    assert.ok(!after.includes('error') && !after.includes('degraded'), `read ${after.join(' -> ')}`);
  });
});

test('gridded-index and sst-anomaly re-activated over a rebuilt source prove it afresh: an earlier verdict never speaks for it', async () => {
  for (const [key, modulePath, sourceId, layerId] of [
    ['gridded-index', GRIDDED, 'gridded-index', 'gridded-index-raster'],
    ['sst-anomaly', '../src/layers/sst-anomaly.ts', 'sst-anomaly', 'sst-anomaly']
  ]) {
    await withLayer(key, modulePath, async ({ mod, map }) => {
      await mod.activate(map);
      map.requestTile(sourceId, 'a1');
      map.loadTile(sourceId, 'a1', true);
      assert.equal(registry.getStatus(key), 'ready');
      // Something outside the module (a style swap) dropped the source.
      map.removeLayer(layerId);
      map.removeSource(sourceId);
      registry.setStatus(key, 'loading');
      await mod.activate(map);
      assert.ok(map.getSource(sourceId), `${key} did not re-add its source`);
      assert.equal(registry.getStatus(key), 'loading', `${key}: the old verdict spoke for a new source`);
      map.requestTile(sourceId, 'b1');
      map.loadTile(sourceId, 'b1', true);
      assert.equal(registry.getStatus(key), 'ready');
    });
  }
});

/**
 * The smallest legend DOM gridded-index's section renders into, so a case can
 * change the product selector the way a user does (the change handler is the
 * only route to the product swap). Returns the selector and a restore.
 */
function installLegendDom() {
  const doc = globalThis.document;
  const saved = {
    getElementById: doc.getElementById,
    createElement: doc.createElement,
    history: globalThis.history
  };
  const handlers = [];
  const select = {
    value: '',
    innerHTML: '',
    addEventListener(type, handler) {
      if (type === 'change') handlers.push(handler);
    }
  };
  const container = {
    children: [],
    querySelector: () => null,
    appendChild() {},
    insertBefore() {}
  };
  const panel = { hidden: true };
  doc.getElementById = (id) =>
    id === 'legend-sections' ? container : id === 'legend-panel' ? panel : null;
  doc.createElement = () => ({
    className: '',
    dataset: {},
    innerHTML: '',
    querySelector: (sel) => (sel === '#gridded-index-product' ? select : null),
    remove() {}
  });
  globalThis.history = {
    state: null,
    replaceState(_state, _title, url) {
      globalThis.location = new URL(url, globalThis.location.href);
    }
  };
  return {
    choose(slug) {
      select.value = slug;
      for (const handler of [...handlers]) handler();
    },
    restore() {
      doc.getElementById = saved.getElementById;
      doc.createElement = saved.createElement;
      globalThis.history = saved.history;
    }
  };
}

test("gridded-index reads loading after a product swap until the new product's first tile succeeds", async () => {
  const legend = installLegendDom();
  try {
    await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
      await mod.activate(map);
      map.requestTile('gridded-index', 't1');
      map.loadTile('gridded-index', 't1', true);
      assert.equal(registry.getStatus('gridded-index'), 'ready');
      const before = map.getSource('gridded-index');
      const mark = status.seen.length;
      legend.choose('ce-ACIS_NRCC_NN-spi-30d');
      await settle(); // the new product's info.json read answers
      assert.notEqual(map.getSource('gridded-index'), before, 'the swap did not rebuild the source');
      assert.equal(
        registry.getStatus('gridded-index'),
        'loading',
        `the old product's verdict spoke for the new one: read ${status.seen.slice(mark).join(' -> ')}`
      );
      map.requestTile('gridded-index', 'n1');
      assert.equal(registry.getStatus('gridded-index'), 'loading');
      map.loadTile('gridded-index', 'n1', true);
      assert.equal(registry.getStatus('gridded-index'), 'ready');
      // Back to the default window, so no later case inherits this one's product.
      legend.choose('ce-ACIS_NRCC_NN-spi-90d');
      await settle();
      assert.equal(registry.getStatus('gridded-index'), 'loading');
    });
  } finally {
    legend.restore();
    globalThis.location = new URL('https://ddm.test/?view=console');
  }
});

test('gridded-index leaves no listener or timer behind after deactivate, and a late tile writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('gridded-index', 't1');
    mod.deactivate(map);
    assert.equal(map.listenerCount(), 0);
    const before = status.seen.length;
    map.loadTile('gridded-index', 't1', true);
    t.mock.timers.tick(deadlineMs * 2);
    assert.equal(status.seen.length, before, `wrote ${status.seen.slice(before).join(', ')} after deactivate`);
  });
});

// -- the current view (review finding C1, DDM-P14-T04) -----------------------
//
// The verdict covers the tiles on the map NOW, not the requests a cycle saw.
// MapLibre 6.6 (node_modules/maplibre-gl/src/tile/tile_manager.ts) restores a
// tile from its out-of-view cache with no event at all (`_addTile`), caches a
// loaded tile that leaves the view with no event (`_removeTile`), fires
// nothing for a 404 (`_loadTile`), and fires `dataabort` only when a tile
// without data leaves. `trackView` models that tile manager on the fake map
// (`map.style.tileManagers`, the internal the watcher reads behind a guard);
// the cases above run without it and pin the request-set fallback. A camera
// change follows MapLibre's order: `move` and `moveend` fire first, the next
// frame updates the tile manager (requests, removals, cache restores), and
// only then does `render` fire.

function trackView(map, sourceId) {
  const tiles = new Map();
  const tile = (state) => ({
    state,
    hasData() {
      return this.state === 'loaded';
    }
  });
  map.style = {
    tileManagers: {
      [sourceId]: { getIds: () => [...tiles.keys()], getTileByID: (id) => tiles.get(id) }
    }
  };
  return {
    /** A tile the view needs and the cache lacks: fetched, with `dataloading`. */
    request(key) {
      tiles.set(key, tile('loading'));
      map.requestTile(sourceId, key);
    },
    /** It loaded (`data`); `settled` marks the source's last pending tile. */
    load(key, settled = false) {
      tiles.get(key).state = 'loaded';
      map.loadTile(sourceId, key, settled);
    },
    /** It answered 404: errored in place, with no event. */
    fail(key) {
      tiles.get(key).state = 'errored';
    },
    /** It left the view: a loaded tile goes to the cache silently; any other aborts. */
    leave(key) {
      const left = tiles.get(key);
      tiles.delete(key);
      if (left.state !== 'loaded') map.abortTile(sourceId, key);
    },
    /** A cached tile came back into view: no event at all. */
    restore(key) {
      tiles.set(key, tile('loaded'));
    },
    /** The camera changed: `move` then `moveend`, before the manager updates. */
    move() {
      map.move();
      map.emit('moveend', {});
    },
    /** The next frame, after the manager updated for the new camera. */
    frame() {
      map.emit('render', {});
    }
  };
}

test('current view S1: a return to a covered view restored from the tile cache reads live again after an off-coverage failure', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    const view = trackView(map, 'gridded-index');
    await mod.activate(map);
    view.request('a');
    view.load('a', true);
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'ready');
    // A pan wholly off coverage: the new tile and its fallback parent answer
    // 404, and the loaded tile leaves silently into the cache.
    view.move();
    view.request('b');
    view.leave('a');
    view.frame();
    view.fail('b');
    view.request('b-parent');
    view.fail('b-parent');
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'error', 'off coverage reads unavailable (DR-050 a)');
    // The pan back: `a` comes back from the cache with no event, the failed
    // tiles leave with `sourcedataabort`, and nothing is requested.
    view.move();
    view.restore('a');
    view.leave('b');
    view.leave('b-parent');
    view.frame(); // a map that never idles (the 3D scene) reads the view here
    assert.equal(
      registry.getStatus('gridded-index'),
      'ready',
      `the first frame over the cached view read ${status.seen.join(' -> ')}`
    );
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'ready', `the cached view read ${status.seen.join(' -> ')}`);
    const mark = status.seen.length;
    map.idle();
    view.move();
    view.frame();
    assert.equal(status.seen.length, mark, `an unchanged view reported again: ${status.seen.slice(mark).join(', ')}`);
  });
});

test('current view S1 at idle: a layer shown again over cached covered tiles, with no camera move, reads live again when the map idles', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    const view = trackView(map, 'gridded-index');
    await mod.activate(map);
    view.request('a');
    view.load('a', true);
    map.idle();
    view.move(); // off coverage: the new tile answers 404, `a` goes to the cache
    view.request('b');
    view.leave('a');
    view.frame();
    view.fail('b');
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'error', 'off coverage reads unavailable (DR-050 a)');
    // Hidden: MapLibre drops every tile of an unused source; the verdict stays.
    view.leave('b');
    view.move(); // back over the covered view while hidden
    view.frame();
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'error', `a hidden view spoke: read ${status.seen.join(' -> ')}`);
    // Shown again: `a` comes back from the cache with no event and no move.
    view.restore('a');
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'ready', `the cached view read ${status.seen.join(' -> ')}`);
  });
});

test('current view S2: a success that left the view during an active cycle never makes a destination whose own tiles all failed read live (partial)', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    const view = trackView(map, 'gridded-index');
    await mod.activate(map);
    view.request('a1');
    view.request('a2');
    view.load('a1'); // a2 is still pending, so the cycle stays open
    // A pan mid-cycle: a1 leaves silently into the cache, a2 aborts, and every
    // destination tile (and its fallback parent) answers 404.
    const mark = status.seen.length;
    view.move();
    view.request('b1');
    view.request('b2');
    view.leave('a1');
    view.leave('a2');
    view.frame();
    assert.equal(
      status.seen.length,
      mark,
      `a frame read tiles still loading as a verdict: ${status.seen.slice(mark).join(', ')}`
    );
    view.fail('b1');
    view.fail('b2');
    view.request('b-parent');
    view.fail('b-parent');
    map.idle();
    assert.equal(
      registry.getStatus('gridded-index'),
      'error',
      `a tile that left the view spoke for the destination: read ${status.seen.join(' -> ')}`
    );
    assert.ok(!status.seen.includes('degraded'), `read ${status.seen.join(' -> ')}`);
  });
});

test('current view S3: a small pan after a partial view keeps the success still in view, so a failing new tile reads live (partial), not unavailable', async () => {
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    const view = trackView(map, 'gridded-index');
    await mod.activate(map);
    view.request('inside');
    view.request('outside');
    view.fail('outside');
    view.load('inside', true);
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'degraded');
    const mark = status.seen.length;
    // A small pan: one new tile comes in and answers 404; both old tiles stay.
    view.move();
    view.request('east');
    view.frame();
    view.fail('east');
    map.idle();
    assert.equal(
      registry.getStatus('gridded-index'),
      'degraded',
      `the success still in view was forgotten: read ${status.seen.slice(mark).join(' -> ')}`
    );
    assert.ok(!status.seen.slice(mark).includes('error'), `read ${status.seen.slice(mark).join(' -> ')}`);
  });
});

test('current view F: a frame proven from cached tiles alone keeps the found-042 floor, and a finished view may still read unavailable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    const view = trackView(map, 'gridded-index');
    // The source's tile is already on the map when the watch attaches, so no
    // tile event ever proves it; only the view does.
    view.restore('a');
    await mod.activate(map);
    map.idle();
    const provenFromCache = registry.getStatus('gridded-index');
    // A pan to a view whose one tile never answers before the deadline (a map
    // that never idles, so no finished cycle intervenes).
    view.move();
    view.request('b');
    view.leave('a');
    view.frame();
    const mark = status.seen.length;
    t.mock.timers.tick(deadlineMs);
    assert.equal(
      registry.getStatus('gridded-index'),
      'degraded',
      `the deadline alone read ${status.seen.slice(mark).join(' -> ')} after a rendered frame (found-042)`
    );
    assert.ok(!status.seen.slice(mark).includes('error'), `read ${status.seen.slice(mark).join(' -> ')}`);
    assert.equal(provenFromCache, 'ready', 'the cached frame was not proven at idle');
    // The view finishes with its one tile failed: evidence may cross the floor.
    view.fail('b');
    map.idle();
    assert.equal(registry.getStatus('gridded-index'), 'error', `read ${status.seen.join(' -> ')}`);
  });
});

test('current view F settled: on a map that never idles, a deadline over a view whose every tile has errored reads unavailable, since settled evidence crosses the found-042 floor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('gridded-index', GRIDDED, async ({ mod, map, status }) => {
    const view = trackView(map, 'gridded-index');
    await mod.activate(map);
    view.request('a');
    view.load('a', true);
    assert.equal(registry.getStatus('gridded-index'), 'ready', `the proven frame read ${status.seen.join(' -> ')}`);
    // A pan wholly off coverage on a map that never idles: the new tile and its
    // fallback parent answer 404 (errored in place, no event, and no idle
    // follows in the browser: tests/raster-current-view.spec.ts step B1), and
    // the loaded tile leaves silently into the cache. Only the deadline reads
    // the view, and every tile in it has settled.
    view.move();
    view.request('b');
    view.leave('a');
    view.frame();
    view.fail('b');
    view.request('b-parent');
    view.fail('b-parent');
    const mark = status.seen.length;
    t.mock.timers.tick(deadlineMs);
    assert.equal(
      registry.getStatus('gridded-index'),
      'error',
      `a settled all-errored view read ${status.seen.slice(mark).join(' -> ')} at the deadline (DR-050 a)`
    );
  });
});

test('current view guard: a settled source whose view empties (its layer hidden) keeps its verdict, silently', async () => {
  for (const [key, modulePath] of [
    ['gridded-index', GRIDDED],
    ['sst-anomaly', '../src/layers/sst-anomaly.ts']
  ]) {
    await withLayer(key, modulePath, async ({ mod, map, status }) => {
      const view = trackView(map, key);
      await mod.activate(map);
      view.request('inside');
      view.request('outside');
      view.fail('outside');
      view.load('inside', true);
      map.idle();
      assert.equal(registry.getStatus(key), 'degraded');
      const mark = status.seen.length;
      const warnings = [];
      const warn = console.warn;
      console.warn = (...args) => warnings.push(args);
      try {
        map.idle(); // an unchanged partial view neither reports nor warns again
        // Hidden: MapLibre drops every tile of an unused source.
        view.leave('inside');
        view.leave('outside');
        map.idle();
        view.move();
        view.frame();
        map.idle();
        assert.equal(registry.getStatus(key), 'degraded');
        assert.equal(status.seen.length, mark, `${key} reported ${status.seen.slice(mark).join(', ')}`);
        assert.equal(warnings.length, 0, `${key} warned ${warnings.length} time(s)`);
      } finally {
        console.warn = warn;
      }
    });
  }
});

test('current view guard: a watch without a deadline (the Fire 3D terrain path) reports nothing from the view, and detaches whole', async () => {
  // The no-deadline watch is raster-error-watch.ts's alone (DR-142).
  const { watchRasterTiles } = await import('../src/util/raster-error-watch.ts');
  const map = new FakeMap();
  const view = trackView(map, 'terrain');
  view.request('t1');
  view.fail('t1'); // a failed tile already on the map when the watch attaches
  const reports = [];
  const watch = watchRasterTiles(map, 'terrain', (state) => reports.push(state));
  map.idle();
  view.move();
  view.frame();
  map.idle();
  assert.deepEqual(reports, [], 'the legacy watch read a verdict off the view');
  watch.detach();
  assert.equal(map.listenerCount(), 0, 'a map listener outlived detach');
});

// -- the no-deadline error watch (DR-142: the Fire 3D activation closure) ----
//
// fire3d.ts's terrain watch passes no completeness deadline, so all it needs
// is the rolling-window degrade and the heal on a loaded tile. That policy
// lives alone in src/util/raster-error-watch.ts, and raster-status.ts has no
// no-deadline mode and does not import it, so the policy is written once,
// the Fire 3D activation closure (scripts/check-activation-budget.mjs, the
// fire3d-mode row) carries none of the completeness mode, and no
// raster-status closure (the heatrisk-days row among them) carries the error
// watch. A statement-level `import type` is erased at build and does not
// count as reaching a module.

const RASTER_STATUS = 'src/util/raster-status.ts';
const ERROR_WATCH = 'src/util/raster-error-watch.ts';

/** The root-relative source file a relative specifier in `file` names, or null for a package. */
function resolveSourceSpecifier(file, specifier, root) {
  if (!specifier.startsWith('.')) return null;
  const base = join(root, file, '..', specifier);
  const candidates = /\.tsx?$/.test(specifier) ? [base] : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return posix(relative(root, candidates.find((c) => existsSync(c)) ?? candidates[0]));
}

/**
 * Every source file `file` reaches as a VALUE: `import`/`export ... from`, a
 * bare `import '...'`, and a dynamic `import('...')`. A statement-level
 * `import type`/`export type` is erased and skipped, and so is a
 * `typeof import('...')` type query; an inline `{ type X }` is not skipped,
 * because the statement itself survives.
 */
function valueImportsOf(file, root = ROOT) {
  const text = stripComments(readFileSync(join(root, file), 'utf8'));
  const specifiers = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?[\w$*{},\s]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (!m[1]) specifiers.push(m[2]);
  }
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
  for (const m of text.matchAll(/(?<!\btypeof\s+)\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
  return specifiers.map((s) => resolveSourceSpecifier(file, s, root)).filter((s) => s !== null);
}

/** Every problem with `entry` reaching `target` as a value, following `start`'s value imports transitively. */
function valueReachProblems(entry, start, target, root = ROOT) {
  const problems = [];
  const direct = valueImportsOf(entry, root);
  if (direct.includes(target)) problems.push(`${entry} imports ${target} as a value`);
  if (!direct.includes(start)) problems.push(`${entry} does not take its watch from ${start}`);
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!existsSync(join(root, file))) {
      problems.push(`${file} does not exist`);
      continue;
    }
    for (const dep of valueImportsOf(file, root)) {
      if (dep === target) problems.push(`${file} imports ${target} as a value`);
      else if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return problems;
}

test("fire3d's no-deadline watch reaches no raster-status value code", () => {
  assert.deepEqual(valueReachProblems('src/map/fire3d.ts', ERROR_WATCH, RASTER_STATUS), []);
});

test('value-import self-test: a type-only import is allowed, and every value route to the target is named', (t) => {
  const dir = withFixtureDir(t, {
    'util/target.ts': 'export const X = 1;\n',
    'util/guard.ts': 'export const G = 2;\n',
    'util/watch.ts': "import type { T } from './target';\nimport { G } from './guard';\nexport const W = G;\n",
    'map/clean.ts':
      "import { W } from '../util/watch';\nimport type { T } from '../util/target';\n" +
      "let m: typeof import('../util/target') | null = null;\n",
    'map/direct.ts': "import { W } from '../util/watch';\nimport { X } from '../util/target';\n",
    'map/inline.ts': "import { W } from '../util/watch';\nimport { type T } from '../util/target';\n",
    'map/dynamic.ts': "import { W } from '../util/watch';\nconst lazy = () => import('../util/target');\n",
    'map/elsewhere.ts': "import { G } from '../util/guard';\n"
  });
  const reach = (entry) => valueReachProblems(entry, 'util/watch.ts', 'util/target.ts', dir);
  assert.deepEqual(reach('map/clean.ts'), []);
  assert.deepEqual(reach('map/direct.ts'), ['map/direct.ts imports util/target.ts as a value']);
  assert.deepEqual(reach('map/inline.ts'), ['map/inline.ts imports util/target.ts as a value']);
  assert.deepEqual(reach('map/dynamic.ts'), ['map/dynamic.ts imports util/target.ts as a value']);
  assert.deepEqual(reach('map/elsewhere.ts'), ['map/elsewhere.ts does not take its watch from util/watch.ts']);
  // A value route through the watch module itself is found transitively.
  const leaky = withFixtureDir(t, {
    'util/target.ts': 'export const X = 1;\n',
    'util/bridge.ts': "export { X } from './target';\n",
    'util/watch.ts': "import { X } from './bridge';\nexport const W = X;\n",
    'map/entry.ts': "import { W } from '../util/watch';\n"
  });
  assert.deepEqual(valueReachProblems('map/entry.ts', 'util/watch.ts', 'util/target.ts', leaky), [
    'util/bridge.ts imports util/target.ts as a value'
  ]);
});

/** A module-private constant of the error watch, read where it is declared. */
function errorWatchConstant(name) {
  const text = readFileSync(join(ROOT, ERROR_WATCH), 'utf8');
  const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(text);
  assert.ok(match, `${ERROR_WATCH} no longer declares ${name}`);
  return Number(match[1].replace(/_/g, ''));
}

/** A MapLibre tile error for `sourceId` (the id rides the event's data). */
function tileError(sourceId) {
  return { sourceId, error: new Error('synthetic tile failure') };
}

/** The events the fake map has a live listener for, sorted. */
function listenedEvents(map) {
  return [...map.listeners]
    .filter(([, handlers]) => handlers.size > 0)
    .map(([event]) => event)
    .sort();
}

/** Capture console.warn for the case, as the text a console would print. */
function captureWarn(t) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  t.after(() => {
    console.warn = warn;
  });
  return warnings;
}

const REPEATED_FAILURES = (sourceId) =>
  `[${sourceId}] repeated tile-load failures; reporting unavailable. Error: synthetic tile failure`;

test('the no-deadline error watch degrades once, after ERROR_THRESHOLD tile errors of its own source inside WINDOW_MS', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { watchRasterTiles } = await import('../src/util/raster-error-watch.ts');
  const threshold = errorWatchConstant('ERROR_THRESHOLD');
  const windowMs = errorWatchConstant('WINDOW_MS');
  const warnings = captureWarn(t);
  const map = new FakeMap();
  const reports = [];
  watchRasterTiles(map, 'terrain', (state) => reports.push(state));
  for (let i = 0; i < threshold; i += 1) {
    map.emit('error', tileError('other-source')); // another source's failure is not this one's
    map.emit('error', { error: new Error('a map error with no source') });
  }
  assert.deepEqual(reports, [], 'errors of no source or another source counted');
  // Spread across the window, never reaching its end.
  for (let i = 1; i < threshold; i += 1) {
    map.emit('error', tileError('terrain'));
    t.mock.timers.tick(Math.floor((windowMs - 1) / threshold));
  }
  assert.deepEqual(reports, [], 'degraded below the threshold');
  map.emit('error', tileError('terrain'));
  assert.deepEqual(reports, ['error']);
  map.emit('error', tileError('terrain'));
  assert.deepEqual(reports, ['error'], 'a degraded watch reported again');
  assert.deepEqual(warnings, [REPEATED_FAILURES('terrain')]);
});

test('the no-deadline error watch does not degrade when its errors fall outside WINDOW_MS, or when a tile loads between them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { watchRasterTiles } = await import('../src/util/raster-error-watch.ts');
  const threshold = errorWatchConstant('ERROR_THRESHOLD');
  const windowMs = errorWatchConstant('WINDOW_MS');
  const warnings = captureWarn(t);
  const map = new FakeMap();
  const reports = [];
  const watch = watchRasterTiles(map, 'terrain', (state) => reports.push(state));
  // Each error a full window after the last: only one ever counts.
  for (let i = 0; i < threshold * 2; i += 1) {
    map.emit('error', tileError('terrain'));
    t.mock.timers.tick(windowMs);
  }
  assert.deepEqual(reports, [], 'errors outside the window degraded the watch');
  // One short of the threshold, a tile that loads, then one more.
  for (let i = 1; i < threshold; i += 1) map.emit('error', tileError('terrain'));
  map.loadTile('terrain', 't1');
  map.emit('error', tileError('terrain'));
  assert.deepEqual(reports, [], 'a loaded tile did not clear the window');
  // One short of the threshold, a reset, then one more.
  watch.reset();
  for (let i = 1; i < threshold; i += 1) map.emit('error', tileError('terrain'));
  assert.deepEqual(reports, [], 'reset did not forget the accumulated errors');
  // With nothing between them the same errors do degrade: the window and the
  // loaded tile were the reasons above, not a watch that never degrades.
  map.emit('error', tileError('terrain'));
  assert.deepEqual(reports, ['error']);
  assert.deepEqual(warnings, [REPEATED_FAILURES('terrain')]);
});

test('the no-deadline error watch heals on a loaded tile of its own source, and reportInitialSuccess reports the first tile once per reset', async (t) => {
  const { watchRasterTiles } = await import('../src/util/raster-error-watch.ts');
  const threshold = errorWatchConstant('ERROR_THRESHOLD');
  captureWarn(t);
  const map = new FakeMap();
  const reports = [];
  watchRasterTiles(map, 'terrain', (state) => reports.push(state));
  map.loadTile('terrain', 't0');
  assert.deepEqual(reports, [], 'a success before any failure reported by default');
  for (let i = 0; i < threshold; i += 1) map.emit('error', tileError('terrain'));
  assert.deepEqual(reports, ['error']);
  map.loadTile('other-source', 'x1');
  map.emit('sourcedata', { sourceId: 'terrain', dataType: 'metadata', tile: { tileID: { key: 'm' } } });
  map.emit('sourcedata', { sourceId: 'terrain', dataType: 'source', isSourceLoaded: true });
  assert.deepEqual(reports, ['error'], 'healed on something other than a loaded tile of its own source');
  map.loadTile('terrain', 't1');
  assert.deepEqual(reports, ['error', 'ready']);
  map.loadTile('terrain', 't2');
  assert.deepEqual(reports, ['error', 'ready'], 'a healed watch reported ready again');

  const initial = [];
  const watch = watchRasterTiles(map, 'frame', (state) => initial.push(state), { reportInitialSuccess: true });
  map.loadTile('frame', 'f1');
  map.loadTile('frame', 'f2');
  assert.deepEqual(initial, ['ready']);
  watch.reset();
  map.loadTile('frame', 'f3');
  assert.deepEqual(initial, ['ready', 'ready']);
});

test('the no-deadline error watch listens to error and sourcedata only, reads nothing off the view, and detach removes every listener', async (t) => {
  const { watchRasterTiles } = await import('../src/util/raster-error-watch.ts');
  const threshold = errorWatchConstant('ERROR_THRESHOLD');
  captureWarn(t);
  const map = new FakeMap();
  const view = trackView(map, 'terrain');
  view.request('t1');
  view.fail('t1'); // a failed tile already on the map when the watch attaches
  const reports = [];
  const watch = watchRasterTiles(map, 'terrain', (state) => reports.push(state));
  assert.deepEqual(listenedEvents(map), ['error', 'sourcedata']);
  map.idle();
  view.move();
  view.frame();
  map.idle();
  assert.deepEqual(reports, [], 'the error watch read a verdict off the view');
  watch.detach();
  assert.equal(map.listenerCount(), 0, 'a map listener outlived detach');
  for (let i = 0; i < threshold; i += 1) map.emit('error', tileError('terrain'));
  map.loadTile('terrain', 't2');
  assert.deepEqual(reports, [], 'a detached watch reported');
});

/**
 * Every problem with raster-status.ts keeping a no-deadline mode: a value
 * import of the error watch (whose chunk would then ride every raster-status
 * closure, heatrisk-days among them), more than one `watchRasterTiles`
 * signature, an optional or defaulted options parameter, or an options type
 * whose completeness deadline is optional.
 */
function noDeadlineModeProblems(file = RASTER_STATUS, root = ROOT) {
  const problems = [];
  if (valueImportsOf(file, root).includes(ERROR_WATCH)) problems.push(`${file} imports ${ERROR_WATCH} as a value`);
  const text = stripComments(readFileSync(join(root, file), 'utf8'));
  const signatures = callArguments(text, 'function\\s+watchRasterTiles');
  if (signatures.length !== 1) {
    problems.push(`${file} declares watchRasterTiles ${signatures.length} times; one signature, deadline required, is the whole API`);
  }
  for (const params of signatures.map(topLevelArgs)) {
    const options = params[3] ?? '';
    if (!/^[\w$]+\s*:/.test(options) || /=(?!>)/.test(options)) {
      problems.push(`${file}: watchRasterTiles's options parameter is optional or defaulted: "${options}"`);
    }
    const typeName = /^[\w$]+\s*\??\s*:\s*([\w$]+)/.exec(options)?.[1];
    const declaration = typeName ? new RegExp(`\\binterface\\s+${typeName}\\b[^{]*\\{`).exec(text) : null;
    const body = declaration ? enclosingObject(text, declaration.index + declaration[0].length)?.body ?? '' : '';
    if (!/\brequestCompletenessDeadlineMs\s*:\s*number\b/.test(body)) {
      problems.push(`${file}: watchRasterTiles's options type does not require requestCompletenessDeadlineMs: "${options}"`);
    }
  }
  return problems;
}

test('raster-status.ts has no no-deadline mode and no value import of raster-error-watch.ts', () => {
  assert.deepEqual(noDeadlineModeProblems(), []);
});

test('no-deadline self-test: the delegating shape is named in every part, and a deadline-only module with a type import passes', (t) => {
  const signature = (options) => `export function watchRasterTiles(map: M, id: string, report: (s: O) => void, ${options}): W`;
  const fixture = (lines) =>
    withFixtureDir(t, {
      [ERROR_WATCH]: 'export function watchRasterTiles() {}\n',
      [RASTER_STATUS]: lines.join('\n')
    });
  const clean = fixture([
    "import type { W } from './raster-error-watch';",
    'export interface Opts {',
    '  readonly requestCompletenessDeadlineMs: number;',
    '}',
    `${signature('options: Opts')} {`,
    '  return start(map, id, report, options.requestCompletenessDeadlineMs);',
    '}'
  ]);
  assert.deepEqual(noDeadlineModeProblems(RASTER_STATUS, clean), []);
  const delegating = fixture([
    "import { watchRasterTiles as errorWatch } from './raster-error-watch';",
    'export interface Opts {',
    '  readonly requestCompletenessDeadlineMs?: number;',
    '}',
    `${signature('options?: Opts')};`,
    `${signature('options: Opts = {}')} {`,
    '  return errorWatch(map, id, report);',
    '}'
  ]);
  assert.deepEqual(noDeadlineModeProblems(RASTER_STATUS, delegating), [
    `${RASTER_STATUS} imports ${ERROR_WATCH} as a value`,
    `${RASTER_STATUS} declares watchRasterTiles 2 times; one signature, deadline required, is the whole API`,
    `${RASTER_STATUS}: watchRasterTiles's options parameter is optional or defaulted: "options?: Opts"`,
    `${RASTER_STATUS}: watchRasterTiles's options type does not require requestCompletenessDeadlineMs: "options?: Opts"`,
    `${RASTER_STATUS}: watchRasterTiles's options parameter is optional or defaulted: "options: Opts = {}"`,
    `${RASTER_STATUS}: watchRasterTiles's options type does not require requestCompletenessDeadlineMs: "options: Opts = {}"`
  ]);
});

test('raster-status.ts reads no watcher-level no-data: an empty view reads by emptyIdleOutcome, ready or error', () => {
  const text = stripComments(readFileSync(join(ROOT, RASTER_STATUS), 'utf8'));
  assert.deepEqual(text.match(/['"`]no-data['"`]/g) ?? [], [], `${RASTER_STATUS} still carries a no-data outcome`);
});

// -- hillshade (row C2, a declared tile-proof exception) --------------------
//
// DDM-P14-T04 director's ruling: hillshade does not wait for tile proof
// (see the EXCEPTIONS entry above for the measured reason). These two cases
// are the exception's own guards: it still reports `ready` honestly on a
// successful source add, and it still cleans up its one map listener.

const HILLSHADE = '../src/layers/hillshade.ts';

test('hillshade reports ready on source add by declared exception (no tile proof)', async () => {
  await withLayer('hillshade', HILLSHADE, async ({ mod, map, status }) => {
    await mod.activate(map);
    await settle();
    assert.ok(map.getSource('hillshade-dem'), 'the probed archive was not added');
    assert.equal(registry.getStatus('hillshade'), 'ready', 'the exception reports ready without a tile');
    assert.ok(!status.seen.includes('no-data'), `read ${status.seen.join(' -> ')}: hillshade never proves or disproves a tile`);
  });
});

// First among the two on purpose: the listener used to be wired behind a
// module-level flag that was never reset, so only the process's FIRST
// activation attached it (and every later map got none at all).
test("hillshade's deactivate removes its map error listener", async () => {
  await withLayer('hillshade', HILLSHADE, async ({ mod, map }) => {
    await mod.activate(map);
    await settle();
    assert.ok(map.getSource('hillshade-dem'), 'the probed archive was not added');
    mod.deactivate(map);
    assert.equal(map.listeners.get('error')?.size ?? 0, 0, 'the error listener outlived deactivate');
    assert.equal(map.listenerCount(), 0, 'a map listener outlived deactivate');
  });
});

// -- sst-anomaly (row C1) ---------------------------------------------------

const SST = '../src/layers/sst-anomaly.ts';

/** The SST rail the layer installed: step it the way the time bar does. */
function stepSst(index) {
  const bar = timeBars.get('sst-anomaly');
  assert.ok(bar?.rail, 'sst-anomaly installed no time-bar rail');
  bar.rail.onStep(index);
}

test('sst-anomaly stays loading until its first selected-frame tile succeeds, then reads live', async () => {
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    assert.equal(registry.getStatus('sst-anomaly'), 'loading');
    assert.ok(!status.seen.includes('ready'), `read ${status.seen.join(' -> ')} before any tile`);
    map.requestTile('sst-anomaly', 'g1');
    map.loadTile('sst-anomaly', 'g1', true);
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');
  });
});

test("sst-anomaly's stepping path stays loading until the stepped frame's own tile succeeds", async () => {
  await withLayer('sst-anomaly', SST, async ({ mod, map }) => {
    await mod.activate(map);
    map.requestTile('sst-anomaly', 'g1');
    map.loadTile('sst-anomaly', 'g1', true);
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');

    stepSst(1); // 2026-09-21
    assert.equal(registry.getStatus('sst-anomaly'), 'loading');
    map.loadTile('sst-anomaly', 'g2', true); // the default frame's tile is not the stepped frame's
    assert.equal(registry.getStatus('sst-anomaly'), 'loading');
    map.requestTile('sst-frame-2026-09-21', 'f1');
    map.loadTile('sst-frame-2026-09-21', 'f1', true);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');
  });
});

test('sst-anomaly never reports ready for a stepped frame whose wait ends unproven', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    const mark = status.seen.length;
    stepSst(2); // 2026-09-22: its tiles are requested and never succeed
    map.requestTile('sst-frame-2026-09-22', 'f1');
    t.mock.timers.tick(6_000); // the loop's buffer timeout: the wait gives up unproven
    await settle();
    assert.ok(!status.seen.slice(mark).includes('ready'), `read ${status.seen.slice(mark).join(' -> ')}`);
    t.mock.timers.tick(deadlineMs);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'error');
    assert.ok(!status.seen.slice(mark).includes('ready'), `read ${status.seen.slice(mark).join(' -> ')}`);
  });
});

test('sst-anomaly reads live (partial) when a stated subset of its tiles fails', async () => {
  await withLayer('sst-anomaly', SST, async ({ mod, map }) => {
    await mod.activate(map);
    map.requestTile('sst-anomaly', 'g1');
    map.requestTile('sst-anomaly', 'g2');
    map.loadTile('sst-anomaly', 'g1');
    map.idle();
    assert.equal(registry.getStatus('sst-anomaly'), 'degraded');
  });
});

test('sst-anomaly reads live (partial) when a failed tile\'s fallback loads after the view settled', async () => {
  // The same shared watcher, in the same MapLibre order as the gridded case.
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('sst-anomaly', 'g1');
    map.requestTile('sst-anomaly', 'g2');
    map.loadTile('sst-anomaly', 'g1', true); // g2 answered 404
    assert.equal(registry.getStatus('sst-anomaly'), 'degraded');
    map.requestTile('sst-anomaly', 'g2-parent');
    map.loadTile('sst-anomaly', 'g2-parent', true);
    assert.equal(registry.getStatus('sst-anomaly'), 'degraded', `read ${status.seen.join(' -> ')}`);
  });
});

test('sst-anomaly reads unavailable for an empty cycle, never live (DR-050 a)', async () => {
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.idle();
    assert.equal(registry.getStatus('sst-anomaly'), 'error');
    assert.ok(!status.seen.includes('ready'), `read ${status.seen.join(' -> ')}`);
  });
});

test('sst-anomaly is not downgraded below live (partial) when a later cycle\'s deadline fires after a rendered frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('sst-anomaly', 'g1');
    map.loadTile('sst-anomaly', 'g1', true);
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');
    map.requestTile('sst-anomaly', 'g2');
    t.mock.timers.tick(deadlineMs);
    assert.equal(registry.getStatus('sst-anomaly'), 'degraded');
    assert.ok(!status.seen.includes('error'), `read ${status.seen.join(' -> ')}`);
  });
});

test("sst-anomaly re-activated over a rendered, untouched source keeps its verdict and is never downgraded by the new cycle's deadline alone", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    map.requestTile('sst-anomaly', 'g1');
    map.loadTile('sst-anomaly', 'g1', true);
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');
    const mark = status.seen.length;
    await reactivateOverUntouchedSource(mod, map, 'sst-anomaly', 'sst-anomaly');
    t.mock.timers.tick(deadlineMs);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'ready', `read ${status.seen.slice(mark).join(' -> ')}`);
    map.idle(); // an idle with no tile event is not a fresh empty cycle either
    assert.equal(registry.getStatus('sst-anomaly'), 'ready', `read ${status.seen.slice(mark).join(' -> ')}`);
    const after = status.seen.slice(mark);
    assert.ok(!after.includes('error') && !after.includes('degraded'), `read ${after.join(' -> ')}`);
  });
});

test('sst-anomaly re-activated while a dated frame is displayed keeps that frame\'s verdict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    stepSst(4); // the newest stop, 2026-09-24, as its own dated frame
    map.requestTile('sst-frame-2026-09-24', 'f1');
    map.loadTile('sst-frame-2026-09-24', 'f1', true);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');
    const mark = status.seen.length;
    await reactivateOverUntouchedSource(mod, map, 'sst-anomaly', 'sst-frame-2026-09-24');
    t.mock.timers.tick(deadlineMs);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'ready', `read ${status.seen.slice(mark).join(' -> ')}`);
  });
});

test('sst-anomaly proves each dated frame from its mount: a lookahead frame that loaded reads live when stepped to', async () => {
  globalThis.__rasterReadinessTest.prefetch = true;
  await withLayer('sst-anomaly', SST, async ({ mod, map }) => {
    await mod.activate(map);
    // activate pre-warms the previous day at opacity 0 (2026-09-23).
    assert.ok(map.getSource('sst-frame-2026-09-23'), 'no lookahead frame was mounted');
    map.requestTile('sst-frame-2026-09-23', 'w1');
    map.loadTile('sst-frame-2026-09-23', 'w1', true);
    assert.equal(registry.getStatus('sst-anomaly'), 'loading', 'a lookahead frame spoke for the surface');
    stepSst(3);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'ready');
  });
});

test('sst-anomaly leaves no listener or timer behind after deactivate, and a superseded frame never writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withLayer('sst-anomaly', SST, async ({ mod, map, status }) => {
    await mod.activate(map);
    stepSst(1);
    stepSst(2); // supersedes the step to 2026-09-21
    map.requestTile('sst-frame-2026-09-21', 'late');
    map.loadTile('sst-frame-2026-09-21', 'late', true);
    await settle();
    assert.equal(registry.getStatus('sst-anomaly'), 'loading', 'the superseded frame wrote the status');

    mod.deactivate(map);
    assert.equal(map.listenerCount(), 0, 'a map listener outlived deactivate');
    const before = status.seen.length;
    map.loadTile('sst-frame-2026-09-22', 'late', true);
    t.mock.timers.tick(deadlineMs * 2);
    await settle();
    assert.equal(status.seen.length, before, `wrote ${status.seen.slice(before).join(', ')} after deactivate`);
  });
});
