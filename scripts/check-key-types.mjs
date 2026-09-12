/**
 * DDM-P1-T05 microtask 3: the compile-time half of the acceptance sentence
 * ("An internal catalog, preset, coactivation, or cluster recipe key typo
 * fails type checking"). The runtime half lives in
 * tests/config-key-authority.spec.ts; this script is what stands between
 * that sentence and silent rot, because nothing else in the repo proves it.
 *
 * `tests/types/key-typos.ts` is a fixture that DELIBERATELY fails to
 * typecheck: four object literals, each one key typo away from a real
 * entry in LAYER_KEYS, PRESET_KEYS, or a recipe's LayerKey union. This
 * script runs `tsc -p tsconfig.key-typos.json` against that ONE file
 * (tsconfig.key-typos.json extends the project tsconfig so the fixture is
 * judged under the same strictness as src/) and inverts the usual
 * pass/fail sense on purpose:
 *
 *   - tsc SUCCEEDS (exit 0)  -> this script FAILS. A clean compile means
 *     one of the four unions silently widened back to `string` and the
 *     narrowing this task built has stopped catching typos.
 *   - tsc FAILS (exit non-0) -> this script checks that the failure is
 *     the RIGHT failure: an error naming each of the four pinned lines
 *     below, no fewer. A wrong-line or missing-line failure is still a
 *     failure, but it does not prove what this gate exists to prove, so
 *     it is reported by name rather than accepted as a pass.
 *
 * EXPECTED_TYPOS is the one table this script and the fixture are edited
 * together from: a line number changes in one file, it changes here too.
 *
 * npm semantics, not grep semantics: exit 0 is clean, exit 1 fails
 * `check:all`.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'tests/types/key-typos.ts';
const PROJECT = 'tsconfig.key-typos.json';

/**
 * The four deliberate typos in tests/types/key-typos.ts, by the line each
 * one sits on. Keep this in step with that file: a typo moved to a new
 * line without an update here reads as "not caught".
 */
const EXPECTED_TYPOS = [
  { line: 28, name: 'catalog key typo (LayerDef.key, LAYER_KEYS)' },
  { line: 46, name: 'coactivation typo (LayerDef.coActivateWith, LAYER_KEYS)' },
  { line: 55, name: 'preset key typo (ViewPreset.key, PRESET_KEYS)' },
  { line: 68, name: 'cluster recipe typo (HazardClusterDef.recipes, LayerKey)' }
];

/**
 * Resolve the `tsc` entry point the same way the rest of this tree's
 * toolchain does: from the project's own installed `typescript` package,
 * never a global on PATH (a global tsc could be a different major version
 * from the one this repo builds with, or absent entirely on a clean
 * checkout that has not run `npm install`). TypeScript 7's package.json
 * does not expose `./bin/tsc` through `exports`, so this reads the `bin`
 * field off the resolved `package.json` instead of guessing a path, and
 * invokes it with THIS process's own node, sidestepping the
 * cmd/shell-shim differences between `node_modules/.bin/tsc` on Windows
 * and everywhere else.
 */
function resolveTsc() {
  const require = createRequire(join(root, 'package.json'));
  const pkgPath = require.resolve('typescript/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
  if (!binRelative) {
    console.error(
      'check-key-types: the installed typescript package.json declares no "tsc" bin entry; run `npm ci` to restore a normal install'
    );
    process.exit(1);
  }
  return join(dirname(pkgPath), binRelative);
}

const tscPath = resolveTsc();

const result = spawnSync(process.execPath, [tscPath, '-p', PROJECT], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});

if (result.error) {
  console.error(`check-key-types: could not run tsc (${result.error.message})`);
  process.exit(1);
}

if (result.status === 0) {
  console.error(
    'check-key-types: tsc -p tsconfig.key-typos.json SUCCEEDED, and it must not. ' +
      `${FIXTURE} exists to fail typechecking; a clean compile means one of the ` +
      'four internal key unions (LAYER_KEYS/LayerKey, PRESET_KEYS/PresetKey, or a ' +
      'recipe\'s LayerKey typing) has silently widened back to `string` and a ' +
      'catalog, preset, coactivation, or cluster recipe typo would no longer fail ' +
      'type checking. Find which of src/config/layers.ts, src/config/presets.ts, ' +
      'or src/config/clusters.ts stopped narrowing and restore it.'
  );
  process.exit(1);
}

// tsc reports one line per diagnostic on stdout, shaped
// `path/to/file.ts(line,col): error TSNNNN: message`. Parsed per line so a
// multi-line message body cannot be mistaken for a second diagnostic.
const ERROR_LINE = new RegExp(
  `^${FIXTURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\((\\d+),\\d+\\): error TS\\d+:`
);
const reportedLines = new Set(
  (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => ERROR_LINE.exec(line))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
);

const missing = EXPECTED_TYPOS.filter((typo) => !reportedLines.has(typo.line));
const expectedLineSet = new Set(EXPECTED_TYPOS.map((typo) => typo.line));
const unexpected = [...reportedLines].filter((line) => !expectedLineSet.has(line));

if (missing.length > 0 || unexpected.length > 0) {
  console.error(
    `check-key-types: tsc -p tsconfig.key-typos.json failed (as expected), but not for the right reasons.`
  );
  for (const typo of missing) {
    console.error(
      `  NOT CAUGHT: ${typo.name}, expected an error on ${FIXTURE}:${typo.line}`
    );
  }
  for (const line of unexpected) {
    console.error(
      `  UNEXPECTED: an error was reported on ${FIXTURE}:${line}, which is not one of the four pinned typo lines; the fixture and EXPECTED_TYPOS in this script have drifted apart`
    );
  }
  console.error('Full tsc output:');
  console.error(result.stdout);
  process.exit(1);
}

console.log(
  `check-key-types: clean (tsc failed as required, catching all ${EXPECTED_TYPOS.length} deliberate typos; ` +
    'the four internal key tables (LAYER_KEYS, PRESET_KEYS, and the LayerKey-typed cluster recipes) still reject a typo at compile time)'
);
