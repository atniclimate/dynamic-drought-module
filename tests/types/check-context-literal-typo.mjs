/**
 * DDM-P15-T07: the negative proof the acceptance sentence demands, run as
 * part of `npm run typecheck:tests` (via `check:all`), never on its own.
 *
 * `tests/types/context-literal-typo.ts` is a fixture that DELIBERATELY
 * fails to typecheck: a `BoundarySelectionContext` literal missing its
 * required `containing` field. This script mirrors
 * `scripts/check-key-types.mjs`'s inversion (that script is scripts/, not
 * owned by this task; this one lives under tests/types/ instead) and
 * inverts the usual pass/fail sense on purpose:
 *
 *   - tsc SUCCEEDS (exit 0)  -> this script FAILS. A clean compile means
 *     `containing` silently went optional, or `BoundarySelectionContext`
 *     lost the field, and a hand-built literal missing it would no longer
 *     be caught.
 *   - tsc FAILS (exit non-0) -> this script checks the failure is the
 *     RIGHT failure: an error naming the fixture's own line, no fewer.
 *
 * npm semantics, not grep semantics: exit 0 is clean, exit 1 fails
 * `typecheck:tests` and therefore `check:all`.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = 'tests/types/context-literal-typo.ts';
const PROJECT = 'tsconfig.context-literal-typo.json';

/** The one deliberate omission in the fixture, pinned to its line. */
const EXPECTED_LINE = 27;
const EXPECTED_NAME = 'missing required `containing` field (BoundarySelectionContext, src/impact/types.ts)';

/**
 * Resolve `tsc` from this project's own installed `typescript` package, the
 * same way scripts/check-key-types.mjs does (see that file's own comment
 * for why: no global tsc, no exports-map guess, this process's own node).
 */
function resolveTsc() {
  const require = createRequire(join(root, 'package.json'));
  const pkgPath = require.resolve('typescript/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
  if (!binRelative) {
    console.error(
      'check-context-literal-typo: the installed typescript package.json declares no "tsc" bin entry; run `npm ci` to restore a normal install'
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
  console.error(`check-context-literal-typo: could not run tsc (${result.error.message})`);
  process.exit(1);
}

if (result.status === 0) {
  console.error(
    'check-context-literal-typo: tsc -p tsconfig.context-literal-typo.json SUCCEEDED, and it must not. ' +
      `${FIXTURE} exists to fail typechecking; a clean compile means BoundarySelectionContext's ` +
      '`containing` field silently went optional (or the interface lost it), and a hand-built ' +
      'literal missing it would no longer fail type checking.'
  );
  process.exit(1);
}

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

if (!reportedLines.has(EXPECTED_LINE)) {
  console.error(
    `check-context-literal-typo: tsc -p tsconfig.context-literal-typo.json failed (as expected), but not for the right reason.`
  );
  console.error(`  NOT CAUGHT: ${EXPECTED_NAME}, expected an error on ${FIXTURE}:${EXPECTED_LINE}`);
  console.error('Full tsc output:');
  console.error(result.stdout);
  process.exit(1);
}

console.log(
  `check-context-literal-typo: clean (tsc failed as required, on the pinned line; ` +
    'BoundarySelectionContext still rejects a literal missing `containing` at compile time)'
);
