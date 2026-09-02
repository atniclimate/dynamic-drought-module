import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the Dynamic Drought Module (DDM) smoke suite.
 *
 * The suite follows one verification loop: build, preview, drive, assert,
 * then clean up.
 *
 * Two doctrines shape what the suite asserts:
 *
 *   1. Verify the PRODUCTION build, never the dev server. The deployed site
 *      serves `dist/`, and dev-only behavior is a false pass. The `webServer`
 *      block runs `npm run build && npm run preview` so a stale `dist/` can
 *      never be verified (a build failure fails the run).
 *
 *   2. Deterministic backbone only. The suite asserts structure and behavior
 *      that do not depend on live agency data: role-group order, surface
 *      exclusivity, URL-as-state round trips, old-link resolution, preset
 *      swaps, and that status pills reach a TERMINAL state (never a specific
 *      live value). Exact live-value assertions ("Forebay 75.4 ft") stay in
 *      the manual ddm-ui-verifier lane, where a blipping upstream is a human
 *      judgment call, not a red CI run. See tests/README.md.
 *
 * The general suite uses the domain root. A focused deployment-subpath spec
 * also boots the production artifact from `/dynamic-drought-module/` and
 * verifies that its relative entry assets load from that seat.
 */

// 127.0.0.1 EXPLICITLY, never `localhost`: on this machine `localhost`
// can resolve to ::1 first, and an unrelated preview (another worktree
// lane's orphaned `vite preview`) listening on [::1]:4173 would then be
// tested in place of this tree's build (observed 2026-07-24: two review
// runs nondeterministically hit another lane's dist). Pinning the
// literal IPv4 loopback on both the health check and the browser, and
// binding the preview to the same host below, makes the served build
// deterministic even with a stale IPv6 listener present.
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';
const BASE_PATH = '/';
const BASE_URL = `${PREVIEW_ORIGIN}${BASE_PATH}`;

const isCI = !!process.env['CI'];

// The 3D Fire specs build terrain, a sky, a smoke volume, and context tiles
// on the software renderer, and carry their own 120 to 180 second budgets
// (`test.setTimeout` in fire3d-mode.spec.ts, `timeout_ms` rows in
// view-contracts.yaml). They live in their own project so CI can give them
// their own runners (DDM-P0-T02: the moving flake set of 2026-08-28 was
// timing on these specs, not product behavior) instead of inflating the
// global budget, and so a general shard never waits behind a scene build.
// Locally `npm test` and `npm run test:serial` still run both projects.
const FIRE3D_SPECS = ['**/fire3d-mode.spec.ts', '**/view-contracts.spec.ts'];

// The interaction cluster (R1/R3, 2026-08-29): these four files carry about
// 35 of the 53 named flake events tallied in the per-test table (section 3)
// of the 2026-08-29 CI flake report, across 21 CI runs (01:38-10:30 UTC) --
// a livelock in a click-retry loop, a sub-120ms CSS-transition read, an
// unwaited restore race, and the shards that happened to sit beside them.
// (The report's own "33" figure is a different slice: the chromium 3/4
// shard's event count, not a per-file total -- do not conflate the two.)
// They hold 42 tests today (`npx playwright test --list
// --project=chromium-interaction`, measured on 56dd46a). Moving them to
// their own project gives them a stable identity (a named project does not
// move when tests are added, unlike a shard boundary) and isolates a red or
// flaky run to its own ~2-shard project instead of dragging the whole
// general project.
//
// Read the above as the history that produced this grouping, not as a claim
// about today. Since the isolation shipped these four files have not behaved
// like a flake cluster: 19 of 19 passed serially on the first attempt locally
// on 2026-09-01, and in Validate 33452141530 and 33444784737 their two shards
// were the fastest and greenest in the matrix. The isolation may simply have
// worked. The grouping stays until something measured says otherwise.
const INTERACTION_SPECS = [
  '**/popup-viewport.spec.ts',
  '**/studio-restore.spec.ts',
  '**/s4-minimap.spec.ts',
  '**/s4-shell.spec.ts'
];

// MapLibre GL needs a WebGL2 context. Headless Chromium has no GPU, so force
// ANGLE over SwiftShader (a pure-software GL implementation) and allow it
// explicitly (recent Chromium gates the SwiftShader WebGL fallback behind
// this flag). Without these the map never fires `load` and the sidebar never
// builds, failing every spec at boot.
const CHROMIUM_USE = {
  browserName: 'chromium' as const,
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist'
    ]
  }
};

