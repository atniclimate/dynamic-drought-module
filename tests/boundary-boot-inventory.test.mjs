import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

/**
 * DDM-P1-T08 acceptance, part two: a future spec cannot boot the application
 * against a live sovereign-geography service by accident, and cannot put a
 * live external geometry body into a retained CI artifact.
 *
 * `tests/boundary-stubs.spec.ts` proves the stub holds DYNAMICALLY for the
 * boot shells `gotoApp` drives. This file is the STATIC counterpart, and it
 * is what covers the rest: it walks every module under `tests/` (specs,
 * shared helpers, and fixture modules alike, at any depth) and fails when a
 * navigation bypasses `gotoApp` without a recorded reason and without
 * installing the suite-wide stub itself, when a module creates a second Page
 * the routing was not written for, when a module registers or removes a
 * stubbed route outside its shared home, and when a spec reaches for the live
 * mode outside the one recorded allowance.
 *
 * WHAT THIS FILE IS AND IS NOT (the honest scope, after the 2026-08-29
 * adversarial review). A source scan is best-effort: it cannot see a
 * navigation driven from inside `page.evaluate`, an option assembled at
 * runtime, or a helper that is imported but never called. It is a tripwire
 * that makes the unusual thing visible in review, not the guarantee. The
 * GUARANTEE is elsewhere and does not depend on this file being exhaustive:
 * the suite-wide stubs are registered on the browser CONTEXT, so they cover
 * every Page in it including one this suite never opened, they are
 * fail-closed so an unrecognized request is fulfilled rather than forwarded,
 * and `installBoundaryStubs` THROWS on the live mode whenever `CI` is set.
 * This file's job is to keep those three properties from being quietly
 * removed, and to make a new seam a conversation.
 *
 * The recorded site COUNTS in `DIRECT_BOOT_REASONS` are brittle on purpose.
 * Adding an unrelated `.setContent(` or `.goto(` to one of these files fails
 * this test, which is the moment to ask whether the new site needs the
 * boundary stub installed by hand. Update the count in the same commit.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `node:test` files in the gate.
 */

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** This file's own name, so its prose and regexes do not scan themselves. */
const SELF = 'tests/boundary-boot-inventory.test.mjs';

/**
 * Navigation that does not go through `gotoApp`: `page.goto`, `frame.goto`,
 * and `page.setContent` (a synthesized host document that frames the app).
 * `page.reload()` is deliberately NOT here: a reload replays the routes the
 * boot already installed, so it cannot reach an agency the boot did not.
 */
