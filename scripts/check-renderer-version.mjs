/**
 * Renderer version and browser floor: one statement, proved.
 *
 * README.md's "Browser support" section is the ONE place this project
 * states the renderer it runs and the browser and graphics floor that
 * renderer implies (DDM-P15-T02). `vite.config.ts` and `DEVELOPER.md`
 * point at that section instead of repeating it, and this script is what
 * keeps the pointers honest. It proves two things:
 *
 *   1. VERSION. The pin (package.json), the lock, the installed tree, and
 *      the README statement all name the SAME maplibre-gl, and the pin is
 *      exact.
 *
 *      Asked for by the 3D Fire review (planning 03-fire-3d.md) after a
 *      node_modules drift incident: the installed tree held 5.24.0 while
 *      the lock still said 4.7.1, so every local run exercised a renderer
 *      no artifact described, and the specs that passed proved nothing
 *      about the shipped build. `npm ci` prevents that; a developer's
 *      `npm install <pkg>@next`, a half-applied upgrade branch, or a stale
 *      worktree does not.
 *
 *      The pin is deliberately EXACT ("6.6.0", no range operator):
 *      MapLibre is the whole map, its minor releases have moved WebGL and
 *      style-spec behavior the app asserts on, and a caret would let a
 *      machine-local install change the renderer under a green gate.
 *
 *   2. FLOOR. `build.target` in vite.config.ts is exactly the target list
 *      the README states. The build target is the only machine-readable
 *      form of the published promise, so a build that quietly narrows or
 *      widens it while the promise stands still is the failure this
 *      catches. Vite 8's default `baseline-widely-available` resolves to
 *      Safari 16.4 and would do exactly that.
 *
 * `.nvmrc` is deliberately NOT part of this check. It pins the Node
 * toolchain that BUILDS the application, which is a different axis from
 * the browser that RUNS it; folding them into one statement would let a
 * toolchain bump read as a change to the browser promise.
 *
 * npm semantics, not grep semantics: exit 0 is clean, exit 1 prints the
 * disagreement and fails the `check:all` script.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PACKAGE = 'maplibre-gl';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** An exact semver pin: digits.digits.digits plus an optional prerelease. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Read a text file with line endings normalized. The working tree is
 * checked out with `core.autocrlf = true` on Windows, so a document can
 * carry CRLF here and LF on a runner; every pattern below is written
 * against LF.
 */
function readText(relativePath) {
  try {
    return readFileSync(join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

const failures = [];

// ---------- 1. The renderer version ----------

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const installed = readJson(`node_modules/${PACKAGE}/package.json`);

const pinned = pkg?.dependencies?.[PACKAGE];
const locked = lock?.packages?.[`node_modules/${PACKAGE}`]?.version;
const present = installed?.version;

const shown = `pinned ${pinned ?? 'missing'}, locked ${locked ?? 'missing'}, installed ${present ?? 'missing'}`;

if (!pinned || !EXACT.test(pinned)) {
  console.error(
    `renderer-version check: ${PACKAGE} must be pinned to an exact version in package.json dependencies (${shown}); run \`npm install ${PACKAGE}@<version> --save-exact\``
  );
  process.exit(1);
}

if (!locked || !present || pinned !== locked || pinned !== present) {
  console.error(
    `renderer-version check: ${PACKAGE} versions disagree (${shown}); run \`npm ci\` to restore the locked renderer`
  );
  process.exit(1);
}

// ---------- 2. The one statement, and the build that must obey it ----------

// Both values are read from the "Browser support" section only, so a
// version or a target named in passing elsewhere in the README cannot
// satisfy the check.
const readme = readText('README.md');
const section = readme?.match(/\n## Browser support\n([\s\S]*?)(?=\n## |$)/)?.[1];

if (!section) {
  console.error(
    'renderer-version check: README.md has no "## Browser support" section; that section is the one statement of the renderer version and the browser floor'
  );
  process.exit(1);
}

const statedVersion = section.match(
  /MapLibre GL JavaScript (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/
)?.[1];
if (!statedVersion) {
  failures.push(
    'README.md "Browser support" names no exact MapLibre GL JavaScript version; it must state the renderer version the product runs'
  );
} else if (statedVersion !== pinned) {
  failures.push(
    `README.md "Browser support" states MapLibre GL JavaScript ${statedVersion} but package.json pins ${pinned}; the published statement and the pin must agree`
  );
}

// Whitespace-tolerant: the phrase and the list are prose and may wrap.
const statedTargetText = section.match(
  /production\s+build\s+target\s+is\s+`([^`]+)`/
)?.[1];
const viteConfig = readText('vite.config.ts');
const viteTargetBlock = viteConfig?.match(/target:\s*\[([^\]]*)\]/)?.[1];
const viteTarget = viteTargetBlock
  ? [...viteTargetBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
  : undefined;

if (!statedTargetText) {
  failures.push(
    'README.md "Browser support" does not state the production build target (expected: the production build target is `es2020, ...`)'
  );
}
if (!viteTarget || viteTarget.length === 0) {
  failures.push('vite.config.ts declares no build.target array to compare against README.md');
}
if (statedTargetText && viteTarget && viteTarget.length > 0) {
  const stated = statedTargetText
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const statedShown = stated.join(', ');
  const builtShown = viteTarget.join(', ');
  if (statedShown !== builtShown) {
    failures.push(
      `the build target and the published floor disagree: README.md says ${statedShown}, vite.config.ts builds ${builtShown}; state the floor once and change both together`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`renderer-version check: ${failure}`);
  process.exit(1);
}

console.log(
  `renderer-version check: clean (${PACKAGE} ${pinned} pinned, locked, installed and stated in README.md; build target ${viteTarget.join(', ')} matches the published floor)`
);
