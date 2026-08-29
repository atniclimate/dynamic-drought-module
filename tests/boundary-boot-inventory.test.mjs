import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * DDM-P1-T08 acceptance, part two: a future spec cannot boot the application
 * against the live Census AIANNH or BIA AIAN-LAR services by accident.
 *
 * `tests/boundary-stubs.spec.ts` proves the stub holds for the boot shells the
 * suite drives TODAY. This file is the static counterpart: it walks every
 * browser spec and fails when a navigation bypasses `gotoApp` without a
 * recorded reason and without installing the suite-wide boundary stub itself,
 * and when a spec registers a boundary route outside the shared helper (which
 * would be shadowed by `gotoApp`, since Playwright matches route handlers in
 * reverse registration order).
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `node:test` files in the gate.
 */

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Navigation that does not go through `gotoApp`: `page.goto`, `frame.goto`,
 * and `page.setContent` (a synthesized host document that frames the app).
 * `page.reload()` is deliberately NOT here: a reload replays the routes the
 * boot already installed, so it cannot reach an agency the boot did not.
 */
const RAW_NAVIGATION = /\.(?:goto|setContent)\s*\(/g;

/** Any spelling of the two sovereign-boundary services. */
const BOUNDARY_MARKER =
  /AIANNH_ROUTE|BIA_ROUTE|tigerweb\.geo\.census\.gov|biamaps\.geoplatform\.gov|AIANNHA\/MapServer|BIA_AIAN_National_LAR/;

/** Anything that installs or claims a boundary route for the page. */
const INSTALLS_BOUNDARY_STUB = /routeAllTribalFixtures\(|routeBoundary\(|routeGeojson\(|installBoundaryStubs\(/;

/**
 * Every browser spec that navigates without `gotoApp`, with the reason and
 * the number of such sites. A new raw boot fails this test until it is
 * recorded here, which is the moment to ask whether it needs the boundary
 * stub installed by hand (it does: see `routeAllTribalFixtures` in each file
 * below).
 */
const DIRECT_BOOT_REASONS = {
  'tests/deployment-subpath.spec.ts': {
    sites: 1,
    reason:
      'boots the production artifact from the GitHub Pages subpath mount, which gotoApp does not model'
  },
  'tests/embed-viewport.spec.ts': {
    sites: 1,
    reason:
      'navigates to a synthesized host page that frames the app in an iframe at the minimum embed width'
  },
  'tests/island-premount.spec.ts': {
    sites: 1,
    reason:
      'aborts the island chunk, so gotoApp catalog-independent boot signal cannot be used and the pre-mount window is the subject'
  },
  'tests/studio-guards.spec.ts': {
    sites: 2,
    reason:
      'frames the app inside a synthesized host document and renavigates that frame to reach each studio route guard'
  },
  'tests/umbrella.spec.ts': {
    sites: 3,
    reason:
      'three embed boots assert that no catalog island is requested, which the gotoApp island wait would defeat'
  },
  'tests/view-mode.spec.ts': {
    sites: 1,
    reason: 'asserts that a brief embed boot has no catalog DOM at all to wait for'
  }
};

async function browserSpecs() {
  const names = (await readdir(TESTS_DIR)).filter((name) => name.endsWith('.spec.ts'));
  names.sort();
  const files = [];
  for (const name of names) {
    files.push({
      key: `tests/${name}`,
      source: await readFile(join(TESTS_DIR, name), 'utf8')
    });
  }
  return files;
}

/** Count matches, ignoring line comments so prose about `page.goto(` is inert. */
function countOutsideComments(source, pattern) {
  const code = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, ''))
    .join('\n');
  return [...code.matchAll(pattern)].length;
}

test('every browser spec boots through gotoApp, or records why it does not', async () => {
  const files = await browserSpecs();
  assert.ok(files.length >= 100, `expected the browser suite, found ${files.length} specs`);

  const unrecorded = [];
  const miscounted = [];
  const unstubbed = [];
  for (const { key, source } of files) {
    const sites = countOutsideComments(source, RAW_NAVIGATION);
    const recorded = DIRECT_BOOT_REASONS[key];
    if (sites === 0) {
      if (recorded) miscounted.push(`${key}: recorded ${recorded.sites} raw boots, found none`);
      continue;
    }
    if (!recorded) {
      unrecorded.push(`${key}: ${sites} navigation site(s) outside gotoApp with no recorded reason`);
      continue;
    }
    if (recorded.sites !== sites) {
      miscounted.push(`${key}: recorded ${recorded.sites} raw boots, found ${sites}`);
    }
    if (!INSTALLS_BOUNDARY_STUB.test(source)) {
      unstubbed.push(`${key}: boots outside gotoApp and installs no boundary stub of its own`);
    }
  }

  assert.deepEqual(unrecorded, [], 'unrecorded boots that bypass the suite-wide boundary stub');
  assert.deepEqual(miscounted, [], 'recorded raw-boot counts that no longer match the specs');
  assert.deepEqual(unstubbed, [], 'raw boots that could reach a live sovereign-geography service');

  for (const [key, entry] of Object.entries(DIRECT_BOOT_REASONS)) {
    assert.ok(files.some((file) => file.key === key), `${key} is recorded but no longer exists`);
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length > 20,
      `${key} needs a real reason, not a placeholder`
    );
  }
});

test('no browser spec registers a boundary route outside the shared helper', async () => {
  const files = await browserSpecs();
  const offenders = [];
  for (const { key, source } of files) {
    for (const match of source.matchAll(/\.route\(\s*([^,\n]*)/g)) {
      if (BOUNDARY_MARKER.test(match[1] ?? '')) {
        offenders.push(`${key}: page.route(${(match[1] ?? '').trim()}, ...)`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'boundary routes must go through routeBoundary (a raw page.route is shadowed by gotoApp)'
  );
});

test('the shared boot helper installs the boundary stub on every boot it drives', async () => {
  const helpers = await readFile(join(TESTS_DIR, 'helpers.ts'), 'utf8');
  assert.match(helpers, /import \{ installBoundaryStubs/);
  const gotoApp = helpers.slice(helpers.indexOf('export async function gotoApp'));
  const body = gotoApp.slice(0, gotoApp.indexOf('page.goto('));
  assert.match(
    body,
    /await installBoundaryStubs\(page, options\.boundaries \?\? 'fixture'\);/,
    'gotoApp must install the boundary stub before it navigates'
  );
});

test('the fixture route patterns still match the URLs the runtime builds', async () => {
  const urls = await readFile(join(ROOT, 'src/config/urls.ts'), 'utf8');
  const aiannhLayer = await readFile(join(ROOT, 'src/layers/aiannh.ts'), 'utf8');
  const biaLayer = await readFile(join(ROOT, 'src/layers/bia-reservations.ts'), 'utf8');
  const fixtures = await readFile(join(TESTS_DIR, 'tribal-fixtures.ts'), 'utf8');

  // A silent change to either service path would stop the glob from matching
  // and every boot would quietly go live again, which is exactly the failure
  // this task exists to prevent.
  assert.match(urls, /censusAiannhMapServer:\s*\r?\n?\s*'https:\/\/tigerweb\.geo\.census\.gov\//);
  assert.match(urls, /biaLarFeatureServer:\s*\r?\n?\s*'https:\/\/biamaps\.geoplatform\.gov\//);
  assert.match(urls, /tigerweb\.geo\.census\.gov\/arcgis\/rest\/services\/TIGERweb\/AIANNHA\/MapServer/);
  assert.match(urls, /biamaps\.geoplatform\.gov\/server\/rest\/services\/DivLTR\/BIA_AIAN_National_LAR\/FeatureServer\/0/);
  assert.match(aiannhLayer, /censusAiannhMapServer\}\/47\/query\?/);
  assert.match(biaLayer, /biaLarFeatureServer\}\/query\?/);

  assert.match(
    fixtures,
    /AIANNH_ROUTE = '\*\*\/tigerweb\.geo\.census\.gov\/\*\*\/MapServer\/47\/query\*'/
  );
  assert.match(
    fixtures,
    /BIA_ROUTE = '\*\*\/biamaps\.geoplatform\.gov\/\*\*\/FeatureServer\/0\/query\*'/
  );
});
