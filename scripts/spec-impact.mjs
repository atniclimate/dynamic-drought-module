#!/usr/bin/env node
/**
 * Which browser specs a block's commits touch, and which still name what the
 * block removed (owner, 2026-10-19: the 0.7.7 Validate run went red on specs
 * asserting on-screen text the block had deleted).
 *
 *   node scripts/spec-impact.mjs [--base <ref>]   stale mentions; exit 1 if any
 *   node scripts/spec-impact.mjs --list           touched spec paths, one line
 *   node scripts/spec-impact.mjs --run            one local run of the selection
 *   node scripts/spec-impact.mjs --red [run id]   one local run of a red run's failed cases
 *   node scripts/spec-impact.mjs --dispatch       a targeted GitHub run of them
 *
 * The range is <base>...HEAD; the default base is `git merge-base HEAD
 * origin/main`. Everything is read from commits, never the working tree:
 * commit first. `--run` and `--red` refuse uncommitted changes under the paths
 * the build reads, because the run builds the working tree.
 *
 * A stale mention is a string literal, attribute value, kebab-case token or
 * visible text on a line REMOVED under src/ or index.html, at least 4
 * characters, found nowhere in the code of src/ or index.html at HEAD
 * (comments do not count), that a spec file under tests/ (`.spec.ts`) at HEAD
 * still contains. Text the block moved or reworded, rather than deleted
 * everywhere, is not caught.
 *
 * The selection has two tiers (audit of 23 red runs, 2026-11-22):
 *   Tier 1, exact: the tests a changed spec's edits fall inside (`file:line`),
 *     or the whole file when an edit sits outside every test (a file-level
 *     helper, a hook, a shared constant).
 *   Tier 2, by rule: spec files with a stale mention, spec files importing a
 *     changed src/ module directly, spec files importing a test-helper name
 *     the change reaches, plus a few fixed specs when the range touches shared
 *     style or markup, a map-key, legend, dock or minimap component, or the
 *     test seam (CROSS_CUTTING), or one of the modules MODULE_SPECS maps by
 *     hand; each is printed with the rule that added it.
 * A test-helper change that reaches `gotoApp` (every boot) or most specs is
 * BROAD: GitHub's full run is its test, and no local list is made for it.
 * The measurement-only specs (playwright.config.ts MEASURE_SPECS) and
 * browser-free PURE_SPECS are left out of browser execution selection; the
 * chromium-3d specs (FIRE3D_SPECS) are never run locally. Stale-text
 * inspection still covers every spec.
 *
 * A local run is limited by its estimated wait, not a file count: one build
 * plus the GitHub seconds of the selected cases (tests/spec-timings.json,
 * rebuilt by scripts/refresh-spec-timings.mjs), doubled for this machine
 * (LOCAL_SLOWDOWN), at two workers, at most ten minutes.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_LENGTH = 4;
export const LOCAL_LIMIT_SECONDS = 600;
export const LOCAL_WORKERS = 2;
// The build before the cases: about 3 s of tsc and vite on GitHub, estimated
// under a minute locally (audit, 2026-11-22). Counted so a one-case run still
// reads as a minute of waiting, which it is.
export const BUILD_SECONDS = 60;
// A case here takes about twice its GitHub seconds: the first real check:push
// (2026-11-22) estimated 9.0 min of cases for 26 files at two workers and they
// ran 19.4 min on this laptop, the build included.
export const LOCAL_SLOWDOWN = 2;
// The median browser spec file when no timing is known (files.tsv, cef1d35).
export const DEFAULT_FILE_SECONDS = 23;
export const LOCAL_PROJECTS = ['chromium', 'chromium-interaction'];
export const BROWSER_PROJECTS = new Set([...LOCAL_PROJECTS, 'chromium-3d']);
// What the build and the browser run read. A tracked edit here that is not
// committed would be built and tested while the selection read only commits.
export const RUN_PATHS = ['src', 'tests', 'index.html', 'public', 'playwright.config.ts', 'playwright.pure.config.ts', 'vite.config.ts'];
export const BUSY_PORTS = [4173, 4180];
export const REPO = 'atniclimate/dynamic-drought-module';

const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const ATTRIBUTE = /[\w:-]+=(["'])(.*?)\1/g;
const TEXT_NODE = />([^<>{}]+)</g;
const COMMENT_OR_BLANK = /^\s*(?:$|\/\/|\/\*|\*)/;

const normalize = (text) => text.replace(/\r\n/g, '\n');

/** Every candidate string on one removed source line. */
export function lineLiterals(line) {
  const pieces = [];
  // Markup and template holes split a literal into its visible pieces; the
  // whole literal stays too, so attribute names inside its tags still tokenize.
  for (const [, , body] of line.matchAll(QUOTED)) pieces.push(body, ...body.split(/\$\{[^}]*\}|<[^>]*>/));
  for (const [, , value] of line.matchAll(ATTRIBUTE)) pieces.push(value);
  for (const [, text] of line.matchAll(TEXT_NODE)) pieces.push(text);
  const out = new Set();
  for (const piece of pieces) {
    const text = piece.trim();
    // A composed selector is judged by its tokens, which outlive any one query string.
    const selector = /^[#.[]/.test(text) || /\[[\w-]+[\]=]/.test(text);
    if (text.length >= MIN_LENGTH && !selector) out.add(text);
    // Class lists and selectors: `ddm-legend is-open` or `.ddm-legend > button`.
    for (const token of text.split(/[\s>+~,()[\]=:"']+/)) {
      const bare = token.replace(/^[.#]+/, '');
      if (bare.includes('-') && bare.length >= MIN_LENGTH) out.add(bare);
    }
  }
  return out;
}

/** Candidate strings from the removed lines of a unified diff, comments skipped. */
export function removedLiterals(diffText) {
  const out = new Set();
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('-')) {
      const code = line.slice(1).trim();
      if (/^(\/\/|\/\*|\*)/.test(code)) continue;
      for (const text of lineLiterals(code)) out.add(text);
    }
  }
  return [...out].sort();
}

/** Source text without its block, HTML, whole-line and trailing `//` comments. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The candidates found nowhere in the HEAD source code (a comment naming one does not keep it). */
export function staleLiterals(literals, headSource) {
  const code = stripComments(headSource);
  return literals.filter((text) => !code.includes(text));
}

const ABSENCE = /toHaveCount\(0\)|toBeHidden\(|\.not\.(?:toBeVisible|toBeAttached|toHaveText|toContain)/;
const INTENDED = 'spec-impact: intended';

/**
 * `{ file, line, text, absent }` for every non-comment spec line that still
 * names a stale string. `absent` marks a likely absence check (`toHaveCount(0)`,
 * `toBeHidden(`, or `.not.` before toBeVisible, toBeAttached, toHaveText or
 * toContain/toContainText, in the same statement, read to its `;` over at most
 * three lines), which is the right way to keep naming a removed thing, or a line
 * that says `spec-impact: intended` on itself or the line above.
 */
export function findMentions(stale, specs) {
  const mentions = [];
  for (const { path, text: source } of specs) {
    const hits = stale.filter((text) => source.includes(text));
    if (hits.length === 0) continue;
    const lines = source.split('\n');
    lines.forEach((content, index) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(content)) return;
      let end = index;
      while (end < index + 2 && end + 1 < lines.length && !lines[end].trimEnd().endsWith(';')) end += 1;
      const absent = ABSENCE.test(lines.slice(index, end + 1).join('\n'))
        || content.includes(INTENDED) || (lines[index - 1] ?? '').includes(INTENDED);
      for (const text of hits) if (content.includes(text)) mentions.push({ file: path, line: index + 1, text, absent });
    });
  }
  return mentions;
}

const stripExtension = (path) => path.replace(/\.(?:[cm]?[jt]sx?)$/, '');

/** Whether a spec imports (statically or dynamically) one of the changed src/ or tests/ helper files. */
export function importsChanged(specPath, specSource, changedModules) {
  const targets = new Set();
  for (const file of changedModules) {
    const bare = stripExtension(file);
    targets.add(bare);
    if (bare.endsWith('/index')) targets.add(bare.slice(0, -'/index'.length));
  }
  for (const [, specifier] of specSource.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    if (targets.has(stripExtension(posix.join(posix.dirname(specPath), specifier)))) return true;
  }
  return false;
}

// Browser specs enter through the built app, so shared CSS, markup and key or
// dock components reach their specs through no import. Chosen from the 0.7.7
// Validate run's reds (shell, dock, map key, minimap, responsive, tokens); not
// a dependency graph. Keep the union small: it joins every local estimate.
const SHELL_SPECS = ['tests/interface-responsive.spec.ts', 'tests/s4-shell.spec.ts'];
export const CROSS_CUTTING = [
  {
    rule: 'shared style or markup',
    match: (path) => path.startsWith('src/styles/') || path === 'index.html',
    specs: [...SHELL_SPECS, 'tests/telemetry-hover-tokens.spec.ts', 'tests/horizon-chips.spec.ts']
  },
  {
    rule: 'map key, legend or dock component',
    match: (path) => path.startsWith('src/') && (/map-key|legend|dock/i.test(path) || path === 'src/ui/island/shell.tsx'),
    specs: [...SHELL_SPECS, 'tests/flow-wire.spec.ts']
  },
  {
    rule: 'minimap component',
    match: (path) => path.startsWith('src/') && /minimap/i.test(path),
    specs: ['tests/s4-minimap.spec.ts']
  },
  {
    rule: 'shared test seam',
    match: (path) => ['tests/helpers.ts', 'tests/offline-test.ts', 'playwright.config.ts'].includes(path),
    specs: [...SHELL_SPECS, 'tests/flow-wire.spec.ts', 'tests/s4-minimap.spec.ts']
  }
];

// Modules whose specs reach them only through the built app, mapped by hand
// from those specs' selectors, chunk routes and source reads (2026-11-06:
// each picked no spec). Also not a dependency graph: a new spec for one of
// these modules is added here by hand. At most five per module.
export const MODULE_SPECS = {
  'src/main.ts': ['tests/boot.spec.ts', 'tests/boot-without-map.spec.ts', 'tests/boot-command-order.spec.ts', 'tests/identify-paths.spec.ts'],
  'src/map/interaction-coordinator.ts': ['tests/interaction-coordinator.spec.ts', 'tests/identify-paths.spec.ts', 'tests/popup-viewport.spec.ts', 'tests/surface-popups.spec.ts'],
  'src/layers/telemetry.ts': ['tests/telemetry.spec.ts', 'tests/telemetry-discovery.spec.ts', 'tests/telemetry-raws-gate.spec.ts', 'tests/identify-paths.spec.ts'],
  'src/ui/island/place-studio.tsx': ['tests/place-studio.spec.ts', 'tests/place-studio-brief.spec.ts', 'tests/place-studio-map.spec.ts', 'tests/place-studio-watersheds.spec.ts', 'tests/island-chunk-isolation.spec.ts'],
  'src/ui/sidebar.ts': ['tests/precedence.spec.ts', 'tests/u3i.spec.ts', 'tests/s4-shell.spec.ts', 'tests/activation-failure.spec.ts'],
  'src/ui/time-bar.ts': ['tests/temporal-axis.spec.ts', 'tests/fire-heat-time-bar.spec.ts', 'tests/raster-status.spec.ts', 'tests/usdm-time.spec.ts'],
  'src/ui/heatrisk-sequence.ts': ['tests/heat-h1-heatrisk.spec.ts', 'tests/map-drawers.spec.ts', 'tests/heat-h2-point-heat.spec.ts', 'tests/map-chrome-focus.spec.ts'],
  'src/ui/sheet-alerts.ts': ['tests/mobile-sheet.spec.ts', 'tests/heat-h0-integrity.spec.ts', 'tests/hazard-rail.spec.ts', 'tests/retry-doors.spec.ts'],
  'src/ui/popup-conditions.ts': ['tests/interaction-coordinator.spec.ts', 'tests/place-popups.spec.ts'],
  // 2026-11-13: both changed in one block and picked neither spec that then went red.
  'src/config/map-chrome.ts': ['tests/map-chrome-focus.spec.ts', 'tests/map-chrome-seats.spec.ts', 'tests/map-chrome-icons.spec.ts'],
  'src/layers/aiannh.ts': ['tests/trio-hardening.spec.ts'],
  // 2026-11-13: the phone rail's cells are generated here; only the rail spec reads them.
  'src/ui/hazard-rail.ts': ['tests/hazard-rail.spec.ts']
};
const MODULE_RULES = Object.entries(MODULE_SPECS).map(([module, specs]) => ({ rule: `specs of ${module}`, match: (path) => path === module, specs }));

/** `Map<spec path, rule names>` the changed paths fire, limited to specs that exist. */
export function crossCuttingSpecs(changedPaths, specPaths, rules = [...CROSS_CUTTING, ...MODULE_RULES]) {
  const picked = new Map();
  for (const { rule, match, specs } of rules) {
    if (!changedPaths.some(match)) continue;
    for (const spec of specs) if (specPaths.has(spec)) picked.set(spec, [...(picked.get(spec) ?? []), rule]);
  }
  return picked;
}

/** Sorted, unique browser spec paths; pure and measurement-only files stay out. */
export function touchedSpecs({ changedSpecs, mentions, specs, changedModules, measureOnly = new Set(), pureOnly = new Set(), crossCutting = new Map() }) {
  const out = new Set([...changedSpecs, ...crossCutting.keys()]);
  for (const { file } of mentions) out.add(file);
  for (const { path, text } of specs) if (importsChanged(path, text, changedModules)) out.add(path);
  return [...out].filter((path) => !measureOnly.has(path) && !pureOnly.has(path)).sort();
}

/** The spec paths a `const NAME = ['**\/name.spec.ts', ...]` list of playwright.config.ts names. */
function configGlobs(configText, name) {
  const list = configText.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))?.[1] ?? '';
  return new Set([...list.matchAll(/\*\*\/([\w.-]+\.spec\.ts)/g)].map(([, file]) => `tests/${file}`));
}

