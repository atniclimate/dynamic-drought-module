/**
 * Resource-catalog schema check (0.6.0 R2; D-0.6.0-004). The strict build-time
 * gate for `public/data/resources/*.json`, the system of record for state-tier
 * resource routing. Run in `npm run gate`; the runtime validation in
 * `src/impact/resource-catalog.ts` is only the defensive backstop.
 *
 * Rules (docs/resource-catalog-schema.md is the authoritative statement):
 *   - filename is `<code>.json` where <code> is a valid lowercase two-letter
 *     state / district / territory code (the StateCode union);
 *   - the file is a JSON object with `label` (non-empty string), `verified`
 *     (non-empty string, the entry-level stamp), and `resources` (array);
 *   - every row has `label`, `agency`, and `tier`; `tier` is one of the four
 *     stewardship tiers; `description` is optional;
 *   - every `url` (optional) is `https://`.
 *
 * npm semantics: exit 0 is clean, exit 1 lists every offending file with the
 * reason and fails the gate.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join('public', 'data', 'resources');

// The StateCode union from src/impact/resources.ts, lowercased. Keep in sync
// with that union; a filename outside this set fails the check.
const VALID_CODES = new Set(
  [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'DC', 'PR'
  ].map((c) => c.toLowerCase())
);

const VALID_TIERS = new Set(['tribe-own', 'federal', 'state', 'bia-regional']);

const errors = [];
function fail(file, reason) {
  errors.push(`${file}: ${reason}`);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function checkFile(file) {
  const base = file.replace(/\.json$/, '');
  if (!VALID_CODES.has(base)) {
    fail(file, `filename "${base}" is not a valid lowercase two-letter state code`);
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
  if (!isNonEmptyString(data.label)) fail(file, 'missing or empty "label"');
  if (!isNonEmptyString(data.verified)) fail(file, 'missing or empty "verified" stamp');
  if (!Array.isArray(data.resources)) {
    fail(file, 'missing "resources" array');
    return;
  }

  data.resources.forEach((row, i) => {
    const at = `resources[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail(file, `${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(row.label)) fail(file, `${at} missing or empty "label"`);
    if (!isNonEmptyString(row.agency)) fail(file, `${at} missing or empty "agency"`);
    if (!isNonEmptyString(row.tier) || !VALID_TIERS.has(row.tier)) {
      fail(file, `${at} "tier" must be one of ${[...VALID_TIERS].join(', ')}`);
    }
    if (row.url !== undefined) {
      if (typeof row.url !== 'string' || !row.url.startsWith('https://')) {
        fail(file, `${at} "url" must be an https:// URL`);
      }
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

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
for (const file of files) checkFile(file);

if (errors.length > 0) {
  console.error(`resource-catalog check: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`resource-catalog check: clean (${files.length} state file(s))`);
