/**
 * The `verify:pure` membership rule (DR-052 b; playwright.pure.config.ts).
 *
 * Every file the pure lane lists must stay browser-free: no fixture name,
 * no boot helper, no navigation. The pure config has no `webServer`, so a
 * listed file that grows a browser case would not fail loudly there; it
 * would wait on a page that never comes, or pass a `page`-less assertion it
 * did not mean to. This test fails first, at `check:all`, naming the file
 * and the token, so the file leaves the list before the lane misreports.
 *
 * The counting rule is the one the 2026-09-02 packet used (Appendix A,
 * section 2): a case is pure when its body mentions none of `page`,
 * `browser`, `context`, `request`, `browserName`, `gotoApp`, `newPage`,
 * `newContext`. Applied here per FILE, as a word-boundary scan over the
 * source with comments stripped, which is stricter than per case on
 * purpose: a mixed file belongs to the main config, not to this lane.
 *
 * This lexical rule guards fixture requests and boot helpers in the spec's
 * OWN source; it cannot see a DOM API (`document.`/`window.`) reached
 * transitively through an `import` from `src/`, and it does not try to
 * (DDM-P15-T08). That gap is closed a different way: `verify:pure` now runs
 * inside `check:all` (this file's own third test), so a spec whose imported
 * code reaches the DOM fails loudly there, in the pure lane itself, the
 * first time the gate runs it.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * How a spec asks for a browser: a Playwright fixture destructured from a
 * test or hook callback (`async ({ page }) =>`, `({ context, request })`),
 * or a boot helper that needs a page. Matched as fixture REQUESTS rather
 * than as bare words, because a pure spec may legitimately name a local
 * `context` or `request` of its own (the probe spec does), and a bare-word
 * scan would evict it for its vocabulary rather than for its needs.
 */
const FIXTURE_NAMES = ['page', 'browser', 'context', 'request', 'browserName'];
const FIXTURE_REQUEST = new RegExp(
  `\\(\\s*\\{[^}]*\\b(?:${FIXTURE_NAMES.join('|')})\\b[^}]*\\}\\s*\\)\\s*=>`
);
const BROWSER_HELPERS = ['gotoApp', 'newPage', 'newContext'];

export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function pureSpecsFromConfig() {
  const config = await readFile(join(ROOT, 'playwright.pure.config.ts'), 'utf8');
  const block = /export const PURE_SPECS = \[([\s\S]*?)\] as const;/.exec(config);
  assert.ok(block, 'PURE_SPECS is not declared as an `as const` array in playwright.pure.config.ts');
  const files = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length > 0, 'PURE_SPECS is empty');
  return files;
}

test('every pure-lane spec is browser-free by the packet counting rule', async () => {
  const files = await pureSpecsFromConfig();
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted, 'PURE_SPECS must stay alphabetical so a diff reads as a membership change');
  for (const file of files) {
    const source = stripComments(await readFile(join(ROOT, file), 'utf8'));
    const request = FIXTURE_REQUEST.exec(source);
    assert.equal(
      request,
      null,
      `${file} requests a browser fixture (${request?.[0] ?? ''}); it needs the main config, not the pure lane`
    );
    for (const helper of BROWSER_HELPERS) {
      const hit = new RegExp(`\\b${helper}\\s*\\(`).exec(source);
      assert.equal(
        hit,
        null,
        `${file} calls ${helper}(), which needs a page; it needs the main config, not the pure lane`
      );
    }
  }
});

test('the pure config carries no web server and one project', async () => {
  const config = await readFile(join(ROOT, 'playwright.pure.config.ts'), 'utf8');
  // The lane's whole point is the absence of the build-and-serve step; the
  // inherited object must have it stripped, not merely overridden to a
  // second server.
  assert.match(config, /const \{ webServer: _webServer, projects: _projects, \.\.\.inherited \} = base;/);
  assert.doesNotMatch(config, /\bwebServer:\s*\{/);
  assert.match(config, /name: 'pure'/);
});

test('the pure lane is wired as verify:pure and the ladder documents it', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:pure'],
    'playwright test -c playwright.pure.config.ts --workers=1'
  );
  const readme = await readFile(join(ROOT, 'tests', 'README.md'), 'utf8');
  assert.match(readme, /`npm run verify:pure`/);
});

// Found while writing this assertion (2026-09-12, DDM-P15-T08): two files,
// tests/camera-region-fallbacks.spec.ts and tests/config-key-authority.spec.ts,
// sat in both PURE_SPECS and the verify:smoke roster. Since `verify:smoke`
// runs `gate` (which now runs verify:pure inside check:all) and then its own
// named roster, each ran twice inside one `verify:smoke` call. The director
// removed both from the verify:smoke roster in the same commit; they still
// run once per smoke, through the pure lane. No overlap is excused.
test('every pure-lane spec exists on disk and none also sits in the smoke roster', async () => {
  const files = await pureSpecsFromConfig();
  for (const file of files) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is listed in PURE_SPECS but is not on disk`);
  }
  // A spec in both lanes runs twice per gate (once under verify:pure, once
  // under verify:smoke's own named roster). Read the roster straight out of
  // the verify:smoke script rather than duplicating it here, so the two
  // lists cannot drift apart silently.
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const smokeScript = pkg.scripts['verify:smoke'];
  assert.ok(smokeScript, 'verify:smoke script is missing from package.json');
  const smokeRoster = new Set([...smokeScript.matchAll(/tests\/[\w.-]+\.spec\.ts/g)].map((m) => m[0]));
  const overlap = files.filter((file) => smokeRoster.has(file));
  assert.deepEqual(overlap, [], 'a pure-lane spec also appears in the verify:smoke roster and would run twice per gate');
});
