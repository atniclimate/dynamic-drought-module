/**
 * Measured gzip bundle gate (0.7.0 U0d; ratified line: plan section 6,
 * ratification 9.9 item 2a; hardened by D-0.7.0-045 at the S1 unit).
 * The maplibre and pmtiles vendor chunks are exempt as cache-stable.
 *
 * TWO ENFORCED LINES (D-0.7.0-045: "state both numbers, and the gate
 * command enforces both"). Until DR-085 amendment_2026_09_12, both
 * lines were fixed ceilings (45 kB entry, 100 kB eager app) that no
 * measurement backed. That amendment replaced both with a ratified
 * measurement plus ACTIVATION_HEADROOM (8 percent, rounded to one
 * decimal), the same rule and the same constant name as
 * check-activation-budget.mjs, so the two gates read the same way even
 * though they do not share code:
 *
 *   1. The ENTRY line: the entry chunk (assets/index-*.js) must stay
 *      under RATIFIED_ENTRY_KB plus headroom BY DEFAULT (the ADR 0002
 *      condition; no remembered flag). --budget overrides this line
 *      only, as an exploratory check; the default is the gate.
 *   2. The APP line: the eager boot payload (entry plus every
 *      modulepreload in dist/index.html, vendor exempt) must stay
 *      under RATIFIED_EAGER_KB plus headroom, always. Enforcing it on
 *      the eager total keeps weight from hiding in a preloaded shared
 *      chunk.
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

// The last ratified measurement of the entry chunk, measured at the C2
// landing, main 45756c7, 2026-09-11, ratified by DR-085
// amendment_2026_09_12. To re-record: run `npm run build && npm run
// check:bundle`, put the new measured figure here with the date and
// the reason for the growth, and cite the commit. Growth past the
// headroom fails the gate until that is done.
const RATIFIED_ENTRY_KB = 35.0;

// The last ratified measurement of the eager boot payload (entry plus
// modulepreload, vendor exempt), measured at the same C2 landing, main
// 45756c7, 2026-09-11, ratified by DR-085 amendment_2026_09_12.
// Re-record the same way as RATIFIED_ENTRY_KB above.
const RATIFIED_EAGER_KB = 51.6;

// The one headroom both lines carry above their ratified measurement.
// Same name and value as check-activation-budget.mjs's constant, by
// intent (one rule stated twice), not by import: the two scripts do
// not share code. Eight percent, rounded to one decimal, turns 35.0
// into 37.8 and 51.6 into 55.7; see budgetForMeasurement() below.
const ACTIVATION_HEADROOM = 0.08;

/** The enforced line for a ratified measurement, in kB to one decimal. */
function budgetForMeasurement(measuredKb) {
  return Math.round(measuredKb * (1 + ACTIVATION_HEADROOM) * 10) / 10;
}

// Enforced lines derived from the constants above: 37.8 kB entry, 55.7
// kB eager app.
const ENTRY_LINE_KB = budgetForMeasurement(RATIFIED_ENTRY_KB);
const APP_LINE_KB = budgetForMeasurement(RATIFIED_EAGER_KB);
const VENDOR_EXEMPT = /^(maplibre|pmtiles)-/;

const budgetArgAt = process.argv.indexOf('--budget');
const budgetKb = budgetArgAt !== -1
  ? Number(process.argv[budgetArgAt + 1])
  : ENTRY_LINE_KB;
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

console.log(`bundle gate (gzip, kB = 1000 bytes; entry line ${budgetKb} kB (ratified ${RATIFIED_ENTRY_KB.toFixed(1)} kB plus 8% headroom), app line ${APP_LINE_KB} kB (ratified ${RATIFIED_EAGER_KB.toFixed(1)} kB plus 8% headroom) on the eager app total)`);
console.log(`  app entry chunk    ${kb(entryGzip).padStart(7)} kB  ${entryName}`);
console.log('  eager boot payload (entry + modulepreload):');
for (const row of eagerRows) console.log(row);
console.log(`  eager app total    ${kb(eagerAppGzip).padStart(7)} kB  (vendor-exempt chunks excluded)`);
console.log(`  lazy chunks        ${kb(lazyGzip).padStart(7)} kB  across ${lazyJs.length} files`);
console.log(`  stylesheets        ${kb(cssGzip).padStart(7)} kB  across ${allCss.length} files`);

let failed = false;
if (entryGzip / 1000 >= budgetKb) {
  console.error(`bundle gate: FAIL; app entry chunk ${kb(entryGzip)} kB gzip is at or over the ${budgetKb} kB entry line (ratified ${RATIFIED_ENTRY_KB.toFixed(1)} kB plus 8% headroom; re-ratify with a new measurement and a dated reason if this growth is real)`);
  failed = true;
}
if (eagerAppGzip / 1000 >= APP_LINE_KB) {
  console.error(`bundle gate: FAIL; eager app total ${kb(eagerAppGzip)} kB gzip is at or over the ${APP_LINE_KB} kB app line (ratified ${RATIFIED_EAGER_KB.toFixed(1)} kB plus 8% headroom; re-ratify with a new measurement and a dated reason if this growth is real)`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`bundle gate: clean (entry ${kb(entryGzip)} kB under ${budgetKb} kB, ratified ${RATIFIED_ENTRY_KB.toFixed(1)} kB plus 8% headroom; eager app ${kb(eagerAppGzip)} kB under ${APP_LINE_KB} kB, ratified ${RATIFIED_EAGER_KB.toFixed(1)} kB plus 8% headroom)`);