/** The spec paths playwright.config.ts's MEASURE_SPECS names (`'**\/name.spec.ts'`). */
export function measureSpecs(configText) {
  return configGlobs(configText, 'MEASURE_SPECS');
}

/** The chromium-3d project's spec paths (FIRE3D_SPECS): GitHub's by rule, never a local run. */
export function fire3dSpecs(configText) {
  const specs = configGlobs(configText, 'FIRE3D_SPECS');
  if (specs.size === 0) throw new Error('Cannot read FIRE3D_SPECS from playwright.config.ts');
  return specs;
}

/** The browser-free roster lives alongside the browser project's exclusions. */
export function pureSpecs(configText) {
  const list = configText.match(/const PURE_SPECS = \[([^\]]*)\]/)?.[1];
  if (!list) throw new Error('Cannot read PURE_SPECS from playwright.config.ts');
  return new Set([...list.matchAll(/['"](tests\/[\w.-]+\.spec\.ts)['"]/g)].map(([, path]) => path));
}

// ---- Case-level selection -------------------------------------------------------------------

/**
 * `Map<path, hunk[]>` from a `-U0` unified diff; a hunk is `{ start, count,
 * added: [{ line, text }], removed: [text] }` with new-side line numbers.
 */
export function diffHunks(diffText) {
  const out = new Map();
  let path = null;
  let hunk = null;
  let next = 0;
  for (const raw of normalize(diffText).split('\n')) {
    if (raw.startsWith('diff --git')) {
      path = null;
      hunk = null;
    } else if (!hunk && raw.startsWith('+++ ')) {
      // A deleted file has no new side to select from.
      path = raw === '+++ /dev/null' ? null : raw.slice('+++ b/'.length);
    } else if (raw.startsWith('@@')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!path || !match) continue;
      hunk = { start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]), added: [], removed: [] };
      next = hunk.start;
      out.set(path, [...(out.get(path) ?? []), hunk]);
    } else if (hunk && raw.startsWith('+')) {
      hunk.added.push({ line: next, text: raw.slice(1) });
      next += 1;
    } else if (hunk && raw.startsWith('-')) {
      hunk.removed.push(raw.slice(1));
    }
  }
  return out;
}

