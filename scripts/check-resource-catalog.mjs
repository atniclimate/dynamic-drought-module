/**
 * Resource-catalog schema check (0.6.0 R2; D-0.6.0-004; hardened per the
 * 2026-07-09 Codex adversarial review, D-0.6.0-011). The strict build-time
 * gate for `public/data/resources/*.json`, the system of record for the
 * catalog-supplied resource tiers. Run in `npm run gate`; the runtime
 * validation in `src/impact/resource-catalog.ts` is only the defensive
 * backstop.
 *
 * Rules (docs/resource-catalog-schema.md is the authoritative statement):
 *   - every `.json`-like filename in the directory must be exactly lowercase
 *     (a `WA.json` or `wa.JSON` would silently vanish on case-sensitive
 *     hosting while looking present locally);
 *   - the basename is a valid two-letter state / district / territory code
 *     (the StateCode union) or the reserved `federal` file;
 *   - the file is a JSON object with `label` (the canonical display name for
 *     the code; "Federal" for federal.json), `verified` (a real ISO calendar
 *     date, `YYYY-MM-DD`), and `resources` (array);
 *   - every row has `label`, `agency`, `tier`, and an `https://` `url`;
 *     `description` is optional; the `tier` is LOCKED by file kind (state
 *     files: `state`; federal.json: `federal`), so a data file can never
 *     inject a row into another stewardship tier;
 *   - no two rows in a file share a URL (an authoring error).
 *
 * npm semantics: exit 0 is clean, exit 1 lists every offending file with the
 * reason and fails the gate.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join('public', 'data', 'resources');

// The StateCode union from src/impact/resources.ts, as lowercase code to
// canonical display label. Keep in sync with that union; a filename outside
// this set (other than `federal`) fails the check, and a label that does not
// match the canonical name fails too (corrupted metadata trips future
// consumers even while the label is unrendered).
const STATE_LABELS = new Map(Object.entries({
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida',
  ga: 'Georgia', hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana',
  ia: 'Iowa', ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine',
  md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota',
  ms: 'Mississippi', mo: 'Missouri', mt: 'Montana', ne: 'Nebraska',
  nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey', nm: 'New Mexico',
  ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio',
  ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island',
  sc: 'South Carolina', sd: 'South Dakota', tn: 'Tennessee', tx: 'Texas',
  ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming',
  dc: 'District of Columbia', pr: 'Puerto Rico'
}));

/** Reserved non-state files: basename to { expected tier, expected label }. */
const RESERVED = new Map([
  ['federal', { tier: 'federal', label: 'Federal' }]
]);

const VERIFIED_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
function fail(file, reason) {
  errors.push(`${file}: ${reason}`);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** A real ISO calendar date: format plus round-trip (rejects 2026-99-99). */
function isIsoCalendarDate(v) {
  if (!VERIFIED_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function checkFile(file) {
  const base = file.replace(/\.json$/, '');
  const expected = RESERVED.get(base) ??
    (STATE_LABELS.has(base) ? { tier: 'state', label: STATE_LABELS.get(base) } : null);
  if (!expected) {
    fail(file, `filename "${base}" is not a valid lowercase two-letter state code (or "federal")`);
    return;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  } catch (err) {
    fail(file, `invalid JSON (${err.message})`);
    return;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail(file, 'top-level value must be an object');
    return;
  }
  if (!isNonEmptyString(data.label)) {
    fail(file, 'missing or empty "label"');
  } else if (data.label !== expected.label) {
    fail(file, `"label" must be "${expected.label}" for ${base} (got "${data.label}")`);
  }
  if (!isNonEmptyString(data.verified)) {
    fail(file, 'missing or empty "verified" stamp');
  } else if (!isIsoCalendarDate(data.verified)) {
    fail(file, `"verified" must be a real ISO calendar date YYYY-MM-DD (got "${data.verified}")`);
  }
  if (!Array.isArray(data.resources)) {
    fail(file, 'missing "resources" array');
    return;
  }

  const seenUrls = new Set();
  data.resources.forEach((row, i) => {
    const at = `resources[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail(file, `${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(row.label)) fail(file, `${at} missing or empty "label"`);
    if (!isNonEmptyString(row.agency)) fail(file, `${at} missing or empty "agency"`);
    if (row.tier !== expected.tier) {
      fail(file, `${at} "tier" must be "${expected.tier}" in this file (got ${JSON.stringify(row.tier)}); a catalog file may never inject another stewardship tier`);
    }
    if (typeof row.url !== 'string' || !row.url.startsWith('https://')) {
      fail(file, `${at} "url" is required and must be an https:// URL`);
    } else if (seenUrls.has(row.url)) {
      fail(file, `${at} duplicates the URL ${row.url}`);
    } else {
      seenUrls.add(row.url);
    }
    if (row.description !== undefined && typeof row.description !== 'string') {
      fail(file, `${at} "description" must be a string when present`);
    }
  });
}

if (!existsSync(DIR)) {
  console.log('resource-catalog check: no public/data/resources/ directory (skipped)');
  process.exit(0);
}

// Pick up .json case-insensitively so a `wa.JSON` cannot slip past the gate,
// then require the exact lowercase form (the runtime fetches lowercase names;
// case-sensitive hosting would 404 anything else).
const entries = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json'));
const files = [];
for (const f of entries) {
  if (f !== f.toLowerCase()) {
    fail(f, 'filename must be exactly lowercase (case-sensitive hosting fetches lowercase names)');
  } else {
    files.push(f);
  }
}
for (const file of files) checkFile(file);

if (errors.length > 0) {
  console.error(`resource-catalog check: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`resource-catalog check: clean (${files.length} catalog file(s))`);