const RAW_NAVIGATION = /\.(?:goto|setContent)\s*\(/g;

/**
 * A second Page. Page-level routes do not follow one, and before 2026-08-29
 * neither did the boundary stub. The stub is on the context now, so a popup
 * inherits it, but a new Page is still a boot nobody wrote a stub call for
 * and still deserves a review conversation rather than a silent pass.
 */
const SECOND_PAGE = /\.newPage\s*\(|waitForEvent\s*\(\s*['"]popup['"]|['"]popup['"]\s*\)/g;

/** Any spelling of the two sovereign-boundary services. */
const BOUNDARY_MARKER =
  /AIANNH_ROUTE|BIA_ROUTE|tigerweb\.geo\.census\.gov|biamaps\.geoplatform\.gov|AIANNHA\/MapServer|BIA_AIAN_National_LAR/;

/** Any spelling of the minimap's two continental analysis inputs. */
const MINIMAP_MARKER =
  /NA_LAND_BASE_ROUTE|NUNAVUT_ANALYSIS_ROUTE|na\/base\/northamerica\.geojson|Digital_boundary_files\/MapServer/;

/** Anything that installs or claims a boundary route for the page. */
const INSTALLS_BOUNDARY_STUB =
  /routeAllTribalFixtures\(|routeBoundary\(|routeGeojson\(|installBoundaryStubs\(/;

/**
 * The minimap's continental analysis stub. A module that boots outside
 * `gotoApp` misses it exactly as it misses the boundary stub, and until
 * 2026-08-29 all six recorded raw boots did: their pages fetched
 * `ncei.noaa.gov` and `geo.statcan.gc.ca` live. Checked SEPARATELY from
 * INSTALLS_BOUNDARY_STUB rather than folded into it, because an OR would let
 * a module satisfy the boundary requirement by installing only the minimap
 * stub.
 */
const INSTALLS_MINIMAP_STUB = /installMinimapAnalysisStubs\(/;

/**
 * Pixel capture. `toHaveScreenshot` is visual-regression comparison and
 * `attach` hands an arbitrary buffer to the reporter and the trace; neither
 * is used here, and the first use of either should be a decision, because CI
 * retains traces and reports on a public repository. `page.screenshot()` is
 * different: it has legitimate in-test uses, so it is recorded per file
 * below rather than banned.
 */
const PIXEL_CAPTURE = /toHaveScreenshot\s*\(|\.attach\s*\(/g;

/** Removing a route. Banned outright; see the assertion message. */
const UNROUTE = /\.unroute(?:All)?\s*\(/g;

/**
 * The live boundary mode, in any spelling a module is likely to reach for:
 * the option literal `boundaries: 'live'`, and a named constant or typed
 * variable whose line mentions a boundary and the literal. Matching the LINE
 * rather than an exact option shape is what catches the ternary form the
 * fire3d allowance uses.
 */
const LIVE_BOUNDARY_MODE = /boundar[a-z]*[^\n]*['"]live['"]/i;

/**
 * The modules allowed to call `page.route` on each stubbed pattern family:
 * the one place each shared helper and its suite-wide stub are defined.
 */
const ROUTE_HOMES = [
  { home: 'tests/tribal-fixtures.ts', marker: BOUNDARY_MARKER, family: 'boundary' },
  { home: 'tests/minimap-fixtures.ts', marker: MINIMAP_MARKER, family: 'minimap analysis' }
];

/**
 * The one module allowed to ask for live boundaries, and the guard it must
 * carry. `tests/fire3d-mode.spec.ts` writes the owner's local visual-review
 * captures to the gitignored `fire3d-evidence/`; a capture of the synthetic
 * rectangles cannot answer the question those captures exist to answer, so
 * the three evidence-bearing boots ask for the real cartography, and only
 * when `CI` is unset. `installBoundaryStubs` throws if that guard is ever
 * removed, so this record is the review tripwire, not the enforcement.
 */
const LIVE_BOUNDARY_ALLOWANCE = {
  file: 'tests/fire3d-mode.spec.ts',
  guard: /!process\.env\['CI'\]/,
  reason:
    'the local-only fire3d evidence captures render real boundary cartography for the owner visual review, and are skipped under CI'
};

/**
 * Every browser module that navigates without `gotoApp`, with the reason and
 * the number of such sites. A new raw boot fails this test until it is
 * recorded here, which is the moment to ask whether it needs the boundary
 * stub installed by hand (it does: every file below calls
 * `routeAllTribalFixtures` or `routeBoundary` for exactly that reason).
 */
const DIRECT_BOOT_REASONS = {
  'tests/helpers.ts': {
    sites: 1,
    reason:
      'this is gotoApp itself, the one navigation the whole suite is funnelled through, and it installs the suite-wide stub immediately before it'
  },
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

/**
 * Modules allowed to create a second Page, with the reason. Empty today, and
 * that is the point: the first one to appear fails this test.
 */
const SECOND_PAGE_REASONS = {};

/**
 * Modules allowed to call `page.screenshot()`, with the reason and the site
 * count. Both entries write or read pixels WITHOUT handing them to the trace:
 * the config sets `attachments: false` in CI, so a screenshot buffer a spec
 * takes for its own use is not stored in a retained artifact. A new site here
 * is the moment to check that is still true.
 */
const SCREENSHOT_REASONS = {
  'tests/fire3d-mode.spec.ts': {
    sites: 4,
    reason:
      'the owner visual-review evidence captures, written to the gitignored fire3d-evidence/ and skipped under CI'
  },
  'tests/m-breadth-heatrisk-days.spec.ts': {
    sites: 1,
    reason:
      'reads the map canvas back as a buffer to assert rendered colour bands in the test itself, and never attaches it'
  }
};

/**
 * Modules allowed to remove a route, with the reason and the site count.
 * Both entries below unroute a LITERAL, non-sensitive pattern and immediately
 * replace it; neither touches a boundary or minimap route. The counts are
 * brittle on purpose, and a RegExp or variable argument, an `unrouteAll()`,
 * or a new site in any other file fails the check outright.
 */
const UNROUTE_REASONS = {
  'tests/place-studio-brief.spec.ts': {
    sites: 3,
    reason:
      'drops the same-origin us-states.geojson stub installed for the file so three cases can serve a narrower state collection instead'
  },
  'tests/satellite-fixture.ts': {
    sites: 1,
    reason:
      'replaces its own satellite tile fixture with an aborting handler for the tile-failure path, in the module that owns that route'
  }
};

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

/**
 * Every module under tests/, at ANY depth. Playwright's testDir is
 * recursive, so a spec in a subdirectory is a real spec; a top-level-only
 * scan would let one escape every rule below.
 */
async function testModules(dir = TESTS_DIR, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await testModules(full, files);
      continue;
    }
    if (!MODULE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    const key = `tests/${relative(TESTS_DIR, full).split(sep).join('/')}`;
    if (key === SELF) continue;
    files.push({
      key,
      isSpec: key.endsWith('.spec.ts'),
      source: await readFile(full, 'utf8')
    });
  }
  return files;
}

/** Strip line comments so prose about a banned call is inert. */
function code(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, ''))
    .join('\n');
}

function countOutsideComments(source, pattern) {
  return [...code(source).matchAll(pattern)].length;
}

test('every browser module boots through gotoApp, or records why it does not', async () => {
  const files = await testModules();
  assert.ok(files.length >= 100, `expected the browser suite, found ${files.length} modules`);
  assert.ok(
    files.some((file) => file.key === 'tests/helpers.ts'),
    'the shared helpers module must be in scope'
  );
  assert.ok(
    files.some((file) => file.key.includes('/')),
    'the scan must reach modules in subdirectories, or it is not recursive'
  );

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
    if (!INSTALLS_MINIMAP_STUB.test(source)) {
      unstubbed.push(`${key}: boots outside gotoApp and installs no minimap analysis stub of its own`);
    }
  }

  assert.deepEqual(unrecorded, [], 'unrecorded boots that bypass the suite-wide boundary stub');
  assert.deepEqual(miscounted, [], 'recorded raw-boot counts that no longer match the modules');
  assert.deepEqual(unstubbed, [], 'raw boots that could reach a live sovereign-geography service');

  for (const [key, entry] of Object.entries(DIRECT_BOOT_REASONS)) {
    assert.ok(files.some((file) => file.key === key), `${key} is recorded but no longer exists`);
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length > 20,
      `${key} needs a real reason, not a placeholder`
    );
  }
});

test('no browser module opens a second Page without recording why', async () => {
  const files = await testModules();
  const offenders = [];
  for (const { key, source } of files) {
    if (countOutsideComments(source, SECOND_PAGE) === 0) continue;
    if (SECOND_PAGE_REASONS[key]) continue;
    offenders.push(`${key}: creates or awaits a second Page with no recorded reason`);
  }
  assert.deepEqual(
    offenders,
    [],
    // A second Page is a boot nobody wrote a stub call for. The context-level
    // stubs do follow it, which is why this is a review tripwire and not the
    // guarantee, but a popup also brings its own basemap, its own request
    // stream, and its own trace entries, so it should be a decision.
    'a new Page or popup must be recorded in SECOND_PAGE_REASONS, with its stub story'
  );
});

test('no browser module registers or removes a stubbed route outside its shared helper', async () => {
  const files = await testModules();
  const offenders = [];
  for (const { key, source } of files) {
    for (const { home, marker, family } of ROUTE_HOMES) {
      if (key === home) continue;
      for (const match of code(source).matchAll(/\.(route|unroute)\(\s*([^,)\n]*)/g)) {
        const [, method, argument] = match;
        if (!marker.test(argument ?? '')) continue;
        offenders.push(`${key}: ${family}: page.${method}(${(argument ?? '').trim()}...)`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    // A raw page.route on one of these patterns duplicates a body the shared
    // helper already serves, and drifts from it silently. A page.unroute is
    // worse: it strands the suite-wide stub's only backstop for that pattern.
    'stubbed routes must go through their shared helper, and must never be unrouted'
  );
});

test('the live boundary mode appears only in the one recorded allowance', async () => {
  const files = await testModules();
  const offenders = [];
  let allowanceSeen = false;
  for (const { key, source } of files) {
    if (key === 'tests/tribal-fixtures.ts') continue;
    if (!LIVE_BOUNDARY_MODE.test(code(source))) continue;
    if (key === LIVE_BOUNDARY_ALLOWANCE.file) {
      allowanceSeen = true;
      assert.match(
        source,
        LIVE_BOUNDARY_ALLOWANCE.guard,
        `${key} asks for live boundaries, so it must gate them on CI being unset`
      );
      continue;
    }
    offenders.push(key);
  }
  assert.deepEqual(
    offenders,
    [],
    // The live mode is documented so a future maintainer knows the seam
    // exists, not so it can ride into CI. `installBoundaryStubs` throws on it
    // whenever CI is set, so this scan is the review tripwire; the throw is
    // the enforcement.
    `only ${LIVE_BOUNDARY_ALLOWANCE.file} may ask for live boundaries (${LIVE_BOUNDARY_ALLOWANCE.reason})`
  );
  assert.ok(
    allowanceSeen,
    `${LIVE_BOUNDARY_ALLOWANCE.file} no longer asks for live boundaries: drop the allowance rather than leaving a stale one`
  );
});

test('the live boundary mode is refused at runtime under CI, not only in a source scan', async () => {
  const fixtures = await readFile(join(TESTS_DIR, 'tribal-fixtures.ts'), 'utf8');
  // The throw is what makes an alias, a wrapper, or a computed option
  // harmless. Losing it would leave only the grep above, which the review
  // that produced this test showed to be bypassable.
  assert.match(
    fixtures,
    /if \(mode === 'live' && process\.env\['CI'\]\) \{[\s\S]{0,80}throw new Error\(/,
    'installBoundaryStubs must refuse the live mode under CI'
  );
});

test('the shared boot helper installs both suite-wide stubs on every boot it drives', async () => {
  const helpers = await readFile(join(TESTS_DIR, 'helpers.ts'), 'utf8');
  assert.match(helpers, /import \{ installBoundaryStubs/);
  assert.match(helpers, /import \{ installMinimapAnalysisStubs \}/);
  const gotoApp = helpers.slice(helpers.indexOf('export async function gotoApp'));
  const body = gotoApp.slice(0, gotoApp.indexOf('page.goto('));
  assert.match(
    body,
    /await installBoundaryStubs\(page, options\.boundaries \?\? 'fixture'\);/,
    'gotoApp must install the boundary stub before it navigates'
  );
  assert.match(
    body,
    /await installMinimapAnalysisStubs\(page\);/,
    'gotoApp must install the minimap analysis stub before it navigates'
  );
});

test('the suite-wide stubs route the browser context, so a Page nobody opened is still covered', async () => {
  const fixtures = await readFile(join(TESTS_DIR, 'tribal-fixtures.ts'), 'utf8');
  const minimap = await readFile(join(TESTS_DIR, 'minimap-fixtures.ts'), 'utf8');
  // Page-level routing was the hole the 2026-08-29 review named: a popup or
  // an explicit newPage would have reached the agency. Context routing is
  // what closes it, and it must not quietly become page routing again.
  assert.match(fixtures, /await context\.route\(BOUNDARY_PATTERNS\[service\]/);
  assert.match(minimap, /await context\.route\(NA_LAND_BASE_ROUTE/);
  assert.match(minimap, /await context\.route\(NUNAVUT_ANALYSIS_ROUTE/);
});

test('the fixture route patterns still match the URLs the runtime builds', async () => {
  const urls = await readFile(join(ROOT, 'src/config/urls.ts'), 'utf8');
  const aiannhLayer = await readFile(join(ROOT, 'src/layers/aiannh.ts'), 'utf8');
  const biaLayer = await readFile(join(ROOT, 'src/layers/bia-reservations.ts'), 'utf8');
  const fixtures = await readFile(join(TESTS_DIR, 'tribal-fixtures.ts'), 'utf8');
  const minimap = await readFile(join(TESTS_DIR, 'minimap-fixtures.ts'), 'utf8');

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

  // The same drift check for the minimap's two continental analysis inputs.
  assert.match(urls, /nadmNorthAmericaBaseGeojson:\s*\r?\n?\s*'https:\/\/www\.ncei\.noaa\.gov\//);
  assert.match(urls, /\/na\/base\/northamerica\.geojson'/);
  assert.match(urls, /statsCanNunavutBoundaryGeojson:\s*\r?\n?\s*'https:\/\/geo\.statcan\.gc\.ca\//);
  assert.match(urls, /Digital_boundary_files\/MapServer\/0\/query\?/);
  assert.match(minimap, /NA_LAND_BASE_ROUTE = '\*\*\/na\/base\/northamerica\.geojson'/);
  assert.match(
    minimap,
    /NUNAVUT_ANALYSIS_ROUTE = '\*\*\/Digital_boundary_files\/MapServer\/0\/query\?\*\*'/
  );
});

test('no browser module captures pixels into a retained artifact', async () => {
  const files = await testModules();
  const banned = [];
  const unrecorded = [];
  const miscounted = [];
  for (const { key, source } of files) {
    if (countOutsideComments(source, PIXEL_CAPTURE) > 0) {
      banned.push(`${key}: uses toHaveScreenshot() or attach()`);
    }
    const sites = countOutsideComments(source, /\.screenshot\s*\(/g);
    const recorded = SCREENSHOT_REASONS[key];
    if (sites === 0) {
      if (recorded) miscounted.push(`${key}: recorded ${recorded.sites} screenshot sites, found none`);
      continue;
    }
    if (!recorded) {
      unrecorded.push(`${key}: ${sites} page.screenshot() site(s) with no recorded reason`);
      continue;
    }
    if (recorded.sites !== sites) {
      miscounted.push(`${key}: recorded ${recorded.sites} screenshot sites, found ${sites}`);
    }
  }
  assert.deepEqual(
    banned,
    [],
    // A visual-regression baseline or an attached buffer is a rendered map
    // frame, and CI retains traces and reports publicly. The config keeps
    // pixels out (`screenshots: false`, `screenshot: 'off'`, `video: 'off'`,
    // `attachments: false`); this keeps a spec from putting them back.
    'toHaveScreenshot() and attach() would place rendered pixels in a retained public artifact'
  );
  assert.deepEqual(unrecorded, [], 'unrecorded page.screenshot() sites');
  assert.deepEqual(miscounted, [], 'recorded screenshot-site counts that no longer match');
});

test('the CI trace object keeps every pixel and source channel off', async () => {
  const config = await readFile(join(ROOT, 'playwright.config.ts'), 'utf8');
  // Four separate switches, and `attachments` is the one that defaults to ON.
  // Losing any of them silently re-arms pixel capture in a public artifact.
  assert.match(config, /screenshots: false/, 'the CI trace must not record timeline frames');
  assert.match(config, /sources: false/, 'the CI trace must not embed spec source text');
  assert.match(config, /attachments: false/, 'the CI trace must not store attached buffers');
  assert.match(config, /screenshot: isCI \? 'off' : 'only-on-failure'/);
  assert.match(config, /video: 'off'/);
});

test('no browser module removes a route', async () => {
  const files = await testModules();
  const offenders = [];
  for (const { key, source } of files) {
    const sites = countOutsideComments(source, UNROUTE);
    const recorded = UNROUTE_REASONS[key];
    if (sites === 0) {
      if (recorded) offenders.push(`${key}: recorded ${recorded.sites} unroute sites, found none`);
      continue;
    }
    if (!recorded) {
      offenders.push(`${key}: ${sites} unroute site(s) with no recorded reason`);
      continue;
    }
    if (recorded.sites !== sites) {
      offenders.push(`${key}: recorded ${recorded.sites} unroute sites, found ${sites}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    // Banned WHOLESALE, argument shape included. The earlier route-home check
    // reads the first argument and can only recognise a literal it knows, so
    // a RegExp, a variable, a template string, or a bare `unrouteAll()` would
    // walk straight past it and strip the page's stub mid-test. There is no
    // legitimate use in this suite, so the honest rule is none at all.
    'page.unroute and page.unrouteAll strip a stub mid-test and must be recorded in UNROUTE_REASONS'
  );
});

test('the deployer-owned Tribal and Treaty slots are empty, so a same-origin trace carries nothing', async () => {
  // These two slots are SAME-ORIGIN: the preview server serves them, so no
  // route stub stands between them and a trace. They are deep-linkable
  // (?layers=tribal / ?layers=treaty) even though the catalog hides them, so
  // "no spec toggles them today" is not a guarantee. What makes a retained
  // trace safe here is that the committed files hold zero features, and this
  // is the assertion that keeps them that way: a deployer who drops real
  // Treaty geometry into this repository fails the gate before CI can
  // publish an artifact containing it (hard rule 1; see the
  // NON-REDISTRIBUTION GUARD in src/layers/aiannh.ts).
  const tribalLayer = await readFile(join(ROOT, 'src/layers/tribal.ts'), 'utf8');
  const treatyLayer = await readFile(join(ROOT, 'src/layers/treaty.ts'), 'utf8');
  assert.match(tribalLayer, /URLS\.tribalLandsLocal/);
  assert.match(treatyLayer, /URLS\.treatyAreasLocal/);

  const urls = await readFile(join(ROOT, 'src/config/urls.ts'), 'utf8');
  assert.match(urls, /tribalLandsLocal: BASE_URL \+ 'data\/tribal-lands\.geojson'/);
  assert.match(urls, /treatyAreasLocal: BASE_URL \+ 'data\/treaty-areas\.geojson'/);

  for (const name of ['tribal-lands.geojson', 'treaty-areas.geojson']) {
    const raw = await readFile(join(ROOT, 'public/data', name), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(
      parsed.type,
      'FeatureCollection',
      `public/data/${name} must stay a FeatureCollection`
    );
    assert.ok(Array.isArray(parsed.features), `public/data/${name} must carry a features array`);
    assert.equal(
      parsed.features.length,
      0,
      `public/data/${name} must hold zero features: this repository redistributes no sovereign geometry, and CI now retains traces of same-origin fetches`
    );
  }
});
