/**
 * Em-dash scan (CLAUDE.md section 4, rule 4): no U+2014 anywhere in the
 * covered paths. This is the local npm-script mirror of the byte-level
 * grep the CI checks job runs; coverage matches CI (src, index.html,
 * tests, docs, workers, scripts, root *.md) with node_modules excluded
 * and public/ deliberately out of scope (binary assets).
 *
 * npm semantics, not grep semantics: exit 0 is clean, exit 1 lists every
 * offending path:line and fails the `gate` script.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'tests', 'docs', 'workers', 'scripts'];
const ROOT_FILES = ['index.html'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2',
  '.pmtiles', '.zip', '.exe', '.pdf'
]);
// Built from the escape so this file never carries the literal byte
// sequence (the CI byte-level grep covers scripts/ too).
const EM_DASH = String.fromCharCode(0x2014);

const hits = [];

function scanFile(path) {
  if (SKIP_EXTS.has(extname(path).toLowerCase())) return;
  const text = readFileSync(path, 'utf8');
  if (!text.includes(EM_DASH)) return;
  text.split('\n').forEach((line, i) => {
    if (line.includes(EM_DASH)) hits.push(`${path}:${i + 1}`);
  });
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) walk(path);
    else scanFile(path);
  }
}

for (const root of ROOTS) {
  try {
    walk(root);
  } catch {
    // A covered directory may not exist in a partial checkout; skip it.
  }
}
for (const file of ROOT_FILES) {
  try {
    scanFile(file);
  } catch {
    // Same tolerance for root files.
  }
}
for (const entry of readdirSync('.')) {
  if (entry.endsWith('.md')) scanFile(entry);
}

if (hits.length > 0) {
  console.error(`em-dash scan: ${hits.length} line(s) contain U+2014:`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log('em-dash scan: clean');
