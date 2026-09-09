/**
 * Citation-manifest agreement check (DDM-P0-T13). tests/enso-citations.spec.ts
 * asserts the three Pacific Northwest tilt sentences against
 * tests/fixtures/citation-manifest.json, a small tracked copy of three
 * entries from the private references ledger,
 * planning/references/register.yaml. That ledger is a directory junction
 * into a private repository (planning/) and is absent from the public tree
 * and from CI (scripts/check-public-tree.mjs forbids the path), so the spec
 * can no longer read it directly; this script is what keeps the tracked
 * manifest honest against the ledger, on whichever machine still has it.
 *
 * Two outcomes, both a clean exit:
 *   - the ledger is present (the maintainer's machine, through the
 *     planning/ junction): every manifest entry's url must equal the
 *     ledger's url for that id, or this fails and exits 1.
 *   - the ledger is absent (CI, or any checkout without the junction): the
 *     manifest cannot be verified here, and that is reported honestly rather
 *     than silently assumed clean.
 *
 * Deliberately a small text scan of the YAML rather than a YAML dependency,
 * matching what the spec itself used to do: the point is only to compare
 * the url the manifest carries against the url the ledger carries.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_PATH = join('tests', 'fixtures', 'citation-manifest.json');
const LEDGER_PATH = join('planning', 'references', 'register.yaml');

/** The `url:` the private ledger records for one `- id:` block, or null. */
function ledgerUrl(yaml, id) {
  const block = new RegExp(`^  - id: ${id}\\s*$([\\s\\S]*?)(?=^  - id: |\\Z)`, 'm').exec(yaml);
  if (!block) return null;
  const url = /^\s*url:\s*"([^"]+)"\s*$/m.exec(block[1]);
  return url ? url[1] : null;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const entries = manifest.entries ?? [];

if (!existsSync(LEDGER_PATH)) {
  console.log(
    `citation-manifest check: private ledger unavailable (${entries.length} entries unverified against it)`
  );
  process.exit(0);
}

const yaml = readFileSync(LEDGER_PATH, 'utf8');
const problems = [];
for (const entry of entries) {
  const ledger = ledgerUrl(yaml, entry.id);
  if (ledger === null) {
    problems.push(`"${entry.id}" is in the manifest but not in the private references ledger`);
  } else if (ledger !== entry.url) {
    problems.push(
      `"${entry.id}" disagrees: manifest has "${entry.url}", ledger has "${ledger}"`
    );
  }
}

if (problems.length > 0) {
  console.error(`citation-manifest check: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `citation-manifest check: clean (${entries.length} entries agree with the private references ledger)`
);
