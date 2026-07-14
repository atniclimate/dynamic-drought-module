/**
 * Gate-time validation of the SHIPPED municipal place bundle against the
 * SHIPPED glyph ranges (U4 stage-5 adversarial major 4: the generator's
 * glyph gate runs only when build-places.mjs is invoked, which the
 * production build never does, so an edited or stale
 * public/data/us-places.json could ship a name no bundled glyph range can
 * draw). This check needs NO network: it reads the two artifacts that
 * actually deploy and fails the gate on any mismatch.
 *
 * Checks:
 *   1. Every bundled name is NFC-normalized (MapLibre's glyph path never
 *      composes decomposed marks).
 *   2. Every codepoint of every name falls inside a glyph range file that
 *      ships under public/fonts/glyphs/Noto Sans Regular/.
 *   3. The bundle is non-trivial (over 500 places; a truncated artifact
 *      fails loudly, not as a quietly empty layer).
 *
 * Wired into `npm run gate`. Run directly: node scripts/check-places-artifact.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BUNDLE_PATH = fileURLToPath(
  new URL('../public/data/us-places.json', import.meta.url)
);
const GLYPH_DIR = fileURLToPath(
  new URL('../public/fonts/glyphs/Noto Sans Regular/', import.meta.url)
);

const bundle = JSON.parse(await readFile(BUNDLE_PATH, 'utf8'));
const places = bundle.places ?? [];

const ranges = (await readdir(GLYPH_DIR))
  .filter((f) => f.endsWith('.pbf'))
  .map((f) => f.replace('.pbf', '').split('-').map(Number));

const problems = [];
if (places.length <= 500) {
  problems.push(`bundle carries only ${places.length} places (truncated artifact?)`);
}
for (const p of places) {
  const name = String(p.name ?? '');
  if (name !== name.normalize('NFC')) {
    problems.push(`${name}: not NFC-normalized`);
    continue;
  }
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (!ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      problems.push(
        `${name}: U+${cp.toString(16).toUpperCase().padStart(4, '0')} outside the shipped glyph ranges`
      );
    }
  }
}

if (problems.length > 0) {
  console.error('places-artifact check FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `places-artifact check: clean (${places.length} places against ranges ${ranges
    .map(([a, b]) => `${a}-${b}`)
    .join(', ')})`
);
