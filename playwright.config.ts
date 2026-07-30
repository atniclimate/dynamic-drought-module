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
 * The preview is exercised at the historical deployment subpath. Vite emits
 * relative asset URLs so the same artifact also works at a domain root.
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

export default defineConfig({
  testDir: './tests',

  // Specs are independent (each loads its own URL into a fresh page), so run
  // them in parallel. The worker count is capped hard at 2: each page spins up
  // its own MapLibre GL context on ANGLE-over-SwiftShader (pure-software GL),
  // which is CPU and memory heavy, and too many concurrent contexts exhaust
  // the software renderer so a map never fires `load` and its sidebar never
  // builds. Two is the reliable ceiling on both a 2-core CI runner and a
  // developer laptop; the suite is small enough that the wall-clock cost is
  // a handful of seconds.
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

  reporter: isCI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // Traces and screenshots are captured only when something goes wrong, so
    // the tree stays clean on a green run (the artifacts land in gitignored
    // `test-results/`).
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off'
  },

  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // MapLibre GL needs a WebGL2 context. Headless Chromium has no GPU, so
        // force ANGLE over SwiftShader (a pure-software GL implementation) and
        // allow it explicitly (recent Chromium gates the SwiftShader WebGL
        // fallback behind this flag). Without these the map never fires `load`
        // and the sidebar never builds, failing every spec at boot.
        launchOptions: {
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist'
          ]
        }
      }
    }
  ],

  webServer: {
    // Build then serve the production bundle. Locally this guarantees a fresh
    // `dist/`; in CI the same command runs on the runner. `reuseExistingServer`
    // lets a developer keep a `npm run preview` running between local runs.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !isCI,
    // The build (tsc plus vite) plus preview startup can take a while on a cold
    // CI runner; give it room.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