export default defineConfig({
  testDir: './tests',

  // Specs are independent (each loads its own URL into a fresh page), so run
  // them in parallel. The worker count is capped hard at 2: each page spins up
  // its own MapLibre GL context on ANGLE-over-SwiftShader (pure-software GL),
  // which is CPU and memory heavy, and too many concurrent contexts exhaust
  // the software renderer so a map never fires `load` and its sidebar never
  // builds. Two is the reliable ceiling on a developer laptop; CI passes
  // `--workers=1` per runner and fans out across runners instead
  // (browser-suite.yml).
  //
  // The serial baseline recorded here was "about 31 minutes, 2026-08-28".
  // That is stale and low. Re-measured 2026-09-01 on `d5aaac1`: about 3.8 s
  // per browser test in `chromium`, about 4.1 s in `chromium-interaction`,
  // and 11.1 minutes for `fire3d-mode.spec.ts` alone, over 852 tests in 107
  // files, which puts `npm run test:serial` at roughly 50 to 55 minutes.
  // Treat it as the integration branch's final pass, not a routine loop; the
  // cheaper tiers are `npm run verify:quick`, `verify:smoke`, and
  // `verify:fire` (tests/README.md).
  fullyParallel: true,
  workers: 2,

  // Retries in CI absorb the occasional cold-map or slow-tile flake on the
  // software renderer; local runs never retry, so a real regression is not
  // masked behind a green retry. Measured, not assumed (2026-08-29): across
  // 196 shard executions since 2026-08-29 01:38 UTC, every flaky pass came on
  // retry 1 and nothing ever passed on retry 2, so the third attempt bought no
  // green-ness while costing roughly 6 minutes on a red shard. One retry keeps
  // the same flake tolerance for less wall clock. browser-suite.yml's
  // `retries` workflow_call input can override this per dispatch for a
  // retry-zero sample.
  retries: isCI ? 1 : 0,

  // A guard against a missing `test.only` sneaking into CI.
  forbidOnly: isCI,

  // Generous per-test budget: a headless software-rendered MapLibre map takes
  // a few seconds to reach its `load` event before the sidebar builds, and the
  // longest legitimate network chain the app can run is ~36 seconds (the CWMS
  // discovery path in src/util/cwms.ts: three sequential fetches at a 12-second
  // budget each, taken by the Bonneville Dam station in production). The budget
  // must sit above boot plus that chain, or a correctly-behaving app fails on a
  // slow upstream day and CI retries quietly absorb a structural flake.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // CI adds GitHub annotations and a JSON report the workflow reads for its
  // per-shard summary (passed, failed, flaky, and the names of each).
  reporter: isCI
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'test-results/report.json' }]
      ]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // Locally, traces and screenshots are captured only when something goes
    // wrong, so the tree stays clean on a green run (they land in gitignored
    // `test-results/`). CI is DELIBERATELY NOT the same (2026-08-29,
    // DDM-P1-T08, owner ratified and then narrowed by adversarial review):
    // CI keeps a PIXEL-FREE trace and NO screenshots.
    //
    // Both were off in CI until today because the ordinary boot fetched live
    // AIANNH and BIA boundary geometry, which a trace records as a response
    // body and a screenshot renders as pixels, and every artifact on this
    // PUBLIC repository is downloadable by any GitHub user (the project's
    // hard rule 1; see the NON-REDISTRIBUTION GUARD in src/layers/aiannh.ts
    // and the cache note in src/layers/bia-reservations.ts). Since T08 every
    // boot answers those two queries from synthetic fixtures
    // (installBoundaryStubs, called by gotoApp in tests/helpers.ts, routed on
    // the CONTEXT so a popup inherits them), so the response-body objection
    // is answered and tests/boundary-stubs.spec.ts and
    // tests/boundary-boot-inventory.test.mjs keep it answered.
    //
    // The PIXEL objection is not answered, so pixels stay out. The basemap is
    // live OpenStreetMap raster (src/map/style.ts), and a rendered frame of
    // synthetic rectangles labelled as Tribal geography can be mistaken for
    // real boundaries once it is detached from its test. So in CI:
    // `screenshots: false` drops the trace's own timeline frames, `screenshot`
    // stays `off`, and `video` is off everywhere. `sources: false` keeps the
    // spec source text out of a public zip. `attachments: false` is the one
    // that is not belt and braces: it defaults to TRUE, and a spec that calls
    // `page.screenshot()` for its own pixel analysis (m-breadth-heatrisk-days
    // does) would otherwise hand that image to the trace as an attachment. Off
    // by configuration beats off by convention. What remains is what diagnoses
    // a flake: request and response records, DOM snapshots, console, and
    // timings. A synthetic basemap would be the precondition for turning
    // pixels back on; that is deferred, not assumed.
    //
    // `on-first-retry` records retry 1, not the original failing attempt 0.
    // Accepted for now because every flaky pass observed on this suite came
    // on retry 1, so the retry trace still carries the timing of the flaky
    // path; `retain-on-failure` is the upgrade if retry traces prove thin.
    //
    // The explicit evidence captures in fire3d-mode.spec.ts stay gated on CI:
    // they are a deliberate local scene capture for the owner's visual
    // review, not failure diagnosis, and nothing retains them.
    trace: isCI
      ? {
          mode: 'on-first-retry',
          screenshots: false,
          snapshots: true,
          sources: false,
          attachments: false
        }
      : 'on-first-retry',
    screenshot: isCI ? 'off' : 'only-on-failure',
    video: 'off'
  },

  projects: [
    {
      // Everything except the 3D Fire specs and the interaction cluster. CI
      // shards this project across a runner matrix with `--shard=i/n`
      // (contiguous equal-count slices of the file-ordered test list), one
      // worker per runner.
      name: 'chromium',
      // `**/*.test.mjs` are the node:test suites (`node --test`, run by the
      // gate); Playwright's default testMatch otherwise IMPORTS them on every
      // collection and every worker, where they register zero Playwright
      // tests but do execute, so a module-scope throw in one would red a
      // shard as a collection error rather than fail its own runner.
      testIgnore: [...FIRE3D_SPECS, ...INTERACTION_SPECS, '**/*.test.mjs'],
      use: CHROMIUM_USE
    },
    {
      // The interaction cluster, sharded onto its own runners in CI. See
      // INTERACTION_SPECS above for why these four files are grouped.
      name: 'chromium-interaction',
      testMatch: INTERACTION_SPECS,
      testIgnore: ['**/*.test.mjs'],
      use: CHROMIUM_USE
    },
    {
      // The 3D Fire specs alone, sharded onto their own runners in CI. The
      // per-test budgets above the 60 s default are declared in the specs.
      name: 'chromium-3d',
      testMatch: FIRE3D_SPECS,
      testIgnore: ['**/*.test.mjs'],
      use: CHROMIUM_USE
    }
  ],

  webServer: {
    // Build then serve the production bundle for every run. Refuse an existing
    // listener on the verification port so the suite cannot silently exercise
    // another worktree's server or a stale `dist/` artifact.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --strictPort',
    url: BASE_URL,
    // KEEP THIS `false`. Reusing an existing listener is exactly the failure
    // the 127.0.0.1 pin above was added to prevent: another lane's `dist/`
    // verified in place of this tree's.
    //
    // The cost is a recurring local papercut, and Playwright's own message
    // for it names the port but not the cause, so it is written out here for
    // whoever greps for it:
    //
    //   Error: http://127.0.0.1:4173 is already used, make sure that nothing
    //   is running on the port/url or set reuseExistingServer:true in
    //   config.webServer.
    //
    // That means a previous run was killed part way (Ctrl+C, a tool call
    // timing out, a terminated shard) and orphaned its `vite preview` child,
    // observed 2026-09-01 with PID 30372 still LISTENING on 127.0.0.1:4173
    // after a SIGTERM'd fire3d run. The fix is to stop the orphan, never to
    // flip this flag; tests/README.md, "When port 4173 is still held", has
    // the PowerShell and Git Bash commands.
    //
    // Not detected here on purpose: Playwright's own port probe throws
    // inside its webServer plugin before `command` runs and before any hook
    // this config owns, and a config module has no safe synchronous way to
    // probe a socket, so a friendlier message would need a new async seam
    // for no new information.
    reuseExistingServer: false,
    // The build (tsc plus vite) plus preview startup can take a while on a cold
    // CI runner; give it room.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
