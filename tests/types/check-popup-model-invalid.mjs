/**
 * S30D D1 M23 (the Codex Tier 2 review PF2 and PF4, "invalid popup variants
 * do not compile"): the negative type proof for the popup frame model,
 * modelled on tests/types/check-context-literal-typo.mjs, whose inversion it
 * shares.
 *
 * `tests/types/popup-model-invalid.ts` DELIBERATELY fails to typecheck, once
 * on each pinned line below:
 *
 *   - tsc SUCCEEDS (exit 0)  -> this script FAILS: every invalid variant
 *     compiled, so the model admits them all.
 *   - tsc FAILS (exit non-0) -> this script checks every pinned line is
 *     reported AND no other line is: a pinned line that compiles means the
 *     model admits that variant; an error elsewhere means the valid
 *     scaffolding broke, and then the pinned errors prove nothing.
 *
 * npm semantics: exit 0 clean, exit 1 fails `typecheck:tests`.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = 'tests/types/popup-model-invalid.ts';
const PROJECT = 'tsconfig.popup-model-invalid.json';

/** Each deliberate invalid variant, pinned to its line. */
const EXPECTED = new Map([
  [33, 'an M3 group issuer (GroupIssuerKey admits nifc and bcws only; DR-104)'],
  [35, 'a group with fewer than two records'],
  [37, 'a caller-supplied group head (the head is derived from group facts)'],
  [39, 'an AIANNH place without its representation caveat (plan_rules 8)'],
  [41, 'a deployer popup with a source link (plan_rules 7)'],
  [43, 'a perRecord source outside the generated group head'],
  [45, 'an AIANNH caveat of another product\'s variant'],
  [47, 'a deployer source mixing its no-source reason with a link (plan_rules 7)']
]);

function resolveTsc() {
  const require = createRequire(join(root, 'package.json'));
  const pkgPath = require.resolve('typescript/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
  if (!binRelative) {
    console.error('check-popup-model-invalid: the installed typescript package.json declares no "tsc" bin entry; run `npm ci`');
    process.exit(1);
  }
  return join(dirname(pkgPath), binRelative);
}

const result = spawnSync(process.execPath, [resolveTsc(), '-p', PROJECT], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});

if (result.error) {
  console.error(`check-popup-model-invalid: could not run tsc (${result.error.message})`);
  process.exit(1);
}

if (result.status === 0) {
  console.error(
    `check-popup-model-invalid: tsc -p ${PROJECT} SUCCEEDED, and it must not: every invalid popup variant in ${FIXTURE} compiled.`
  );
  process.exit(1);
}

const ERROR_LINE = /^([^()\r\n]+)\((\d+),\d+\): error TS\d+:/;
const reported = new Set();
const elsewhere = [];
for (const line of (result.stdout ?? '').split(/\r?\n/)) {
  const match = ERROR_LINE.exec(line);
  if (!match) continue;
  const file = match[1].replace(/\\/g, '/');
  const lineNo = Number(match[2]);
  if (file === FIXTURE && EXPECTED.has(lineNo)) reported.add(lineNo);
  else elsewhere.push(line);
}

const missing = [...EXPECTED.keys()].filter((lineNo) => !reported.has(lineNo));
if (missing.length > 0 || elsewhere.length > 0) {
  for (const lineNo of missing) {
    console.error(`  NOT CAUGHT: ${EXPECTED.get(lineNo)}, expected an error on ${FIXTURE}:${lineNo}`);
  }
  for (const line of elsewhere) console.error(`  UNEXPECTED: ${line}`);
  console.error('Full tsc output:');
  console.error(result.stdout);
  process.exit(1);
}

console.log(
  `check-popup-model-invalid: clean (tsc failed as required on all ${EXPECTED.size} pinned lines and nowhere else)`
);