/** New-side lines whose code a file's hunks changed. A comment or a blank line changes no behaviour. */
export function changedCodeLines(hunks) {
  const lines = new Set();
  for (const { start, count, added, removed } of hunks) {
    const code = added.filter(({ text }) => !COMMENT_OR_BLANK.test(text));
    for (const { line } of code) lines.add(line);
    if (code.length === 0 && removed.some((text) => !COMMENT_OR_BLANK.test(text))) {
      // Removed code with nothing added sits between new lines `start` and
      // `start + 1`; both neighbours own it, so a removal at a boundary between
      // two tests reads as file-level, never as nothing.
      const anchors = count === 0 ? [start, start + 1] : Array.from({ length: count }, (_, i) => start + i);
      for (const line of anchors) lines.add(line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

// A loop may declare its test on its own line: `for (const x of xs) test(` or
// `] as const) test(`.
const TEST_CALL = /^(\s*)(?:(?:for\b|\]).*?\)\s*)?test(\.(?:only|skip|fixme|slow|fail))?\(\s*(?:(['"`])((?:\\.|(?!\3)[^\\])*)\3)?/;
const DESCRIBE_CALL = /^(\s*)test\.describe(?:\.(?:only|skip|fixme|serial|parallel))*\(\s*(?:(['"`])((?:\\.|(?!\2)[^\\])*)\2)?/;

/** Brackets a line leaves open, its strings and trailing comment ignored. */
function openBrackets(line) {
  const code = line.replace(QUOTED, '""').replace(/\/\/.*$/, '');
  return (code.match(/[([{]/g) ?? []).length - (code.match(/[)\]}]/g) ?? []).length;
}

/**
 * The last line of the call that opens on `index`. Formatted specs close a
 * call at its own indentation, which survives the regular expressions and
 * template strings a bracket counter would trip on. A line indented less
 * than the call ends it early, which only ever widens a selection.
 */
function closingLine(lines, index, indent) {
  if (openBrackets(lines[index]) <= 0) return index;
  for (let at = index + 1; at < lines.length; at += 1) {
    const trimmed = lines[at].trim();
    if (!trimmed) continue;
    const depth = lines[at].length - lines[at].trimStart().length;
    if (depth < indent) return at - 1;
    if (depth === indent) return /^[)}\]]/.test(trimmed) ? at : at - 1;
  }
  return lines.length - 1;
}

/**
 * Every test a spec declares: `{ line, end, title, describes }` with 1-based
 * lines, `title` the literal (a template keeps its `${...}` holes, a variable
 * title is null) and `describes` the enclosing describe titles, outermost
 * first. `test.skip(condition)` and `test.slow()` declare nothing.
 */
export function testSpans(text) {
  const lines = normalize(text).split('\n');
  const describes = [];
  const tests = [];
  lines.forEach((content, index) => {
    const block = DESCRIBE_CALL.exec(content);
    if (block) {
      describes.push({ line: index + 1, end: closingLine(lines, index, block[1].length) + 1, title: block[3] ?? null });
      return;
    }
    const call = TEST_CALL.exec(content);
    if (!call || (call[2] && call[3] === undefined)) return;
    const end = closingLine(lines, index, call[1].length) + 1;
    const chain = describes.filter((d) => d.line < index + 1 && d.end >= end).map((d) => d.title);
    tests.push({ line: index + 1, end, title: call[4] ?? null, describes: chain });
  });
  // Tests never nest: a test whose closing indent is off (one closes at two
  // spaces after opening at none) still ends before the next one begins.
  tests.forEach((span, i) => {
    if (tests[i + 1] && span.end >= tests[i + 1].line) span.end = tests[i + 1].line - 1;
  });
  return tests;
}

/**
 * The entries a changed spec contributes: `path:line` for each test its
 * changed lines fall inside, or `[path]` when any changed line sits outside
 * every test (an import, a file-level helper, a hook, a shared constant, a
 * describe header), because then any test of the file may be affected.
 */
export function caseSelection(path, text, lines) {
  if (lines.length === 0) return [];
  const spans = testSpans(text);
  const picked = new Set();
  for (const line of lines) {
    const span = spans.find(({ line: from, end }) => line >= from && line <= end);
    if (!span) return [path];
    picked.add(span.line);
  }
  return [...picked].sort((a, b) => a - b).map((line) => `${path}:${line}`);
}

/** `{ file, line }` of a `tests/x.spec.ts` or `tests/x.spec.ts:12` entry; `line` is null for a whole file. */
export function parseEntry(entry) {
  const match = /^(.*?)(?::(\d+))?$/.exec(entry);
  return { file: match[1], line: match[2] ? Number(match[2]) : null };
}

/** Sorted, unique entries; a whole file absorbs its own `file:line` entries. */
export function mergeEntries(entries) {
  const whole = new Set(entries.filter((entry) => parseEntry(entry).line === null));
  const kept = new Set(entries.filter((entry) => {
    const { file, line } = parseEntry(entry);
    return line === null || !whole.has(file);
  }));
  return [...kept].sort(byEntry);
}

/** File order, then line order within a file. */
function byEntry(a, b) {
  const x = parseEntry(a);
  const y = parseEntry(b);
  return x.file === y.file ? (x.line ?? 0) - (y.line ?? 0) : x.file < y.file ? -1 : 1;
}

// ---- Test-helper reach ----------------------------------------------------------------------

const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const IMPORT_FROM = /import\s+(?:type\s+)?([^'";]*?)\s+from\s+['"](\.[^'"]+)['"]/g;
const IMPORT_WHOLE = /import\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** Top-level declarations of a helper file, `{ name, line, end }`, each running to the next one. */
export function declarationSpans(text) {
  const lines = normalize(text).split('\n');
  const starts = [];
  lines.forEach((content, index) => {
    const match = DECLARATION.exec(content);
    if (match) starts.push({ name: match[1], line: index + 1 });
  });
  return starts.map((start, i) => ({ ...start, end: (starts[i + 1]?.line ?? lines.length + 1) - 1 }));
}

/** The 1-based lines that belong to import statements, which change no behaviour by themselves. */
function importLines(lines) {
  const out = new Set();
  let open = false;
  lines.forEach((content, index) => {
    if (!open && !/^import\b/.test(content)) return;
    out.add(index + 1);
    open = !/from\s+['"]|^import\s+['"]|;\s*$/.test(content);
  });
  return out;
}

/** `[local, imported]` pairs of one import clause; `*` stands for a whole module. */
function importClause(clause) {
  const names = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (!name) continue;
      const [imported, local = imported] = name.split(/\s+as\s+/).map((piece) => piece.trim());
      names.push([local, imported]);
    }
  }
  const star = /\*\s+as\s+([\w$]+)/.exec(clause);
  if (star) names.push([star[1], '*']);
  const first = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
  if (first && first[1] !== 'type') names.push([first[1], '*']);
  return names;
}

/** The helper file a relative specifier names, or null when it is not one. */
function resolveHelper(fromPath, specifier, known) {
  const base = posix.join(posix.dirname(fromPath), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, base.replace(/\.js$/, '.ts'), `${base}/index.ts`];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** `Map<local name, { from, name }>` of the helper names one file imports (`name` may be `*`). */
export function helperImports(path, text, known) {
  const out = new Map();
  for (const [, clause, specifier] of normalize(text).matchAll(IMPORT_FROM)) {
    const from = resolveHelper(path, specifier, known);
    if (from) for (const [local, name] of importClause(clause)) out.set(local, { from, name });
  }
  for (const [, specifier] of normalize(text).matchAll(IMPORT_WHOLE)) {
    const from = resolveHelper(path, specifier, known);
    if (from && ![...out.values()].some((entry) => entry.from === from)) out.set(`*${from}`, { from, name: '*' });
  }
  return out;
}

/** The nodes one import stands for: the named declaration, or every declaration of a whole-module import. */
const importedNodes = (nodesOf, { from, name }) => (name === '*' ? nodesOf(from) : [`${from}#${name}`]);

/**
 * A symbol graph over the test helpers (tests/ files that are neither specs
 * nor node tests). A node is `path#name` for a top-level declaration; it
 * points at every declaration its code names, in its own file or through an
 * import. Reading names, not calls, over-counts a little, and an over-count
 * only widens a selection. A name a helper re-exports from a package (the
 * `expect` of offline-test.ts) is no node, since no commit here changes it.
 */
export function helperGraph(helpers) {
  const known = new Set(helpers.map(({ path }) => path));
  const spans = new Map();
  const reverse = new Map();
  const nodesOf = (path) => (spans.get(path) ?? []).map(({ name }) => `${path}#${name}`);
  for (const { path, text } of helpers) spans.set(path, declarationSpans(text));
  for (const { path, text } of helpers) {
    const lines = normalize(text).split('\n');
    const own = new Set(spans.get(path).map(({ name }) => name));
    const imports = helperImports(path, text, known);
    for (const { name, line, end } of spans.get(path)) {
      const targets = new Set();
      // A doc comment names other helpers without calling them.
      for (const [token] of stripComments(lines.slice(line - 1, end).join('\n')).matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (own.has(token)) targets.add(`${path}#${token}`);
        if (imports.has(token)) for (const node of importedNodes(nodesOf, imports.get(token))) targets.add(node);
      }
      for (const target of targets) {
        if (!reverse.has(target)) reverse.set(target, new Set());
        reverse.get(target).add(`${path}#${name}`);
      }
    }
  }
  return { known, spans, reverse, nodesOf, texts: new Map(helpers.map(({ path, text }) => [path, text])) };
}

/** The nodes a helper file's changed lines fall in; code outside every declaration counts as all of them. */
export function changedNodes(graph, path, lines) {
  const spans = graph.spans.get(path) ?? [];
  const imports = importLines(normalize(graph.texts.get(path) ?? '').split('\n'));
  const out = new Set();
  for (const line of lines) {
    const span = spans.find(({ line: from, end }) => line >= from && line <= end);
    if (span) out.add(`${path}#${span.name}`);
    else if (!imports.has(line)) for (const node of graph.nodesOf(path)) out.add(node);
  }
  return out;
}

/** Every node that names one of `nodes`, directly or through others, `nodes` included. */
export function reachingNodes(graph, nodes) {
  const out = new Set(nodes);
  const queue = [...nodes];
  while (queue.length > 0) {
    for (const caller of graph.reverse.get(queue.pop()) ?? []) {
      if (!out.has(caller)) {
        out.add(caller);
        queue.push(caller);
      }
    }
  }
  return out;
}

/** The helper names a spec imports that `affected` holds, as `path#name` nodes. */
export function specHelperHits(graph, spec, affected) {
  const hits = new Set();
  for (const imported of helperImports(spec.path, spec.text, graph.known).values()) {
    for (const node of importedNodes(graph.nodesOf, imported)) if (affected.has(node)) hits.add(node);
  }
  return [...hits];
}

const nameList = (names) => (names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', '));

/**
 * What one changed helper file selects: `{ path, names, specs, broad }`.
 * `broad` is a reason when the change reaches `gotoApp` (every boot, the
 * default stubs included) or more than half the browser specs; then GitHub's
 * full run is the test and `specs` is not run locally (audit, 2026-11-22: 14
 * of 23 red runs changed helpers.ts in a way that reached `gotoApp`).
 */
export function helperChange(graph, path, lines, browserSpecs) {
  const changed = changedNodes(graph, path, lines);
  const names = [...changed].map((node) => node.split('#')[1]).sort();
  if (changed.size === 0) return { path, names, specs: [], broad: null };
  const affected = reachingNodes(graph, changed);
  const specs = browserSpecs.filter((spec) => specHelperHits(graph, spec, affected).length > 0).map(({ path: spec }) => spec).sort();
  const boot = [...affected].find((node) => node.endsWith('#gotoApp'));
  let broad = null;
  if (boot) broad = `${path} changes ${nameList(names)}, which ${boot.split('#')[0]}'s gotoApp reaches: every boot changes`;
  else if (specs.length * 2 > browserSpecs.length) broad = `${path} changes ${nameList(names)}, which ${specs.length} of ${browserSpecs.length} browser specs import`;
  return { path, names, specs, broad };
}

// ---- The whole selection --------------------------------------------------------------------

/**
 * Tier 1 and Tier 2 of a range, from HEAD's specs and helpers and the
 * range's changed paths and test-file hunks:
 * `{ tier1, tier2, broad, helperReasons, crossCutting, pureTouched, mentionEntries }`.
 * Tier entries are browser specs only; pure and measurement specs are out.
 */
export function selectSpecs({ specs, helpers, changed, hunks, mentions, measureOnly = new Set(), pureOnly = new Set() }) {
  const specPaths = new Set(specs.map(({ path }) => path));
  const textOf = new Map(specs.map(({ path, text }) => [path, text]));
  const browser = (path) => !measureOnly.has(path) && !pureOnly.has(path);
  const graph = helperGraph(helpers);
  const browserSpecs = specs.filter(({ path }) => browser(path));

  const changedSpecs = changed.filter((path) => specPaths.has(path));
  const caseEntries = changedSpecs.flatMap((path) => {
    const fileHunks = hunks.get(path);
    // A changed spec with no readable hunk (a rename, a mode change) is taken whole.
    return fileHunks ? caseSelection(path, textOf.get(path), changedCodeLines(fileHunks)) : [path];
  });

  const helperChanges = changed.filter((path) => graph.known.has(path)).map((path) => {
    const fileHunks = hunks.get(path);
    const lines = fileHunks ? changedCodeLines(fileHunks) : graph.spans.get(path).map(({ line }) => line);
    return helperChange(graph, path, lines, browserSpecs);
  });
  const broad = helperChanges.filter((change) => change.broad);
  const broadPaths = new Set(broad.map(({ path }) => path));
  const helperReasons = new Map();
  for (const { path, names, specs: picked, broad: isBroad } of helperChanges) {
    if (isBroad) continue;
    for (const spec of picked) helperReasons.set(spec, [...(helperReasons.get(spec) ?? []), `${path}: ${nameList(names)}`]);
  }

  const mentionEntries = mentions.flatMap(({ file, line }) => caseSelection(file, textOf.get(file) ?? '', [line]));
  const crossCutting = crossCuttingSpecs(changed.filter((path) => !broadPaths.has(path)), specPaths);
  // Helpers in the graph are judged by symbol; anything else (src/, a JSON
  // or YAML fixture) by direct import, as before.
  const changedModules = changed.filter((path) => !specPaths.has(path) && !graph.known.has(path));
  const byRule = touchedSpecs({ changedSpecs: [], mentions: [], specs, changedModules, measureOnly, pureOnly, crossCutting });
  const tier2 = mergeEntries([...byRule, ...helperReasons.keys(), ...mentionEntries].filter((entry) => browser(parseEntry(entry).file)));
  const tier1 = mergeEntries(caseEntries.filter((entry) => browser(parseEntry(entry).file)));
  const importers = specs.filter(({ path, text }) => importsChanged(path, text, changedModules)).map(({ path }) => path);
  const pureTouched = [...new Set([...changedSpecs, ...importers, ...mentions.map(({ file }) => file)])].filter((path) => pureOnly.has(path)).sort();
  return { tier1, tier2, broad, helperReasons, crossCutting, pureTouched };
}

/** The unique spec files of some entries, for a dispatch or a listing. */
export function entryFiles(entries) {
  return [...new Set(entries.map((entry) => parseEntry(entry).file))].sort();
}

// ---- Cost ------------------------------------------------------------------------------------

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The GitHub seconds one entry costs. A file missing from the timings counts
 * as the median file; a case missing (its line moved, or it is new) counts as
 * its file's median case, or the median file when the file is unknown too.
 */
export function costModel(timings) {
  const files = timings?.files ?? {};
  const cases = timings?.cases ?? {};
  const fileMedian = median(Object.values(files)) ?? DEFAULT_FILE_SECONDS;
  const perFile = new Map();
  for (const [key, seconds] of Object.entries(cases)) {
    const { file } = parseEntry(key);
    perFile.set(file, [...(perFile.get(file) ?? []), seconds]);
  }
  return (entry) => {
    const { file, line } = parseEntry(entry);
    if (line === null) return files[file] ?? fileMedian;
    return cases[entry] ?? median(perFile.get(file) ?? []) ?? fileMedian;
  };
}

/** Estimated seconds of waiting for one local run: the build, then the cases shared by the workers. */
export function estimateWait(entries, cost, workers = LOCAL_WORKERS) {
  if (entries.length === 0) return 0;
  return BUILD_SECONDS + (entries.reduce((sum, entry) => sum + cost(entry), 0) * LOCAL_SLOWDOWN) / workers;
}

export const minutes = (seconds) => `${(seconds / 60).toFixed(1)} min`;

/**
 * What runs locally: `{ run, seconds, threeD, over }`. Everything fits, or
 * Tier 1 alone (taken in order until the limit), and the rest is `over`.
 * chromium-3d files are always left out and named in `threeD`.
 */
export function planLocalRun({ tier1, tier2 = [], fire3d, cost, limit = LOCAL_LIMIT_SECONDS }) {
  const local = (entry) => !fire3d.has(parseEntry(entry).file);
  const everything = mergeEntries([...tier1, ...tier2]);
  const threeD = entryFiles(everything.filter((entry) => !local(entry)));
  const all = everything.filter(local);
  if (estimateWait(all, cost) <= limit) return { run: all, seconds: estimateWait(all, cost), threeD, over: [] };
  const run = [];
  for (const entry of mergeEntries(tier1).filter(local)) {
    if (estimateWait([...run, entry], cost) <= limit) run.push(entry);
  }
  const taken = new Set(run);
  return { run, seconds: estimateWait(run, cost), threeD, over: all.filter((entry) => !taken.has(entry)) };
}

/** Why `--run` or `--red` must not start, or null. */
export function runRefusal(entries, seconds = 0, limit = LOCAL_LIMIT_SECONDS) {
  if (entries.length === 0) {
    return 'No touched spec files. An empty list would run the whole suite, which is GitHub\'s job, not a local one.';
  }
  if (seconds > limit) {
    return `${entries.length} entries, an estimated ${minutes(seconds)} at ${LOCAL_WORKERS} workers (limit ${minutes(limit)}): too broad for a local run; use the targeted GitHub run.`;
  }
  return null;
}

/** Why the selection must not run on this working tree, or null (`git status --porcelain` rows). */
export function dirtyRefusal(porcelain) {
  const paths = porcelain.split('\n').map((row) => row.trimEnd()).filter(Boolean).map((row) => row.slice(3));
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 8).join(', ') + (paths.length > 8 ? `, and ${paths.length - 8} more` : '');
  return `Uncommitted changes the build would read: ${shown}. The selection reads commits and the run builds the working tree, so they would test different code. Commit first.`;
}

/**
 * Why `--dispatch` must not start, or null. An empty `specs` would start the
 * full run under the plain title. An open pull request's own Validate run
 * already tests the pushed tip, and a dispatch would be a second, uncancelled
 * run of the same candidate (audit, 2026-11-22).
 */
export function dispatchRefusal(specs, branch, head, pushed, openPull = null) {
  if (specs.length === 0) return 'No touched spec files. An empty list would dispatch the full run, not a targeted one.';
  if (branch === 'HEAD') return 'HEAD is detached: check out the branch to dispatch it.';
  if (!branch) return 'No work branch on origin contains HEAD: push the block to one first.';
  if (openPull) return `Pull request #${openPull.number} is open on ${branch}: its own Validate run covers the push, so a dispatch would only duplicate it.`;
  if (head !== pushed) return `HEAD is not the pushed tip of ${branch}: push first, so the run tests these commits.`;
  return null;
}

// ---- Run logs: timings and red cases --------------------------------------------------------

// One line of the `list` reporter as `gh run view --log` prints it: job, step,
// timestamp, then the mark, the case number, the project and the location.
const CASE_LINE = /^([^\t]+)\t[^\t]*\t\S+\s+([✓✘-])\s+\d+ \[([\w-]+)\] › tests[/\\]([\w.-]+\.spec\.ts):(\d+):\d+ › (.*?)( \(retry #\d+\))?(?: \(([\d.]+)(ms|s|m)\))?\s*$/u;
const UNIT_MS = { ms: 1, s: 1000, m: 60000 };

/** Every case line of a Validate run log: `{ job, project, file, line, title, status, retry, ms }`. */
export function parseCaseLog(text) {
  const cases = [];
  for (const raw of normalize(text).split('\n')) {
    const match = CASE_LINE.exec(raw);
    if (!match) continue;
    const [, job, mark, project, file, line, title, retry, duration, unit] = match;
    cases.push({
      job: job.replace(/^Browser suite \/ /, ''),
      project,
      file: `tests/${file}`,
      line: Number(line),
      title,
      status: { '✓': 'pass', '✘': 'fail', '-': 'skip' }[mark],
      retry: Boolean(retry),
      ms: duration ? Number(duration) * UNIT_MS[unit] : 0
    });
  }
  return cases;
}

/**
 * The timings file from a run's cases: first attempts of browser cases only,
 * seconds to one decimal, keyed by file and by `file:line` (a line that
 * declares a loop of tests sums them, since a `file:line` filter runs them all).
 */
export function buildTimings(cases, source = {}) {
  const files = {};
  const tests = {};
  for (const { project, file, line, status, retry, ms } of cases) {
    if (retry || status === 'skip' || !BROWSER_PROJECTS.has(project)) continue;
    files[file] = (files[file] ?? 0) + ms;
    tests[`${file}:${line}`] = (tests[`${file}:${line}`] ?? 0) + ms;
  }
  const seconds = (table) => Object.fromEntries(Object.keys(table).sort(byEntry).map((key) => [key, Math.round(table[key] / 100) / 10]));
  return { ...source, unit: 'GitHub seconds, one worker, first attempt', files: seconds(files), cases: seconds(tests) };
}

/** The cases whose every attempt failed: `{ project, file, line, title }`, one per case. */
export function failedCases(cases) {
  const attempts = new Map();
  for (const entry of cases) {
    if (entry.status === 'skip') continue;
    const key = `${entry.project}\t${entry.file}\t${entry.title}`;
    const seen = attempts.get(key) ?? { project: entry.project, file: entry.file, line: entry.line, title: entry.title, passed: false };
    if (entry.status === 'pass') seen.passed = true;
    attempts.set(key, seen);
  }
  return [...attempts.values()].filter(({ passed }) => !passed).map(({ passed, ...rest }) => rest);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const titlePattern = (title) => new RegExp(`^${title.split(/\$\{[^}]*\}/).map(escapeRegExp).join('.+?')}$`);

/** The test of one spec a reported title names, or null. Lines move, titles mostly do not. */
function findTest(spans, title, line) {
  const last = title.split(' › ').at(-1);
  const full = spans.filter((span) => span.title !== null && [...span.describes, span.title].join(' › ') === title);
  if (full.length === 1) return full[0];
  const exact = spans.filter((span) => span.title === last);
  if (exact.length === 1) return exact[0];
  const patterned = spans.filter((span) => span.title !== null && span.title.includes('${') && titlePattern(span.title).test(last));
  if (patterned.length === 1) return patterned[0];
  return [...full, ...exact, ...patterned].find((span) => span.line === line) ?? null;
}

/**
 * The current `file:line` of each failed case, matched by file and title:
 * `{ entries, moved, unmatched }`. A test moved to another spec file (the
 * page-free tests that went to `*-logic.spec.ts`) is found by its exact title
 * when that title is unique across the specs. As a last resort a test still
 * declared at the reported line is taken, flagged in `unmatched` if not.
 */
export function matchRedCases(failed, specs) {
  const spansOf = new Map();
  const spans = (path) => {
    if (!spansOf.has(path)) spansOf.set(path, testSpans(specs.find((spec) => spec.path === path)?.text ?? ''));
    return spansOf.get(path);
  };
  const entries = new Set();
  const moved = [];
  const unmatched = [];
  for (const failure of failed) {
    const own = findTest(spans(failure.file), failure.title, failure.line);
    if (own) {
      entries.add(`${failure.file}:${own.line}`);
      continue;
    }
    const last = failure.title.split(' › ').at(-1);
    const elsewhere = specs.flatMap(({ path }) => spans(path).filter((span) => span.title === last).map((span) => `${path}:${span.line}`));
    if (elsewhere.length === 1) {
      entries.add(elsewhere[0]);
      moved.push({ ...failure, now: elsewhere[0] });
    } else {
      unmatched.push(failure);
    }
  }
  return { entries: mergeEntries([...entries]), moved, unmatched };
}

/** The Validate run `--red` re-runs: the newest failed one in `runs` (newest first), or null. */
export function newestFailedRun(runs) {
  return runs.find((run) => run.conclusion === 'failure') ?? null;
}

/**
 * The branch this checkout pushes to. A work branch checked out is itself;
 * on `main` (the one line of work) it is the newest origin `work/*` branch
 * whose tip HEAD contains. `remotes` is newest first, `{ name }` without the
 * `origin/` prefix; `contains(name)` asks git.
 */
export function chooseWorkBranch(current, remotes, contains) {
  if (current && current !== 'HEAD' && current !== 'main') return current;
  return remotes.find(({ name }) => name.startsWith('work/') && contains(name))?.name ?? null;
}

// ---- Git and gh, kept thin ------------------------------------------------------------------

export function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function gh(args) {
  return execFileSync('gh', [...args, '-R', REPO], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Every blob under the given paths at HEAD, as `{ path, text }`, in one cat-file process. */
export function headFiles(paths) {
  const entries = git(['ls-tree', '-r', 'HEAD', '--', ...paths])
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [meta, path] = row.split('\t');
      const [, type, sha] = meta.split(' ');
      return { type, sha, path };
    })
    .filter(({ type }) => type === 'blob');
  const raw = execFileSync('git', ['cat-file', '--batch'], {
    input: entries.map((entry) => entry.sha).join('\n') + '\n',
    maxBuffer: 256 * 1024 * 1024
  });
  let at = 0;
  return entries.map(({ path }) => {
    const newline = raw.indexOf(10, at);
    const size = Number(raw.toString('utf8', at, newline).split(' ')[2]);
    const text = raw.toString('utf8', newline + 1, newline + 1 + size);
    at = newline + 1 + size + 1;
    return { path, text };
  });
}

export function isListening(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (listening) => {
      socket.destroy();
      done(listening);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** The held verification port, or null. */
export async function busyPort() {
  for (const port of BUSY_PORTS) if (await isListening(port)) return port;
  return null;
}

export function readTimings(url = new URL('../tests/spec-timings.json', import.meta.url)) {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
}

/** The dirty-tree refusal for this checkout, or null. */
export function workingTreeRefusal() {
  return dirtyRefusal(git(['status', '--porcelain', '--untracked-files=no', '--', ...RUN_PATHS]));
}

/** The work branch HEAD pushes to (see chooseWorkBranch), or null. */
export function workBranch() {
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const remotes = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin/work/'])
    .split('\n').filter(Boolean).map((ref) => ({ name: ref.replace(/^origin\//, '') }));
  const contains = (name) => spawnSync('git', ['merge-base', '--is-ancestor', `origin/${name}`, 'HEAD']).status === 0;
  return chooseWorkBranch(current, remotes, contains);
}

/** The open pull request on a branch, `{ number, url }`, or null. Throws when gh cannot answer. */
export function openPullRequest(branch) {
  if (!branch) return null;
  const rows = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']));
  return rows[0] ?? null;
}

/** Validate runs on a branch, newest first, `{ databaseId, conclusion, status, headSha }`. */
export function validateRuns(branch) {
  return JSON.parse(gh(['run', 'list', '--workflow', 'validate.yml', '--branch', branch, '--limit', '20', '--json', 'databaseId,conclusion,status,headSha,createdAt']));
}

/** A red run's failed cases matched to HEAD, `{ run, entries, moved, unmatched, failed }`. */
export function redSelection(runId, specs) {
  const failed = failedCases(parseCaseLog(gh(['run', 'view', String(runId), '--log-failed'])));
  return { run: runId, failed, ...matchRedCases(failed, specs) };
}

/** Everything the modes need about a range, read from commits. */
export function gather(base) {
  const range = `${base}...HEAD`;
  const head = headFiles(['src', 'index.html', 'tests']).map(({ path, text }) => ({ path, text: normalize(text) }));
  const headSource = head.filter(({ path }) => !path.startsWith('tests/')).map(({ text }) => text).join('\n');
  const specs = head.filter(({ path }) => path.startsWith('tests/') && path.endsWith('.spec.ts'));
  const helpers = head.filter(({ path }) => path.startsWith('tests/') && /\.(?:ts|tsx|mjs|js)$/.test(path) && !path.endsWith('.spec.ts') && !path.endsWith('.test.mjs'));

  const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', range, '--', 'src', 'index.html']);
  const mentions = findMentions(staleLiterals(removedLiterals(diff), headSource), specs);
  const changed = git(['diff', '--name-only', range, '--', 'src', 'tests', 'index.html', 'playwright.config.ts']).split('\n').filter(Boolean);
  const hunks = diffHunks(git(['diff', '-U0', '--no-color', '--no-ext-diff', range, '--', 'tests']));
  const config = git(['show', 'HEAD:playwright.config.ts']);
  const measureOnly = measureSpecs(config);
  const pureOnly = pureSpecs(config);
  const fire3d = fire3dSpecs(config);
  const selection = selectSpecs({ specs, helpers, changed, hunks, mentions, measureOnly, pureOnly });
  return { range, specs, mentions, measureOnly, pureOnly, fire3d, ...selection };
}

/** The lines that explain a selection, for any mode. */
export function describeSelection({ tier1, tier2, broad, helperReasons, crossCutting, pureTouched }, plan) {
  const out = [];
  if (pureTouched.length > 0) out.push(`Browser-free specs stay in the pure lane: npm run verify:pure -- ${pureTouched.join(' ')}`);
  for (const { broad: reason } of broad) out.push(`BROAD: ${reason}. GitHub's full Validate run is the test for that part; nothing runs locally for it.`);
  const rules = [...crossCutting].map(([path, names]) => `${path}  (${names.join('; ')})`);
  if (rules.length > 0) out.push(`Added by cross-cutting rules (not a dependency graph):\n  ${rules.join('\n  ')}`);
  const helped = [...helperReasons].map(([path, names]) => `${path}  (${names.join('; ')})`);
  if (helped.length > 0) out.push(`Added by changed test-helper names they import:\n  ${helped.join('\n  ')}`);
  out.push(`Tier 1, the tests the range edited (${tier1.length}): ${tier1.join(' ') || 'none'}`);
  out.push(`Tier 2, by rule (${tier2.length}): ${tier2.join(' ') || 'none'}`);
  if (plan) {
    if (plan.threeD.length > 0) out.push(`Left for GitHub, chromium-3d is never run locally: ${plan.threeD.join(' ')}`);
    if (plan.over.length > 0) out.push(`Over the ${minutes(LOCAL_LIMIT_SECONDS)} local limit, left for GitHub (${plan.over.length}): ${plan.over.join(' ')}`);
    out.push(`Local run: ${plan.run.length} entries, an estimated ${minutes(plan.seconds)} at ${LOCAL_WORKERS} workers.`);
  }
  return out;
}

/**
 * One local Playwright run of some entries, never chromium-3d. Returns the
 * exit status. `lastFailed` runs only the cases the previous run failed
 * (Playwright's own record in test-results), with no retry.
 */
export function runLocally(entries, { workers = LOCAL_WORKERS, lastFailed = false } = {}) {
  const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  const projects = LOCAL_PROJECTS.map((name) => `--project=${name}`);
  const only = lastFailed ? ['--last-failed', '--retries=0'] : [];
  console.log(lastFailed
    ? `Running the failed cases once more, ${workers === 1 ? 'alone (one worker)' : `at ${workers} workers`}.`
    : `Running ${entries.length} entries once: ${entries.join(' ')}`);
  return spawnSync(process.execPath, [cli, 'test', ...projects, `--workers=${workers}`, ...only, ...entries], { stdio: 'inherit' }).status ?? 1;
}

/** `--red [id]`: the red run to read, given or the newest failed one on the work branch. */
function redRunId(argv) {
  const value = argv[argv.indexOf('--red') + 1];
  if (value && /^\d+$/.test(value)) return value;
  const branch = workBranch();
  if (!branch) throw new Error('No work branch on origin contains HEAD: name the run, --red <run id>.');
  const run = newestFailedRun(validateRuns(branch));
  if (!run) throw new Error(`No failed Validate run on ${branch}.`);
  return String(run.databaseId);
}

async function main(argv) {
  const baseAt = argv.indexOf('--base');
  if (baseAt >= 0 && !argv[baseAt + 1]) throw new Error('--base needs a ref');
  const base = baseAt >= 0 ? argv[baseAt + 1] : git(['merge-base', 'HEAD', 'origin/main']).trim();
  const scripted = argv.some((arg) => ['--list', '--dispatch', '--run', '--red'].includes(arg));
  // Stderr in the scripted modes, so --list stays one line.
  const say = scripted ? console.error : console.log;

  if (argv.includes('--red')) {
    const refusal = workingTreeRefusal();
    if (refusal) {
      console.error(refusal);
      return 2;
    }
    const specs = headFiles(['tests']).filter(({ path }) => path.endsWith('.spec.ts')).map(({ path, text }) => ({ path, text: normalize(text) }));
    const config = git(['show', 'HEAD:playwright.config.ts']);
    const pureOnly = pureSpecs(config);
    const red = redSelection(redRunId(argv), specs);
    say(`Validate run ${red.run}: ${red.failed.length} failed cases.`);
    for (const { file, title, now } of red.moved) say(`  moved: ${file} "${title}" is now ${now}`);
    for (const { file, line, title } of red.unmatched) say(`  not found at HEAD (renamed or removed?): ${file}:${line} "${title}"`);
    const pure = red.entries.filter((entry) => pureOnly.has(parseEntry(entry).file));
    if (pure.length > 0) say(`Browser-free cases stay in the pure lane: npm run verify:pure -- ${pure.join(' ')}`);
    const browser = red.entries.filter((entry) => !pureOnly.has(parseEntry(entry).file));
    const plan = planLocalRun({ tier1: browser, fire3d: fire3dSpecs(config), cost: costModel(readTimings()) });
    if (plan.threeD.length > 0) say(`Left for GitHub, chromium-3d is never run locally: ${plan.threeD.join(' ')}`);
    if (argv.includes('--list')) {
      console.log(plan.run.join(' '));
      return 0;
    }
    const why = runRefusal(plan.run, estimateWait([...plan.run, ...plan.over], costModel(readTimings())));
    if (why) {
      console.error(why);
      return 2;
    }
    const port = await busyPort();
    if (port) {
      console.error(`Port ${port} is already listening on 127.0.0.1: one browser runner at a time. Stop it first.`);
      return 2;
    }
    return runLocally(plan.run);
  }

  const picked = gather(base);
  const timings = readTimings();
  if (!timings) say('tests/spec-timings.json is missing or unreadable: every file is estimated at the median file.');
  const plan = planLocalRun({ tier1: picked.tier1, tier2: picked.tier2, fire3d: picked.fire3d, cost: costModel(timings) });
  const touched = entryFiles([...picked.tier1, ...picked.tier2]);
  for (const line of describeSelection(picked, scripted && !argv.includes('--run') ? null : plan)) say(line);

  if (argv.includes('--list')) {
    console.log(touched.join(' '));
    return 0;
  }

  if (argv.includes('--dispatch')) {
    if (touched.length === 0) {
      console.error(dispatchRefusal(touched));
      return 2;
    }
    // On main, the one line of work, the run goes to the work branch it was pushed to.
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD' ? 'HEAD' : workBranch();
    const pushed = !branch || branch === 'HEAD' ? '' : git(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];
    let openPull;
    try {
      openPull = !branch || branch === 'HEAD' ? null : openPullRequest(branch);
    } catch (error) {
      console.error(`Cannot ask GitHub whether a pull request is open on ${branch}, so no dispatch: ${String(error.stderr || error.message).trim()}`);
      return 2;
    }
    const refusal = dispatchRefusal(touched, branch, git(['rev-parse', 'HEAD']).trim(), pushed, openPull);
    if (refusal) {
      console.error(refusal);
      return 2;
    }
    console.log(`Targeted run of ${touched.length} spec files on ${branch}: ${touched.join(' ')}`);
    const args = ['workflow', 'run', 'validate.yml', '--ref', branch, '-R', REPO, '-f', `specs=${touched.join(' ')}`];
    return spawnSync('gh', args, { stdio: 'inherit' }).status ?? 1;
  }

  if (argv.includes('--run')) {
    const dirty = workingTreeRefusal();
    if (dirty) {
      console.error(dirty);
      return 2;
    }
    const refusal = runRefusal(plan.run, estimateWait([...plan.run, ...plan.over], costModel(timings)));
    if (refusal) {
      console.error(refusal);
      return 2;
    }
    const port = await busyPort();
    if (port) {
      console.error(`Port ${port} is already listening on 127.0.0.1: one browser runner at a time. Stop it first.`);
      return 2;
    }
    return runLocally(plan.run);
  }

  const stale = picked.mentions.filter(({ absent }) => !absent);
  console.log(`Range ${picked.range}`);
  console.log(`${stale.length} spec lines name a string the range removed and HEAD no longer has:`);
  for (const { file, line, text } of stale) console.log(`${file}:${line}  ${JSON.stringify(text)}`);
  if (stale.length < picked.mentions.length) {
    console.log(`${picked.mentions.length - stale.length} more look like absence checks or are marked "spec-impact: intended" (not counted):`);
    for (const { file, line, text, absent } of picked.mentions) if (absent) console.log(`${file}:${line}  ${JSON.stringify(text)}`);
  }
  console.log(`Touched specs (${touched.length}): ${touched.join(' ')}`);
  return stale.length > 0 ? 1 : 0;
}

// Not import.meta.main: it is undefined before Node 24.2, and engines admits 24.0.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
