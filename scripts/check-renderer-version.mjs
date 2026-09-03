/**
 * Renderer-version check: the pin, the lock, and the installed tree must all
 * name the SAME maplibre-gl, and the pin must be exact.
 *
 * Asked for by the 3D Fire review (planning 03-fire-3d.md) after a
 * node_modules drift incident: the installed tree held 5.24.0 while the lock
 * still said 4.7.1, so every local run exercised a renderer no artifact
 * described, and the specs that passed proved nothing about the shipped
 * build. `npm ci` prevents that; a developer's `npm install <pkg>@next`, a
 * half-applied upgrade branch, or a stale worktree does not.
 *
 * The pin is deliberately EXACT ("6.6.0", no range operator): MapLibre is the
 * whole map, its minor releases have moved WebGL and style-spec behavior the
 * app asserts on, and a caret would let a machine-local install change the
 * renderer under a green gate.
 *
 * npm semantics, not grep semantics: exit 0 is clean, exit 1 prints one line
 * naming all three versions and fails the `check:all` script.
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

console.log(
  `renderer-version check: clean (${PACKAGE} ${pinned} pinned, locked, installed)`
);
