/**
 * Remove source maps from the built tree before it is published (DR-069,
 * 2026-09-03: production builds publish no source maps while GitHub Pages
 * is the host).
 *
 * The ruling is about what is PUBLISHED, not about what is generated. The
 * activation gate (scripts/check-activation-budget.mjs) proves what is
 * folded INTO each initial chunk by opening that chunk's `.map`, and its
 * contract treats a missing, malformed, or evidence-empty sourcemap on a
 * non-exempt initial chunk as a hard failure, never a skip. So the build
 * keeps emitting maps, `npm run gate` keeps reading them, and this script
 * runs after the gate and before the Pages upload
 * (.github/workflows/deploy.yml) to delete what the gate has already used.
 *
 * `build.sourcemap` is 'hidden' in vite.config.ts, so the emitted chunks
 * carry no `sourceMappingURL` comment and a published chunk does not point
 * at a file that is no longer there. This script is what makes the absence
 * true of the bytes as well: 'hidden' only drops the comment, it still
 * writes the files.
 *
 * npm semantics, not grep semantics: exit 0 after a clean sweep (including
 * a tree that carried none), exit 1 when dist/ is missing or when a map
 * survives deletion.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

if (!existsSync(DIST)) {
  console.error(
    `source-map strip: ${DIST}/ not found; run \`npm run build\` first (the gate script sequences that)`
  );
  process.exit(1);
}

/** Every `.map` file under `dir`, depth first. */
function mapFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...mapFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.map')) found.push(path);
  }
  return found;
}

const found = mapFiles(DIST);
let bytes = 0;
for (const path of found) {
  bytes += statSync(path).size;
  unlinkSync(path);
}

const survivors = mapFiles(DIST);
if (survivors.length > 0) {
  console.error(
    `source-map strip: ${survivors.length} map file(s) survived deletion (${survivors.join(', ')}); the published tree would carry them`
  );
  process.exit(1);
}

console.log(
  `source-map strip: removed ${found.length} source map(s), ${bytes} bytes, from ${DIST}/; nothing published points at one`
);
