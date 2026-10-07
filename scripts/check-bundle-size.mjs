/**
 * Measured gzip bundle gate (0.7.0 U0d; ratified line: plan section 6,
 * ratification 9.9 item 2a; hardened by D-0.7.0-045 at the S1 unit).
 * The maplibre and pmtiles vendor chunks are exempt as cache-stable.
 *
 * THREE ENFORCED LINES (D-0.7.0-045: "state both numbers, and the gate
 * command enforces both"; the third line added under DR-158, found-085).
 * Until DR-085 amendment_2026_09_12, the first two lines were fixed
 * ceilings (45 kB entry, 100 kB eager app) that no measurement backed.
 * That amendment replaced both with a ratified measurement plus
 * ACTIVATION_HEADROOM (8 percent, rounded to one decimal), the same
 * rule and the same constant name as check-activation-budget.mjs, so
 * the two gates read the same way even though they do not share code:
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
 *   3. The HTML line (DR-158, found-085): the built dist/index.html's
 *      own gzip size (the file's bytes, not just the asset names it
 *      names) must stay at or under RATIFIED_HTML_GZIP_B (9,000 B, the
 *      ratified measurement) plus the same 8 percent headroom,
 *      inclusive: 9,720 B computed in raw bytes, never rounded to kB
 *      first (rounding to one decimal kB would turn 9.0 kB plus 8
 *      percent into 9.7 kB and wrongly reject a page that gzips to
 *      9,631 to 9,720 B, the measured range at ratification).
 *
 * Lazy chunks and CSS are informational.
 *
 * npm semantics: exit 0 below both app lines and at or below the HTML
 * line, exit 1 at/over an app line, over the HTML line, or when
 * dist/ is missing (run `npm run build` first; the gate script
 * sequences that). Sizes are reported in kB of 1000 bytes to match
 * Vite's build report.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

// Owner-ratified 2026-10-07: DR-085
// bundle_measurements_ratified_2026_10_07. The W2 PMTiles repair bounds
// range bodies and shared-reader cancellation; measured growth is 928 B
// entry and 929 B eager. Ratified measurement build index SHA256:
// 523bb337df88c34c7c94763ffe3fa10c0aaae25d9ae96c99e28dbc281051d009.
// Future re-recording requires measured
// bytes, a dated reason and owner ratification; headroom stays unchanged.
const RATIFIED_ENTRY_KB = 38.637;

// Eager boot payload (entry plus modulepreload, vendor exempt), from
// the same 2026-10-07 measurement and owner ruling as the entry above.
// First-party transport bytes are included; no vendor exemption changed.
const RATIFIED_EAGER_KB = 56.619;

// The last ratified measurement of the built dist/index.html's own gzip
// size (DR-158, found-085): 9,000 B, measured near 8,452 to 9,631 B across
// the D1 landing runs (RATIFICATION-6 Q7; I:/claude-temp/ddm-s30d/gates/
// d1-m7.log). Kept in raw bytes, not kB, so the 8 percent headroom below
// is computed on whole bytes and never loses precision to kB rounding.
const RATIFIED_HTML_GZIP_B = 9000;

// The one headroom both lines carry above their ratified measurement.
// Same name and value as check-activation-budget.mjs's constant, by
// intent (one rule stated twice), not by import: the two scripts do
// not share code. Eight percent, rounded to one decimal, turns 38.637
// into 41.7 and 56.619 into 61.1; see budgetForMeasurement() below.
const ACTIVATION_HEADROOM = 0.08;

/** The enforced line for a ratified measurement, in kB to one decimal. */
function budgetForMeasurement(measuredKb) {
  return Math.round(measuredKb * (1 + ACTIVATION_HEADROOM) * 10) / 10;
}

// Enforced lines derived from the constants above: 41.7 kB entry, 61.1
// kB eager app.
const ENTRY_LINE_KB = budgetForMeasurement(RATIFIED_ENTRY_KB);
const APP_LINE_KB = budgetForMeasurement(RATIFIED_EAGER_KB);

// The HTML line, in raw bytes (DR-158): 9,000 B plus 8 percent headroom
// rounded to the nearest whole byte, which is exactly 9,720 B and never
// goes through the kB-rounding helper above.
const HTML_LINE_B = Math.round(RATIFIED_HTML_GZIP_B * (1 + ACTIVATION_HEADROOM));

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

// The HTML line (DR-158, found-085): the built dist/index.html's own gzip
// size, in raw bytes, never a kB rounding of it.
const htmlGzip = gzipBytes(join(DIST, 'index.html'));

console.log(`bundle gate (gzip, kB = 1000 bytes; entry line ${budgetKb} kB (ratified ${RATIFIED_ENTRY_KB.toFixed(1)} kB plus 8% headroom), app line ${APP_LINE_KB} kB (ratified ${RATIFIED_EAGER_KB.toFixed(1)} kB plus 8% headroom) on the eager app total, HTML line ${HTML_LINE_B} B (ratified ${RATIFIED_HTML_GZIP_B} B plus 8% headroom))`);
console.log(`  app entry chunk    ${kb(entryGzip).padStart(7)} kB  ${entryName}`);
console.log('  eager boot payload (entry + modulepreload):');
for (const row of eagerRows) console.log(row);
console.log(`  eager app total    ${kb(eagerAppGzip).padStart(7)} kB  (vendor-exempt chunks excluded)`);
console.log(`  lazy chunks        ${kb(lazyGzip).padStart(7)} kB  across ${lazyJs.length} files`);
console.log(`  stylesheets        ${kb(cssGzip).padStart(7)} kB  across ${allCss.length} files`);
console.log(`  index.html         ${String(htmlGzip).padStart(7)} B   gzip (HTML line ${HTML_LINE_B} B, ratified ${RATIFIED_HTML_GZIP_B} B plus 8% headroom)`);

let failed = false;
if (entryGzip / 1000 >= budgetKb) {
  console.error(`bundle gate: FAIL; app entry chunk ${kb(entryGzip)} kB gzip is at or over the ${budgetKb} kB entry line (ratified ${RATIFIED_ENTRY_KB.toFixed(1)} kB plus 8% headroom; re-ratify with a new measurement and a dated reason if this growth is real)`);
  failed = true;
}
if (eagerAppGzip / 1000 >= APP_LINE_KB) {
  console.error(`bundle gate: FAIL; eager app total ${kb(eagerAppGzip)} kB gzip is at or over the ${APP_LINE_KB} kB app line (ratified ${RATIFIED_EAGER_KB.toFixed(1)} kB plus 8% headroom; re-ratify with a new measurement and a dated reason if this growth is real)`);
  failed = true;
}
if (htmlGzip > HTML_LINE_B) {
  console.error(`bundle gate: FAIL; index.html ${htmlGzip} B gzip is over the ${HTML_LINE_B} B HTML line (ratified ${RATIFIED_HTML_GZIP_B} B plus 8% headroom; re-ratify with a new measurement and a dated reason if this growth is real, DR-158)`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`bundle gate: clean (entry ${kb(entryGzip)} kB under ${budgetKb} kB, ratified ${RATIFIED_ENTRY_KB.toFixed(1)} kB plus 8% headroom; eager app ${kb(eagerAppGzip)} kB under ${APP_LINE_KB} kB, ratified ${RATIFIED_EAGER_KB.toFixed(1)} kB plus 8% headroom; index.html ${htmlGzip} B under ${HTML_LINE_B} B, ratified ${RATIFIED_HTML_GZIP_B} B plus 8% headroom)`);
