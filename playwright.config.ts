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
  // builds. Two is the reliable ceiling on a developer laptop (the idle serial
  // baseline is about 31 minutes, 2026-08-28); CI passes `--workers=1` per
  // runner and fans out across runners instead (browser-suite.yml).
  fullyParallel: true,
  workers: 2,

  // Retries in CI absorb the occasional cold-map or slow-tile flake on the
  // software renderer; local runs never retry, so a real regression is not
  // masked behind a green retry.
  retries: isCI ? 2 : 0,

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
    // `test-results/`). In CI both are OFF: the ordinary boot fetches live
    // AIANNH and BIA boundary geometry, which the runtime holds in memory and
    // never writes to disk (the project's hard rule 1; see the
    // NON-REDISTRIBUTION GUARD in src/layers/aiannh.ts and the cache note in
    // src/layers/bia-reservations.ts). A trace records response bodies and a
    // screenshot renders the polygons, and CI retains failure diagnostics as
    // artifacts on a public repository. The retained report keeps the error
    // text, the ARIA error context, stdout and stderr, and timings, none of
    // which carry geometry. The explicit evidence captures in
    // fire3d-mode.spec.ts are gated on CI for the same reason.
    trace: isCI ? 'off' : 'on-first-retry',
    screenshot: isCI ? 'off' : 'only-on-failure',
    video: 'off'
  },

  projects: [
    {
      // Everything except the 3D Fire specs. CI shards this project across
      // a runner matrix with `--shard=i/n` (contiguous equal-count slices of
      // the file-ordered test list), one worker per runner.
      name: 'chromium',
      // `**/*.test.mjs` are the node:test suites (`node --test`, run by the
      // gate); Playwright's default testMatch otherwise IMPORTS them on every
      // collection and every worker, where they register zero Playwright
      // tests but do execute, so a module-scope throw in one would red a
      // shard as a collection error rather than fail its own runner.
      testIgnore: [...FIRE3D_SPECS, '**/*.test.mjs'],
      use: CHROMIUM_USE
    },
    {
      // The 3D Fire specs alone, sharded onto their own runners in CI. The
      // per-test budgets above the 60 s default are declared in the specs.
      name: 'chromium-3d',
      testMatch: FIRE3D_SPECS,
      use: CHROMIUM_USE
    }
  ],

  webServer: {
    // Build then serve the production bundle for every run. Refuse an existing
    // listener on the verification port so the suite cannot silently exercise
    // another worktree's server or a stale `dist/` artifact.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --strictPort',
    url: BASE_URL,
    reuseExistingServer: false,
    // The build (tsc plus vite) plus preview startup can take a while on a cold
    // CI runner; give it room.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
