/**
 * Em-dash scan (a project hard rule): no U+2014 in any text file Git would
 * ship. The file list is `git ls-files` (tracked plus new not-ignored files),
 * so public/ text and .github are covered and ignored private files are
 * never read. A listed file that cannot be read fails the scan loudly.
 *
 * npm semantics, not grep semantics: exit 0 is clean, exit 1 lists every
 * offending path:line and fails the `gate` script.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Binary formats: random bytes can spell any codepoint, and the rule is
// prose-scoped (D-0.7.0-027).
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.otf', '.pbf',
  '.pmtiles', '.zip', '.exe', '.pdf', '.gz',
  '.tif', '.tiff', '.gpkg', '.grib2', '.f64'
]);
// Built from the escape so this file never carries the literal character.
const EM_DASH = String.fromCharCode(0x2014);

const git = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);
// Tracked plus new not-ignored files, so a file not yet added is scanned too;
// a tracked file deleted in the working tree has nothing left to scan.
const deleted = new Set(git('--deleted'));
const files = git('--cached', '--others', '--exclude-standard').filter((path) => !deleted.has(path));

const hits = [];
for (const path of files) {
  if (SKIP_EXTS.has(extname(path).toLowerCase())) continue;
  const text = readFileSync(path, 'utf8');
  if (!text.includes(EM_DASH)) continue;
  text.split('\n').forEach((line, i) => {
    if (line.includes(EM_DASH)) hits.push(`${path}:${i + 1}`);
  });
}

if (hits.length > 0) {
  console.error(`em-dash scan: ${hits.length} line(s) contain U+2014:`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`em-dash scan: clean (${files.length} files)`);
