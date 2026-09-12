/**
 * Config-level proof (DDM-P15-T08, ROADMAP.yaml DDM-P15-T08 clause 4):
 * `npm test` and `npm run test:serial` cannot collect
 * tests/mode-switch-cost.spec.ts, and `npm run measure:mode-switch` collects
 * nothing else.
 *
 * package.json's `test` and `test:serial` used to be bare `playwright test`
 * invocations, which collect every project, including `chromium-measure`
 * (playwright.config.ts's fourth project, added for DDM-P14-T08's
 * mode-switch measurement alone). Route A (smallest, per the DDM-P15-T08
 * brief): both scripts now name
 * `--project=chromium --project=chromium-interaction --project=chromium-3d`
 * explicitly, the same three projects CI's fixed matrix names
 * (.github/workflows/browser-suite.yml); playwright.config.ts is unchanged.
 *
 * Two checks: (1) the script text itself names exactly the right projects
 * and never chromium-measure, and `measure:mode-switch` names only
 * chromium-measure; (2) `playwright test --list` (collects without a build
 * or a browser) run with each script's own project flags actually
 * excludes/includes the measurement spec. If `--list` ever starts the
 * webServer or grows past about twenty seconds, this file would need to
 * fall back to parsing playwright.config.ts's `MEASURE_SPECS` and project
 * names instead of shelling out; measured at write time (2026-09-12) it took
 * low single-digit seconds and started no server, so that fallback is not
 * implemented.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const THREE_PROJECTS = ['chromium', 'chromium-interaction', 'chromium-3d'];
const LIST_BUDGET_MS = 20_000;

async function readPkg() {
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
}

function projectFlagsIn(script) {
  return [...script.matchAll(/--project=(\S+)/g)].map((m) => m[1]);
}

test('test and test:serial name exactly the three CI projects, never chromium-measure', async () => {
  const pkg = await readPkg();
  for (const name of ['test', 'test:serial']) {
    const script = pkg.scripts[name];
    assert.ok(script, `${name} script is missing`);
    assert.deepEqual(
      projectFlagsIn(script),
      THREE_PROJECTS,
      `${name} must name exactly ${THREE_PROJECTS.join(', ')}, in order`
    );
    assert.doesNotMatch(script, /chromium-measure/, `${name} must never name chromium-measure`);
  }
});

test('measure:mode-switch names only chromium-measure', async () => {
  const pkg = await readPkg();
  const script = pkg.scripts['measure:mode-switch'];
  assert.ok(script, 'measure:mode-switch script is missing');
  assert.deepEqual(
    projectFlagsIn(script),
    ['chromium-measure'],
    'measure:mode-switch must name only chromium-measure'
  );
});

/**
 * Resolve the Playwright CLI from this project's own installed
 * `@playwright/test` package: the same doctrine
 * tests/types/check-context-literal-typo.mjs uses for `tsc` (no global
 * binary, no PATH guess, this process's own node).
 */
function resolvePlaywrightCli() {
  const require = createRequire(join(ROOT, 'package.json'));
  const pkgPath = require.resolve('@playwright/test/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright;
  assert.ok(binRelative, '@playwright/test package.json declares no "playwright" bin entry');
  return join(dirname(pkgPath), binRelative);
}

function listSpecs(projectFlags) {
  const cli = resolvePlaywrightCli();
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '--list', ...projectFlags.flatMap((p) => ['--project', p])],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000 }
  );
  const elapsedMs = Date.now() - started;
  if (result.error) {
    assert.fail(`playwright --list (${projectFlags.join(',')}) could not run: ${result.error.message}`);
  }
  assert.equal(
    result.status,
    0,
    `playwright --list (${projectFlags.join(',')}) exited ${result.status}: ${result.stderr}`
  );
  assert.ok(
    elapsedMs < LIST_BUDGET_MS,
    `playwright --list (${projectFlags.join(',')}) took ${elapsedMs}ms, over the ~${LIST_BUDGET_MS}ms budget ` +
      'this test assumes (no webServer, no browser); this config-level proof needs the ' +
      'playwright.config.ts-parsing fallback described in this file\'s header if that budget stops holding'
  );
  return { lines: (result.stdout ?? '').split(/\r?\n/), elapsedMs };
}

test('playwright test --list with the test script projects never lists mode-switch-cost.spec.ts', () => {
  const { lines, elapsedMs } = listSpecs(THREE_PROJECTS);
  console.log(`playwright --list (${THREE_PROJECTS.join(',')}) took ${elapsedMs}ms`);
  const hit = lines.find((line) => line.includes('mode-switch-cost.spec.ts'));
  assert.equal(hit, undefined, `mode-switch-cost.spec.ts is collected by the test script's own projects: ${hit}`);
});

test('playwright test --list --project=chromium-measure lists mode-switch-cost.spec.ts and nothing else', () => {
  const { lines, elapsedMs } = listSpecs(['chromium-measure']);
  console.log(`playwright --list (chromium-measure) took ${elapsedMs}ms`);
  const specLines = lines.filter((line) => line.trim().startsWith('['));
  assert.ok(specLines.length > 0, 'chromium-measure listed no tests at all');
  for (const line of specLines) {
    assert.match(
      line,
      /mode-switch-cost\.spec\.ts/,
      `chromium-measure listed a spec other than mode-switch-cost.spec.ts: ${line}`
    );
  }
});
