#!/usr/bin/env node
/**
 * Which browser specs a block's commits touch, and which still name what the
 * block removed (owner, 2026-10-19: the 0.7.7 Validate run went red on specs
 * asserting on-screen text the block had deleted).
 *
 *   node scripts/spec-impact.mjs [--base <ref>]   stale mentions; exit 1 if any
 *   node scripts/spec-impact.mjs --list           touched spec paths, one line
 *   node scripts/spec-impact.mjs --run            one local run of those specs
 *   node scripts/spec-impact.mjs --dispatch       a targeted GitHub run of them
 *
 * The range is <base>...HEAD; the default base is `git merge-base HEAD
 * origin/main`. Everything is read from commits, never the working tree:
 * commit first.
 *
 * A stale mention is a string literal, attribute value, kebab-case token or
 * visible text on a line REMOVED under src/ or index.html, at least 4
 * characters, found nowhere in the code of src/ or index.html at HEAD
 * (comments do not count), that a spec file under tests/ (`.spec.ts`) at HEAD
 * still contains. Text the block moved or reworded, rather than deleted
 * everywhere, is not caught.
 *
 * Touched specs: spec files changed in the range, spec files with a stale
 * mention, and spec files that import a changed src/ module or test helper
 * directly. The measurement-only specs (playwright.config.ts MEASURE_SPECS),
 * which no CI shard and no --run project collects, are left out.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_LENGTH = 4;
export const MAX_LOCAL_SPECS = 12;
const BUSY_PORTS = [4173, 4180];
const REPO = 'atniclimate/dynamic-drought-module';

const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const ATTRIBUTE = /[\w:-]+=(["'])(.*?)\1/g;
const TEXT_NODE = />([^<>{}]+)</g;

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

/** Sorted, unique spec paths a block touches, measurement-only specs left out. */
export function touchedSpecs({ changedSpecs, mentions, specs, changedModules, measureOnly = new Set() }) {
  const out = new Set(changedSpecs);
  for (const { file } of mentions) out.add(file);
  for (const { path, text } of specs) if (importsChanged(path, text, changedModules)) out.add(path);
  return [...out].filter((path) => !measureOnly.has(path)).sort();
}

/** The spec paths playwright.config.ts's MEASURE_SPECS names (`'**\/name.spec.ts'`). */
export function measureSpecs(configText) {
  const list = configText.match(/const MEASURE_SPECS = \[([^\]]*)\]/)?.[1] ?? '';
  return new Set([...list.matchAll(/\*\*\/([\w.-]+\.spec\.ts)/g)].map(([, name]) => `tests/${name}`));
}

/** Why `--run` must not start, or null. */
export function runRefusal(specs) {
  if (specs.length === 0) {
    return 'No touched spec files. An empty list would run the whole suite, which is GitHub\'s job, not a local one.';
  }
  if (specs.length > MAX_LOCAL_SPECS) {
    return `${specs.length} touched spec files (more than ${MAX_LOCAL_SPECS}): too broad for a local run; use the targeted GitHub run.`;
  }
  return null;
}

/** Why `--dispatch` must not start, or null. An empty `specs` would start the full run under the plain title. */
export function dispatchRefusal(specs, branch, head, pushed) {
  if (specs.length === 0) return 'No touched spec files. An empty list would dispatch the full run, not a targeted one.';
  if (branch === 'HEAD') return 'HEAD is detached: check out the branch to dispatch it.';
  if (head !== pushed) return `HEAD is not the pushed tip of ${branch}: push first, so the run tests these commits.`;
  return null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Every blob under the given paths at HEAD, as `{ path, text }`, in one cat-file process. */
function headFiles(paths) {
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

async function main(argv) {
  const baseAt = argv.indexOf('--base');
  if (baseAt >= 0 && !argv[baseAt + 1]) throw new Error('--base needs a ref');
  const base = baseAt >= 0 ? argv[baseAt + 1] : git(['merge-base', 'HEAD', 'origin/main']).trim();
  const range = `${base}...HEAD`;

  const head = headFiles(['src', 'index.html', 'tests']);
  const headSource = head.filter(({ path }) => !path.startsWith('tests/')).map(({ text }) => text).join('\n');
  const specs = head.filter(({ path }) => path.startsWith('tests/') && path.endsWith('.spec.ts'));
  const specPaths = new Set(specs.map(({ path }) => path));

  const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', range, '--', 'src', 'index.html']);
  const mentions = findMentions(staleLiterals(removedLiterals(diff), headSource), specs);
  const changed = git(['diff', '--name-only', range, '--', 'src', 'tests']).split('\n').filter(Boolean);
  const changedSpecs = changed.filter((path) => specPaths.has(path));
  const changedModules = changed.filter((path) => !specPaths.has(path));
  const measureOnly = measureSpecs(git(['show', 'HEAD:playwright.config.ts']));
  const touched = touchedSpecs({ changedSpecs, mentions, specs, changedModules, measureOnly });

  if (argv.includes('--list')) {
    console.log(touched.join(' '));
    return 0;
  }

  if (argv.includes('--dispatch')) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const pushed = branch === 'HEAD' ? '' : git(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];
    const refusal = dispatchRefusal(touched, branch, git(['rev-parse', 'HEAD']).trim(), pushed);
    if (refusal) {
      console.error(refusal);
      return 2;
    }
    console.log(`Targeted run of ${touched.length} spec files on ${branch}: ${touched.join(' ')}`);
    const args = ['workflow', 'run', 'validate.yml', '--ref', branch, '-R', REPO, '-f', `specs=${touched.join(' ')}`];
    return spawnSync('gh', args, { stdio: 'inherit' }).status ?? 1;
  }

  if (argv.includes('--run')) {
    const refusal = runRefusal(touched);
    if (refusal) {
      console.error(refusal);
      return 2;
    }
    for (const port of BUSY_PORTS) {
      if (await isListening(port)) {
        console.error(`Port ${port} is already listening on 127.0.0.1: one browser runner at a time. Stop it first.`);
        return 2;
      }
    }
    const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
    const projects = ['chromium', 'chromium-interaction', 'chromium-3d'].map((name) => `--project=${name}`);
    console.log(`Running ${touched.length} touched spec files once: ${touched.join(' ')}`);
    return spawnSync(process.execPath, [cli, 'test', ...projects, '--workers=1', ...touched], { stdio: 'inherit' }).status ?? 1;
  }

  const stale = mentions.filter(({ absent }) => !absent);
  console.log(`Range ${range}`);
  console.log(`${stale.length} spec lines name a string the range removed and HEAD no longer has:`);
  for (const { file, line, text } of stale) console.log(`${file}:${line}  ${JSON.stringify(text)}`);
  if (stale.length < mentions.length) {
    console.log(`${mentions.length - stale.length} more look like absence checks or are marked "spec-impact: intended" (not counted):`);
    for (const { file, line, text, absent } of mentions) if (absent) console.log(`${file}:${line}  ${JSON.stringify(text)}`);
  }
  console.log(`Touched specs (${touched.length}): ${touched.join(' ')}`);
  return stale.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
