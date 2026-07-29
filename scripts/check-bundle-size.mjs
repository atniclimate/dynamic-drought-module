/**
 * Measured gzip bundle gate (0.7.0 U0d; ratified line: plan section 6,
 * ratification 9.9 item 2a; hardened by D-0.7.0-045 at the S1 unit).
 * The maplibre and pmtiles vendor chunks are exempt as cache-stable.
 *
 * TWO ENFORCED LINES (D-0.7.0-045: "state both numbers, and the gate
 * command enforces both"):
 *
 *   1. The ENTRY line: the entry chunk (assets/index-*.js) must stay
 *      under 45 kB gzip BY DEFAULT (the ADR 0002 condition; no
 *      remembered flag). --budget overrides this line only, for
 *      exploratory checks; the default is the gate.
 *   2. The APP line: the eager boot payload (entry plus every
 *      modulepreload in dist/index.html, vendor exempt) must stay
 *      under 100 kB gzip, always. Enforcing it on the eager total
 *      keeps weight from hiding in a preloaded shared chunk.
 *
 * Lazy chunks and CSS are informational.
 *
 * npm semantics: exit 0 under both lines, exit 1 over either or when
 * dist/ is missing (run `npm run build` first; the gate script
 * sequences that). Sizes are reported in kB of 1000 bytes to match
 * Vite's build report.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');
const DEFAULT_BUDGET_KB = 45;
const APP_LINE_KB = 100;
const VENDOR_EXEMPT = /^(maplibre|pmtiles)-/;

const budgetArgAt = process.argv.indexOf('--budget');
const budgetKb = budgetArgAt !== -1
  ? Number(process.argv[budgetArgAt + 1])
  : DEFAULT_BUDGET_KB;
if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
  console.error('bundle gate: --budget must be a positive number (kB gzip)');
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`bundle gate: ${DIST}/index.html not found; run npm run build first`);
  process.exit(1);
}

const kb = (bytes) => (bytes / 1000).toFixed(1);
const gzipBytes = (path) => gzipSync(readFileSync(path)).length;

// The eager set is what dist/index.html actually loads at boot: the
// module script (the entry) plus every modulepreload.
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const eagerNames = [...html.matchAll(/assets\/([\w.-]+\.js)/g)].map((m) => m[1]);
const entryName = eagerNames.find((name) => name.startsWith('index-'));
if (!entryName) {
  console.error('bundle gate: no assets/index-*.js entry referenced by dist/index.html');
  process.exit(1);
}

const allJs = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const allCss = readdirSync(ASSETS).filter((f) => f.endsWith('.css'));
const eagerSet = new Set(eagerNames);

const entryGzip = gzipBytes(join(ASSETS, entryName));

let eagerAppGzip = 0;
const eagerRows = [];
for (const name of eagerNames) {
  const size = gzipBytes(join(ASSETS, name));
  const exempt = VENDOR_EXEMPT.test(name);
  if (!exempt) eagerAppGzip += size;
  eagerRows.push(`  ${exempt ? '(vendor, exempt)' : '                '} ${kb(size).padStart(7)} kB  ${name}`);
}

const lazyJs = allJs.filter((f) => !eagerSet.has(f));
const lazyGzip = lazyJs.reduce((sum, f) => sum + gzipBytes(join(ASSETS, f)), 0);
const cssGzip = allCss.reduce((sum, f) => sum + gzipBytes(join(ASSETS, f)), 0);

console.log(`bundle gate (gzip, kB = 1000 bytes; entry line ${budgetKb} kB, app line ${APP_LINE_KB} kB on the eager app total)`);
console.log(`  app entry chunk    ${kb(entryGzip).padStart(7)} kB  ${entryName}`);
console.log('  eager boot payload (entry + modulepreload):');
for (const row of eagerRows) console.log(row);
console.log(`  eager app total    ${kb(eagerAppGzip).padStart(7)} kB  (vendor-exempt chunks excluded)`);
console.log(`  lazy chunks        ${kb(lazyGzip).padStart(7)} kB  across ${lazyJs.length} files`);
console.log(`  stylesheets        ${kb(cssGzip).padStart(7)} kB  across ${allCss.length} files`);

let failed = false;
if (entryGzip / 1000 >= budgetKb) {
  console.error(`bundle gate: FAIL; app entry chunk ${kb(entryGzip)} kB gzip is at or over the ${budgetKb} kB entry line`);
  failed = true;
}
if (eagerAppGzip / 1000 >= APP_LINE_KB) {
  console.error(`bundle gate: FAIL; eager app total ${kb(eagerAppGzip)} kB gzip is at or over the ${APP_LINE_KB} kB app line`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`bundle gate: clean (entry ${kb(entryGzip)} kB under ${budgetKb} kB; eager app ${kb(eagerAppGzip)} kB under ${APP_LINE_KB} kB)`);
